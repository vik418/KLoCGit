/** Git composition in disposable local object databases. Sources are read-only. */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { V1Error } from '../../core/v1/conventions.mjs';
import { gitOid } from '../../core/v1/domain.mjs';
import { gitSnapshot } from '../../core/v1/git-store.mjs';
import { materializationInputs, materializedCandidate } from '../../core/v1/materialization.mjs';
import { verifyCandidateContent } from '../../core/v1/promotion.mjs';
import { WorkspaceSource, gitObjectOid } from '../../core/v1/workspace.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const environment = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
});

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

class Budget {
  constructor(limits) {
    const keys = [
      'max_objects',
      'max_bytes',
      'max_files',
      'max_history_commits',
      'timeout_ms',
      'max_candidates',
    ];
    valid(Object.keys(limits).length === keys.length);
    for (const key of keys) valid(Number.isSafeInteger(limits[key]) && limits[key] > 0);
    this.limits = Object.freeze({ ...limits });
    this.started = performance.now();
    this.objects = 0;
    this.bytes = 0;
    this.history = 0;
  }

  remaining() {
    const remaining = Math.floor(this.limits.timeout_ms - (performance.now() - this.started));
    if (remaining <= 0) throw new V1Error('PROVIDER_UNAVAILABLE');
    return remaining;
  }

  async wait(operation) {
    const timeout = this.remaining();
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new V1Error('PROVIDER_UNAVAILABLE')), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  account(bytes) {
    if (++this.objects > this.limits.max_objects || (this.bytes += bytes) > this.limits.max_bytes)
      throw new V1Error('INCOMPLETE_ANALYSIS');
  }

  visit() {
    if (++this.history > this.limits.max_history_commits) throw new V1Error('INCOMPLETE_ANALYSIS');
  }
}

function run(binary, directory, args, budget, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.attributesFile=/dev/null',
        '-c',
        'protocol.allow=never',
        '-c',
        'merge.renormalize=false',
        '-c',
        'merge.renameLimit=' + budget.limits.max_files,
        ...args,
      ],
      {
        cwd: directory,
        env: environment,
        encoding: 'buffer',
        timeout: budget.remaining(),
        maxBuffer: budget.limits.max_bytes,
      },
      (error, stdout) => {
        if (error && !Number.isInteger(error.code)) reject(new V1Error('PROVIDER_UNAVAILABLE'));
        else resolve({ code: error?.code ?? 0, stdout });
      },
    );
    // A killed process may close stdin while an object is being copied.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

class LocalComposition {
  constructor({ binary, directory, oidLength, budget, identity }) {
    Object.assign(this, { binary, directory, oidLength, budget, identity });
    this.imported = new Set();
    this.providers = new Map();
    this.sourceWorkspaces = new Set();
  }

  async git(args, input) {
    const result = await run(this.binary, this.directory, args, this.budget, input);
    if (result.code !== 0) throw new V1Error('PROVIDER_UNAVAILABLE');
    return result.stdout;
  }

  async write(kind, bytes, expected) {
    if (expected && this.imported.has(expected)) return expected;
    const copied = new Uint8Array(bytes);
    const actual = await gitObjectOid(kind, copied, this.oidLength);
    if (expected && actual !== expected) throw new V1Error('INTEGRITY_MISMATCH');
    if (this.imported.has(actual)) return actual;
    this.budget.account(copied.length);
    const oid = (await this.git(['hash-object', '-w', '-t', kind, '--stdin'], copied))
      .toString('ascii')
      .trim();
    if (oid !== actual) throw new V1Error('INTEGRITY_MISMATCH');
    this.imported.add(oid);
    return oid;
  }

  async importSnapshot(workspace) {
    if (workspace.status().metadata_complete !== true) throw new V1Error('INCOMPLETE_ANALYSIS');
    this.sourceWorkspaces.add(workspace);
    for (const { oid, kind } of workspace.objectInventory()) {
      gitOid(oid, this.oidLength);
      if (kind === 'blob') {
        if (!this.providers.has(oid)) this.providers.set(oid, []);
        this.providers.get(oid).push(workspace);
      } else {
        valid(['commit', 'tree'].includes(kind));
        const object = await this.budget.wait(() => workspace.readObject(oid, kind));
        if (object.status !== 'AVAILABLE') throw new V1Error('INCOMPLETE_ANALYSIS');
        await this.write(kind, object.bytes, oid);
      }
    }
    // Git parses the copied tree, so metadata hints cannot omit a changed path.
    return this.files(workspace.identity.tree_oid);
  }

  async files(tree) {
    gitOid(tree, this.oidLength);
    const bytes = await this.git(['ls-tree', '-r', '-z', tree]);
    const files = new Map();
    try {
      for (const line of decoder.decode(bytes).split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t');
        const [mode, kind, oid] = line.slice(0, tab).split(' ');
        const path = line.slice(tab + 1);
        gitOid(oid, this.oidLength);
        valid(tab > 0 && ['blob', 'commit'].includes(kind) && !files.has(path));
        files.set(path, { oid, mode, kind });
        if (files.size > this.budget.limits.max_files) throw new V1Error('INCOMPLETE_ANALYSIS');
      }
    } catch (error) {
      if (error instanceof V1Error) throw error;
      throw new V1Error('UNSUPPORTED_CAPABILITY');
    }
    return files;
  }

  async hydrate(oid) {
    if (this.imported.has(oid)) return;
    for (const workspace of this.providers.get(oid) ?? []) {
      const object = await this.budget.wait(() => workspace.readObject(oid, 'blob'));
      if (object.status === 'AVAILABLE') {
        await this.write('blob', object.bytes, oid);
        return;
      }
    }
    throw new V1Error('NOT_FOUND');
  }

  async commit(tree, parents = [], message = 'Candidate') {
    const { name, email, timestamp } = this.identity;
    const author = `${name} <${email}> ${timestamp} +0000`;
    return this.write(
      'commit',
      new TextEncoder().encode(
        `tree ${tree}\n${parents.map((oid) => 'parent ' + oid + '\n').join('')}author ${author}\ncommitter ${author}\n\n${message}\n`,
      ),
    );
  }

  async merge(baseTree, currentTree, selectedTree) {
    const maps = await Promise.all(
      [baseTree, currentTree, selectedTree].map((tree) => this.files(tree)),
    );
    const paths = new Set(maps.flatMap((map) => [...map.keys()]));
    const required = new Set();
    for (const path of paths) {
      const entries = maps.map((map) => map.get(path));
      const signatures = entries.map((entry) => (entry ? entry.mode + ':' + entry.oid : null));
      if (new Set(signatures).size === 1 && path.split('/').at(-1) !== '.gitattributes') continue;
      for (const entry of entries) {
        if (entry?.kind === 'commit') throw new V1Error('UNSUPPORTED_CAPABILITY');
        if (entry?.kind === 'blob') required.add(entry.oid);
      }
    }
    for (const oid of required) await this.hydrate(oid);
    // Both synthetic parents share the exact recorded baseline. This avoids
    // guessing ancestry after rebase/force-push and needs no producer history.
    const base = await this.commit(baseTree, [], 'Composition base');
    const current = await this.commit(currentTree, [base]);
    const selected = await this.commit(selectedTree, [base]);
    const result = await run(
      this.binary,
      this.directory,
      ['merge-tree', '--write-tree', '-z', current, selected],
      this.budget,
    );
    if (result.code === 1) throw new V1Error('CONFLICT');
    if (result.code !== 0) throw new V1Error('PROVIDER_UNAVAILABLE');
    const tree = gitOid(
      result.stdout.subarray(0, result.stdout.indexOf(0)).toString('ascii'),
      this.oidLength,
    );
    await this.files(tree);
    return tree;
  }

  async readObject({ oid, kind }) {
    gitOid(oid, this.oidLength);
    valid(['commit', 'tree', 'blob'].includes(kind));
    // Hydration remains lazy when a targeted evaluator needs an unchanged file.
    let result = await this.git(['cat-file', '--batch'], oid + '\n');
    if (result.toString('ascii').trim() === oid + ' missing' && kind === 'blob') {
      await this.hydrate(oid);
      result = await this.git(['cat-file', '--batch'], oid + '\n');
    }
    const newline = result.indexOf(10);
    const [actual, actualKind, sizeText] = result.subarray(0, newline).toString('ascii').split(' ');
    const size = Number(sizeText);
    if (
      actual !== oid ||
      actualKind !== kind ||
      !/^\d+$/.test(sizeText ?? '') ||
      !Number.isSafeInteger(size) ||
      result.length !== newline + size + 2 ||
      result.at(-1) !== 10
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    return {
      status: 'AVAILABLE',
      bytes: new Uint8Array(result.subarray(newline + 1, newline + 1 + size)),
      bytes_transferred: size,
    };
  }
}

export class LocalMaterializer {
  #candidates = new Map();
  #closed = false;

  constructor({ root, resolveSource, limits, binary = '/usr/bin/git' }) {
    valid(typeof root === 'string' && isAbsolute(root));
    valid(typeof binary === 'string' && isAbsolute(binary) && typeof resolveSource === 'function');
    new Budget(limits);
    Object.assign(this, { root, resolveSource, limits: Object.freeze({ ...limits }), binary });
  }

  async materialize(specInput, workspaceInput) {
    if (this.#closed) throw new V1Error('NOT_FOUND');
    const inputs = await materializationInputs(specInput, workspaceInput);
    const budget = new Budget(this.limits);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.root, 'candidate-'));
    const states = new Map(),
      snapshots = new Map();
    let retained = false;
    try {
      const help = await run(this.binary, directory, ['merge-tree', '-h'], budget);
      if (!help.stdout.includes(Buffer.from('--write-tree')))
        throw new V1Error('UNSUPPORTED_CAPABILITY');
      const version = await run(this.binary, directory, ['--version'], budget);
      if (version.code !== 0) throw new V1Error('PROVIDER_UNAVAILABLE');
      const fetch = async (repo_id, commit_oid, expected = {}) => {
        const key = JSON.stringify([repo_id, commit_oid]);
        if (!snapshots.has(key)) {
          const source = await budget.wait(() => this.resolveSource(repo_id));
          valid(typeof source?.fetch === 'function');
          const workspace = await budget.wait(() =>
            source.fetch(
              { schema_version: 1, repo_id, commit_oid, ...expected },
              { blobs: 'none' },
            ),
          );
          const identity = gitSnapshot(workspace.identity);
          if (identity.repo_id !== repo_id || identity.commit_oid !== commit_oid)
            throw new V1Error('INTEGRITY_MISMATCH');
          snapshots.set(key, workspace);
        }
        const result = snapshots.get(key);
        if (
          (expected.tree_oid && result.identity.tree_oid !== expected.tree_oid) ||
          (expected.parent_oids &&
            JSON.stringify(expected.parent_oids) !== JSON.stringify(result.identity.parent_oids))
        )
          throw new V1Error('INTEGRITY_MISMATCH');
        return result;
      };
      const repoTrees = {},
        repoCommits = {};
      for (const repoId of Object.keys(inputs.base_revision.repositories).sort()) {
        const oid = inputs.base_revision.repositories[repoId];
        const repoDirectory = join(directory, String(states.size));
        await mkdir(repoDirectory, { mode: 0o700 });
        const state = new LocalComposition({
          binary: this.binary,
          directory: repoDirectory,
          oidLength: oid.length,
          budget,
          identity: inputs.commit_identity,
        });
        await state.git([
          'init',
          '--bare',
          '--quiet',
          '--template=',
          '--object-format=' + (oid.length === 40 ? 'sha1' : 'sha256'),
        ]);
        const baseline = await fetch(repoId, oid);
        await state.importSnapshot(baseline);
        states.set(repoId, state);
        repoTrees[repoId] = baseline.identity.tree_oid;
        repoCommits[repoId] = oid;
      }
      const revisions = new Map(inputs.revisions.map((revision) => [revision.id, revision]));
      for (const selection of inputs.spec.selections) {
        const revision = revisions.get(selection.future_revision_id);
        const binding = inputs.bindings[revision.id];
        const state = states.get(selection.target_repo_id);
        await state.importSnapshot(await fetch(revision.repo_id, revision.commit_oid, revision));
        let baseTree, selectedTree;
        if (selection.kind === 'future') {
          const base = await fetch(revision.repo_id, binding.base_commit_oid, {
            tree_oid: binding.base_tree_oid,
          });
          await state.importSnapshot(base);
          baseTree = base.identity.tree_oid;
          selectedTree = revision.tree_oid;
        } else {
          const pending = [revision.commit_oid],
            visited = new Set();
          let reached = false;
          while (pending.length) {
            const oid = pending.pop();
            if (visited.has(oid)) continue;
            visited.add(oid);
            budget.visit();
            if (oid === selection.commit_oid) {
              reached = true;
              break;
            }
            try {
              pending.push(...(await fetch(revision.repo_id, oid)).identity.parent_oids);
            } catch (error) {
              if (error instanceof V1Error && error.code === 'NOT_FOUND')
                throw new V1Error('INCOMPLETE_ANALYSIS');
              throw error;
            }
          }
          if (!reached) throw new V1Error('FORBIDDEN');
          const commit = await fetch(revision.repo_id, selection.commit_oid, {
            tree_oid: selection.tree_oid,
          });
          const parents = commit.identity.parent_oids;
          valid(
            parents.length
              ? parents.includes(selection.parent_commit_oid)
              : selection.parent_commit_oid === null,
          );
          await state.importSnapshot(commit);
          selectedTree = commit.identity.tree_oid;
          if (selection.parent_commit_oid === null)
            baseTree = await state.write('tree', new Uint8Array());
          else {
            const parent = await fetch(revision.repo_id, selection.parent_commit_oid);
            await state.importSnapshot(parent);
            baseTree = parent.identity.tree_oid;
          }
        }
        repoTrees[selection.target_repo_id] = await state.merge(
          baseTree,
          repoTrees[selection.target_repo_id],
          selectedTree,
        );
      }
      for (const [repoId, state] of states) {
        const baseline = snapshots.get(JSON.stringify([repoId, repoCommits[repoId]]));
        if (repoTrees[repoId] !== baseline.identity.tree_oid)
          repoCommits[repoId] = await state.commit(
            repoTrees[repoId],
            [repoCommits[repoId]],
            'Candidate ' + inputs.spec.id,
          );
      }
      const candidate = await materializedCandidate(inputs.spec.id, repoTrees, {
        schema_version: 1,
        materializer: 'git-three-way-v1',
        git_version: version.stdout.toString('ascii').trim(),
        base_revision_digest: inputs.base_revision.digest,
        commit_identity: inputs.commit_identity,
        selections: inputs.spec.selections,
        repo_commit_oids: repoCommits,
      });
      if (this.#closed) throw new V1Error('NOT_FOUND');
      if (!this.#candidates.has(candidate.digest)) {
        if (this.#candidates.size >= this.limits.max_candidates) throw new V1Error('RATE_LIMITED');
        this.#candidates.set(candidate.digest, {
          candidate,
          directory,
          states,
          elapsed_ms: performance.now() - budget.started,
        });
        retained = true;
      }
      return candidate;
    } finally {
      if (!retained) await rm(directory, { recursive: true, force: true });
    }
  }

  async open(candidateInput, repo_id) {
    const candidate = await verifyCandidateContent(candidateInput);
    const entry = this.#candidates.get(candidate.digest);
    if (!entry) throw new V1Error('NOT_FOUND');
    const state = entry.states.get(repo_id);
    if (!state) throw new V1Error('FORBIDDEN');
    // Independent reads must not extend another evaluation's deadline.
    const reader = new LocalComposition({
      binary: this.binary,
      directory: state.directory,
      oidLength: state.oidLength,
      budget: new Budget(this.limits),
      identity: state.identity,
    });
    reader.imported = state.imported;
    reader.providers = state.providers;
    const source = new WorkspaceSource({
      repo_id,
      provider: {
        readObject: (request) => {
          if (request.repo_id !== repo_id) throw new V1Error('FORBIDDEN');
          if (!this.#candidates.has(candidate.digest)) throw new V1Error('NOT_FOUND');
          return reader.readObject(request);
        },
      },
    });
    return source.fetch(
      {
        schema_version: 1,
        repo_id,
        commit_oid: candidate.materialization_record.repo_commit_oids[repo_id],
        tree_oid: candidate.repo_tree_oids[repo_id],
      },
      { blobs: 'none' },
    );
  }

  async release(digest) {
    const entry = this.#candidates.get(digest);
    if (!entry) return;
    this.#candidates.delete(digest);
    await rm(entry.directory, { recursive: true, force: true });
  }

  metrics(digest) {
    const entry = this.#candidates.get(digest);
    if (!entry) throw new V1Error('NOT_FOUND');
    const sources = new Set(
      [...entry.states.values()].flatMap((state) => [...state.sourceWorkspaces]),
    );
    const counters = {
      schema_version: 1,
      elapsed_ms: entry.elapsed_ms,
      bytes_transferred: 0,
      metadata_bytes_transferred: 0,
      blob_bytes_transferred: 0,
      cache_hits: 0,
      cache_misses: 0,
      provider_reads: 0,
    };
    for (const source of sources) {
      const metrics = source.metrics();
      for (const key of Object.keys(counters))
        if (!['schema_version', 'elapsed_ms'].includes(key)) counters[key] += metrics[key];
    }
    return Object.freeze(counters);
  }

  async close() {
    this.#closed = true;
    for (const digest of this.#candidates.keys()) await this.release(digest);
  }
}
