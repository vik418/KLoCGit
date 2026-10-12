import { hashProjection, payloadDigest } from '../../../packages/contracts/src/index.ts';
import { sameScope, signToken, verifyToken } from './auth.ts';
import type { InternalGrant } from './auth.ts';
import { Failure, validateScope } from './runtime.ts';
import type { Bindings, Scope } from './runtime.ts';

const encoder = new TextEncoder();
export const INLINE_LIMIT = 32 * 1024;
export const QUEUE_LIMIT = 128 * 1024;
const PAYLOAD_LIMIT = 8 * 1024 * 1024;

export interface EventEnvelope {
  schema_version: 1;
  event_id: string;
  trace_id: string;
  idempotency_key: string;
  type: string;
  scope: Scope;
  subject_version: number;
  payload_digest: string;
  payload?: unknown;
  payload_ref?: string;
  authorization: string;
}

function descriptor(envelope: Omit<EventEnvelope, 'authorization'>) {
  return {
    schema_version: envelope.schema_version, event_id: envelope.event_id,
    trace_id: envelope.trace_id, idempotency_key: envelope.idempotency_key,
    type: envelope.type, scope: envelope.scope, subject_version: envelope.subject_version,
    payload_digest: envelope.payload_digest,
  };
}

export async function packEvent(env: Bindings, options: {
  type: string; scope: Scope; subject_version: number; payload: unknown;
  idempotency_key: string; trace_id: string; actor_id: string; expires_at: number;
}): Promise<EventEnvelope> {
  validateScope(options.scope);
  if (!Number.isSafeInteger(options.subject_version) || options.subject_version < 1
    || !options.idempotency_key || options.idempotency_key.length > 256 || options.trace_id.length > 128) {
    throw new Failure('INVALID_EVENT', 400, 'Invalid event identity or version');
  }
  const bytes = encoder.encode(JSON.stringify(options.payload));
  if (bytes.length > PAYLOAD_LIMIT) throw new Failure('PAYLOAD_TOO_LARGE', 413, 'Event payload exceeds limit');
  const payload_digest = await payloadDigest(bytes);
  const envelope: Omit<EventEnvelope, 'authorization'> = {
    schema_version: 1, event_id: options.idempotency_key, trace_id: options.trace_id,
    idempotency_key: options.idempotency_key, type: options.type, scope: options.scope,
    subject_version: options.subject_version, payload_digest,
  };
  const grant: InternalGrant = {
    schema_version: 1, aud: 'queue', action: 'dispatch', scope: options.scope,
    actor_id: options.actor_id, expires_at: options.expires_at,
    subject_digest: await hashProjection('klocgit.event', descriptor(envelope)),
  };
  const authorization = await signToken(grant, env.INTERNAL_SIGNING_KEY);
  const inline = { ...envelope, payload: options.payload, authorization };
  if (encoder.encode(JSON.stringify(inline)).length < INLINE_LIMIT) return inline;
  const payload_ref = 'events/' + options.scope.tenant_id + '/' + payload_digest.slice(7);
  const existing = await env.PAYLOADS.get(payload_ref);
  if (existing) {
    if (await payloadDigest(new Uint8Array(await existing.arrayBuffer())) !== payload_digest) throw new Failure('PAYLOAD_CORRUPT', 409, 'Content-addressed payload differs');
  } else {
    await env.PAYLOADS.put(payload_ref, bytes, {
      customMetadata: { retention_class: 'REBUILDABLE', payload_digest, schema_version: '1' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
  }
  const referenced = { ...envelope, payload_ref, authorization };
  if (encoder.encode(JSON.stringify(referenced)).length >= QUEUE_LIMIT) throw new Failure('PAYLOAD_TOO_LARGE', 413, 'Queue envelope exceeds limit');
  return referenced;
}

export async function unpackEvent(env: Bindings, envelope: EventEnvelope): Promise<unknown> {
  if (encoder.encode(JSON.stringify(envelope)).length >= QUEUE_LIMIT || envelope.schema_version !== 1
    || !envelope.event_id || envelope.event_id !== envelope.idempotency_key
    || !envelope.trace_id || envelope.trace_id.length > 128 || envelope.idempotency_key.length > 256
    || !Number.isSafeInteger(envelope.subject_version) || envelope.subject_version < 1
    || !/^sha256:[0-9a-f]{64}$/.test(envelope.payload_digest)
    || (Object.hasOwn(envelope, 'payload') === Object.hasOwn(envelope, 'payload_ref'))) {
    throw new Failure('INVALID_EVENT', 400, 'Invalid queue envelope');
  }
  validateScope(envelope.scope);
  const grant = await verifyToken<InternalGrant>(envelope.authorization, env.INTERNAL_SIGNING_KEY);
  const expected = await hashProjection('klocgit.event', descriptor(envelope));
  if (grant.schema_version !== 1 || grant.aud !== 'queue' || grant.action !== 'dispatch'
    || grant.subject_digest !== expected || grant.expires_at <= Date.now()
    || !sameScope(grant.scope, envelope.scope)) throw new Failure('FORBIDDEN', 403, 'Invalid event authorization');
  let bytes: Uint8Array;
  if (envelope.payload_ref !== undefined) {
    if (envelope.payload_ref !== 'events/' + envelope.scope.tenant_id + '/' + envelope.payload_digest.slice(7)) throw new Failure('FORBIDDEN', 403, 'Payload reference is outside its scope');
    const object = await env.PAYLOADS.get(envelope.payload_ref);
    if (!object || object.size > PAYLOAD_LIMIT) throw new Failure('PAYLOAD_MISSING', 503, 'Claim-check payload is unavailable');
    bytes = new Uint8Array(await object.arrayBuffer());
  } else {
    if (encoder.encode(JSON.stringify(envelope)).length >= INLINE_LIMIT) throw new Failure('INVALID_EVENT', 400, 'Oversized inline event');
    bytes = encoder.encode(JSON.stringify(envelope.payload));
  }
  if (await payloadDigest(bytes) !== envelope.payload_digest) throw new Failure('PAYLOAD_CORRUPT', 409, 'Claim-check digest verification failed');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Failure('INVALID_EVENT', 400, 'Invalid event payload'); }
}
