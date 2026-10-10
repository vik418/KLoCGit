import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { LocalGitStore } from '../../adapters/local/git-store.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { FutureIngestor } from '../../core/v1/ingestion.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { EventConsumer } from '../../core/v1/consumer.mjs';
import { createEvent } from '../../core/v1/events.mjs';

const limits = { max_event_bytes: 2048, inline_payload_bytes: 512, max_claim_bytes: 8192 };
const principal = { id: 'authenticated-producer', tenant_id: 'tenant' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-ingestion-'));
  const adapter = new LocalGit(directory);
  const repository = { id: 'repository', canonical_ref: 'refs/heads/main' };
  const gitDirectory = adapter.dir(repository);
  await mkdir(gitDirectory, { recursive: true });
  await git(gitDirectory, ['init', '--bare', '--quiet']);
  const tree = await git(gitDirectory, ['mktree'], '');
  const create = (message, parents = []) =>
    git(gitDirectory, [
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      message,
    ]);
  const initial = await create('initial');
  await git(gitDirectory, ['update-ref', repository.canonical_ref, initial]);
  let provider;
  provider = new LocalGitStore({
    adapter,
    repository,
    workspaceSource: {
      fetch: async (revision) => ({ identity: await provider.snapshot(revision.commit_oid) }),
    },
  });
  const gitStore = new GitStore({ repo_id: repository.id, provider });
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'REF',
    resource_id: { repo_id: repository.id, ref: repository.canonical_ref },
  };
  const filename = join(directory, 'state.sqlite');
  const backends = [];
  const open = () => {
    const backend = new SqliteCoordinationBackend({ filename, busy_timeout_ms: 1000 });
    backends.push(backend);
    return new CoordinationStore(backend);
  };
  let store = open();
  let authorization = true;
  const ingestor = new FutureIngestor({
    scope,
    gitStore,
    authorize: ({ principal: actor }) => authorization && actor.tenant_id === scope.tenant_id,
    clock: () => new Date().toISOString(),
    observationFilter: { paths: [] },
  });
  const consumer = () =>
    new EventConsumer({
      store,
      limits,
      max_attempts: 3,
      authorize: ingestor.authorize,
      resolveScope: ingestor.resolveScope,
      handler: ingestor.observe,
      reconcile: ingestor.observe,
      executor: {
        idempotent: true,
        execute: async () => {
          assert.fail('ingestion must not mutate Git');
        },
      },
      deadLetters: {
        send: async () => {
          assert.fail('valid observations must not reach DLQ');
        },
      },
    });
  const event = async (version, payload = {}, metadata = {}) =>
    createEvent(
      {
        schema_version: 1,
        type: 'git.ref-observed',
        tenant_id: scope.tenant_id,
        system_id: scope.system_id,
        objective_id: null,
        subject_id: repository.id,
        subject_version: version,
        occurred_at: new Date().toISOString(),
        trace_id: 'trace-' + version,
        ...metadata,
      },
      {
        schema_version: 1,
        repo_id: repository.id,
        ref: repository.canonical_ref,
        producer: null,
        ...payload,
      },
      limits,
    );
  const consume = (event, actor = principal) =>
    consumer().consume(event, { principal: actor, attempt: 1 });
  const latest = () =>
    store.transaction(scope, async (tx) => {
      const observed = await tx.get('observed-ref');
      return observed ? tx.get('future-revision:' + observed.revision_id) : null;
    });
  t.after(async () => {
    for (const backend of backends) backend.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    scope,
    gitStore,
    create,
    initial,
    event,
    consume,
    latest,
    advance: (oid) => git(gitDirectory, ['update-ref', repository.canonical_ref, oid]),
    get: (key) => store.transaction(scope, (tx) => tx.get(key)),
    deny: () => {
      authorization = false;
    },
    restart: () => {
      backends.at(-1).close();
      store = open();
    },
  };
}

test('duplicate delivery and restart preserve one immutable revision', async (t) => {
  const f = await fixture(t);
  const event = await f.event(1);
  const outcomes = await Promise.all([f.consume(event), f.consume(event)]);
  assert.ok(outcomes.every((outcome) => outcome.state === 'APPLIED'));
  const revision = await f.latest();
  f.restart();
  assert.equal((await f.consume(event)).state, 'APPLIED');
  assert.deepEqual(await f.latest(), revision);
  const repeated = await f.event(2);
  await f.consume(repeated);
  assert.deepEqual(await f.latest(), revision);
  assert.equal((await f.get('git-observation:' + repeated.event_id)).created, false);
});

test('reordered provider events cannot restore an obsolete observed head', async (t) => {
  const f = await fixture(t);
  const obsolete = await f.event(1);
  const next = await f.create('external push', [f.initial]);
  await f.advance(next);
  const newer = await f.event(3);
  assert.equal((await f.consume(newer)).state, 'APPLIED');
  assert.equal((await f.latest()).commit_oid, next);
  assert.equal((await f.consume(obsolete)).state, 'IGNORED');
  assert.equal((await f.latest()).commit_oid, next);
});

test('delayed hints cause Git rereads rather than acceptance of claimed source state', async (t) => {
  const f = await fixture(t);
  const event = await f.event(1);
  const head = await f.create('changed after event', [f.initial]);
  await f.advance(head);
  await f.consume(event);
  assert.equal((await f.latest()).commit_oid, head);
  assert.equal(
    (await f.latest()).tree_oid,
    (await f.gitStore.fetch({ schema_version: 1, repo_id: 'repository', commit_oid: head }, {}))
      .identity.tree_oid,
  );
});

test('force pushes and rebases create revisions without mutating previous records', async (t) => {
  const f = await fixture(t);
  await f.consume(await f.event(1));
  const first = await f.latest();
  const replacement = await f.create('replacement root');
  await f.advance(replacement);
  await f.consume(await f.event(2));
  const forced = await f.latest();
  const rebased = await f.create('rebased change', [replacement]);
  await f.advance(rebased);
  await f.consume(await f.event(3));
  const current = await f.latest();
  assert.equal(new Set([first.id, forced.id, current.id]).size, 3);
  assert.deepEqual(forced.parent_oids, []);
  assert.deepEqual(current.parent_oids, [replacement]);
  assert.deepEqual(await f.get('future-revision:' + first.id), first);
});

test('unknown provenance remains valid and declared claims never become observations', async (t) => {
  const f = await fixture(t);
  await f.consume(await f.event(1));
  assert.equal((await f.latest()).producer, null);
  const other = await f.create('claimed work', [f.initial]);
  await f.advance(other);
  const claim = { name: 'agent', basis: 'OBSERVED', correctness: 'proven' };
  await f.consume(await f.event(2, { producer: claim }));
  assert.deepEqual((await f.latest()).producer, { basis: 'DECLARED', value: claim });
});

test('authorization and registered ref binding protect ingestion boundaries', async (t) => {
  const f = await fixture(t);
  for (const metadata of [
    { tenant_id: 'other' },
    { system_id: 'other' },
    { subject_id: 'other' },
    { objective_id: 'invented-objective' },
  ]) {
    await assert.rejects(f.consume(await f.event(1, {}, metadata)), { code: 'FORBIDDEN' });
  }
  assert.equal(
    (await f.consume(await f.event(1, { ref: 'refs/heads/unregistered' }))).failure.code,
    'FORBIDDEN',
  );
  assert.equal(await f.latest(), null);
  f.deny();
  await assert.rejects(f.consume(await f.event(1)), { code: 'FORBIDDEN' });
  assert.equal(await f.latest(), null);
});
