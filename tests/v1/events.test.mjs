import assert from 'node:assert/strict';
import test from 'node:test';
import { digestBytes } from '../../core/v1/conventions.mjs';
import {
  EventEnvelope,
  createEvent,
  deserializeEvent,
  eventLimits,
  readEventPayload,
  serializeEvent,
} from '../../core/v1/events.mjs';

const limits = { max_event_bytes: 1024, inline_payload_bytes: 100, max_claim_bytes: 8192 };
const metadata = {
  schema_version: 1,
  type: 'future.observed',
  tenant_id: 'tenant-1',
  system_id: 'system-1',
  objective_id: null,
  subject_id: 'repo-1',
  subject_version: 1,
  occurred_at: '2026-10-10T00:00:00Z',
  trace_id: 'trace-1',
};
const fails = (code) => (error) => error.code === code;

function store() {
  const data = new Map();
  const reads = [];
  return {
    data,
    reads,
    async put({ tenant_id, bytes, digest }) {
      data.set(tenant_id + ':' + digest, bytes.slice());
      return digest;
    },
    async get(input) {
      reads.push(input);
      return data.get(input.tenant_id + ':' + input.ref);
    },
  };
}

test('inline envelope round-trips and freezes nested producer data', async () => {
  const payload = { paths: ['src/retry.js'] };
  const event = await createEvent(metadata, payload, limits);
  payload.paths.push('changed');
  assert.deepEqual(await readEventPayload(event, limits), { paths: ['src/retry.js'] });
  assert.ok(Object.isFrozen(event.payload.paths));
  assert.deepEqual(deserializeEvent(serializeEvent(event, limits), limits), event);
  assert.deepEqual(await createEvent(metadata, { paths: ['src/retry.js'] }, limits), event);
});

test('large payload uses tenant-scoped claim-check and verifies digest before consumption', async () => {
  const objects = store();
  const payload = { log: 'x'.repeat(500) };
  const event = await createEvent(metadata, payload, limits, objects);
  assert.equal(Object.hasOwn(event, 'payload'), false);
  assert.ok(serializeEvent(event, limits).length <= limits.max_event_bytes);
  assert.deepEqual(await readEventPayload(event, limits, objects), payload);
  assert.deepEqual(objects.reads, [
    { tenant_id: metadata.tenant_id, ref: event.payload_ref, max_bytes: limits.max_claim_bytes },
  ]);
  objects.data.set(metadata.tenant_id + ':' + event.payload_ref, new TextEncoder().encode('{}'));
  await assert.rejects(readEventPayload(event, limits, objects), fails('INTEGRITY_MISMATCH'));
});

test('serializer rejects oversized inline payload even if a producer bypasses creation', async () => {
  const event = await createEvent(metadata, {}, limits);
  assert.throws(
    () => serializeEvent({ ...event, payload: 'x'.repeat(100) }, limits),
    fails('INVALID_ARGUMENT'),
  );
  const atLimit = await createEvent(metadata, 'x'.repeat(98), limits);
  assert.equal(new TextEncoder().encode(JSON.stringify(atLimit.payload)).length, 100);
  assert.ok(serializeEvent(atLimit, limits));
});

test('UTF-8 byte budgets count multibyte characters and JSON escaping', async () => {
  const objects = store();
  for (const payload of ['💛'.repeat(25), '\n'.repeat(50)]) {
    const event = await createEvent(metadata, payload, limits, objects);
    assert.ok(Object.hasOwn(event, 'payload_ref'));
    assert.equal(await readEventPayload(event, limits, objects), payload);
  }
});

test('metadata and reference sizes cannot bypass the full envelope bound', async () => {
  const event = await createEvent(metadata, {}, limits);
  assert.throws(
    () => EventEnvelope({ ...event, trace_id: 'x'.repeat(1024) }, limits),
    fails('INVALID_ARGUMENT'),
  );
  await assert.rejects(
    createEvent(metadata, 'x'.repeat(101), limits, { put: async () => 'x'.repeat(1024) }),
    fails('INVALID_ARGUMENT'),
  );
  assert.throws(() => deserializeEvent(new Uint8Array(1025), limits), fails('INVALID_ARGUMENT'));
});

test('transport identity detects payload, tenant, version and claim substitution', async () => {
  const event = await createEvent(metadata, { head: 'abc' }, limits);
  for (const mutation of [
    { payload: { head: 'def' } },
    { tenant_id: 'other-tenant' },
    { subject_version: 2 },
  ]) {
    await assert.rejects(
      readEventPayload({ ...event, ...mutation }, limits),
      fails('INTEGRITY_MISMATCH'),
    );
  }
  const objects = store();
  const claim = await createEvent(metadata, 'x'.repeat(101), limits, objects);
  await assert.rejects(
    readEventPayload({ ...claim, payload_ref: 'other' }, limits, objects),
    fails('INTEGRITY_MISMATCH'),
  );
  assert.equal(objects.reads.length, 0);
});

test('claim limits and missing storage fail closed', async () => {
  await assert.rejects(
    createEvent(metadata, 'x'.repeat(8192), limits, store()),
    fails('INVALID_ARGUMENT'),
  );
  await assert.rejects(createEvent(metadata, 'x'.repeat(101), limits), fails('INVALID_ARGUMENT'));
  const claim = await createEvent(metadata, 'x'.repeat(101), limits, store());
  await assert.rejects(readEventPayload(claim, limits), fails('INVALID_ARGUMENT'));
  await assert.rejects(
    readEventPayload(claim, limits, { get: async () => new Uint8Array(8193) }),
    fails('INVALID_ARGUMENT'),
  );
});

test('verified claim still rejects malformed UTF-8, JSON and unsupported JSON values', async () => {
  for (const payloadBytes of [
    new Uint8Array([0xff]),
    new TextEncoder().encode('null trailing'),
    new TextEncoder().encode('1e999'),
  ]) {
    const objects = store();
    const original = await createEvent(metadata, 'x'.repeat(101), limits, objects);
    // Rebuild the identity to isolate payload decoding from envelope integrity.
    const { digestCanonical } = await import('../../core/v1/encoding.mjs');
    const { objectId } = await import('../../core/v1/conventions.mjs');
    const { event_id, ...body } = original;
    void event_id;
    body.payload_digest = await digestBytes('event-payload', payloadBytes);
    objects.data.set(metadata.tenant_id + ':' + body.payload_ref, payloadBytes);
    const event = {
      ...body,
      event_id: objectId('event', await digestCanonical('object-event', body)),
    };
    await assert.rejects(readEventPayload(event, limits, objects), fails('INVALID_ARGUMENT'));
  }
});

for (const [name, mutation] of Object.entries({
  'unknown field': { extra: true },
  'negative version': { subject_version: -1 },
  'fractional version': { subject_version: 1.5 },
  'empty scope': { tenant_id: '' },
  'invalid type': { type: 'Future Observed' },
  'invalid date': { occurred_at: '2026-02-30T00:00:00Z' },
  'ambiguous timestamp': { occurred_at: '2026-10-10T00:00:00+00:00' },
  'unsupported version': { schema_version: 2 },
  'both payload forms': {
    payload_ref: 'key',
    payload_digest: 'sha256:event-payload:v1:' + 'a'.repeat(64),
  },
})) {
  test('rejects ' + name, async () => {
    const event = await createEvent(metadata, {}, limits);
    assert.throws(() => EventEnvelope({ ...event, ...mutation }, limits));
  });
}

test('producer getters are rejected without invocation', async () => {
  let invoked = false;
  const payload = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error('must not execute');
    },
  });
  await assert.rejects(createEvent(metadata, payload, limits), fails('INVALID_ARGUMENT'));
  assert.equal(invoked, false);
});

test('threshold configuration is explicit and internally consistent', () => {
  for (const input of [
    undefined,
    {},
    { ...limits, inline_payload_bytes: 1024 },
    { ...limits, max_claim_bytes: 99 },
    { ...limits, max_event_bytes: 1.5 },
  ]) {
    assert.throws(() => eventLimits(input), fails('INVALID_ARGUMENT'));
  }
  assert.deepEqual(eventLimits(limits), limits);
});
