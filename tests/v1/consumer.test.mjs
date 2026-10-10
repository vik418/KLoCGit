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
        image.set(key, draft);
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
  const payload = await readEventPayload(dead, limits, f.objectStore);
  assert.equal(payload.original_event.event_id, event.event_id);
  assert.equal(payload.failure.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(payload).includes('secret-token'), false);
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
