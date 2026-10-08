import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine, emptyState } from '../core/engine.mjs';
import { LocalGit, git } from '../server/git.mjs';
import { RemoteGit } from '../server/remote-git.mjs';
import { ArtifactsGit } from '../worker/artifacts.mjs';
import { observationRef, pageRefs } from '../core/git-refs.mjs';

const main = 'refs/heads/main';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  await adapter.repositoryCreate({ id: 'app', ref: main, description: '', operation_id: 'fixture' });
  const createCommit = async (id, parent, name, content) => {
    const dir = adapter.dir({ id });
    const blob = await git(dir, ['hash-object', '-w', '--stdin'], content);
    const tree = await git(dir, ['mktree'], '100644 blob ' + blob + '\t' + name + '\n');
    return git(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', content]);
  };
  const base = await createCommit('app', null, 'app.mjs', 'baseline');
  await git(adapter.dir({ id: 'app' }), ['update-ref', main, base]);
  const facts = await adapter.facts({ id: 'app' }, base, base);
  const state = emptyState();
  state.repositories.push({ id: 'app', canonical_ref: main, baseline: base, head: base, tree: facts.tree, provider: 'local-git', remote: adapter.dir({ id: 'app' }) });
  const engine = new Engine(state, adapter);
  const created = await engine.native.createFuture({ repository_ids: ['app'], request_id: 'future' }, 'owner');
  const future = engine.native.future(created.future.id);
  const source = future.repositories[0].repo_id;
  return { root, adapter, engine, native: engine.native, state, future, source, base, createCommit };
}

const observe = (f, refs, request = 'observe') => f.native.observeFuture(f.future.id, {
  expected_version: f.future.version, request_id: request,
  ...(refs ? { repository_refs: refs } : {}),
}, 'owner');

test('bounded ref pages expose branches and tag objects while hiding internal retention refs', async (t) => {
  const f = await fixture(t);
  const repo = { id: f.source }, dir = f.adapter.dir(repo);
  await git(dir, ['update-ref', 'refs/heads/topic', f.base]);
  await git(dir, ['tag', 'light', f.base]);
  await git(dir, ['tag', '-a', 'release', f.base, '-m', 'release rationale']);
  const blob = await git(dir, ['hash-object', '-w', '--stdin'], 'blob tag');
  await git(dir, ['update-ref', 'refs/tags/blob', blob]);
  await git(dir, ['update-ref', 'refs/klocgit/candidates/internal', f.base]);
  const first = await f.native.listRepositoryRefs(f.source, { limit: 2 }, 'owner');
  assert.equal(first.refs.length, 2);
  assert.equal(first.has_more, true);
  const second = await f.native.listRepositoryRefs(f.source, { limit: 2, cursor: first.next_cursor }, 'owner');
  assert.ok(second.refs.every((entry) => entry.ref > first.next_cursor));
  const all = (await f.native.listRepositoryRefs(f.source, {}, 'owner')).refs;
  assert.ok(all.every((entry) => !entry.ref.startsWith('refs/klocgit/')));
  const release = all.find((entry) => entry.ref === 'refs/tags/release');
  assert.equal(release.object_type, 'tag');
  assert.equal(release.commit, f.base);
  assert.notEqual(release.object_id, f.base);
  assert.equal(all.find((entry) => entry.ref === 'refs/tags/blob').available_for_future, false);
  assert.equal((await f.adapter.ref(repo, 'refs/tags/release')), f.base);
  assert.equal((await f.adapter.readRef(repo, 'refs/tags/light')).object_id, f.base);
});

test('explicit retarget pins another branch without changing canonical policy or overwriting history', async (t) => {
  const f = await fixture(t);
  const old = f.native.revision(f.future.current_revision_id), snapshot = structuredClone(old);
  const next = await f.createCommit(f.source, f.base, 'app.mjs', 'topic work');
  await git(f.adapter.dir({ id: f.source }), ['update-ref', 'refs/heads/topic', next]);
  const result = await observe(f, [{ repo_id: f.source, ref: 'refs/heads/topic' }]);
  assert.notEqual(result.revision.id, old.id);
  assert.equal(result.revision.repository_heads[0].commit, next);
  assert.equal(result.revision.repository_heads[0].object_id, next);
  assert.equal(result.revision.repository_heads[0].ref, 'refs/heads/topic');
  assert.equal(result.revision.baseline_refs[0].ref, main);
  assert.equal(f.engine.repo('app').canonical_ref, main);
  assert.equal(await f.adapter.ref({ id: 'app' }, main), f.base);
  assert.deepEqual(old, snapshot);
  const version = f.future.version;
  await assert.rejects(() => f.native.observeFuture(f.future.id, {
    expected_version: version - 1, request_id: 'stale-retarget',
    repository_refs: [{ repo_id: f.source, ref: main }],
  }, 'owner'), { code: 'FUTURE_STALE' });
  assert.equal(f.future.repositories[0].ref, 'refs/heads/topic');
});

test('annotated tag retarget and movement to the same commit create distinct immutable revisions', async (t) => {
  const f = await fixture(t), dir = f.adapter.dir({ id: f.source });
  await git(dir, ['tag', '-a', 'release', f.base, '-m', 'first rationale']);
  const originalTag = (await f.adapter.readRef({ id: f.source }, 'refs/tags/release')).object_id;
  const first = await observe(f, [{ repo_id: f.source, ref: 'refs/tags/release' }]);
  await git(dir, ['tag', '-f', '-a', 'release', f.base, '-m', 'revised rationale']);
  const movedTag = (await f.adapter.readRef({ id: f.source }, 'refs/tags/release')).object_id;
  assert.notEqual(movedTag, originalTag);
  const stale = await f.native.observeRepositoryPush({ repo: f.source, ref: 'refs/tags/release', after: originalTag }, 'ingress');
  assert.equal(stale.reason, 'OUT_OF_ORDER_EVENT');
  const current = await f.native.observeRepositoryPush({ repo: f.source, ref: 'refs/tags/release', before: originalTag, after: movedTag }, 'ingress');
  const revision = f.native.revision(current.revision_id);
  assert.notEqual(revision.id, first.revision.id);
  assert.equal(revision.repository_heads[0].commit, f.base);
  assert.equal(revision.repository_heads[0].object_id, movedTag);
  assert.equal(first.revision.repository_heads[0].object_id, originalTag);
  assert.equal(f.future.baseline_refs[0].ref, main);
});

test('ordinary Git clients can push work branches and tags before choosing a Future ref', async (t) => {
  const f = await fixture(t);
  const client = path.join(f.root, 'client');
  await git(f.root, ['clone', '--quiet', f.adapter.dir({ id: f.source }), client]);
  await git(client, ['checkout', '--quiet', '-b', 'producer/work']);
  await writeFile(path.join(client, 'app.mjs'), 'ordinary producer work');
  await git(client, ['add', 'app.mjs']);
  await git(client, ['commit', '--quiet', '-m', 'work']);
  const head = await git(client, ['rev-parse', 'HEAD']);
  await git(client, ['tag', '-a', 'producer-release', '-m', 'producer tag']);
  await git(client, ['push', '--quiet', 'origin', 'HEAD:refs/heads/producer/work', 'refs/tags/producer-release']);
  const before = f.future.current_revision_id;
  const signal = await f.native.observeRepositoryPush({ repo: f.source, ref: 'refs/heads/producer/work', after: head }, 'ingress');
  assert.equal(signal.reason, 'UNTRACKED_REF');
  assert.equal(f.future.current_revision_id, before);
  assert.equal(f.state.nativeRefObservations.at(-1).facts.commit, head);
  assert.equal(f.state.nativeRefObservations.at(-1).facts.basis, 'observed');
  const result = await observe(f, [{ repo_id: f.source, ref: 'refs/heads/producer/work' }]);
  assert.equal(result.revision.repository_heads[0].commit, head);
  assert.equal(result.revision.provenance_state, 'unknown');
});

test('deleted selected refs revoke eligibility, preserve history and can be retargeted without restoring Git', async (t) => {
  const f = await fixture(t), dir = f.adapter.dir({ id: f.source });
  const old = f.native.revision(f.future.current_revision_id), snapshot = structuredClone(old);
  await git(dir, ['update-ref', 'refs/heads/retained', f.base]);
  await git(dir, ['update-ref', '-d', main]);
  const result = await observe(f, undefined, 'missing');
  assert.equal(result.unavailable, true);
  assert.equal(f.future.status, 'unavailable');
  assert.equal(f.future.current_revision_id, old.id);
  assert.deepEqual(old, snapshot);
  const last = f.state.nativeRefObservations.at(-1);
  assert.equal(last.facts.status, 'missing');
  assert.equal(last.facts.object_id, null);
  assert.equal(last.facts.commit, null);
  const count = f.state.nativeRefObservations.length, version = f.future.version;
  const duplicate = await f.native.observeRepositoryPush({ repo: f.source, ref: main, before: f.base, after: '0'.repeat(40) }, 'ingress');
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.future.version, version);
  assert.equal(f.state.nativeRefObservations.length, count);
  await observe(f, [{ repo_id: f.source, ref: 'refs/heads/retained' }], 'recover-ref');
  assert.equal(f.future.status, 'active');
  assert.equal(f.state.futureRevisions.length, 2);
  await assert.rejects(() => f.adapter.ref({ id: f.source }, main), { code: 'REF_NOT_FOUND' });
});

test('force pushes, rebases and rewinds retain separate revision records even for identical trees', async (t) => {
  const f = await fixture(t), dir = f.adapter.dir({ id: f.source });
  const original = f.future.current_revision_id;
  const a = await f.createCommit(f.source, f.base, 'app.mjs', 'change');
  const tree = await git(dir, ['rev-parse', a + '^{tree}']);
  const rebased = await git(dir, ['commit-tree', tree, '-p', f.base, '-m', 'rebased rationale']);
  assert.equal(await git(dir, ['rev-parse', rebased + '^{tree}']), tree);
  await git(dir, ['update-ref', main, a]);
  const first = await observe(f, undefined, 'change');
  await git(dir, ['update-ref', main, rebased]);
  const second = await observe(f, undefined, 'rebase');
  assert.notEqual(first.revision.id, second.revision.id);
  await git(dir, ['update-ref', main, f.base]);
  const rewind = await observe(f, undefined, 'rewind');
  assert.notEqual(rewind.revision.id, original);
  assert.equal(rewind.revision.previous_revision_id, second.revision.id);
  assert.equal(f.state.futureRevisions.length, 4);
});

test('a ref moving during observation cannot update the Future selection or revision pointer', async (t) => {
  const f = await fixture(t), adapterRead = f.adapter.readRef.bind(f.adapter);
  const next = await f.createCommit(f.source, f.base, 'app.mjs', 'next');
  await git(f.adapter.dir({ id: f.source }), ['update-ref', 'refs/heads/topic', next]);
  const old = f.future.current_revision_id;
  let reads = 0;
  f.adapter.readRef = async (repo, ref) => {
    const value = await adapterRead(repo, ref);
    if (ref === 'refs/heads/topic' && ++reads === 1)
      await git(f.adapter.dir({ id: f.source }), ['update-ref', ref, f.base]);
    return value;
  };
  await assert.rejects(() => observe(f, [{ repo_id: f.source, ref: 'refs/heads/topic' }]), { code: 'FUTURE_CHANGED' });
  assert.equal(f.future.repositories[0].ref, main);
  assert.equal(f.future.current_revision_id, old);
});

test('tag targets which are not commits stay visible and unavailable without manufacturing code state', async (t) => {
  const f = await fixture(t), dir = f.adapter.dir({ id: f.source });
  const blob = await git(dir, ['hash-object', '-w', '--stdin'], 'documentation');
  await git(dir, ['update-ref', 'refs/tags/document', blob]);
  const old = f.future.current_revision_id;
  const result = await observe(f, [{ repo_id: f.source, ref: 'refs/tags/document' }]);
  assert.equal(result.unavailable, true);
  assert.equal(f.future.current_revision_id, old);
  assert.equal(f.state.nativeRefObservations.at(-1).facts.status, 'unsupported');
  assert.equal(f.state.nativeRefObservations.at(-1).facts.commit, null);
  await assert.rejects(() => f.adapter.ref({ id: f.source }, 'refs/tags/document'), { code: 'REF_NOT_COMMIT' });
});

test('invalid ref syntax, unowned repositories and oversized enumeration fail before retarget', async (t) => {
  const f = await fixture(t);
  for (const ref of ['refs/heads/.hidden', 'refs/heads/a..b', 'refs/tags/a.lock', 'refs/heads/a@{b', 'refs/heads/a b', 'refs/klocgit/candidates/one'])
    assert.throws(() => observationRef(ref), { code: 'INVALID_REF' });
  assert.throws(() => pageRefs(Array.from({ length: 1001 }, (_, n) => ({ ref: 'refs/heads/' + n }))), { code: 'REF_BUDGET' });
  await assert.rejects(() => observe(f, [{ repo_id: 'somebody-else', ref: main }]), { code: 'INVALID_NATIVE_INPUT' });
  await assert.rejects(() => f.native.listRepositoryRefs(f.source, { limit: 201 }, 'owner'), { code: 'INVALID_REF_PAGE' });
  await assert.rejects(() => f.native.listRepositoryRefs(f.source, {}, ''), { code: 'UNAUTHENTICATED' });
  assert.equal(f.future.repositories[0].ref, main);
});

test('remote refs are authoritative after deletion even when the executor cache contains a stale branch', async (t) => {
  const f = await fixture(t), cache = path.join(f.root, 'cache');
  const remote = new RemoteGit(cache, {});
  remote.entry = () => ({ remote: f.adapter.dir({ id: f.source }), tokenEnv: 'FIXTURE_TOKEN' });
  remote.remote = async (_id, args) => git(remote.dir({ id: f.source }), args);
  await remote.ensure(f.source);
  assert.equal(await remote.ref({ id: f.source }, main), f.base);
  await git(f.adapter.dir({ id: f.source }), ['update-ref', '-d', main]);
  assert.equal(await git(remote.dir({ id: f.source }), ['rev-parse', main]), f.base);
  await assert.rejects(() => remote.ref({ id: f.source }, main), { code: 'REF_NOT_FOUND' });
  assert.deepEqual((await remote.listRefs({ id: f.source })).refs, []);
});

test('Artifacts branch observation remains native while tag objects and enumeration require the scoped executor', async () => {
  const adapter = new ArtifactsGit({
    ARTIFACTS: { get: async () => ({ log: async () => [{ hash: 'a'.repeat(40) }] }) },
  });
  assert.equal((await adapter.readRef({ id: 'repo' }, main)).object_type, 'commit');
  await assert.rejects(() => adapter.readRef({ id: 'repo' }, 'refs/tags/release'), { code: 'GIT_EXECUTOR_UNAVAILABLE' });
  await assert.rejects(() => adapter.listRefs({ id: 'repo' }), { code: 'GIT_EXECUTOR_UNAVAILABLE' });
});

test('Future context binding is checked before repository effects and copied without accepting producer claims', async (t) => {
  const f = await fixture(t);
  const objective = f.native.objective(f.future.objective_id);
  let calls = 0;
  f.engine.objectiveContext = {
    async bindFuture(value, snapshot) {
      assert.equal(value.id, objective.id);
      calls++;
      assert.equal(snapshot, 'snapshot-one');
      return { context_snapshot: snapshot, context_binding_state: 'bound', context_assumption_refs: ['assumption-one'] };
    },
  };
  const next = await f.native.createFuture({ objective_id: objective.id, context_snapshot_id: 'snapshot-one', context_binding_state: 'trusted', request_id: 'context-future' }, 'owner');
  assert.equal(calls, 1);
  assert.equal(next.future.context_snapshot_id, 'snapshot-one');
  assert.equal(next.revision.context_snapshot_id, 'snapshot-one');
  assert.equal(next.revision.context_binding_state, 'bound');
  assert.deepEqual(next.revision.context_assumption_refs, ['assumption-one']);
});

test('coordinator archive preserves prior source commits and tag objects after producer refs and objects are removed', async (t) => {
  const f = await fixture(t), sourceDir = f.adapter.dir({ id: f.source });
  const next = await f.createCommit(f.source, f.base, 'app.mjs', 'archived work');
  await git(sourceDir, ['update-ref', main, next]);
  await git(sourceDir, ['tag', '-a', 'release', next, '-m', 'archived rationale']);
  const observed = await observe(f, [{ repo_id: f.source, ref: 'refs/tags/release' }], 'archive-tag');
  const tag = observed.revision.repository_heads[0].object_id;
  const receipt = f.state.nativeRetentions.find((entry) => entry.id === observed.revision.retention_ids[0]);
  assert.equal(receipt.status, 'retained');
  assert.equal(receipt.subject.archive_repo_id, 'app');
  assert.deepEqual(receipt.subject.object_ids, [next, tag].sort());
  await git(sourceDir, ['update-ref', main, f.base]);
  await git(sourceDir, ['update-ref', '-d', 'refs/tags/release']);
  await git(sourceDir, ['reflog', 'expire', '--expire=now', '--all']);
  await git(sourceDir, ['gc', '--prune=now']);
  await assert.rejects(() => git(sourceDir, ['cat-file', '-e', next]));
  const archive = f.adapter.dir({ id: 'app' });
  for (const entry of receipt.refs) {
    assert.equal(await git(archive, ['rev-parse', entry.ref]), entry.object_id);
    await git(archive, ['cat-file', '-e', entry.object_id]);
  }
  assert.equal(await f.adapter.ref({ id: 'app' }, main), f.base);
});

test('unavailable archive does not block branch ingestion, and exact revision retention can be retried', async (t) => {
  const f = await fixture(t), retain = f.adapter.retainObservation.bind(f.adapter);
  const next = await f.createCommit(f.source, f.base, 'app.mjs', 'pending archive');
  await git(f.adapter.dir({ id: f.source }), ['update-ref', main, next]);
  f.adapter.retainObservation = async () => { throw Object.assign(new Error('offline'), { code: 'GIT_EXECUTOR_UNAVAILABLE' }); };
  const result = await observe(f, undefined, 'unavailable-archive');
  assert.equal(f.future.status, 'active');
  const old = f.native.revision(result.revision.id), snapshot = structuredClone(old);
  const pending = f.state.nativeRetentions.find((entry) => entry.id === old.retention_ids[0]);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.reason, 'GIT_EXECUTOR_UNAVAILABLE');
  f.adapter.retainObservation = retain;
  const retry = await f.native.retainRevision(old.id, { request_id: 'retry-archive' }, 'owner');
  assert.equal(retry.retentions[0].status, 'retained');
  assert.equal(f.future.repositories[0].retention_state, 'retained');
  assert.deepEqual(old, snapshot);
  assert.deepEqual(await f.native.retainRevision(old.id, { request_id: 'retry-archive' }, 'owner'), retry);
});

test('explicit context rebinding creates a new immutable revision without changing the source code', async (t) => {
  const f = await fixture(t), old = f.native.revision(f.future.current_revision_id), copy = structuredClone(old);
  f.engine.objectiveContext = { async bindFuture(_objective, id) {
    return { context_snapshot: id, context_binding_state: id ? 'bound' : 'unknown', context_assumption_refs: [] };
  } };
  const rebound = await f.native.observeFuture(f.future.id, {
    expected_version: f.future.version, request_id: 'rebind-context', context_snapshot_id: 'snapshot-new',
  }, 'owner');
  assert.notEqual(rebound.revision.id, old.id);
  assert.deepEqual(rebound.revision.repository_heads, old.repository_heads);
  assert.equal(rebound.revision.context_snapshot_id, 'snapshot-new');
  assert.equal(old.context_snapshot_id, null);
  assert.deepEqual(old, copy);
});

test('unresolved context rejects Future creation before dispatching any repository fork', async (t) => {
  const f = await fixture(t), objective = f.native.objective(f.future.objective_id);
  let forks = 0;
  const fork = f.adapter.repositoryFork.bind(f.adapter);
  f.adapter.repositoryFork = async (input) => { forks++; return fork(input); };
  f.engine.objectiveContext = { async bindFuture() {
    throw Object.assign(new Error('One material answer is unresolved'), { code: 'CONTEXT_UNRESOLVED', status: 409 });
  } };
  await assert.rejects(() => f.native.createFuture({
    objective_id: objective.id, context_snapshot_id: 'snapshot-unresolved', request_id: 'unresolved-context',
  }, 'owner'), { code: 'CONTEXT_UNRESOLVED' });
  assert.equal(forks, 0);
  assert.equal(f.state.futures.length, 1);
});
