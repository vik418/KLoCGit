import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine, emptyState } from '../core/engine.mjs';
import { DomainError } from '../core/hash.mjs';
import { LocalGit, git } from '../server/git.mjs';
import worker, { WorkspaceCoordinator } from '../worker/index.mjs';

// Artifacts can read valid custom refs as well as heads. Use real bare Git with
// that capability here, without changing the local adapter's branch-only API.
class IngressGit extends LocalGit {
  async ref(repo, ref) {
    await git(this.dir(repo), ['check-ref-format', ref]);
    try {
      return await git(this.dir(repo), ['rev-parse', '--verify', ref]);
    } catch {
      throw new DomainError('REF_NOT_FOUND', 'Git ref is unavailable', 404);
    }
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-candidate-ingress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  await mkdir(work);
  await git(work, ['init', '--quiet', '-b', 'main']);
  await writeFile(path.join(work, 'notes.md'), 'Baseline\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Baseline']);
  const base = await git(work, ['rev-parse', 'HEAD']),
    adapter = await new IngressGit(root).init(),
    repo = { id: 'application', head: base, baseline: base, canonical_ref: 'refs/heads/main' };
  await mkdir(path.dirname(adapter.dir(repo)), { recursive: true });
  await git(root, ['clone', '--quiet', '--bare', work, adapter.dir(repo)]);
  await git(work, ['remote', 'add', 'origin', adapter.dir(repo)]);
  const state = emptyState();
  state.repositories.push(repo);
  let saves = 0;
  const engine = new Engine(state, adapter, async () => {
    saves++;
  });
  async function publish(ref) {
    await writeFile(path.join(work, 'notes.md'), 'Ordinary producer work\n');
    await git(work, ['add', '.']);
    if (await git(work, ['diff', '--cached', '--name-only']))
      await git(work, ['commit', '--quiet', '-m', 'Producer work']);
    const head = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['push', '--quiet', 'origin', `HEAD:${ref}`]);
    return { repo: repo.id, ref, before: base, after: head };
  }
  return { engine, state, adapter, repo, base, publish, saves: () => saves };
}

test('retained composition push, duplicate and deletion events leave Git and coordination metadata intact', async (t) => {
  const f = await fixture(t),
    candidate = await f.adapter.compose(f.repo, f.base, []);
  const before = structuredClone(f.state);
  const ref = `refs/klocgit/candidates/${candidate.commit}`;
  const event = { repo: f.repo.id, ref, after: candidate.commit };
  for (const change of [
    event,
    event,
    { ...event, before: candidate.commit, after: '0'.repeat(40) },
    { ...event, after: f.base },
  ])
    assert.deepEqual(await f.engine.ingest(change), {
      ignored: true,
      reason: 'INTERNAL_CANDIDATE_REF',
    });
  assert.equal(await f.adapter.ref(f.repo, ref), candidate.commit);
  assert.deepEqual(f.state, before);
  assert.equal(f.saves(), 0);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), f.base);
});

test('only the slash-delimited candidate namespace is reserved; ordinary and custom producer refs retain version gates', async (t) => {
  const f = await fixture(t),
    refs = [
      'refs/heads/klocgit/candidates/work',
      'refs/klocgit/candidates-archive/work',
      'refs/klocgit/reviews/work',
      'refs/klocgit/candidates',
      'refs/producer/candidates/work',
    ];
  for (const ref of refs) {
    const event = await f.publish(ref);
    const result = await f.engine.ingest(event);
    assert.ok(result.revision_id);
    const count = f.state.revisions.length;
    assert.equal((await f.engine.ingest(event)).duplicate, true);
    assert.equal(f.state.revisions.length, count);
    assert.equal((await f.engine.ingest({ ...event, after: f.base })).reason, 'OUT_OF_ORDER_EVENT');
    assert.equal(f.state.refVersions[`${f.repo.id}:${ref}`], event.after);
  }
  assert.deepEqual(
    f.state.proposals.map((p) => p.ref),
    refs,
  );
  assert.equal(f.state.revisions.length, refs.length);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), f.base);
});

test('registered canonical tracking takes precedence over reserved candidate ingress exclusion', async (t) => {
  const f = await fixture(t),
    candidate = await f.adapter.compose(f.repo, f.base, []);
  const ref = `refs/klocgit/candidates/${candidate.commit}`;
  f.repo.canonical_ref = ref;
  assert.deepEqual(await f.engine.ingest({ repo: f.repo.id, ref, after: candidate.commit }), {
    canonical: true,
    head: candidate.commit,
  });
  assert.equal(f.repo.head, candidate.commit);
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.state.revisions.length, 0);
  assert.equal(await f.adapter.ref(f.repo, 'refs/heads/main'), f.base);
});

test('native candidate pushes acknowledge without analysis feedback while normal branch pushes still ingest', async (t) => {
  const f = await fixture(t),
    candidate = await f.adapter.compose(f.repo, f.base, []),
    ref = `refs/klocgit/candidates/${candidate.commit}`,
    analysis = [];
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => undefined, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    { ACTOR_ID: 'owner', WORKSPACE_ID: 'klocgit' },
  );
  await coordinator.ready;
  coordinator.engine = f.engine;
  const env = {
    WORKSPACE_ID: 'klocgit',
    ARTIFACTS_NAMESPACE: 'test',
    COORDINATOR: { idFromName: (name) => name, get: () => coordinator },
    ANALYSIS_QUEUE: { send: async (event) => analysis.push(event) },
  };
  let acknowledged = 0,
    retried = 0;
  const message = (event) => ({
    body: {
      type: 'cf.artifacts.repo.pushed',
      source: { namespace: 'test', repoName: event.repo },
      payload: { ref: event.ref, before: event.before, after: event.after },
    },
    ack() {
      acknowledged++;
    },
    retry() {
      retried++;
    },
  });
  const event = { repo: f.repo.id, ref, after: candidate.commit };
  await worker.queue(
    {
      messages: [
        message(event),
        message(event),
        message({ ...event, before: candidate.commit, after: '0'.repeat(40) }),
      ],
    },
    env,
  );
  assert.equal(acknowledged, 3);
  assert.equal(retried, 0);
  assert.equal(analysis.length, 0);
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.state.revisions.length, 0);
  const producer = await f.publish('refs/heads/producer');
  await worker.queue({ messages: [message(producer)] }, env);
  assert.equal(acknowledged, 4);
  assert.equal(retried, 0);
  assert.equal(f.state.proposals.length, 1);
  assert.equal(f.state.proposals[0].ref, producer.ref);
  assert.equal(analysis.length, 1);
  assert.equal(analysis[0].kind, 'analyze');
  assert.equal(analysis[0].trigger.head, producer.after);
  assert.equal(await f.adapter.ref(f.repo, ref), candidate.commit);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), f.base);
});
