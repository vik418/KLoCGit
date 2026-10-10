/** Bounded transport records. Event identity does not establish sender authority. */
import {
  V1Error,
  assertSchemaVersion,
  digestBytes,
  objectId,
  parseDigest,
  parseObjectId,
} from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const metadata = [
  'schema_version',
  'type',
  'tenant_id',
  'system_id',
  'objective_id',
  'subject_id',
  'subject_version',
  'occurred_at',
  'trace_id',
];

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function exactFields(value, fields) {
  valid(value && typeof value === 'object' && !Array.isArray(value));
  valid(Object.keys(value).length === fields.length);
  valid(fields.every((field) => Object.hasOwn(value, field)));
}

function nonblank(value) {
  valid(typeof value === 'string' && value.trim().length > 0);
}

/** No default is frozen before D008's workload and provider measurements. */
export function eventLimits(input) {
  const value = copyJsonData(input);
  exactFields(value, ['max_event_bytes', 'inline_payload_bytes', 'max_claim_bytes']);
  valid(Object.values(value).every((entry) => Number.isSafeInteger(entry) && entry > 0));
  valid(value.inline_payload_bytes < value.max_event_bytes);
  valid(value.max_claim_bytes >= value.inline_payload_bytes);
  return freeze(value);
}

function validateMetadata(value) {
  assertSchemaVersion(value);
  valid(typeof value.type === 'string' && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.type));
  for (const key of ['tenant_id', 'system_id', 'subject_id', 'trace_id']) nonblank(value[key]);
  if (value.objective_id !== null) nonblank(value.objective_id);
  valid(Number.isSafeInteger(value.subject_version) && value.subject_version >= 0);
  valid(
    typeof value.occurred_at === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.occurred_at),
  );
  const date = new Date(value.occurred_at);
  valid(Number.isFinite(date.getTime()));
  valid(
    date.toISOString() ===
      value.occurred_at.replace(/Z$/, value.occurred_at.includes('.') ? 'Z' : '.000Z'),
  );
}

function bytes(value) {
  return encoder.encode(JSON.stringify(value));
}

/** Validate both payload size and the complete UTF-8 envelope, including metadata. */
export function EventEnvelope(input, configuredLimits) {
  const limits = eventLimits(configuredLimits);
  const value = copyJsonData(input);
  valid(value && typeof value === 'object' && !Array.isArray(value));
  const inline = Object.hasOwn(value, 'payload');
  exactFields(value, [
    'event_id',
    ...metadata,
    ...(inline ? ['payload'] : ['payload_ref', 'payload_digest']),
  ]);
  validateMetadata(value);
  parseObjectId(value.event_id, 'event');
  if (inline) {
    valid(bytes(value.payload).length <= limits.inline_payload_bytes);
  } else {
    nonblank(value.payload_ref);
    parseDigest(value.payload_digest, 'event-payload');
  }
  valid(bytes(value).length <= limits.max_event_bytes);
  return freeze(value);
}

async function identity(value) {
  const { event_id: ignored, ...body } = value;
  void ignored;
  return objectId('event', await digestCanonical('object-event', body));
}

/** Verify metadata and payload binding without hydrating a claim-check object. */
export async function verifyEventEnvelope(input, configuredLimits) {
  const value = EventEnvelope(input, configuredLimits);
  if ((await identity(value)) !== value.event_id) throw new V1Error('INTEGRITY_MISMATCH');
  return value;
}

export function serializeEvent(input, limits) {
  return bytes(EventEnvelope(input, limits));
}

export function deserializeEvent(input, configuredLimits) {
  const limits = eventLimits(configuredLimits);
  valid(input instanceof Uint8Array && input.length <= limits.max_event_bytes);
  let value;
  try {
    value = JSON.parse(decoder.decode(input));
  } catch {
    throw new V1Error('INVALID_ARGUMENT');
  }
  return EventEnvelope(value, limits);
}

/**
 * ObjectStore put/get receives trusted tenant scope explicitly. References are
 * opaque keys, never URLs to fetch. Its adapter owns authorization and retention.
 */
export async function createEvent(input, payload, configuredLimits, objectStore) {
  const limits = eventLimits(configuredLimits);
  const body = copyJsonData(input);
  exactFields(body, metadata);
  validateMetadata(body);
  const snapshot = copyJsonData(payload);
  const payloadBytes = bytes(snapshot);
  valid(payloadBytes.length <= limits.max_claim_bytes);
  let value = { ...body, payload: snapshot };
  value.event_id = await identity(value);
  // Metadata may push an otherwise small payload over the transport budget.
  if (
    payloadBytes.length > limits.inline_payload_bytes ||
    bytes(value).length > limits.max_event_bytes
  ) {
    valid(typeof objectStore?.put === 'function');
    const payload_digest = await digestBytes('event-payload', payloadBytes);
    const payload_ref = await objectStore.put({
      tenant_id: body.tenant_id,
      bytes: payloadBytes,
      digest: payload_digest,
    });
    value = { ...body, payload_ref, payload_digest };
    value.event_id = await identity(value);
  }
  return EventEnvelope(value, limits);
}

/** Verify transport and claim identity before any payload reaches a handler. */
export async function readEventPayload(input, configuredLimits, objectStore) {
  const limits = eventLimits(configuredLimits);
  const value = await verifyEventEnvelope(input, limits);
  if (Object.hasOwn(value, 'payload')) return value.payload;
  valid(typeof objectStore?.get === 'function');
  const stored = await objectStore.get({
    tenant_id: value.tenant_id,
    ref: value.payload_ref,
    max_bytes: limits.max_claim_bytes,
  });
  valid(stored instanceof Uint8Array && stored.length <= limits.max_claim_bytes);
  // Snapshot before awaiting the digest; shared adapter buffers are mutable.
  const snapshot = stored.slice();
  if ((await digestBytes('event-payload', snapshot)) !== value.payload_digest) {
    throw new V1Error('INTEGRITY_MISMATCH');
  }
  let payload;
  try {
    payload = JSON.parse(decoder.decode(snapshot));
  } catch {
    throw new V1Error('INVALID_ARGUMENT');
  }
  return freeze(copyJsonData(payload));
}
