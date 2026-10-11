import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoordinationStore,
  coordinationKey,
  coordinationScope,
} from '../../core/v1/coordination.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { buildDecisionBasis } from '../../core/v1/decisions.mjs';
import { EventConsumer } from '../../core/v1/consumer.mjs';
import { createEvent } from '../../core/v1/events.mjs';

const scope = {
  schema_version: 1,
  tenant_id: 'tenant-1',
  system_id: 'system-1',
  kind: 'OBJECTIVE',
  resource_id: 'objective-1',
};
const decisionId = 'klocgit:decision:v1:sha256:' + 'a'.repeat(64);
const digest = (domain) => 'sha256:' + domain + ':v1:' + 'a'.repeat(64);
const policyEvaluator = {
  required_analysis: async () => ['semantic'],
  can_resolve: async () => true,
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-coordination-'));
  const filename = join(directory, 'state.sqlite');
  const backends = [];
  const open = () => {
    const backend = new SqliteCoordinationBackend({ filename, busy_timeout_ms: 1000 });
    backends.push(backend);
    return { backend, store: new CoordinationStore(backend) };
  };
  t.after(async () => {
    for (const backend of backends) backend.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { open, filename };
}

async function basis() {
  return buildDecisionBasis({
    schema_version: 1,
    candidate_digests: [digest('object-candidate')],
    evidence_digests: [],
    material_effect_digest: digest('material-effect'),
    policy_digest: digest('policy'),
    canonical_ref_oids: { repo: { 'refs/heads/main': 'a'.repeat(40) } },
    required_analysis_status: { semantic: 'COMPLETE' },
  });
}

test('committed state survives closing and reopening the durable backend', async (t) => {
  const f = await fixture(t);
  const first = f.open();
  await first.store.transaction(scope, (tx) =>
    tx.put('authorization', { schema_version: 1, allowed: true }),
  );
  first.backend.close();
  const second = f.open();
  assert.deepEqual(await second.store.transaction(scope, (tx) => tx.get('authorization')), {
    schema_version: 1,
    allowed: true,
  });
});

test('failed transaction persists neither partial state nor a later leaked write', async (t) => {
  const { store } = (await fixture(t)).open();
  let escaped;
  await assert.rejects(
    store.transaction(scope, async (tx) => {
      escaped = tx;
      await tx.put('record', { schema_version: 1, count: 1 });
      throw new Error('abort');
    }),
  );
  assert.equal(await store.transaction(scope, (tx) => tx.get('record')), undefined);
  await assert.rejects(escaped.put('record', { schema_version: 1 }), { code: 'CONFLICT' });
});

test('concurrent writers through separate connections lose no updates', async (t) => {
  const f = await fixture(t);
  const connections = [f.open().store, f.open().store];
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      connections[index % 2].transaction(scope, async (tx) => {
        const record = (await tx.get('counter')) ?? { schema_version: 1, value: 0 };
        await Promise.resolve();
        await tx.put('counter', { ...record, value: record.value + 1 });
      }),
    ),
  );
  assert.equal((await connections[0].transaction(scope, (tx) => tx.get('counter'))).value, 50);
});

test('concurrent Decision transitions cannot skip or repeat a state-machine edge', async (t) => {
  const { store } = (await fixture(t)).open();
  await store.createDecision(scope, {
    schema_version: 1,
    id: decisionId,
    state: 'DISCOVERED',
    basis: null,
    resolution: null,
  });
  const currentBasis = await basis();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      store.transitionDecision(scope, decisionId, 'REVIEWABLE', currentBasis),
    ),
  );
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(
    outcomes
      .filter((result) => result.status === 'rejected')
      .every((result) => result.reason.code === 'CONFLICT'),
  );
  await store.transitionDecision(scope, decisionId, 'RESOLVABLE', currentBasis, {
    policyEvaluator,
    subject: {},
    effects: {},
  });
  await store.transitionDecision(scope, decisionId, 'STALE');
  await assert.rejects(
    store.transitionDecision(scope, decisionId, 'RESOLVED', currentBasis, {
      policyEvaluator,
      subject: {},
      effects: {},
      expectedBasisDigest: currentBasis.digest,
      resolution: { candidate_digest: currentBasis.candidate_digests[0] },
    }),
    { code: 'CONFLICT' },
  );
});

test('tenant, system, objective and ref scope boundaries cannot alias', async (t) => {
  const { store } = (await fixture(t)).open();
  await store.transaction(scope, (tx) =>
    tx.put('record', { schema_version: 1, secret: 'tenant-1-only' }),
  );
  const scopes = [
    { ...scope, tenant_id: 'tenant-2' },
    { ...scope, system_id: 'system-2' },
    { ...scope, resource_id: 'objective-2' },
    { ...scope, kind: 'REF', resource_id: { repo_id: 'repo', ref: 'refs/heads/main' } },
  ];
  for (const other of scopes)
    assert.equal(await store.transaction(other, (tx) => tx.get('record')), undefined);
  assert.equal(
    new Set(await Promise.all([scope, ...scopes].map(coordinationKey))).size,
    scopes.length + 1,
  );
});

test('only versioned immutable data enters authoritative storage', async (t) => {
  const { store } = (await fixture(t)).open();
  await assert.rejects(
    store.transaction(scope, (tx) => tx.put('record', {})),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    store.transaction(scope, (tx) => tx.put('record', { schema_version: 2 })),
    { code: 'UNSUPPORTED_SCHEMA_VERSION' },
  );
  const original = { schema_version: 1, data: ['before'] };
  await store.transaction(scope, (tx) => tx.put('record', original));
  original.data.push('after');
  const stored = await store.transaction(scope, (tx) => tx.get('record'));
  assert.deepEqual(stored.data, ['before']);
  assert.ok(Object.isFrozen(stored.data));
});

test('nested local transactions fail instead of deadlocking', async (t) => {
  const { store } = (await fixture(t)).open();
  await assert.rejects(
    store.transaction(scope, () => store.transaction(scope, async () => null)),
    { code: 'CONFLICT' },
  );
});

test('delivery recovery retains pending operations in durable storage', async (t) => {
  const f = await fixture(t);
  const first = f.open();
  const results = new Map();
  let logicalEffects = 0;
  let crash = true;
  const config = {
    limits: { max_event_bytes: 1024, inline_payload_bytes: 100, max_claim_bytes: 8192 },
    max_attempts: 3,
    authorize: async () => true,
    handler: async () => [{ action: 'observe', resource_id: 'repo', payload: {} }],
    deadLetters: { send: async () => {} },
    executor: {
      idempotent: true,
      execute: async ({ operation_id }) => {
        if (!results.has(operation_id)) {
          results.set(operation_id, { done: true });
          logicalEffects += 1;
        }
        if (crash) {
          crash = false;
          throw new Error('executor response lost');
        }
        return results.get(operation_id);
      },
    },
  };
  const event = await createEvent(
    {
      schema_version: 1,
      type: 'future.observed',
      tenant_id: scope.tenant_id,
      system_id: scope.system_id,
      objective_id: scope.resource_id,
      subject_id: 'repo',
      subject_version: 1,
      occurred_at: '2026-10-10T00:00:00Z',
      trace_id: 'trace',
    },
    {},
    config.limits,
  );
  const delivery = { principal: { id: 'actor' }, attempt: 1 };
  assert.equal(
    (await new EventConsumer({ ...config, store: first.store }).consume(event, delivery))
      .disposition,
    'RETRY',
  );
  first.backend.close();
  const second = f.open();
  assert.equal(
    (
      await new EventConsumer({ ...config, store: second.store }).consume(event, {
        ...delivery,
        attempt: 2,
      })
    ).state,
    'APPLIED',
  );
  assert.equal(logicalEffects, 1);
});

test('scope rejects branch aliases and malformed refs', () => {
  for (const ref of ['main', 'refs/heads/../main', 'refs/heads/main.lock', 'refs/heads/@{bad}']) {
    assert.throws(() =>
      coordinationScope({ ...scope, kind: 'REF', resource_id: { repo_id: 'repo', ref } }),
    );
  }
});

test('queued Decision transitions capture requested selection and policy context before waiting', async (t) => {
  const { store } = (await fixture(t)).open();
  await store.createDecision(scope, {
    schema_version: 1,
    id: decisionId,
    state: 'DISCOVERED',
    basis: null,
    resolution: null,
  });
  const { digest: unused, ...projection } = await basis();
  void unused;
  const second = 'sha256:object-candidate:v1:' + 'b'.repeat(64);
  const currentBasis = await buildDecisionBasis({
    ...projection,
    candidate_digests: [...projection.candidate_digests, second],
  });
  await store.transitionDecision(scope, decisionId, 'REVIEWABLE', currentBasis);
  await store.transitionDecision(scope, decisionId, 'RESOLVABLE', currentBasis, {
    policyEvaluator,
    subject: {},
    effects: {},
  });
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const blocker = store.transaction(scope, async () => {
    started();
    await gate;
  });
  await entered;
  let capturedContext;
  const requested = {
    policyEvaluator: {
      required_analysis: async (subject, effects) => {
        capturedContext = { subject, effects };
        return ['semantic'];
      },
      can_resolve: async () => true,
    },
    subject: { system_id: 'system-1' },
    effects: [{ target: 'original' }],
    expectedBasisDigest: currentBasis.digest,
    resolution: { candidate_digest: currentBasis.candidate_digests[0], actor: 'original-actor' },
  };
  const transition = store.transitionDecision(
    scope,
    decisionId,
    'RESOLVED',
    currentBasis,
    requested,
  );
  requested.resolution.candidate_digest = second;
  requested.resolution.actor = 'different-actor';
  requested.subject.system_id = 'different-system';
  requested.effects[0].target = 'changed';
  requested.expectedBasisDigest = digest('decision-basis');
  requested.policyEvaluator = { required_analysis: async () => [], can_resolve: async () => false };
  release();
  await blocker;
  const resolved = await transition;
  assert.equal(resolved.resolution.candidate_digest, currentBasis.candidate_digests[0]);
  assert.equal(resolved.resolution.actor, 'original-actor');
  assert.deepEqual(capturedContext, {
    subject: { system_id: 'system-1' },
    effects: [{ target: 'original' }],
  });
});

test('transition option accessors are rejected without invoking producer code', async (t) => {
  const { store } = (await fixture(t)).open();
  let calls = 0;
  const options = { policyEvaluator, effects: {} };
  Object.defineProperty(options, 'subject', {
    enumerable: true,
    get() {
      calls += 1;
      return {};
    },
  });
  await assert.rejects(
    store.transitionDecision(scope, decisionId, 'RESOLVABLE', await basis(), options),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.equal(calls, 0);
});
