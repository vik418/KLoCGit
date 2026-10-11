import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../../server/git.mjs';
import { LocalWorkspaceSource } from '../../../adapters/local/workspace-source.mjs';
import { LocalMaterializer } from '../../../adapters/local/materializer.mjs';
import { FutureRevision, SystemRevision } from '../../../core/v1/domain.mjs';
import { objectId } from '../../../core/v1/conventions.mjs';
import { digestCanonical } from '../../../core/v1/encoding.mjs';
import { buildCandidateSpec, wholeFutureSelection } from '../../../core/v1/reduction.mjs';

export const limits = Object.freeze({
  max_objects: 1000,
  max_bytes: 8 * 1024 * 1024,
  max_files: 1000,
  max_history_commits: 100,
  timeout_ms: 30000,
  max_candidates: 16,
});

export async function compositionFixture(t, initial, format = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const sources = new Map(),
    repositories = new Map();
  async function repository(id, clone) {
    const record = { id, canonical_ref: 'refs/heads/main' };
    const directory = adapter.dir(record);
    if (clone)
      await git(root, [
        'clone',
        '--bare',
        '--quiet',
        adapter.dir(repositories.get(clone)),
        directory,
      ]);
    else {
      await mkdir(directory, { recursive: true });
      await git(directory, ['init', '--bare', '--quiet', '--object-format=' + format]);
    }
    repositories.set(id, record);
    sources.set(id, new LocalWorkspaceSource({ adapter, repository: record }));
    return directory;
  }
  async function commit(repoId, files, parent = null) {
    const directory = adapter.dir(repositories.get(repoId));
    const entries = [];
    for (const [path, value] of Object.entries(files)) {
      const file = typeof value === 'string' ? { contents: value } : value;
      const oid = await git(directory, ['hash-object', '-w', '--stdin'], file.contents);
      entries.push({ path, oid, mode: file.mode ?? '100644' });
    }
    async function tree(prefix) {
      const direct = entries.filter((entry) => entry.path.startsWith(prefix));
      const names = [
        ...new Set(direct.map((entry) => entry.path.slice(prefix.length).split('/')[0])),
      ];
      const lines = [];
      for (const name of names) {
        const entry = direct.find((item) => item.path === prefix + name);
        lines.push(
          entry
            ? `${entry.mode} blob ${entry.oid}\t${name}`
            : `040000 tree ${await tree(prefix + name + '/')}\t${name}`,
        );
      }
      return git(directory, ['mktree', '-z'], lines.join('\0') + (lines.length ? '\0' : ''));
    }
    const tree_oid = await tree('');
    const commit_oid = await git(directory, [
      'commit-tree',
      tree_oid,
      ...(parent ? ['-p', parent] : []),
      '-m',
      'fixture',
    ]);
    await git(directory, ['update-ref', 'refs/heads/main', commit_oid]);
    return {
      schema_version: 1,
      repo_id: repoId,
      commit_oid,
      tree_oid,
      parent_oids: parent ? [parent] : [],
    };
  }
  await repository('canonical');
  const baseline = await commit('canonical', initial);
  const baseBody = {
    schema_version: 1,
    repositories: { canonical: baseline.commit_oid },
    configuration_digests: {},
    accepted_decisions: [],
  };
  const digest = await digestCanonical('object-system-revision', baseBody);
  const base_revision = SystemRevision({
    ...baseBody,
    id: objectId('system-revision', digest),
    digest,
  });
  const context = {
    schema_version: 1,
    base_revision,
    revisions: [],
    bindings: {},
    commit_identity: {
      schema_version: 1,
      name: 'Test author',
      email: 'author@example.test',
      timestamp: 100,
    },
  };
  async function future(repoId, files) {
    await repository(repoId, 'canonical');
    const snapshot = await commit(repoId, files, baseline.commit_oid);
    const futureBody = {
      ...snapshot,
      system_id: 'group',
      ref: 'refs/heads/main',
      producer: null,
      observed_at: '2026-10-11T00:00:00Z',
    };
    const revision = FutureRevision({
      ...futureBody,
      id: objectId('future-revision', await digestCanonical('object-future-revision', futureBody)),
    });
    context.revisions.push(revision);
    context.bindings[revision.id] = {
      schema_version: 1,
      repo_id: 'canonical',
      base_commit_oid: baseline.commit_oid,
      base_tree_oid: baseline.tree_oid,
    };
    return revision;
  }
  async function spec(
    selections = context.revisions.map((revision) =>
      wholeFutureSelection(revision, context.bindings[revision.id]),
    ),
    overrides = {},
  ) {
    return buildCandidateSpec({
      schema_version: 1,
      base_revision: context.base_revision.id,
      selected_future_revisions: context.revisions.map(({ id }) => id),
      selections,
      required_dependencies: [],
      effect_summary_digest: await digestCanonical('effect-summary', []),
      creation_reason: 'Selected work',
      ...overrides,
    });
  }
  const materializer = new LocalMaterializer({
    root: join(root, 'executor'),
    limits,
    resolveSource: (repoId) => {
      assert.ok(sources.has(repoId));
      return sources.get(repoId);
    },
  });
  t.after(() => materializer.close());
  const sourceState = () =>
    Promise.all(
      [...repositories.values()].map(async (record) => ({
        id: record.id,
        refs: await git(adapter.dir(record), ['show-ref']),
        objects: await git(adapter.dir(record), ['count-objects', '-v']),
      })),
    );
  return {
    root,
    adapter,
    sources,
    repositories,
    repository,
    commit,
    future,
    spec,
    context,
    baseline,
    materializer,
    sourceState,
  };
}
