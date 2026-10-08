import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalGit, git, protectedGitArguments } from './git.mjs';
import { DomainError } from '../core/hash.mjs';
import { observationRef, pageRefs, gitObjectId } from '../core/git-refs.mjs';
const exec = promisify(execFile);
const commit = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? '') || /^0{40}$/.test(value))
    throw new DomainError('INVALID_COMMIT', 'Full immutable Git commit hashes are required');
  return value;
};

/**
 * Artifacts Git transport backed by a replaceable local object cache. Remotes,
 * trusted validation profiles and credential-variable names come from the owner
 * manifest; producer payloads cannot choose them. Canonical authority stays remote.
 *
 * @param {string} root Cache workspace directory used by LocalGit.
 * @param {object} manifest Trusted repository configuration, without token values.
 */
export class RemoteGit extends LocalGit {
  constructor(root, manifest) {
    super(root);
    this.manifest = manifest;
  }
  entry(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id ?? ''))
      throw new DomainError('INVALID_REPO', 'Executor repository identifiers are bounded names');
    const entry = this.manifest.repositories?.[id];
    let remote;
    try {
      remote = new URL(entry?.remote);
    } catch {}
    if (
      !entry ||
      remote?.protocol !== 'https:' ||
      remote.username ||
      remote.password ||
      !remote.hostname.endsWith('.artifacts.cloudflare.net') ||
      !/^[A-Z][A-Z0-9_]*$/.test(entry.tokenEnv ?? '') ||
      !process.env[entry.tokenEnv]
    )
      throw new DomainError(
        'REPO_NOT_CONFIGURED',
        'Executor has no scoped Artifacts repository credential',
        503,
      );
    return entry;
  }
  configured(repo) {
    const entry = this.entry(repo.id);
    return {
      ...repo,
      validation_profile: entry.validation_profile,
      context_repo: entry.context_repo ?? entry.dependencies?.[0],
    };
  }
  async remote(id, args) {
    const entry = this.entry(id),
      transportEnvironment = Object.fromEntries(
        [
          'HTTP_PROXY',
          'HTTPS_PROXY',
          'ALL_PROXY',
          'NO_PROXY',
          'http_proxy',
          'https_proxy',
          'all_proxy',
          'no_proxy',
          'SSL_CERT_FILE',
          'GIT_SSL_CAINFO',
        ]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      );
    const env = {
      ...transportEnvironment,
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer ' + process.env[entry.tokenEnv],
    };
    try {
      return (
        await exec('/usr/bin/git', [...protectedGitArguments, ...args], {
          cwd: this.dir({ id }),
          env,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 60000,
        })
      ).stdout.trim();
    } catch (error) {
      const lease = args.find((argument) => argument.startsWith('--force-with-lease='));
      const destination = lease?.slice('--force-with-lease='.length).split(':')[0];
      const rejected = (error.stdout ?? '').split('\n').some((line) => {
        const [status, refspec, result] = line.split('\t');
        return (
          status === '!' &&
          refspec === args.at(-1) &&
          refspec.endsWith(':' + destination) &&
          result === '[rejected] (stale info)'
        );
      });
      if (args[0] === 'push' && args.includes('--porcelain') && destination && rejected)
        throw new DomainError('CANONICAL_CAS_REJECTED', 'Git rejected the reviewed ref lease', 409);
      throw new DomainError(
        'REMOTE_GIT_FAILED',
        'Authenticated Git operation failed; credentials are excluded from diagnostics',
        503,
      );
    }
  }
  /**
   * Refresh heads and retained candidate refs from the configured remote.
   * Prepared-operation recovery must not depend on the previous Container's disk.
   *
   * @param {string} id Bounded repository ID present in the trusted manifest.
   * @returns {Promise<void>} Local heads and retained objects have been fetched.
   * @throws {DomainError} Repository/credentials are unconfigured or transport fails.
   * @throws {Error} Local directory creation or bare-repository initialization fails.
   */
  async ensure(id) {
    const entry = this.entry(id);
    await mkdir(this.dir({ id }), { recursive: true });
    try {
      await git(this.dir({ id }), ['rev-parse', '--is-bare-repository']);
    } catch {
      await git(this.dir({ id }), ['init', '--bare', '--quiet']);
    }
    await this.remote(id, [
      'fetch',
      '--quiet',
      entry.remote,
      '--prune',
      '+refs/heads/*:refs/heads/*',
      '+refs/tags/*:refs/tags/*',
      '+refs/klocgit/candidates/*:refs/klocgit/candidates/*',
    ]);
  }
  async prepareCache(id) {
    this.entry(id);
    await mkdir(this.dir({ id }), { recursive: true });
    try {
      await git(this.dir({ id }), ['rev-parse', '--is-bare-repository']);
    } catch {
      await git(this.dir({ id }), ['init', '--bare', '--quiet']);
    }
  }
  /** Mutable ref authority is remote, never a surviving Container cache. */
  async readRef(repo, ref) {
    observationRef(ref);
    await this.prepareCache(repo.id);
    const rows = (await this.remote(repo.id, ['ls-remote', this.entry(repo.id).remote, ref]))
      .split('\n').filter(Boolean).map((line) => line.split(/\s+/));
    const object_id = rows.find((row) => row[1] === ref)?.[0];
    if (!object_id)
      throw new DomainError('REF_NOT_FOUND', 'Remote Git ref is unavailable', 404);
    if (!gitObjectId.test(object_id))
      throw new DomainError('INVALID_GIT_FACTS', 'Remote Git returned an invalid ref object', 503);
    try {
      await git(this.dir(repo), ['cat-file', '-e', object_id]);
    } catch {
      await this.remote(repo.id, ['fetch', '--quiet', this.entry(repo.id).remote, object_id]);
    }
    const object_type = await git(this.dir(repo), ['cat-file', '-t', object_id]);
    let resolved = object_type === 'commit' ? object_id : null;
    if (object_type === 'tag') {
      try {
        resolved = await git(this.dir(repo), ['rev-parse', '--verify', object_id + '^{commit}']);
      } catch {
        resolved = null;
      }
    }
    return { ref, kind: ref.startsWith('refs/tags/') ? 'tag' : 'branch', object_id, object_type, commit: resolved, available_for_future: gitObjectId.test(resolved) };
  }
  async listRefs(repo, input = {}) {
    await this.prepareCache(repo.id);
    const rows = (await this.remote(repo.id, ['ls-remote', '--heads', '--tags', this.entry(repo.id).remote]))
      .split('\n').filter(Boolean).map((line) => line.split(/\s+/));
    const refs = rows.filter((row) => !row[1]?.endsWith('^{}')).map(([object_id, ref]) => {
      observationRef(ref);
      if (!gitObjectId.test(object_id))
        throw new DomainError('INVALID_GIT_FACTS', 'Remote Git returned an invalid ref object', 503);
      const peeled = rows.find((row) => row[1] === ref + '^{}')?.[0];
      const branch = ref.startsWith('refs/heads/');
      // Advertising an unpeeled tag alone cannot establish its target object type.
      return { ref, kind: branch ? 'branch' : 'tag', object_id, object_type: branch ? 'commit' : peeled ? 'tag' : 'unknown', commit: branch ? object_id : null, available_for_future: branch ? true : null };
    });
    return pageRefs(refs, input);
  }
  async retainObservation(repo, objects) {
    if (!Array.isArray(objects) || !objects.length || objects.length > 2)
      throw new DomainError('INVALID_RETENTION', 'Retain the exact ref object and commit');
    const archive = { id: repo.canonical_repo ?? repo.id };
    await this.prepareCache(repo.id);
    await this.prepareCache(archive.id);
    for (const oid of [...new Set(objects)]) {
      commit(oid);
      await this.remote(repo.id, ['fetch', '--quiet', this.entry(repo.id).remote, oid]);
    }
    const retained = await super.retainObservation(repo, objects);
    for (const entry of retained.objects) {
      await this.remote(archive.id, [
        'push', '--porcelain', '--force-with-lease=' + entry.ref + ':',
        this.entry(archive.id).remote, entry.object_id + ':' + entry.ref,
      ]);
      const rows = (await this.remote(archive.id, ['ls-remote', this.entry(archive.id).remote, entry.ref]))
        .split('\n').filter(Boolean).map((line) => line.split(/\s+/));
      if (rows.find((row) => row[1] === entry.ref)?.[0] !== entry.object_id)
        throw new DomainError('RETENTION_UNCERTAIN', 'Remote archive retention is unconfirmed', 503);
    }
    return retained;
  }
  async ensureCommit(id, oid) {
    commit(oid);
    await this.ensure(id);
    try {
      await git(this.dir({ id }), ['cat-file', '-e', `${oid}^{commit}`]);
    } catch {
      await this.remote(id, ['fetch', '--quiet', this.entry(id).remote, oid]);
    }
  }
  async ensureGraphCommit(repo, oid) {
    commit(oid);
    this.entry(repo.id);
    try {
      await git(this.dir(repo), ['cat-file', '-e', `${oid}^{commit}`]);
      return;
    } catch {}
    try {
      await this.ensureCommit(repo.id, oid);
      return;
    } catch {}
    const other = repo.canonical_repo ?? repo.source_repo;
    if (other && other !== repo.id) {
      await this.ensureCommit(other, oid);
      await git(this.dir(repo), ['fetch', '--quiet', this.dir({ id: other }), oid]);
      return;
    }
    throw new DomainError(
      'MISSING_COMMIT',
      'An immutable ancestry input is unavailable from the configured Git sources',
      404,
    );
  }
  async retainCandidate(repo, result) {
    commit(result.commit);
    const ref = `refs/klocgit/candidates/${result.commit}`;
    await this.remote(repo.id, [
      'push',
      '--porcelain',
      this.entry(repo.id).remote,
      `${result.commit}:${ref}`,
    ]);
    const observed = await this.remote(repo.id, ['ls-remote', this.entry(repo.id).remote, ref]);
    if (observed.split(/\s/)[0] !== result.commit)
      throw new DomainError(
        'CANDIDATE_RETENTION_FAILED',
        'The immutable candidate is not retained in authoritative Git',
        503,
      );
    return { ...result, retention_ref: ref };
  }
  async compose(repo, head, revisions) {
    commit(head);
    await this.ensureCommit(repo.id, head);
    for (const revision of revisions) {
      commit(revision.head_commit);
      commit(revision.base_commit);
      const source = revision.source_repo ?? repo.id;
      await this.ensureCommit(source, revision.head_commit);
      await this.ensureCommit(source, revision.base_commit);
      if (source !== repo.id)
        for (const oid of [revision.head_commit, revision.base_commit])
          await git(this.dir(repo), ['fetch', '--quiet', this.dir({ id: source }), oid]);
    }
    const result = await super.compose(this.configured(repo), head, revisions);
    // Retain the actual candidate before the engine prepares a canonical operation.
    return this.retainCandidate(repo, result);
  }
  async composeSelections(repo, head, selections) {
    commit(head);
    await this.ensureCommit(repo.id, head);
    if (!Array.isArray(selections) || selections.length > 100)
      throw new DomainError('INVALID_SELECTION', 'A bounded selection list is required');
    for (const selection of selections) {
      const source = selection.source_repo;
      for (const oid of [
        selection.base_commit,
        selection.head_commit,
        ...(selection.commits ?? []),
      ])
        await this.ensureCommit(source, oid);
    }
    return this.retainCandidate(
      repo,
      await super.composeSelections(this.configured(repo), head, selections),
    );
  }
  async revert(repo, currentHead, targetCommit, mainline) {
    commit(currentHead);
    commit(targetCommit);
    await this.ensureGraphCommit(repo, currentHead);
    await this.ensureGraphCommit(repo, targetCommit);
    return this.retainCandidate(
      repo,
      await super.revert(this.configured(repo), currentHead, targetCommit, mainline),
    );
  }
  async validate(repo, oid, constraints, validityHeads = {}) {
    await this.ensureCommit(repo.id, oid);
    for (const [id, head] of Object.entries(validityHeads)) await this.ensureCommit(id, head);
    return super.validate(this.configured(repo), oid, constraints, validityHeads);
  }
  async message(repo, oid) {
    await this.ensureCommit(repo.id, oid);
    return super.message(repo, oid);
  }
  async trailers(repo, oid) {
    const message = await this.message(repo, oid),
      parsed = await git(this.dir(repo), ['interpret-trailers', '--parse'], message + '\n');
    return parsed
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(':');
        return { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() };
      });
  }
  async diff(repo, base, head) {
    await this.ensureCommit(repo.id, base);
    await this.ensureCommit(repo.id, head);
    return super.diff(repo, base, head);
  }
  /**
   * Push the selected immutable candidate with an explicit old-head lease. A lost
   * reply can follow a successful write, so an ambiguous result must reach the
   * coordinator's prepared-operation recovery rather than trigger another push.
   *
   * @param {{id: string, canonical_ref: string}} repo Configured canonical repository.
   * @param {string} expected Full immutable old commit ID reviewed by the caller.
   * @param {string} target Full immutable retained candidate commit ID.
   * @returns {Promise<boolean>} True for an acknowledged push; false only for Git's
   *   explicit porcelain lease rejection.
   * @throws {DomainError} Invalid inputs/configuration or an unresolved remote outcome.
   * @throws {Error} Local candidate-cache preparation fails before the push.
   */
  async cas(repo, expected, target) {
    commit(expected);
    commit(target);
    if (
      !/^refs\/heads\/[\w./-]+$/.test(repo.canonical_ref ?? '') ||
      repo.canonical_ref.includes('..')
    )
      throw new DomainError('INVALID_REF', 'Invalid canonical ref');
    await this.ensureCommit(repo.id, target);
    const remote = this.entry(repo.id).remote;
    try {
      const output = await this.remote(repo.id, [
        'push',
        '--porcelain',
        `--force-with-lease=${repo.canonical_ref}:${expected}`,
        remote,
        `${target}:${repo.canonical_ref}`,
      ]);
      const receipt = output
        .split('\n')
        .map((line) => line.split('\t'))
        .find((row) => row[1] === `${target}:${repo.canonical_ref}`);
      // Git marks an already-present target up to date before checking its lease.
      // That acknowledges no write and cannot accept a different reviewed head.
      if (receipt?.[0] === '=') return expected === target;
      if ([' ', '+', '*'].includes(receipt?.[0])) return true;
      throw new DomainError(
        'CANONICAL_WRITE_UNCERTAIN',
        'Git returned no canonical write receipt; reconciliation is required',
        503,
      );
    } catch (error) {
      if (error.code === 'CANONICAL_CAS_REJECTED') return false;
      // A failed reply plus a different ref is still ambiguous: the write may
      // have landed before an external push. Only journal recovery settles it.
      throw error;
    }
  }
}
