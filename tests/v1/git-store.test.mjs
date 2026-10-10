import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { LocalGitStore } from '../../adapters/local/git-store.mjs';
import { gitStoreContract } from '../support/git-store-contract.mjs';

test('existing local Git transport satisfies the provider-independent v1 contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-git-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const repo_id = 'ordinary-git';
  const ref = 'refs/heads/main';
  const repository = { id: repo_id, canonical_ref: ref };
  const directory = adapter.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet']);
  const tree = await git(directory, ['mktree'], '');
  const initialOid = await git(directory, ['commit-tree', tree, '-m', 'initial']);
  const nextOid = await git(directory, ['commit-tree', tree, '-p', initialOid, '-m', 'next']);
  const externalOid = await git(directory, ['commit-tree', tree, '-p', nextOid, '-m', 'external']);
  await git(directory, ['update-ref', ref, initialOid]);
  let provider;
  const workspaceSource = {
    fetch: async (revision) => ({ identity: await provider.snapshot(revision.commit_oid) }),
  };
  provider = new LocalGitStore({ adapter, repository, workspaceSource });
  const store = new GitStore({ repo_id, provider });
  await gitStoreContract({
    store,
    repo_id,
    ref,
    initial: await provider.snapshot(initialOid),
    next: await provider.snapshot(nextOid),
    external: await provider.snapshot(externalOid),
    advance: (oid) => git(directory, ['update-ref', ref, oid]),
  });
});

function fixtureProvider(overrides = {}) {
  const oid = 'a'.repeat(40);
  return {
    observe_ref: async () => oid,
    fetch: async () => ({
      identity: {
        schema_version: 1,
        repo_id: 'repo',
        commit_oid: oid,
        tree_oid: oid,
        parent_oids: [],
      },
    }),
    read_tree: async () => ({ schema_version: 1, tree_oid: oid, entries: [] }),
    compare_and_swap_ref: async () => true,
    ...overrides,
  };
}

test('provider substitution cannot alter the requested exact Git state', async () => {
  const oid = 'a'.repeat(40);
  for (const provider of [
    fixtureProvider({
      read_tree: async () => ({ schema_version: 1, tree_oid: 'b'.repeat(40), entries: [] }),
    }),
    fixtureProvider({
      fetch: async () => ({
        identity: {
          schema_version: 1,
          repo_id: 'other',
          commit_oid: oid,
          tree_oid: oid,
          parent_oids: [],
        },
      }),
    }),
  ]) {
    const store = new GitStore({ repo_id: 'repo', provider });
    if (provider.read_tree !== undefined && (await provider.read_tree()).tree_oid !== oid) {
      await assert.rejects(store.read_tree(oid), { code: 'INTEGRITY_MISMATCH' });
    } else
      await assert.rejects(
        store.fetch({ schema_version: 1, repo_id: 'repo', commit_oid: oid }, {}),
        { code: 'INTEGRITY_MISMATCH' },
      );
  }
});

test('tree validation preserves path order, modes and Git identity', async () => {
  const oid = 'a'.repeat(40);
  const entries = [
    { name: 'z.txt', mode: '100644', kind: 'blob', oid },
    { name: 'a-link', mode: '120000', kind: 'blob', oid },
  ];
  const store = new GitStore({
    repo_id: 'repo',
    provider: fixtureProvider({
      read_tree: async () => ({ schema_version: 1, tree_oid: oid, entries }),
    }),
  });
  assert.deepEqual((await store.read_tree(oid)).entries, entries);
  entries[1].mode = '160000';
  await assert.rejects(store.read_tree(oid), { code: 'INVALID_ARGUMENT' });
});

test('Git CAS always requires a bounded idempotency key and definite provider result', async () => {
  const store = new GitStore({
    repo_id: 'repo',
    provider: fixtureProvider({ compare_and_swap_ref: async () => ({ updated: true }) }),
  });
  await assert.rejects(
    store.compare_and_swap_ref('refs/heads/main', 'a'.repeat(40), 'b'.repeat(40), {}),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    store.compare_and_swap_ref('refs/heads/main', 'a'.repeat(40), 'b'.repeat(40), {
      idempotency_key: 'attempt',
    }),
    { code: 'INVALID_ARGUMENT' },
  );
});
