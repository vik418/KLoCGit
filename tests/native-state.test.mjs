import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeState, initializeNativeState } from '../core/native-state.mjs';
import { DomainError } from '../core/hash.mjs';
import { LocalGit, git } from '../server/git.mjs';

const A = 'a'.repeat(40),
  B = 'b'.repeat(40),
  C = 'c'.repeat(40);
const T1 = '1'.repeat(40),
  T2 = '2'.repeat(40),
  T3 = '3'.repeat(40);
const ref = 'refs/heads/main';

function fixture() {
  const resources = new Map([
    ['app', { id: 'app', ref, status: 'ready', commit: A, tree: T1, operation_id: null }],
  ]);
  const trees = new Map([
    [A, T1],
    [B, T2],
    [C, T3],
  ]);
  const calls = [];
  const saved = [];
  const state = {
    version: 0,
    repositories: [
      {
        id: 'app',
        name: 'app',
        canonical_ref: ref,
        head: A,
        baseline: A,
        provider: 'test-git',
        remote: '/git/app.git',
        validation_profile: null,
      },
    ],
    audit: [],
    evidence: [],
    proposals: [{ id: 'old-proposal' }],
    revisions: [{ id: 'old-revision' }],
  };
  const descriptor = (resource) => ({
    provider: 'test-git',
    remote: '/git/' + resource.id + '.git',
    ...resource,
  });
  const adapter = {
    async repositoryInfo({ id }) {
      const resource = resources.get(id);
      if (!resource) throw new DomainError('REPO_NOT_FOUND', 'Not found', 404);
      return descriptor(resource);
    },
    async repositoryCreate(input) {
      calls.push({ method: 'create', ...input });
      if (resources.has(input.id)) throw new DomainError('REPO_EXISTS', 'Exists', 409);
      const resource = {
        id: input.id,
        ref: input.ref,
        status: 'empty',
        commit: null,
        tree: null,
        operation_id: input.operation_id,
      };
      resources.set(input.id, resource);
      if (adapter.lostAcknowledgement) throw new Error('Acknowledgement lost');
      return descriptor(resource);
    },
    async repositoryImport(input) {
      calls.push({ method: 'import', ...input });
      const resource = {
        id: input.id,
        ref: input.ref,
        status: 'ready',
        commit: A,
        tree: T1,
        operation_id: input.operation_id,
      };
      resources.set(input.id, resource);
      return descriptor(resource);
    },
    async repositoryFork(input) {
      calls.push({ method: 'fork', ...input });
      const current = resources.get(input.source.repo_id);
      if (current.commit !== input.source.commit)
        throw new DomainError('FORK_BASELINE_CHANGED', 'Source moved', 409);
      const resource = {
        id: input.id,
        ref: input.source.ref,
        status: 'ready',
        commit: current.commit,
        tree: current.tree,
        operation_id: input.operation_id,
      };
      resources.set(input.id, resource);
      if (adapter.forkLostAcknowledgement) throw new Error('Fork acknowledgement lost');
      return descriptor(resource);
    },
    async ref(repo) {
      const resource = resources.get(repo.id);
      if (!resource || !resource.commit) throw new DomainError('REF_NOT_FOUND', 'Ref missing', 404);
      return resource.commit;
    },
    async facts(_repo, head, base) {
      return { head, base, tree: trees.get(head), scope: head === base ? [] : ['app.mjs'] };
    },
  };
  const engine = {
    state,
    git: adapter,
    repo(id) {
      const repo = state.repositories.find((item) => item.id === id);
      if (!repo) throw new DomainError('REPO_NOT_FOUND', 'Not found', 404);
      return repo;
    },
    async audit(type, actor, data) {
      state.audit.push({ type, actor, data: structuredClone(data) });
    },
    async save(value) {
      saved.push(structuredClone(value));
    },
  };
  const native = new NativeState(engine);
  return { native, engine, state, adapter, resources, calls, saved };
}

test('native initialization preserves compatibility history without synthesizing Futures', () => {
  const f = fixture();
  initializeNativeState(f.state);
  assert.deepEqual(f.native.view('owner').futures, []);
  assert.deepEqual(f.state.proposals, [{ id: 'old-proposal' }]);
  assert.deepEqual(f.state.revisions, [{ id: 'old-revision' }]);
});

test('empty repositories are durable and idempotent, but cannot become null-headed canonical state', async () => {
  const f = fixture();
  const input = { id: 'empty', request_id: 'create-empty' };
  const result = await f.native.registerRepository(input, 'owner');
  assert.equal(result.repository.status, 'empty');
  assert.equal(result.repository.head, null);
  assert.equal(
    f.state.repositories.some((repo) => repo.id === 'empty'),
    false,
  );
  assert.deepEqual(await f.native.registerRepository(input, 'owner'), result);
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => f.native.registerRepository({ ...input, id: 'other' }, 'owner'), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(
    () => f.native.createFuture({ repository_ids: ['empty'], request_id: 'empty-future' }, 'owner'),
    { code: 'REPOSITORY_NOT_READY' },
  );
  assert.equal(f.state.futures.length, 0);
  assert.equal(f.state.evidence.length, 0);
  const prepared = f.saved.find((snapshot) => snapshot.nativeRequests[0]?.effects.length);
  assert.equal(
    prepared.nativeRequests[0].effects[0].status,
    'prepared',
    'Intent is persisted before the provider is called',
  );
});

test('initial Git push activates an empty repository without trusting an event-supplied head', async () => {
  const f = fixture();
  await f.native.registerRepository({ id: 'new', request_id: 'new-repo' }, 'owner');
  Object.assign(f.resources.get('new'), { status: 'ready', commit: B, tree: T2 });
  const stale = await f.native.observeRepositoryPush({ repo: 'new', ref, after: A }, 'ingress');
  assert.equal(stale.reason, 'OUT_OF_ORDER_EVENT');
  assert.equal(
    f.state.repositories.some((repo) => repo.id === 'new'),
    false,
  );
  const current = await f.native.observeRepositoryPush({ repo: 'new', ref, after: B }, 'ingress');
  assert.equal(current.canonical, true);
  assert.equal(f.engine.repo('new').head, B);
  assert.equal(f.engine.repo('new').validation_profile, null);
  assert.equal(f.state.evidence.length, 0);
});

test('direct Future creation needs no Objective form or MR and retains unknown producer provenance', async () => {
  const f = fixture();
  const result = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'direct-future' },
    'owner',
  );
  assert.equal(result.future.status, 'active');
  assert.equal(result.future.provenance_state, 'unknown');
  assert.equal(result.revision.provenance_state, 'unknown');
  assert.equal(result.revision.context_snapshot, null);
  assert.equal(f.state.objectives[0].statement, null);
  assert.equal(f.state.objectives[0].source.basis, 'unknown');
  assert.deepEqual(result.future.baseline_refs, [{ repo_id: 'app', ref, commit: A, tree: T1 }]);
  assert.equal(f.state.proposals.length, 1);
  assert.equal(f.state.evidence.length, 0);
  assert.equal(f.calls[0].source.commit, A);
  assert.equal(f.calls[0].source.tree, T1);
  assert.equal(
    f.state.nativeEvents.some(
      (event) => event.type === 'io.klocgit.future.created' && event.specversion === '1.0',
    ),
    true,
  );
  assert.deepEqual(
    await f.native.createFuture({ repository_ids: ['app'], request_id: 'direct-future' }, 'owner'),
    result,
  );
  assert.equal(f.calls.length, 1);
});

test('A to B to A records separate immutable revisions while duplicates and stale pushes do not advance latest', async () => {
  const f = fixture();
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  const future = f.native.future(created.future.id);
  const source = f.resources.get(future.repositories[0].repo_id);
  const original = f.native.revision(future.current_revision_id);
  const history = structuredClone(original);
  Object.assign(source, { commit: B, tree: T2 });
  const changed = await f.native.observeRepositoryPush(
    { repo: source.id, ref, before: A, after: B },
    'ingress',
  );
  assert.notEqual(changed.revision_id, original.id);
  const duplicate = await f.native.observeRepositoryPush(
    { repo: source.id, ref, before: A, after: B },
    'ingress',
  );
  assert.equal(duplicate.duplicate, true);
  const stale = await f.native.observeRepositoryPush(
    { repo: source.id, ref, before: B, after: A },
    'ingress',
  );
  assert.equal(stale.reason, 'OUT_OF_ORDER_EVENT');
  assert.equal(future.current_revision_id, changed.revision_id);
  Object.assign(source, { commit: A, tree: T1 });
  const rewind = await f.native.observeRepositoryPush(
    { repo: source.id, ref, before: B, after: A },
    'ingress',
  );
  assert.notEqual(rewind.revision_id, original.id);
  assert.notEqual(rewind.revision_id, changed.revision_id);
  assert.deepEqual(original, history);
  assert.equal(Object.isFrozen(original.repository_heads), true);
  assert.equal(f.state.futureRevisions.length, 3);
});

test('manual observation compares mutable Future version before touching Git or advancing its pointer', async () => {
  const f = fixture();
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  const future = f.native.future(created.future.id);
  Object.assign(f.resources.get(future.repositories[0].repo_id), { commit: B, tree: T2 });
  await assert.rejects(
    () =>
      f.native.observeFuture(
        future.id,
        { expected_version: future.version - 1, request_id: 'stale-observation' },
        'owner',
      ),
    { code: 'FUTURE_STALE' },
  );
  assert.equal(future.current_revision_id, created.revision.id);
  await f.native.observeFuture(
    future.id,
    { expected_version: future.version, request_id: 'current-observation' },
    'owner',
  );
  assert.notEqual(future.current_revision_id, created.revision.id);
});

test('moving canonical baseline is rejected before any fork effect', async () => {
  const f = fixture();
  let reads = 0;
  const original = f.adapter.ref;
  f.adapter.ref = async (repo) => (repo.id === 'app' && ++reads > 1 ? B : original(repo));
  await assert.rejects(
    () => f.native.createFuture({ repository_ids: ['app'], request_id: 'raced' }, 'owner'),
    { code: 'CANONICAL_CHANGED' },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.futures.length, 0);
});

test('lost create acknowledgement never blindly retries and recovery verifies provider-owned operation identity', async () => {
  const f = fixture();
  f.adapter.lostAcknowledgement = true;
  const input = { id: 'uncertain', request_id: 'lost-create' };
  await assert.rejects(() => f.native.registerRepository(input, 'owner'), {
    code: 'RECOVERY_REQUIRED',
  });
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => f.native.registerRepository(input, 'owner'), {
    code: 'RECOVERY_REQUIRED',
  });
  assert.equal(f.calls.length, 1);
  const request = f.state.nativeRequests[0];
  const originalOwner = f.resources.get('uncertain').operation_id;
  f.resources.get('uncertain').operation_id = 'unrelated-operation';
  await assert.rejects(
    () => f.native.recoverRequest(request.id, { request_id: 'wrong-owner-recovery' }, 'owner'),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(
    f.native.view('owner').repositories.some((repo) => repo.id === 'uncertain'),
    false,
  );
  f.resources.get('uncertain').operation_id = originalOwner;
  const recovered = await f.native.recoverRequest(
    request.id,
    { request_id: 'owned-recovery' },
    'owner',
  );
  assert.equal(recovered.repository.status, 'empty');
  assert.equal(f.calls.length, 1);
  assert.equal(request.status, 'applied');
});

test('failed import cannot be reconciled as a successful empty repository creation', async () => {
  const f = fixture();
  f.adapter.repositoryImport = async (input) => {
    f.resources.set(input.id, {
      id: input.id,
      ref: input.ref,
      status: 'empty',
      commit: null,
      tree: null,
      operation_id: input.operation_id,
    });
    throw new Error('Import failed');
  };
  await assert.rejects(
    () =>
      f.native.registerRepository(
        {
          id: 'imported',
          mode: 'import',
          source: { url: 'https://github.com/example/project.git' },
          request_id: 'import-failure',
        },
        'owner',
      ),
    { code: 'RECOVERY_REQUIRED' },
  );
  const request = f.state.nativeRequests[0];
  await assert.rejects(
    () => f.native.recoverRequest(request.id, { request_id: 'inspect-import' }, 'owner'),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(request.status, 'recovery_required');
  assert.equal(
    f.state.repositories.some((repo) => repo.id === 'imported'),
    false,
  );
});

test('credentials and producer trust labels cannot enter durable import or Future provenance', async () => {
  const f = fixture();
  for (const source of [
    { url: 'https://token@github.com/example/project.git' },
    { url: 'https://github.com/example/project.git', token: 'private' },
    { url: 'https://github.com/example/project.git?token=private' },
    { url: 'http://127.0.0.1/repo' },
  ])
    await assert.rejects(() =>
      f.native.registerRepository(
        { id: 'bad', mode: 'import', source, request_id: 'bad-import' },
        'owner',
      ),
    );
  assert.equal(f.state.nativeRequests.length, 0);
  await assert.rejects(
    () => f.native.createFuture({ repository_ids: ['app'], request_id: 'unauthenticated' }, ''),
    { code: 'UNAUTHENTICATED' },
  );
  assert.equal(f.calls.length, 0);
  const result = await f.native.createFuture(
    {
      repository_ids: ['app'],
      producer: { kind: 'human' },
      provenance_state: 'observed',
      request_id: 'declaration',
    },
    'owner',
  );
  assert.equal(result.future.provenance_state, 'declared');
  assert.equal(result.revision.provenance_state, 'declared');
});

test('importing a selected non-main branch uses that exact target ref and stays without trusted evidence', async () => {
  const f = fixture();
  const result = await f.native.registerRepository(
    {
      id: 'imported',
      mode: 'import',
      source: { url: 'https://github.com/example/project.git', branch: 'release' },
      request_id: 'import-release',
    },
    'owner',
  );
  assert.equal(result.repository.canonical_ref, 'refs/heads/release');
  assert.equal(f.calls[0].ref, 'refs/heads/release');
  assert.equal(f.engine.repo('imported').validation_profile, null);
  assert.equal(f.state.evidence.length, 0);
});

test('abandonment preserves ordinary Git and historical observations', async () => {
  const f = fixture();
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  const future = f.native.future(created.future.id);
  await f.native.abandonFuture(
    future.id,
    { expected_version: future.version, request_id: 'abandon' },
    'owner',
  );
  assert.equal(future.status, 'abandoned');
  assert.equal(f.resources.has(future.repositories[0].repo_id), true);
  assert.equal(f.state.futureRevisions.length, 1);
  assert.equal(f.state.nativeEvents.at(-1).type, 'io.klocgit.future.abandoned');
});

test('real Git can initialize a native repository, fork it, push work and rewind without an MR', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const state = { version: 0, repositories: [], audit: [] };
  const engine = {
    state,
    git: adapter,
    async save() {},
    async audit(type, actor, data) {
      state.audit.push({ type, actor, data });
    },
    repo(id) {
      return state.repositories.find((repo) => repo.id === id);
    },
  };
  const native = new NativeState(engine);
  const empty = await native.registerRepository(
    { id: 'ordinary', request_id: 'ordinary' },
    'owner',
  );
  assert.equal(empty.repository.status, 'empty');
  const work = path.join(root, 'work');
  await mkdir(work);
  await git(root, ['clone', '--quiet', empty.repository.remote, work]);
  const treeA = await git(work, ['mktree'], '');
  const commitA = await git(work, ['commit-tree', treeA, '-m', 'Initial ordinary Git state']);
  await git(work, ['update-ref', ref, commitA]);
  await git(work, ['push', '--quiet', 'origin', 'main']);
  await native.observeRepositoryPush({ repo: 'ordinary', ref, after: commitA }, 'git-ingress');
  const created = await native.createFuture(
    {
      repository_ids: ['ordinary'],
      statement: 'Explore ordinary concurrent work',
      request_id: 'fork',
    },
    'owner',
  );
  const future = native.future(created.future.id);
  assert.equal(future.status, 'active');
  const forkWork = path.join(root, 'fork-work');
  await git(root, ['clone', '--quiet', future.repositories[0].remote, forkWork]);
  const blob = await git(forkWork, ['hash-object', '-w', '--stdin'], 'Real concurrent work\n');
  const treeB = await git(forkWork, ['mktree'], '100644 blob ' + blob + '\tchange.txt\n');
  const commitB = await git(forkWork, ['commit-tree', treeB, '-p', commitA, '-m', 'Future work']);
  await git(forkWork, ['update-ref', ref, commitB]);
  await git(forkWork, ['push', '--quiet', 'origin', 'main']);
  await native.observeRepositoryPush(
    { repo: future.repositories[0].repo_id, ref, before: commitA, after: commitB },
    'git-ingress',
  );
  assert.equal(native.revision(future.current_revision_id).repository_heads[0].commit, commitB);
  await git(forkWork, ['update-ref', ref, commitA]);
  await git(forkWork, ['push', '--quiet', '--force', 'origin', 'main']);
  await native.observeRepositoryPush(
    { repo: future.repositories[0].repo_id, ref, before: commitB, after: commitA },
    'git-ingress',
  );
  assert.notEqual(future.current_revision_id, created.revision.id);
  assert.equal(state.futureRevisions.length, 3);
  assert.equal(await adapter.ref(engine.repo('ordinary'), ref), commitA);
  assert.deepEqual(
    state.audit.filter((entry) => entry.type === 'future.revised').map((entry) => entry.actor),
    ['owner', 'git-ingress', 'git-ingress'],
  );
});

test('long canonical names receive unique isolated repositories within the same Future', async () => {
  const f = fixture();
  const prefix = 'a'.repeat(70);
  const ids = [prefix + 'one', prefix + 'two'];
  for (const id of ids) {
    f.resources.set(id, { id, ref, status: 'ready', commit: A, tree: T1, operation_id: null });
    f.state.repositories.push({
      id,
      canonical_ref: ref,
      head: A,
      baseline: A,
      provider: 'test-git',
      remote: '/git/' + id + '.git',
    });
  }
  const created = await f.native.createFuture(
    { repository_ids: ids, request_id: 'long-repos' },
    'owner',
  );
  const names = created.future.repositories.map((repo) => repo.repo_id);
  assert.equal(new Set(names).size, 2);
  assert.equal(
    names.every((name) => name.length <= 100),
    true,
  );
  assert.deepEqual(
    created.revision.repository_heads.map((entry) => entry.repo_id),
    ids,
  );
});

test('canonical/deletion replay is a no-op and same-head ref restoration preserves historical revisions', async () => {
  const f = fixture();
  f.native.registerObserved(await f.adapter.repositoryInfo({ id: 'app', ref }), 'app', ref);
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  await f.native.observeRepositoryPush({ repo: 'app', ref, after: A }, 'ingress');
  const auditCount = f.state.audit.length;
  await f.native.observeRepositoryPush({ repo: 'app', ref, after: A }, 'ingress');
  assert.equal(f.state.audit.length, auditCount);
  const future = f.native.future(created.future.id);
  const resource = f.resources.get(future.repositories[0].repo_id);
  resource.commit = null;
  const deletion = { repo: resource.id, ref, before: A, after: '0'.repeat(40) };
  await f.native.observeRepositoryPush(deletion, 'ingress');
  const version = future.version,
    afterDeleteAudit = f.state.audit.length;
  await f.native.observeRepositoryPush(deletion, 'ingress');
  assert.equal(future.version, version);
  assert.equal(f.state.audit.length, afterDeleteAudit);
  Object.assign(resource, { status: 'ready', commit: A, tree: T1 });
  await f.native.observeRepositoryPush(
    { repo: resource.id, ref, before: '0'.repeat(40), after: A },
    'ingress',
  );
  assert.equal(future.status, 'active');
  assert.equal(future.current_revision_id, created.revision.id);
  assert.equal(f.state.futureRevisions.length, 1);
});

test('abandoned work cannot be resurrected by deletion or recovery of its creation acknowledgement', async () => {
  const f = fixture();
  f.adapter.forkLostAcknowledgement = true;
  await assert.rejects(
    () => f.native.createFuture({ repository_ids: ['app'], request_id: 'lost-fork' }, 'owner'),
    { code: 'RECOVERY_REQUIRED' },
  );
  const future = f.state.futures[0];
  const request = f.state.nativeRequests.find((item) => item.operation === 'future.create');
  await f.native.abandonFuture(
    future.id,
    { expected_version: future.version, request_id: 'abandon-lost-fork' },
    'owner',
  );
  const recovered = await f.native.recoverRequest(
    request.id,
    { request_id: 'reconcile-abandoned' },
    'owner',
  );
  assert.equal(recovered.future.status, 'abandoned');
  assert.equal(recovered.revision, null);
  const resource = f.resources.get(future.repositories[0].repo_id);
  resource.commit = null;
  await f.native.observeRepositoryPush(
    { repo: resource.id, ref, after: '0'.repeat(40) },
    'ingress',
  );
  assert.equal(future.status, 'abandoned');
});

test('asynchronous forks expose no invented remote or revision and observation can retry without repeating creation', async () => {
  const f = fixture();
  const fork = f.adapter.repositoryFork;
  f.adapter.repositoryFork = async (input) => {
    await fork(input);
    return {
      id: input.id,
      ref: input.source.ref,
      provider: 'test-git',
      remote: null,
      status: 'forking',
      commit: null,
      tree: null,
      operation_id: input.operation_id,
    };
  };
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'async' },
    'owner',
  );
  assert.equal(created.future.status, 'preparing');
  assert.equal(created.future.repositories[0].remote, null);
  assert.equal(created.revision, null);
  const future = f.native.future(created.future.id);
  const resource = f.resources.get(future.repositories[0].repo_id);
  const ready = { ...resource };
  Object.assign(resource, { status: 'forking', commit: null, tree: null });
  const info = f.adapter.repositoryInfo;
  f.adapter.repositoryInfo = async (input) => {
    const result = await info(input);
    if (result.status === 'forking') result.remote = null;
    return result;
  };
  const input = { expected_version: future.version, request_id: 'observe-async' };
  await assert.rejects(() => f.native.observeFuture(future.id, input, 'owner'), {
    code: 'FUTURE_NOT_READY',
  });
  Object.assign(resource, ready);
  const observed = await f.native.observeFuture(future.id, input, 'owner');
  assert.equal(observed.future.status, 'active');
  assert.equal(observed.revision.repository_heads[0].commit, A);
  assert.equal(f.calls.filter((call) => call.method === 'fork').length, 1);
});

test('prepared observation after a metadata-process crash can resume without another repository effect', async () => {
  const f = fixture();
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  const future = f.native.future(created.future.id);
  const input = { expected_version: future.version, request_id: 'observation-crash' };
  const save = f.engine.save;
  let crashed = false;
  f.engine.save = async (value) => {
    if (!crashed && value.nativeRequests.at(-1)?.operation === 'future.observe') {
      crashed = true;
      throw new Error('Metadata process crashed after preparing observation');
    }
    return save(value);
  };
  await assert.rejects(() => f.native.observeFuture(future.id, input, 'owner'));
  const prepared = f.state.nativeRequests.at(-1);
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.effects, []);
  f.engine.save = save;
  Object.assign(f.resources.get(future.repositories[0].repo_id), { commit: B, tree: T2 });
  const resumed = await f.native.observeFuture(future.id, input, 'owner');
  assert.equal(resumed.revision.repository_heads[0].commit, B);
  assert.equal(prepared.status, 'applied');
  assert.equal(f.calls.filter((call) => call.method === 'fork').length, 1);
});

test('a reloaded client can reconcile an interrupted observation by journal ID without issuing any Git effect', async () => {
  const f = fixture();
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  const future = f.native.future(created.future.id);
  const save = f.engine.save;
  f.engine.save = async (value) => {
    if (value.nativeRequests.at(-1)?.operation === 'future.observe')
      throw new Error('Process interrupted');
    return save(value);
  };
  await assert.rejects(() =>
    f.native.observeFuture(
      future.id,
      { expected_version: future.version, request_id: 'lost-client-key' },
      'owner',
    ),
  );
  const original = f.state.nativeRequests.at(-1);
  f.engine.save = save;
  const recovered = await f.native.recoverRequest(
    original.id,
    { request_id: 'new-client-recovery-key' },
    'owner',
  );
  assert.equal(recovered.outcome, 'no_repository_effect');
  assert.equal(original.status, 'failed');
  assert.equal(f.native.view('owner').attention.kind, 'nothing');
  assert.equal(f.calls.filter((call) => call.method === 'fork').length, 1);
  assert.equal(future.current_revision_id, created.revision.id);
});

test('native ownership never steals ordinary canonical-repository branches from the Git compatibility adapter', async () => {
  const f = fixture();
  const branch = { repo: 'app', ref: 'refs/heads/work', after: B };
  assert.deepEqual(await f.native.observeRepositoryPush(branch, 'ingress'), { handled: false });
  const initial = f.resources.get('app');
  f.state.nativeRepositories.push({
    id: 'app',
    canonical_ref: ref,
    head: A,
    tree: T1,
    status: 'ready',
    remote: '/git/app.git',
    provider: 'test-git',
    baseline: A,
    version: 1,
  });
  assert.deepEqual(await f.native.observeRepositoryPush(branch, 'ingress'), { handled: false });
  assert.equal(initial.commit, A);
  assert.equal(f.state.futureRevisions.length, 0);
});

test('authoritative canonical reconciliation restores a stale native availability projection without rewriting the last head', async () => {
  const f = fixture();
  f.native.registerObserved(await f.adapter.repositoryInfo({ id: 'app', ref }), 'app', ref);
  f.resources.get('app').commit = null;
  await f.native.observeRepositoryPush(
    { repo: 'app', ref, before: A, after: '0'.repeat(40) },
    'ingress',
  );
  assert.equal(f.native.getRepository('app').status, 'unavailable');
  assert.equal(f.engine.repo('app').head, A);
  Object.assign(f.engine.repo('app'), { unavailable: false, head: B, tree: T2 });
  const observed = f.native.getRepository('app');
  assert.equal(observed.status, 'ready');
  assert.equal(observed.head, B);
  assert.equal(observed.tree, T2);
});

test('untracked native ref signals cannot persist arbitrary objects as Git versions', async () => {
  const f = fixture();
  const created = await f.native.createFuture(
    { repository_ids: ['app'], request_id: 'future' },
    'owner',
  );
  const repo = created.future.repositories[0].repo_id;
  const before = f.state.nativeEvents.length;
  await assert.rejects(
    () =>
      f.native.observeRepositoryPush(
        {
          repo,
          ref: 'refs/tags/experiment',
          after: { producer_claim: 'not-a-Git-version' },
        },
        'ingress',
      ),
    { code: 'INVALID_EVENT' },
  );
  assert.equal(f.state.nativeEvents.length, before);
  assert.equal(f.state.futureRevisions.length, 1);
});
