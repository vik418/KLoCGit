import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetainedPayloadStore } from '../../core/v1/evidence-retention.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { FileObjectStore } from '../../adapters/local/object-store.mjs';
import { digestBytes, objectId } from '../../core/v1/conventions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = 1000;
  let backend = new SqliteCoordinationBackend({
    filename: join(root, 'metadata.sqlite'),
    busy_timeout_ms: 1000,
  });
  t.after(() => backend.close());
  const objects = new FileObjectStore({ root: join(root, 'objects'), max_bytes: 16384 });
  const options = {
    tenant_id: 'tenant',
    system_id: 'group',
    principal: { actor_id: 'controller' },
    authorize: async (principal) => principal.actor_id === 'controller',
    coordinationStore: new CoordinationStore(backend),
    objectStore: objects,
    ttl_ms: {
      schema_version: 1,
      EPHEMERAL: 10,
      REBUILDABLE: 20,
      DECISION_RECORD: null,
      CANONICAL: null,
    },
    now: () => time,
    max_payload_bytes: 16384,
  };
  const scope = { schema_version: 1, tenant_id: 'tenant', system_id: 'group', trace_id: 'trace' };
  const store = new RetainedPayloadStore(options);
  const bytes = new TextEncoder().encode('observed evaluation payload');
  const digest = await digestBytes('evidence-payload', bytes);
  const input = {
    schema_version: 1,
    scope,
    digest,
    bytes,
    retention_class: 'EPHEMERAL',
    idempotency_key: 'payload-1',
  };
  const pin = {
    schema_version: 1,
    scope,
    digest,
    reference_id: objectId('decision', await digestBytes('object-decision', bytes)),
  };
  return {
    options,
    store,
    objects,
    input,
    pin,
    scope,
    advance: (value) => {
      time += value;
    },
    restart: () => {
      backend.close();
      backend = new SqliteCoordinationBackend({
        filename: join(root, 'metadata.sqlite'),
        busy_timeout_ms: 1000,
      });
      options.coordinationStore = new CoordinationStore(backend);
      return new RetainedPayloadStore(options);
    },
  };
}

test('retention is assigned at creation and duplicate writes preserve exact content', async (t) => {
  const f = await fixture(t);
  const first = await f.store.put(f.input);
  f.advance(5);
  assert.deepEqual(await f.store.put(f.input), first);
  assert.deepEqual(await f.store.read(f.input), f.input.bytes);
  f.advance(6);
  assert.equal(await f.store.expire(f.input), true);
  await assert.rejects(f.store.read(f.input), { code: 'NOT_FOUND' });
  assert.equal(await f.store.expire(f.input), true);
});

test('decision references protect temporary payloads across restart and expiration', async (t) => {
  const f = await fixture(t);
  f.pin.payload_ref = (await f.store.put(f.input)).ref;
  await f.store.pin(f.pin);
  await f.store.pin(f.pin);
  f.advance(1000);
  const restarted = f.restart();
  assert.equal(await restarted.expire(f.input), false);
  assert.deepEqual(await restarted.read(f.input), f.input.bytes);
});

test('canonical and decision-record payloads survive cleanup while rebuildable data expires', async (t) => {
  const f = await fixture(t);
  for (const retention_class of ['CANONICAL', 'DECISION_RECORD']) {
    const bytes = new TextEncoder().encode(retention_class);
    const input = {
      ...f.input,
      retention_class,
      bytes,
      digest: await digestBytes('evidence-payload', bytes),
    };
    await f.store.put(input);
    f.advance(1000);
    assert.equal(await f.store.expire(input), false);
    assert.deepEqual(await f.store.read(input), bytes);
  }
  const input = { ...f.input, retention_class: 'REBUILDABLE' };
  await f.store.put(input);
  f.advance(21);
  assert.equal(await f.store.expire(input), true);
});

test('retention can increase without rewriting Evidence identity or allowing a later downgrade', async (t) => {
  const f = await fixture(t);
  const first = await f.store.put(f.input);
  await f.store.put({ ...f.input, retention_class: 'DECISION_RECORD' });
  await f.store.put(f.input);
  f.advance(1000);
  assert.equal(await f.store.expire(f.input), false);
  assert.equal((await f.store.put(f.input)).ref, first.ref);
});

test('cross-tenant access, forged payload identity and unauthorized retention actions fail', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.put({ ...f.input, scope: { ...f.scope, tenant_id: 'other' } }), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(f.store.put({ ...f.input, bytes: new Uint8Array() }), {
    code: 'INTEGRITY_MISMATCH',
  });
  f.pin.payload_ref = (await f.store.put(f.input)).ref;
  const denied = new RetainedPayloadStore({ ...f.options, authorize: async () => false });
  for (const operation of ['read', 'expire', 'pin'])
    await assert.rejects(denied[operation](operation === 'pin' ? f.pin : f.input), {
      code: 'FORBIDDEN',
    });
  const unauthenticated = new RetainedPayloadStore({ ...f.options, principal: {} });
  await assert.rejects(unauthenticated.read(f.input), { code: 'UNAUTHENTICATED' });
});

test('an ambiguous deletion blocks new canonical references until restart reconciliation', async (t) => {
  const f = await fixture(t);
  f.pin.payload_ref = (await f.store.put(f.input)).ref;
  const interrupted = new RetainedPayloadStore({
    ...f.options,
    objectStore: {
      put: f.objects.put.bind(f.objects),
      get: f.objects.get.bind(f.objects),
      delete: async (input) => {
        await f.objects.delete(input);
        throw new Error('connection lost');
      },
    },
  });
  f.advance(11);
  await assert.rejects(interrupted.expire(f.input), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(interrupted.pin(f.pin), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(interrupted.put(f.input), { code: 'OUTCOME_UNKNOWN' });
  const restarted = f.restart();
  assert.equal(await restarted.expire(f.input), true);
  await assert.rejects(restarted.pin(f.pin), { code: 'NOT_FOUND' });
});

test('cleanup cannot race a prepared canonical reference', async (t) => {
  const f = await fixture(t);
  f.pin.payload_ref = (await f.store.put(f.input)).ref;
  await f.store.pin(f.pin);
  f.advance(11);
  const outcomes = await Promise.all([f.store.expire(f.input), f.store.pin(f.pin)]);
  assert.equal(outcomes[0], false);
  assert.deepEqual(await f.store.read(f.input), f.input.bytes);
});

test('payload corruption is detected before a reference can preserve false evidence', async (t) => {
  const f = await fixture(t);
  f.pin.payload_ref = (await f.store.put(f.input)).ref;
  const corrupted = new RetainedPayloadStore({
    ...f.options,
    objectStore: {
      put: f.objects.put.bind(f.objects),
      delete: f.objects.delete.bind(f.objects),
      get: async () => new Uint8Array(),
    },
  });
  await assert.rejects(corrupted.read(f.input), { code: 'INTEGRITY_MISMATCH' });
  await assert.rejects(corrupted.pin(f.pin), { code: 'INTEGRITY_MISMATCH' });
});

test('a delayed deletion retry cannot remove a recreated, decision-pinned payload', async (t) => {
  const f = await fixture(t);
  const first = await f.store.put(f.input);
  let firstStarted, secondStarted, releaseFirst, releaseSecond;
  const firstReady = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const secondReady = new Promise((resolve) => {
    secondStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  let calls = 0;
  const racing = new RetainedPayloadStore({
    ...f.options,
    objectStore: {
      put: f.objects.put.bind(f.objects),
      get: f.objects.get.bind(f.objects),
      delete: async (input) => {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await firstGate;
        } else {
          secondStarted();
          await secondGate;
        }
        await f.objects.delete(input);
      },
    },
  });
  f.advance(11);
  const one = racing.expire(f.input);
  await firstReady;
  const two = racing.expire(f.input);
  await secondReady;
  releaseFirst();
  await one;
  const recreated = await f.store.put({ ...f.input, retention_class: 'DECISION_RECORD' });
  assert.notEqual(recreated.ref, first.ref);
  await f.store.pin({ ...f.pin, payload_ref: recreated.ref });
  releaseSecond();
  await two;
  assert.deepEqual(await f.store.read({ ...f.input, payload_ref: recreated.ref }), f.input.bytes);
  await assert.rejects(f.store.pin({ ...f.pin, payload_ref: first.ref }), { code: 'NOT_FOUND' });
});
