import assert from 'node:assert/strict';
import test from 'node:test';
import { V1Error } from '../../core/v1/conventions.mjs';
import { EventConsumer } from '../../core/v1/consumer.mjs';
import { createEvent, readEventPayload, serializeEvent } from '../../core/v1/events.mjs';

const limits = { max_event_bytes: 1024, inline_payload_bytes: 100, max_claim_bytes: 8192 };
const principal = { id: 'trusted-worker', tenant_id: 'tenant-1' };
const delivery = { principal, attempt: 1 };
const metadata = {
  schema_version: 1,
  type: 'future.observed',
  tenant_id: 'tenant-1',
  system_id: 'system-1',
  objective_id: 'objective-1',
  subject_id: 'repo-1',
  subject_version: 1,
  occurred_at: '2026-10-10T00:00:00Z',
  trace_id: 'trace-1',
};

// Durable image is shared across consumer instances; the test transaction model
// commits only after the callback succeeds and serializes writers per scope.
function transactionStore(image = new Map()) {
  const locks = new Map();
  return {
    image,
    async transaction(scope, callback) {
      const key = JSON.stringify(scope);
      const prior = locks.get(key) ?? Promise.resolve();
      let release;
      const lock = new Promise((resolve) => {
        release = resolve;
      });
      locks.set(
        key,
        prior.then(() => lock),
      );
      await prior;
      try {
        const draft = structuredClone(image.get(key) ?? new Map());
        const result = await callback({
          get: async (name) => structuredClone(draft.get(name)),
          put: async (name, value) => {
            draft.set(name, structuredClone(value));
          },
        });
        if (draft.size > 0 || image.has(key)) image.set(key, draft);
        return result;
      } finally {
        release();
      }
    },
  };
}

function fixture(overrides = {}) {
  const objects = new Map();
  const calls = [];
  const results = new Map();
  const dlq = [];
  const objectStore = {
    put: async ({ tenant_id, bytes, digest }) => {
      objects.set(tenant_id + digest, bytes.slice());
      return digest;
    },
    get: async ({ tenant_id, ref }) => objects.get(tenant_id + ref),
  };
  const config = {
    store: transactionStore(),
    limits,
    objectStore,
    max_attempts: 3,
    authorize: async ({ principal: actor, event }) => actor.tenant_id === event.tenant_id,
    handler: async ({ event, payload, transaction }) => {
      await transaction.put('projection', {
        schema_version: 1,
        version: event.subject_version,
        payload,
      });
      return [{ action: 'observe', resource_id: event.subject_id, payload }];
    },
    executor: {
      idempotent: true,
      execute: async (entry) => {
        if (!results.has(entry.operation_id)) {
          calls.push(entry);
          results.set(entry.operation_id, { accepted: true });
        }
        return results.get(entry.operation_id);
      },
    },
    deadLetters: {
      send: async (event) => {
        dlq.push(event);
      },
    },
    ...overrides,
  };
  return { config, calls, results, dlq, objectStore, consumer: new EventConsumer(config) };
}

test('duplicate delivery and consumer restart do not repeat logical effects', async () => {
  const f = fixture();
  const event = await createEvent(metadata, { head: 'one' }, limits);
  assert.equal((await f.consumer.consume(event, delivery)).state, 'APPLIED');
  const restarted = new EventConsumer({
    ...f.config,
    store: transactionStore(f.config.store.image),
  });
  assert.equal((await restarted.consume(event, delivery)).state, 'APPLIED');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].principal.id, principal.id);
});

test('concurrent duplicate delivery prepares one operation', async () => {
  const f = fixture();
  const event = await createEvent(metadata, { head: 'one' }, limits);
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () => f.consumer.consume(event, delivery)),
  );
  assert.ok(outcomes.every((result) => result.disposition === 'ACK'));
  assert.equal(f.calls.length, 1);
});

test('older versions cannot overwrite a newer projection or produce an effect', async () => {
  const f = fixture();
  const first = await createEvent(metadata, { head: 'one' }, limits);
  const second = await createEvent({ ...metadata, subject_version: 2 }, { head: 'two' }, limits);
  await f.consumer.consume(first, delivery);
  await f.consumer.consume(second, delivery);
  const old = await createEvent(
    { ...metadata, trace_id: 'redelivered-old' },
    { head: 'old' },
    limits,
  );
  assert.equal((await f.consumer.consume(old, delivery)).state, 'IGNORED');
  assert.equal(f.calls.length, 2);
  for (const state of f.config.store.image.values())
    assert.equal(state.get('projection').payload.head, 'two');
});

test('version gaps and same-version collisions require authoritative reconciliation', async () => {
  let rereads = 0;
  const f = fixture({
    reconcile: async ({ event, transaction }) => {
      rereads += 1;
      await transaction.put('projection', {
        schema_version: 1,
        version: event.subject_version,
        payload: { head: 'authoritative' },
      });
      return [];
    },
  });
  await f.consumer.consume(
    await createEvent({ ...metadata, subject_version: 4 }, { head: 'claim' }, limits),
    delivery,
  );
  await f.consumer.consume(
    await createEvent({ ...metadata, subject_version: 4 }, { head: 'different' }, limits),
    delivery,
  );
  assert.equal(rereads, 2);
  assert.equal(f.calls.length, 0);
});

test('gapped event is retryable when reconciliation is unavailable', async () => {
  const f = fixture();
  const event = await createEvent({ ...metadata, subject_version: 8 }, {}, limits);
  assert.equal((await f.consumer.consume(event, delivery)).failure.code, 'OUTCOME_UNKNOWN');
  assert.equal(f.config.store.image.size, 0);
});

test('handler failure rolls back receipt, version and projection atomically', async () => {
  const f = fixture({
    handler: async ({ transaction }) => {
      await transaction.put('projection', { schema_version: 1, invalid: true });
      throw new V1Error('PROVIDER_UNAVAILABLE');
    },
  });
  const event = await createEvent(metadata, {}, limits);
  assert.equal((await f.consumer.consume(event, delivery)).disposition, 'RETRY');
  assert.equal(f.config.store.image.size, 0);
  assert.equal(f.calls.length, 0);
});

test('crash after external success resumes with the same idempotency key', async () => {
  const f = fixture();
  const execute = f.config.executor.execute;
  let crashed = false;
  f.config.executor.execute = async (entry) => {
    const result = await execute(entry);
    if (!crashed) {
      crashed = true;
      throw new V1Error('OUTCOME_UNKNOWN');
    }
    return result;
  };
  const event = await createEvent(metadata, {}, limits);
  assert.equal((await f.consumer.consume(event, delivery)).disposition, 'RETRY');
  const restarted = new EventConsumer({
    ...f.config,
    store: transactionStore(f.config.store.image),
  });
  assert.equal((await restarted.consume(event, { ...delivery, attempt: 2 })).state, 'APPLIED');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].operation_id.startsWith('klocgit:operation:v1:sha256:'));
});

test('poison event reaches bounded DLQ after configured attempts with sanitized failure', async () => {
  const f = fixture({
    handler: async () => {
      throw new Error('secret-token-must-not-leak');
    },
  });
  const event = await createEvent(metadata, {}, limits);
  assert.equal((await f.consumer.consume(event, delivery)).disposition, 'RETRY');
  assert.equal(f.dlq.length, 0);
  const outcome = await f.consumer.consume(event, { ...delivery, attempt: 3 });
  assert.equal(outcome.state, 'DEADLETTERED');
  const dead = f.dlq[0];
  assert.ok(serializeEvent(dead, limits).length <= limits.max_event_bytes);
  assert.deepEqual(dead, event);
  assert.deepEqual(await readEventPayload(dead, limits, f.objectStore), {});
  for (const image of f.config.store.image.values()) {
    const journal = image.get('deadletter:' + event.event_id);
    assert.equal(journal.schema_version, 1);
    assert.equal(journal.attempt, 3);
    assert.equal(journal.failure.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(journal).includes('secret-token'), false);
  }
  await new EventConsumer(f.config).consume(event, { ...delivery, attempt: 4 });
  assert.equal(f.dlq.length, 1);
  const repaired = new EventConsumer({
    ...f.config,
    handler: async () => [{ action: 'observe', resource_id: 'repo-1', payload: {} }],
  });
  assert.equal((await repaired.consume(event, delivery)).state, 'DEADLETTERED');
  assert.equal(f.calls.length, 0);
});

test('DLQ outage preserves original message for retry', async () => {
  const f = fixture({
    handler: async () => {
      throw new V1Error('INVALID_ARGUMENT');
    },
    deadLetters: {
      send: async () => {
        throw new Error('offline');
      },
    },
  });
  const event = await createEvent(metadata, {}, limits);
  const result = await f.consumer.consume(event, { ...delivery, attempt: 3 });
  assert.equal(result.disposition, 'RETRY');
  assert.equal(result.failure.code, 'PROVIDER_UNAVAILABLE');
});

test('tenant rejection occurs before claim-check access or coordination', async () => {
  let reads = 0;
  const f = fixture();
  const event = await createEvent(
    { ...metadata, tenant_id: 'other-tenant' },
    'x'.repeat(101),
    limits,
    f.objectStore,
  );
  f.objectStore.get = async () => {
    reads += 1;
    return new Uint8Array();
  };
  await assert.rejects(f.consumer.consume(event, delivery), { code: 'FORBIDDEN' });
  assert.equal(reads, 0);
  assert.equal(f.config.store.image.size, 0);
  assert.equal(f.dlq.length, 0);
});

test('executor cannot be configured without an explicit idempotency contract', () => {
  const f = fixture();
  assert.throws(() => new EventConsumer({ ...f.config, executor: { execute: async () => ({}) } }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('DLQ reuses the exact bounded event even with a minimal claim budget', async () => {
  const smallLimits = { max_event_bytes: 1024, inline_payload_bytes: 100, max_claim_bytes: 100 };
  const f = fixture({
    limits: smallLimits,
    handler: async () => {
      throw new V1Error('INVALID_ARGUMENT');
    },
  });
  const event = await createEvent(metadata, {}, smallLimits);
  assert.equal(
    (await f.consumer.consume(event, { ...delivery, attempt: 3 })).state,
    'DEADLETTERED',
  );
  assert.deepEqual(f.dlq, [event]);
  assert.equal(
    serializeEvent(f.dlq[0], smallLimits).length,
    serializeEvent(event, smallLimits).length,
  );
});

test('near-bound metadata can reach the DLQ without growing its envelope', async () => {
  const smallLimits = { max_event_bytes: 1024, inline_payload_bytes: 100, max_claim_bytes: 100 };
  const f = fixture({
    limits: smallLimits,
    handler: async () => {
      throw new V1Error('INVALID_ARGUMENT');
    },
  });
  const baseline = await createEvent({ ...metadata, trace_id: 'x' }, {}, smallLimits);
  const length = serializeEvent(baseline, smallLimits).length;
  const event = await createEvent(
    { ...metadata, trace_id: 'x'.repeat(1 + smallLimits.max_event_bytes - length) },
    {},
    smallLimits,
  );
  assert.equal(serializeEvent(event, smallLimits).length, smallLimits.max_event_bytes);
  assert.equal(
    (await f.consumer.consume(event, { ...delivery, attempt: 3 })).state,
    'DEADLETTERED',
  );
  assert.deepEqual(f.dlq, [event]);
});

test('an opaque claim reference at the envelope limit remains bounded in the DLQ', async () => {
  let stored;
  let reference = 'r';
  const objectStore = {
    put: async ({ bytes }) => {
      stored = bytes.slice();
      return reference;
    },
    get: async () => stored,
  };
  const f = fixture({
    objectStore,
    handler: async () => {
      throw new V1Error('INVALID_ARGUMENT');
    },
  });
  const payload = 'x'.repeat(101);
  const baseline = await createEvent(metadata, payload, limits, objectStore);
  reference = 'r'.repeat(1 + limits.max_event_bytes - serializeEvent(baseline, limits).length);
  const event = await createEvent(metadata, payload, limits, objectStore);
  assert.equal(serializeEvent(event, limits).length, limits.max_event_bytes);
  assert.equal(
    (await f.consumer.consume(event, { ...delivery, attempt: 3 })).state,
    'DEADLETTERED',
  );
  assert.deepEqual(f.dlq, [event]);
});

test('concurrent DLQ publication remains terminal while an issued effect completes', async () => {
  let release;
  let started;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const issued = [];
  let calls = 0;
  const f = fixture({
    handler: async () => [
      { action: 'observe', resource_id: 'repo-1', payload: { part: 1 } },
      { action: 'observe', resource_id: 'repo-1', payload: { part: 2 } },
    ],
    executor: {
      idempotent: true,
      execute: async (entry) => {
        calls += 1;
        if (calls === 1) {
          issued.push(entry.effect.payload.part);
          started();
          await blocked;
          return { observed: true };
        }
        throw new V1Error('PROVIDER_UNAVAILABLE');
      },
    },
  });
  const event = await createEvent(metadata, {}, limits);
  const first = f.consumer.consume(event, delivery);
  await entered;
  const poison = await f.consumer.consume(event, { ...delivery, attempt: 3 });
  assert.equal(poison.state, 'DEADLETTERED');
  release();
  assert.equal((await first).state, 'DEADLETTERED');
  assert.deepEqual(issued, [1]);
  for (const image of f.config.store.image.values()) {
    assert.equal(image.get('receipt:' + event.event_id).state, 'DEADLETTERED');
    assert.equal(image.get('deadletter:' + event.event_id).state, 'QUEUED');
    const outbox = [...image.entries()].filter(([key]) => key.startsWith('outbox:'));
    assert.deepEqual(
      outbox.map(([, entry]) => entry.state),
      ['APPLIED', 'CANCELLED'],
    );
  }
});

test('a failed DLQ send resumes publication after restart rather than rerunning repaired work', async () => {
  let handlers = 0;
  let sends = 0;
  const f = fixture({
    handler: async () => {
      handlers += 1;
      throw new V1Error('INVALID_ARGUMENT');
    },
    deadLetters: {
      send: async () => {
        sends += 1;
        if (sends === 1) throw new V1Error('PROVIDER_UNAVAILABLE');
      },
    },
  });
  const event = await createEvent(metadata, {}, limits);
  assert.equal((await f.consumer.consume(event, { ...delivery, attempt: 3 })).disposition, 'RETRY');
  const restarted = new EventConsumer({
    ...f.config,
    store: transactionStore(f.config.store.image),
    handler: async () => {
      handlers += 1;
      return [{ action: 'observe', resource_id: 'repo-1', payload: {} }];
    },
  });
  assert.equal((await restarted.consume(event, delivery)).state, 'DEADLETTERED');
  assert.equal(handlers, 1);
  assert.equal(sends, 2);
  assert.equal(f.calls.length, 0);
});

test('persisted DLQ publication resumes even if the original claim is unavailable', async () => {
  let sends = 0;
  let reads = 0;
  const f = fixture({
    handler: async () => {
      throw new V1Error('INVALID_ARGUMENT');
    },
    deadLetters: {
      send: async () => {
        sends += 1;
        if (sends === 1) throw new V1Error('PROVIDER_UNAVAILABLE');
      },
    },
  });
  const get = f.objectStore.get;
  f.objectStore.get = async (input) => {
    reads += 1;
    return get(input);
  };
  const event = await createEvent(metadata, 'x'.repeat(101), limits, f.objectStore);
  assert.equal((await f.consumer.consume(event, { ...delivery, attempt: 3 })).disposition, 'RETRY');
  f.objectStore.get = async () => {
    reads += 1;
    throw new V1Error('NOT_FOUND');
  };
  const restarted = new EventConsumer({
    ...f.config,
    store: transactionStore(f.config.store.image),
  });
  assert.equal((await restarted.consume(event, delivery)).state, 'DEADLETTERED');
  assert.equal(reads, 1);
  assert.equal(sends, 2);
});

test('an applied duplicate verifies its envelope without rehydrating expired claim data', async () => {
  const f = fixture();
  const event = await createEvent(metadata, 'x'.repeat(101), limits, f.objectStore);
  assert.equal((await f.consumer.consume(event, delivery)).state, 'APPLIED');
  let reads = 0;
  f.objectStore.get = async () => {
    reads += 1;
    throw new V1Error('NOT_FOUND');
  };
  assert.equal((await f.consumer.consume(event, delivery)).state, 'APPLIED');
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 1);
  const tampered = { ...event, payload_ref: 'different' };
  await assert.rejects(f.consumer.consume(tampered, delivery), { code: 'INTEGRITY_MISMATCH' });
  assert.equal(reads, 0);
});

test('an identity-tampered final attempt cannot quarantine the genuine event ID', async () => {
  const f = fixture();
  const event = await createEvent(metadata, { head: 'genuine' }, limits);
  const tampered = { ...event, payload: { head: 'tampered' } };
  await assert.rejects(f.consumer.consume(tampered, { ...delivery, attempt: 3 }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(f.dlq.length, 0);
  assert.equal(f.config.store.image.size, 0);
  assert.equal((await f.consumer.consume(event, delivery)).state, 'APPLIED');
  assert.equal(f.calls.length, 1);
  for (const image of f.config.store.image.values())
    assert.equal(image.has('deadletter:' + event.event_id), false);
});

test('a verified envelope with a corrupt claim can still reach the DLQ', async () => {
  const f = fixture();
  const event = await createEvent(metadata, 'x'.repeat(101), limits, f.objectStore);
  f.objectStore.get = async () => new TextEncoder().encode('{"changed":true}');
  const result = await f.consumer.consume(event, { ...delivery, attempt: 3 });
  assert.equal(result.state, 'DEADLETTERED');
  assert.equal(result.failure.code, 'INTEGRITY_MISMATCH');
  assert.deepEqual(f.dlq, [event]);
  assert.equal(f.calls.length, 0);
});

test('an old prepared outbox cannot overwrite already applied newer work', async () => {
  let first = true;
  let externalVersion = 0;
  const applied = new Set();
  const f = fixture({
    handler: async ({ event, transaction }) => {
      await transaction.put('projection', { schema_version: 1, version: event.subject_version });
      return [
        {
          action: 'observe',
          resource_id: event.subject_id,
          payload: { version: event.subject_version },
        },
      ];
    },
    executor: {
      idempotent: true,
      execute: async (entry) => {
        if (first) {
          first = false;
          throw new V1Error('OUTCOME_UNKNOWN');
        }
        if (!applied.has(entry.operation_id)) {
          applied.add(entry.operation_id);
          externalVersion = entry.effect.payload.version;
        }
        return { version: externalVersion };
      },
    },
  });
  const old = await createEvent(metadata, {}, limits);
  const newer = await createEvent({ ...metadata, subject_version: 2 }, {}, limits);
  assert.equal((await f.consumer.consume(old, delivery)).disposition, 'RETRY');
  assert.equal((await f.consumer.consume(newer, delivery)).state, 'APPLIED');
  const restarted = new EventConsumer({
    ...f.config,
    store: transactionStore(f.config.store.image),
  });
  assert.equal((await restarted.consume(old, { ...delivery, attempt: 2 })).state, 'IGNORED');
  assert.equal(externalVersion, 2);
  for (const image of f.config.store.image.values()) {
    assert.equal(image.get('projection').version, 2);
    const oldReceipt = image.get('receipt:' + old.event_id);
    assert.equal(oldReceipt.state, 'IGNORED');
    assert.equal(image.get('outbox:' + oldReceipt.operations[0]).state, 'UNKNOWN');
  }
});

test('canonical version advance during an issued effect cancels its remaining old plan', async () => {
  let release;
  let started;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const issued = [];
  const f = fixture({
    handler: async ({ event }) =>
      [1, 2].map((part) => ({
        action: 'observe',
        resource_id: event.subject_id,
        payload: { version: event.subject_version, part },
      })),
    executor: {
      idempotent: true,
      execute: async ({ effect }) => {
        issued.push(effect.payload);
        if (effect.payload.version === 1) {
          started();
          await blocked;
        }
        return { observed: true };
      },
    },
  });
  const old = await createEvent(metadata, {}, limits);
  const newer = await createEvent({ ...metadata, subject_version: 2 }, {}, limits);
  const oldDelivery = f.consumer.consume(old, delivery);
  await entered;
  assert.equal((await f.consumer.consume(newer, delivery)).state, 'APPLIED');
  release();
  assert.equal((await oldDelivery).state, 'IGNORED');
  assert.deepEqual(issued, [
    { version: 1, part: 1 },
    { version: 2, part: 1 },
    { version: 2, part: 2 },
  ]);
  for (const image of f.config.store.image.values()) {
    const oldReceipt = image.get('receipt:' + old.event_id);
    assert.equal(image.get('outbox:' + oldReceipt.operations[0]).state, 'APPLIED');
    assert.equal(image.get('outbox:' + oldReceipt.operations[1]).state, 'CANCELLED');
  }
});

test('reconciled same-version observations supersede an older pending plan', async () => {
  const f = fixture({
    executor: {
      idempotent: true,
      execute: async () => {
        throw new V1Error('OUTCOME_UNKNOWN');
      },
    },
    reconcile: async () => [],
  });
  const old = await createEvent(metadata, { head: 'old' }, limits);
  const reread = await createEvent(
    { ...metadata, trace_id: 'reread' },
    { head: 'current' },
    limits,
  );
  assert.equal((await f.consumer.consume(old, delivery)).disposition, 'RETRY');
  assert.equal((await f.consumer.consume(reread, delivery)).state, 'APPLIED');
  assert.equal((await f.consumer.consume(old, { ...delivery, attempt: 2 })).state, 'IGNORED');
});

test('observations outside an objective use an explicit ref scope and cannot alias an objective', async () => {
  const f = fixture({
    resolveScope: async ({ event }) => ({
      schema_version: 1,
      tenant_id: event.tenant_id,
      system_id: event.system_id,
      kind: 'REF',
      resource_id: { repo_id: 'repo-1', ref: 'refs/heads/main' },
    }),
  });
  const outside = await createEvent(
    { ...metadata, objective_id: null, subject_id: 'objective-1' },
    {},
    limits,
  );
  const inside = await createEvent(metadata, {}, limits);
  assert.equal((await f.consumer.consume(outside, delivery)).state, 'APPLIED');
  assert.equal((await f.consumer.consume(inside, delivery)).state, 'APPLIED');
  assert.equal(f.config.store.image.size, 2);
  const scopes = [...f.config.store.image.keys()].map(JSON.parse);
  assert.deepEqual(scopes.map((value) => value.kind).sort(), ['OBJECTIVE', 'REF']);
});

test('missing or misrouted ref scopes fail before claim-check or coordination access', async () => {
  const f = fixture();
  const event = await createEvent(
    { ...metadata, objective_id: null },
    'x'.repeat(101),
    limits,
    f.objectStore,
  );
  let reads = 0;
  f.objectStore.get = async () => {
    reads += 1;
    return new Uint8Array();
  };
  await assert.rejects(f.consumer.consume(event, delivery), { code: 'OUTCOME_UNKNOWN' });
  for (const mutation of [
    { tenant_id: 'other-tenant' },
    { system_id: 'other-system' },
    { kind: 'OBJECTIVE', resource_id: event.subject_id },
    { resource_id: { repo_id: 'repo-1', ref: 'main' } },
  ]) {
    const consumer = new EventConsumer({
      ...f.config,
      resolveScope: async () => ({
        schema_version: 1,
        tenant_id: event.tenant_id,
        system_id: event.system_id,
        kind: 'REF',
        resource_id: { repo_id: 'repo-1', ref: 'refs/heads/main' },
        ...mutation,
      }),
    });
    await assert.rejects(consumer.consume(event, delivery));
  }
  assert.equal(reads, 0);
  assert.equal(f.config.store.image.size, 0);
  assert.equal(f.calls.length, 0);
});
