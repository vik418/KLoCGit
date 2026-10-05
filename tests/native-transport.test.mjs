import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, emptyState } from '../core/engine.mjs';
import { LocalGit, git } from '../server/git.mjs';
import { handleLocalRequest } from '../server/local-api.mjs';
import { handleCoordinatorRequest } from '../worker/routes.mjs';

const ref = 'refs/heads/main';

async function fixture(t, transport) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-native-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = emptyState();
  state.workspace.owner_id = 'owner';
  const adapter = new LocalGit(root);
  const engine = new Engine(state, adapter);
  const env = { ACTOR_ID: 'owner' };
  const call = async (pathname, method = 'GET', input = {}) =>
    engine.serial(async () => {
      const url = new URL(pathname, 'https://klocgit.test');
      if (transport === 'worker') {
        const result = await handleCoordinatorRequest(engine, env, { method, url, input });
        assert.equal(result.ok, true);
        return result.json();
      }
      return handleLocalRequest(
        engine,
        { method, url, input, actor: 'owner' },
        { root, save: engine.save },
      );
    });
  return { root, state, adapter, engine, call, env };
}

async function initializeRepository(f, id = 'app') {
  const created = await f.call('/api/repositories', 'POST', { id, request_id: 'create-' + id });
  assert.equal(created.repository.status, 'empty');
  assert.equal(f.state.repositories.length, 0);
  const work = path.join(f.root, id + '-work');
  await git(f.root, ['clone', '--quiet', created.repository.remote, work]);
  const tree = await git(work, ['mktree'], '');
  const head = await git(work, ['commit-tree', tree, '-m', 'Ordinary Git initialization']);
  await git(work, ['update-ref', ref, head]);
  await git(work, ['push', '--quiet', 'origin', 'main']);
  return { created, work, head, tree };
}

test('mounted local routes accept initial Git work, create an isolated Future and ingest its push without an MR', async (t) => {
  const f = await fixture(t, 'local');
  const repository = await initializeRepository(f);
  const registered = await f.call('/api/events', 'POST', {
    event: { repo: 'app', ref, after: repository.head },
    actor: 'forged-owner',
  });
  assert.equal(registered.handled, true);
  assert.equal(f.engine.repo('app').head, repository.head);
  const created = await f.call('/api/futures', 'POST', {
    repository_ids: ['app'],
    statement: 'Explore a real application change',
    request_id: 'future',
    actor: 'forged-owner',
    provenance_state: 'observed',
  });
  assert.equal(created.future.status, 'active');
  assert.equal(created.future.provenance_state, 'unknown');
  const work = path.join(f.root, 'future-work');
  const fork = created.future.repositories[0];
  await git(f.root, ['clone', '--quiet', fork.remote, work]);
  const blob = await git(work, ['hash-object', '-w', '--stdin'], 'Future implementation\n');
  const tree = await git(work, ['mktree'], '100644 blob ' + blob + '\twork.txt\n');
  const head = await git(work, ['commit-tree', tree, '-p', repository.head, '-m', 'Producer work']);
  await git(work, ['update-ref', ref, head]);
  await git(work, ['push', '--quiet', 'origin', 'main']);
  const observed = await f.call('/api/events', 'POST', {
    event: { repo: fork.repo_id, ref, before: repository.head, after: head },
    metadata: { producer: 'authenticated-owner', provenance_state: 'observed' },
  });
  assert.equal(observed.handled, true);
  const result = await f.call('/api/futures/' + created.future.id);
  assert.equal(result.revisions.at(-1).repository_heads[0].commit, head);
  assert.equal(result.revisions.at(-1).tree_hashes[0].tree, tree);
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.engine.mr.list().length, 0);
  assert.equal(f.state.evidence.length, 0);
  assert.equal(
    f.state.audit
      .filter((entry) => entry.type === 'future.created')
      .every((entry) => entry.actor === 'owner'),
    true,
  );
});

test('mounted Worker push handler handles native forks before compatibility ingestion and ignores an untracked branch', async (t) => {
  const f = await fixture(t, 'worker');
  const repository = await initializeRepository(f);
  delete f.env.ACTOR_ID;
  await f.call('/internal/push', 'POST', { event: { repo: 'app', ref, after: repository.head } });
  assert.equal(
    f.state.audit.some(
      (entry) => entry.type === 'canonical.changed' && entry.actor === 'artifacts-ingress',
    ),
    true,
  );
  await assert.rejects(() => f.call('/api/native-state'), { code: 'UNAUTHENTICATED' });
  f.env.ACTOR_ID = 'owner';
  const created = await f.call('/api/futures', 'POST', {
    repository_ids: ['app'],
    request_id: 'future',
  });
  const fork = created.future.repositories[0];
  const descriptor = { id: fork.repo_id };
  const tree = await git(f.adapter.dir(descriptor), ['mktree'], '');
  const head = await git(f.adapter.dir(descriptor), [
    'commit-tree',
    tree,
    '-p',
    repository.head,
    '-m',
    'Queue-observed producer state',
  ]);
  await git(f.adapter.dir(descriptor), ['update-ref', ref, head]);
  delete f.env.ACTOR_ID;
  const observed = await f.call('/internal/push', 'POST', {
    event: { repo: fork.repo_id, ref, before: repository.head, after: head },
  });
  assert.equal(observed.handled, true);
  const current = f.engine.native.future(created.future.id);
  const revisionId = current.current_revision_id;
  await git(f.adapter.dir(descriptor), ['update-ref', 'refs/heads/experiment', head]);
  const unsupported = await f.call('/internal/push', 'POST', {
    event: { repo: fork.repo_id, ref: 'refs/heads/experiment', after: head },
  });
  assert.equal(unsupported.reason, 'UNTRACKED_REF');
  assert.equal(current.current_revision_id, revisionId);
  assert.equal(f.engine.mr.list().length, 0);
  assert.equal(f.state.proposals.length, 0);
  assert.equal(await git(f.adapter.dir(descriptor), ['rev-parse', 'refs/heads/experiment']), head);
});

test('Engine view observes an external native canonical push with its exact new tree, not a cached previous tree', async (t) => {
  const f = await fixture(t, 'local');
  const repository = await initializeRepository(f);
  await f.call('/api/events', 'POST', { event: { repo: 'app', ref, after: repository.head } });
  const blob = await git(
    repository.work,
    ['hash-object', '-w', '--stdin'],
    'External canonical change\n',
  );
  const tree = await git(repository.work, ['mktree'], '100644 blob ' + blob + '\texternal.txt\n');
  const head = await git(repository.work, [
    'commit-tree',
    tree,
    '-p',
    repository.head,
    '-m',
    'External Git client',
  ]);
  await git(repository.work, ['update-ref', ref, head]);
  await git(repository.work, ['push', '--quiet', 'origin', 'main']);
  const snapshot = await f.call('/api/workspace');
  const observed = snapshot.nativeState.repositories.find((repo) => repo.id === 'app');
  assert.equal(observed.head, head);
  assert.equal(observed.tree, tree);
  assert.notEqual(observed.tree, repository.tree);
  assert.equal(observed.validation_profile, null);
  assert.equal(snapshot.evidence.length, 0);
  assert.equal(await f.adapter.ref(f.engine.repo('app'), ref), head);
});

test('ordinary branch pushes in a native canonical repository still enter the compatibility Git adapter', async (t) => {
  const f = await fixture(t, 'local');
  const repository = await initializeRepository(f);
  await f.call('/api/events', 'POST', { event: { repo: 'app', ref, after: repository.head } });
  const branch = 'refs/heads/ordinary-work';
  const blob = await git(
    repository.work,
    ['hash-object', '-w', '--stdin'],
    'Ordinary branch work\n',
  );
  const tree = await git(repository.work, ['mktree'], '100644 blob ' + blob + '\twork.txt\n');
  const head = await git(repository.work, [
    'commit-tree',
    tree,
    '-p',
    repository.head,
    '-m',
    'Ordinary branch work',
  ]);
  await git(repository.work, ['update-ref', branch, head]);
  await git(repository.work, ['push', '--quiet', 'origin', branch]);
  const ingested = await f.call('/api/events', 'POST', {
    event: { repo: 'app', ref: branch, after: head },
  });
  assert.equal(typeof ingested.revision_id, 'string');
  assert.equal(f.state.proposals.length, 1);
  assert.equal(f.state.revisions[0].head_commit, head);
  assert.equal(f.engine.mr.list().length, 0);
  assert.equal(f.state.futures.length, 0);
  assert.equal(await f.adapter.ref(f.engine.repo('app'), branch), head);
});
