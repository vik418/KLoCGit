import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DomainError } from '../core/hash.mjs';
import { createApplicationRunner, applicationValidationConfigHash } from './runner.mjs';
import {
  localRepositoryCreate,
  localRepositoryFork,
  localRepositoryImport,
  localRepositoryInfo,
} from './repositories.mjs';
const exec = promisify(execFile);
const gitEnvironment = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'klocgit',
  GIT_AUTHOR_EMAIL: 'klocgit@localhost',
  GIT_COMMITTER_NAME: 'klocgit',
  GIT_COMMITTER_EMAIL: 'klocgit@localhost',
};
export const protectedGitArguments = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'init.templateDir=',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'commit.gpgSign=false',
];
const immutableCommit = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? '') || /^0{40}$/.test(value))
    throw new DomainError('INVALID_COMMIT', 'Full immutable commit hashes are required');
  return value;
};
export async function git(cwd, args, input, { raw = false } = {}) {
  const finish = (value) => (raw ? value : value.trim());
  const options = { cwd, env: gitEnvironment, maxBuffer: 4 * 1024 * 1024, timeout: 30000 };
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const p = execFile(
        '/usr/bin/git',
        [...protectedGitArguments, ...args],
        options,
        (err, stdout) => (err ? reject(err) : resolve(finish(stdout))),
      );
      p.stdin.end(input);
    });
  }
  return finish((await exec('/usr/bin/git', [...protectedGitArguments, ...args], options)).stdout);
}
/**
 * Trusted adapter for bare repositories under a local workspace. Git supplies
 * observed facts; composition creates retained candidates rather than advancing
 * canonical refs. The coordinator owns review policy, evidence and write recovery.
 *
 * @param {string} root Workspace directory containing repositories/<id>.git.
 */
export class LocalGit {
  constructor(root, repositoryOptions = {}) {
    this.root = root;
    this.configHash = '';
    this.repositoryOptions = repositoryOptions;
  }
  runRepositoryGit(cwd, args) {
    return git(cwd, args);
  }
  repositoryCreate(input) {
    return localRepositoryCreate(this, input);
  }
  repositoryImport(input) {
    return localRepositoryImport(this, input);
  }
  repositoryFork(input) {
    return localRepositoryFork(this, input);
  }
  repositoryInfo(input) {
    return localRepositoryInfo(this, input);
  }
  async init() {
    this.configHash = await applicationValidationConfigHash();
    return this;
  }
  suitesForScope(repo, scope) {
    return repo.validation_profile === 'checkout-effects-v0' &&
      scope.some((p) => ['client/retry.mjs', 'server/charge.mjs', 'app.mjs'].includes(p))
      ? ['checkout-effects']
      : [];
  }
  async message(repo, commit) {
    return git(this.dir(repo), ['show', '-s', '--format=%B', commit]);
  }
  async trailers(repo, commit) {
    return git(this.dir(repo), ['interpret-trailers', '--parse'], await this.message(repo, commit));
  }
  dir(repo) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo.id ?? ''))
      throw new DomainError('INVALID_REPO', 'Repository identifiers must be bounded names');
    return path.join(this.root, 'repositories', repo.id + '.git');
  }
  async ref(repo, ref) {
    if (!/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(ref) || ref.includes('..'))
      throw new DomainError('INVALID_REF', 'A valid branch ref is required');
    try {
      return await git(this.dir(repo), ['rev-parse', '--verify', ref]);
    } catch {
      throw new DomainError('REF_NOT_FOUND', 'Git ref is unavailable', 404);
    }
  }
  async facts(repo, head, base) {
    if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base))
      throw new DomainError('INVALID_COMMIT', 'Full immutable commit hashes are required');
    const tree = await git(this.dir(repo), ['rev-parse', `${head}^{tree}`]);
    const scope = (
      await git(this.dir(repo), [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        base,
        head,
      ])
    )
      .split('\n')
      .filter(Boolean);
    return { head, base, tree, scope };
  }
  async ensureGraphCommit(repo, commit) {
    immutableCommit(commit);
    try {
      await git(this.dir(repo), ['cat-file', '-e', `${commit}^{commit}`]);
      return;
    } catch {}
    const other = repo.canonical_repo ?? repo.source_repo;
    if (other && other !== repo.id)
      try {
        await git(this.dir(repo), ['fetch', '--quiet', this.dir({ id: other }), commit]);
        await git(this.dir(repo), ['cat-file', '-e', `${commit}^{commit}`]);
        return;
      } catch {}
    throw new DomainError('MISSING_COMMIT', 'An immutable ancestry input is unavailable', 404);
  }
  async isAncestor(repo, ancestor, descendant) {
    await this.ensureGraphCommit(repo, ancestor);
    await this.ensureGraphCommit(repo, descendant);
    try {
      await git(this.dir(repo), ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw new DomainError(
        'ANCESTRY_UNAVAILABLE',
        'Git could not establish the requested ancestry',
        422,
      );
    }
  }
  async mergeBase(repo, head, canonical) {
    await this.ensureGraphCommit(repo, head);
    await this.ensureGraphCommit(repo, canonical);
    let bases;
    try {
      bases = (await git(this.dir(repo), ['merge-base', '--all', head, canonical]))
        .split('\n')
        .filter(Boolean);
    } catch (error) {
      if (error.code === 1)
        throw new DomainError(
          'NO_COMMON_ANCESTOR',
          'The immutable inputs have no common Git ancestor',
          422,
        );
      throw new DomainError('ANCESTRY_UNAVAILABLE', 'Git could not determine the merge base', 422);
    }
    if (bases.length !== 1)
      throw new DomainError(
        'AMBIGUOUS_MERGE_BASE',
        'Multiple best Git ancestors require an explicit reviewed base',
        422,
      );
    return immutableCommit(bases[0]);
  }
  /**
   * Build an actual Git composition on an immutable canonical base. Covered
   * ancestors are composed once, while trailers retain every proposal history.
   * Retaining the result keeps later review/recovery independent of the temp clone.
   *
   * @param {{id: string}} repo Destination repository descriptor.
   * @param {string} head Full immutable canonical commit ID captured for review.
   * @param {object[]} revisions Immutable revisions with source head/base IDs.
   * @returns {Promise<object>} Candidate tree/commit, baseTree, source_heads and
   *   canonical_parent. Its candidate ref is retained; canonical Git is unchanged.
   * @throws {DomainError} Invalid IDs, inconsistent revision inputs or a Git conflict.
   * @throws {Error} Repository import, Git command or temporary-filesystem failure.
   */
  async compose(repo, head, revisions) {
    immutableCommit(head);
    for (const revision of revisions) {
      immutableCommit(revision.head_commit);
      immutableCommit(revision.base_commit);
    }
    const temp = await mkdtemp(path.join(os.tmpdir(), 'klocgit-'));
    const cwd = path.join(temp, 'work');
    try {
      await git(temp, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', this.dir(repo), cwd]);
      for (const revision of revisions) {
        const source = this.dir({ id: revision.source_repo ?? repo.id });
        for (const oid of [revision.head_commit, revision.base_commit])
          await git(cwd, ['fetch', '--quiet', source, oid]);
        const tree = await git(cwd, ['rev-parse', `${revision.head_commit}^{tree}`]);
        if (revision.tree_hash && tree !== revision.tree_hash)
          throw new DomainError(
            'REVISION_TREE_MISMATCH',
            'Imported revision tree differs from its immutable version',
            422,
          );
        try {
          await git(cwd, [
            'merge-base',
            '--is-ancestor',
            revision.base_commit,
            revision.head_commit,
          ]);
        } catch {
          throw new DomainError(
            'INVALID_REVISION_BASE',
            'The immutable revision base must be an ancestor of its source head',
            422,
          );
        }
      }
      const ancestor = async (a, b) => {
        try {
          await git(cwd, ['merge-base', '--is-ancestor', a, b]);
          return true;
        } catch (error) {
          if (error.code === 1) return false;
          throw error;
        }
      };
      const heads = [...new Set(revisions.map((r) => r.head_commit))].sort(),
        maximal = [];
      for (const selected of heads) {
        if (await ancestor(selected, head)) continue;
        let covered = false;
        for (const other of heads)
          if (other !== selected && (await ancestor(selected, other))) {
            covered = true;
            break;
          }
        if (!covered) maximal.push(selected);
      }
      let merged = head,
        tree = await git(cwd, ['rev-parse', `${head}^{tree}`]);
      for (const selected of maximal) {
        try {
          tree = (
            await git(cwd, ['merge-tree', '--write-tree', '--no-messages', merged, selected])
          ).split('\n')[0];
        } catch {
          throw new DomainError(
            'COMPOSITION_CONFLICT',
            'The selected immutable Git histories have a textual conflict and require conventional review',
            422,
          );
        }
        immutableCommit(tree);
        merged = await git(cwd, [
          'commit-tree',
          tree,
          '-p',
          merged,
          '-p',
          selected,
          '-m',
          'klocgit: internal immutable Git composition',
        ]);
      }
      const trailers = [
        ...new Set(
          revisions.flatMap((r) => [
            ...(r.future_revision_id
              ? [`Selection: ${r.id}`, `Future-Revision: ${r.future_revision_id}`]
              : [`Proposal-Revision: ${r.id}`]),
            ...(r.context_task_id
              ? [`Decision-Task: ${r.context_task_id}`, `Decision-Context: ${r.context_version}`]
              : []),
            ...(r.context_answer_ref ? [`Decision-Answer: ${r.context_answer_ref}`] : []),
          ]),
        ),
      ].sort();
      const baseTree = await git(cwd, ['rev-parse', `${head}^{tree}`]);
      const commit = await git(
        cwd,
        ['commit-tree', tree, ...[head, ...maximal].flatMap((parent) => ['-p', parent])],
        ['klocgit: immutable reviewed candidate', '', ...trailers, ''].join('\n'),
      );
      await git(this.dir(repo), ['fetch', '--quiet', cwd, commit]);
      await git(this.dir(repo), ['update-ref', `refs/klocgit/candidates/${commit}`, commit]);
      return { tree, commit, baseTree, source_heads: maximal, canonical_parent: head };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  /**
   * Compose whole histories, then apply explicitly ordered commit patches to an
   * index. No producer code or hooks run, and unselected parents are not promoted.
   */
  async composeSelections(repo, head, selections) {
    immutableCommit(head);
    if (!Array.isArray(selections) || !selections.length || selections.length > 100)
      throw new DomainError('INVALID_SELECTION', 'A bounded selection list is required');
    for (const selection of selections) {
      if (!['future', 'commits'].includes(selection.kind))
        throw new DomainError('INVALID_SELECTION', 'Unknown selection kind');
      immutableCommit(selection.head_commit);
      immutableCommit(selection.base_commit);
      immutableCommit(selection.tree_hash);
      if (
        !Array.isArray(selection.commits) ||
        selection.commits.length > 50 ||
        (selection.kind === 'commits' && !selection.commits.length) ||
        (selection.kind === 'future' && selection.commits.length)
      )
        throw new DomainError(
          'INVALID_SELECTION',
          'Select whole histories or bounded commit patches',
        );
      selection.commits.forEach(immutableCommit);
    }
    const whole = selections.filter((selection) => selection.kind === 'future');
    const initial = await this.compose(repo, head, whole);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'klocgit-selection-'));
    const cwd = path.join(temp, 'work');
    try {
      await git(temp, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', this.dir(repo), cwd]);
      let current = initial.commit;
      await git(cwd, ['read-tree', current]);
      const applied = new Set();
      for (const selection of selections.filter((entry) => entry.kind === 'commits')) {
        const source = this.dir({ id: selection.source_repo });
        for (const commit of [selection.base_commit, selection.head_commit, ...selection.commits])
          await git(cwd, ['fetch', '--quiet', source, commit]);
        const tree = await git(cwd, ['rev-parse', selection.head_commit + '^{tree}']);
        if (tree !== selection.tree_hash)
          throw new DomainError('REVISION_TREE_MISMATCH', 'The pinned source tree differs', 422);
        for (const commit of selection.commits) {
          if (applied.has(commit))
            throw new DomainError('INVALID_SELECTION', 'The same commit patch was selected twice');
          applied.add(commit);
          if (commit === selection.base_commit)
            throw new DomainError(
              'COMMIT_OUTSIDE_REVISION',
              'The baseline is not a selectable change',
              422,
            );
          for (const pair of [
            [selection.base_commit, commit],
            [commit, selection.head_commit],
          ]) {
            try {
              await git(cwd, ['merge-base', '--is-ancestor', ...pair]);
            } catch {
              throw new DomainError(
                'COMMIT_OUTSIDE_REVISION',
                'Commit is outside the pinned revision',
                422,
              );
            }
          }
          const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', commit]))
            .split(/\s+/)
            .slice(1);
          if (parents.length !== 1)
            throw new DomainError(
              'COMMIT_PARENT_REQUIRED',
              'Commit selection currently supports non-root, non-merge commits',
              422,
            );
          const patch = await git(
            cwd,
            [
              'diff',
              '--binary',
              '--full-index',
              '--no-ext-diff',
              '--no-textconv',
              parents[0],
              commit,
            ],
            undefined,
            { raw: true },
          );
          try {
            await git(cwd, ['apply', '--cached', '--3way', '--allow-empty'], patch);
          } catch {
            throw new DomainError(
              'COMPOSITION_CONFLICT',
              'Selected patches conflict or require unselected changes',
              422,
            );
          }
          const result = await git(cwd, ['write-tree']);
          current = await git(
            cwd,
            ['commit-tree', result, '-p', current],
            [
              'klocgit: selected immutable commit patch',
              '',
              'Selection: ' + selection.id,
              'Future-Revision: ' + selection.future_revision_id,
              'Source-Commit: ' + commit,
              '',
            ].join('\n'),
          );
        }
      }
      const tree = await git(cwd, ['rev-parse', current + '^{tree}']);
      const trailers = selections.flatMap((selection) => [
        'Selection: ' + selection.id,
        'Future-Revision: ' + selection.future_revision_id,
      ]);
      const commit = await git(
        cwd,
        ['commit-tree', tree, '-p', current],
        ['klocgit: composed native candidate', '', ...trailers, ''].join('\n'),
      );
      await git(this.dir(repo), ['fetch', '--quiet', cwd, commit]);
      await git(this.dir(repo), ['update-ref', 'refs/klocgit/candidates/' + commit, commit]);
      return {
        tree,
        commit: tree === initial.baseTree ? head : commit,
        baseTree: initial.baseTree,
        canonical_parent: head,
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async revert(repo, currentHead, targetCommit, mainline) {
    immutableCommit(currentHead);
    immutableCommit(targetCommit);
    await this.ensureGraphCommit(repo, currentHead);
    await this.ensureGraphCommit(repo, targetCommit);
    if (!(await this.isAncestor(repo, targetCommit, currentHead)))
      throw new DomainError(
        'INVALID_REVERT_TARGET',
        'The target commit must be an ancestor of the captured canonical head',
        422,
      );
    const parents = (await git(this.dir(repo), ['rev-list', '--parents', '-n', '1', targetCommit]))
      .split(/\s+/)
      .slice(1);
    if (parents.length > 1) {
      if (!Number.isInteger(mainline) || mainline < 1 || mainline > parents.length)
        throw new DomainError(
          'REVERT_MAINLINE_REQUIRED',
          'Reverting a merge requires an explicit valid 1-based parent choice',
          422,
        );
    } else if (mainline !== undefined && mainline !== null)
      throw new DomainError(
        'REVERT_MAINLINE_INVALID',
        'A mainline parent is accepted only for a real merge commit',
        422,
      );
    const temp = await mkdtemp(path.join(os.tmpdir(), 'klocgit-revert-')),
      cwd = path.join(temp, 'work');
    try {
      await git(temp, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', this.dir(repo), cwd]);
      await git(cwd, ['checkout', '--quiet', '--detach', currentHead]);
      try {
        await git(cwd, [
          'revert',
          '--no-commit',
          ...(parents.length > 1 ? ['--mainline', String(mainline)] : []),
          targetCommit,
        ]);
      } catch {
        throw new DomainError(
          'COMPOSITION_CONFLICT',
          'The inverse change conflicts with the captured current tree and requires conventional review',
          422,
        );
      }
      const tree = await git(cwd, ['write-tree']),
        baseTree = await git(cwd, ['rev-parse', `${currentHead}^{tree}`]);
      const message = [
        'klocgit: reviewed inverse candidate',
        '',
        `Reverts-Commit: ${targetCommit}`,
        `Revert-Base: ${currentHead}`,
        ...(parents.length > 1 ? [`Revert-Mainline: ${mainline}`] : []),
        '',
      ].join('\n');
      const commit = await git(cwd, ['commit-tree', tree, '-p', currentHead], message),
        retention_ref = `refs/klocgit/candidates/${commit}`;
      await git(this.dir(repo), ['fetch', '--quiet', cwd, commit]);
      await git(this.dir(repo), ['update-ref', retention_ref, commit]);
      return {
        tree,
        commit,
        baseTree,
        target_commit: targetCommit,
        mainline: parents.length > 1 ? mainline : null,
        retention_ref,
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  /**
   * Read a literal path at the caller's immutable commit. Only an observed missing
   * entry means absence: failed reads must not be mistaken for missing provenance.
   *
   * @param {{id: string}} repo Repository descriptor.
   * @param {string} commit Immutable commit ID to read, rather than a moving ref.
   * @param {string} name Repository-relative literal file path.
   * @returns {Promise<string|null>} Trimmed Git text, or null for an absent entry.
   * @throws {DomainError} The repository identifier is invalid.
   * @throws {Error} Commit lookup or file reading fails, including timeout/buffer limits.
   */
  async file(repo, commit, name) {
    const directory = this.dir(repo);
    const entry = await git(directory, [
      '--literal-pathspecs',
      'ls-tree',
      '--full-tree',
      '-z',
      commit,
      '--',
      name,
    ]);
    if (!entry) return null;
    return git(directory, ['show', `${commit}:${name}`]);
  }
  async validate(repo, commit, constraints, validityHeads = {}) {
    if (repo.validation_profile === 'checkout-effects-v0') {
      const policyRepo = repo.context_repo ?? 'payment-policy';
      const policyCommit = validityHeads[policyRepo];
      const runner = await createApplicationRunner({
        repositoryPath: this.dir(repo),
        policyRepositoryPath: policyCommit ? this.dir({ id: policyRepo }) : null,
        policyCommit,
      });
      return runner.validate(commit);
    }
    if (repo.validation_profile === 'context-document-v0') {
      let value;
      try {
        value = JSON.parse(await this.file(repo, commit, 'checkout-policy.json'));
      } catch {
        return {
          passed: false,
          checks: [
            {
              name: 'Policy document parses',
              passed: false,
              detail: 'The immutable policy is not valid JSON.',
            },
          ],
          limitations: ['No code execution or general correctness claim.'],
        };
      }
      const passed =
        value.maxChargesPerOrder === 1 &&
        value.maxConfirmationsPerOrder === 1 &&
        Array.isArray(value.allowed_values);
      return {
        passed,
        checks: [
          {
            name: 'Versioned exactly-once policy is supported',
            passed,
            detail: 'A supported immutable policy bounds charges and confirmations at one.',
          },
        ],
        limitations: ['Only this versioned policy schema is checked.'],
      };
    }
    return {
      passed: false,
      status: 'validation-unavailable',
      checks: [
        {
          name: 'Trusted validation profile is configured',
          passed: false,
          detail: 'Unknown code remains conventional review; no safe-convergence claim is made.',
        },
      ],
      limitations: ['No trusted profile exists for this repository.'],
    };
  }
  /**
   * Ask Git to update a canonical ref against the reviewed old object ID. Using
   * that captured ID, rather than a fresh head, protects against external writers
   * that are outside the coordinator's serialization boundary.
   *
   * @param {{id: string, canonical_ref: string}} repo Canonical repository descriptor.
   * @param {string} expected Immutable old commit ID supplied by the reviewed decision.
   * @param {string} commit Retained candidate commit selected for application.
   * @returns {Promise<boolean>} True when update-ref completes; false for an explicit Git compare
   *   rejection. Other command failures remain uncertain and throw for recovery.
   */
  async cas(repo, expected, commit) {
    immutableCommit(expected);
    immutableCommit(commit);
    if (
      !/^refs\/heads\/[a-zA-Z0-9._/-]+$/.test(repo.canonical_ref ?? '') ||
      repo.canonical_ref.includes('..')
    )
      throw new DomainError('INVALID_REF', 'A valid canonical branch ref is required');
    try {
      await git(this.dir(repo), ['update-ref', repo.canonical_ref, commit, expected]);
      return true;
    } catch (error) {
      // Only Git's explicit compare rejection proves that this attempt made no
      // write. A later ref value cannot establish historical non-application.
      if (
        typeof error.stderr === 'string' &&
        error.stderr.includes("cannot lock ref '" + repo.canonical_ref + "'") &&
        error.stderr.includes('but expected ' + expected)
      )
        return false;
      throw new DomainError(
        'CANONICAL_WRITE_UNCERTAIN',
        'Git did not acknowledge the canonical write; reconciliation is required',
        503,
      );
    }
  }
  async diff(repo, base, head) {
    return git(this.dir(repo), ['diff', '--no-ext-diff', '--no-textconv', base, head]);
  }
  async externalAdvance(repo) {
    const head = await this.ref(repo, repo.canonical_ref);
    const tree = await git(this.dir(repo), ['rev-parse', `${head}^{tree}`]);
    const commit = await git(this.dir(repo), [
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      'External Git client: canonical update',
    ]);
    await this.cas(repo, head, commit);
    return commit;
  }
}
