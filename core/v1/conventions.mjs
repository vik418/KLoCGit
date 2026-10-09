/**
 * v1 wire conventions. Object canonicalization belongs to T011; these helpers
 * hash only bytes that a caller has already encoded.
 */
export const SCHEMA_VERSION = 1;

const definitions = {
  INVALID_ARGUMENT: ['VALIDATION', 'NEVER', 'The input is invalid.'],
  UNSUPPORTED_SCHEMA_VERSION: ['UNSUPPORTED', 'NEVER', 'The schema version is unsupported.'],
  UNSUPPORTED_CAPABILITY: ['UNSUPPORTED', 'NEVER', 'The required capability is unsupported.'],
  UNAUTHENTICATED: ['AUTHORIZATION', 'NEVER', 'Authentication is required.'],
  FORBIDDEN: ['AUTHORIZATION', 'NEVER', 'The action is not permitted.'],
  NOT_FOUND: ['NOT_FOUND', 'NEVER', 'The resource was not found.'],
  CONFLICT: ['CONFLICT', 'NEVER', 'The operation conflicts with current state.'],
  STALE_BASIS: ['CONFLICT', 'NEVER', 'The reviewed basis is stale.'],
  IDEMPOTENCY_CONFLICT: [
    'CONFLICT',
    'NEVER',
    'The idempotency key was already used for different input.',
  ],
  INCOMPLETE_ANALYSIS: ['INCOMPLETE', 'NEVER', 'Required analysis is incomplete.'],
  POLICY_REJECTED: ['POLICY', 'NEVER', 'The operation does not satisfy policy.'],
  INTEGRITY_MISMATCH: ['INTEGRITY', 'NEVER', 'The content does not match its expected identity.'],
  RATE_LIMITED: ['TRANSIENT', 'BACKOFF', 'The operation is rate limited.'],
  PROVIDER_UNAVAILABLE: ['TRANSIENT', 'BACKOFF', 'The provider is unavailable.'],
  OUTCOME_UNKNOWN: ['AMBIGUOUS', 'RECONCILE', 'The operation outcome requires reconciliation.'],
  INTERNAL_ERROR: ['INTERNAL', 'NEVER', 'An internal error occurred.'],
};

export const ERROR_TAXONOMY = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([code, [failure_class, retry_strategy, message]]) => [
      code,
      Object.freeze({ failure_class, retry_strategy, message }),
    ]),
  ),
);

/** Fixed public messages prevent provider errors from leaking credentials. */
export class V1Error extends Error {
  constructor(code) {
    if (typeof code !== 'string' || !Object.hasOwn(ERROR_TAXONOMY, code)) {
      throw new TypeError('Unknown v1 error code.');
    }
    super(ERROR_TAXONOMY[code].message);
    this.name = 'V1Error';
    this.code = code;
    Object.freeze(this);
  }
}

/** Return only the closed public taxonomy, never arbitrary exception fields. */
export function publicError(error) {
  const value =
    error instanceof V1Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  const code =
    typeof value === 'string' && Object.hasOwn(ERROR_TAXONOMY, value) ? value : 'INTERNAL_ERROR';
  return Object.freeze({ schema_version: SCHEMA_VERSION, code, ...ERROR_TAXONOMY[code] });
}

export function assertSchemaVersion(record) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    !Object.hasOwn(record, 'schema_version') ||
    !Number.isSafeInteger(record.schema_version) ||
    record.schema_version < 1
  ) {
    throw new V1Error('INVALID_ARGUMENT');
  }
  if (record.schema_version !== SCHEMA_VERSION) {
    throw new V1Error('UNSUPPORTED_SCHEMA_VERSION');
  }
  return SCHEMA_VERSION;
}

const namePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const digestPattern = /^sha256:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):v([1-9][0-9]*):([a-f0-9]{64})$/;
const idPattern = /^klocgit:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):v([1-9][0-9]*):sha256:([a-f0-9]{64})$/;
const encoder = new TextEncoder();

function assertName(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !namePattern.test(value)) {
    throw new V1Error('INVALID_ARGUMENT');
  }
}

function assertVersion(version) {
  if (version !== String(SCHEMA_VERSION)) throw new V1Error('UNSUPPORTED_SCHEMA_VERSION');
}

/**
 * Hash a versioned, domain-separated frame followed by exact encoded bytes.
 * Copy before awaiting Web Crypto so later caller mutation cannot alter the input.
 */
export async function digestBytes(domain, encoded) {
  assertName(domain, 64);
  if (!(encoded instanceof Uint8Array)) throw new V1Error('INVALID_ARGUMENT');
  const prefix = encoder.encode('klocgit:v1:' + domain + '\0');
  const framed = new Uint8Array(prefix.length + encoded.length);
  framed.set(prefix);
  framed.set(encoded, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', framed));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return 'sha256:' + domain + ':v1:' + hex;
}

export function parseDigest(value, expectedDomain) {
  const match = typeof value === 'string' ? digestPattern.exec(value) : null;
  if (!match) throw new V1Error('INVALID_ARGUMENT');
  const [, domain, version, hex] = match;
  assertName(domain, 64);
  assertVersion(version);
  if (expectedDomain !== undefined) {
    assertName(expectedDomain, 64);
    if (domain !== expectedDomain) throw new V1Error('INTEGRITY_MISMATCH');
  }
  return Object.freeze({ algorithm: 'sha256', domain, schema_version: SCHEMA_VERSION, hex });
}

/** Only a digest in this object's namespace can become its content-addressed ID. */
export function objectId(kind, digest) {
  assertName(kind, 48);
  const { hex } = parseDigest(digest, 'object-' + kind);
  return 'klocgit:' + kind + ':v1:sha256:' + hex;
}

export function parseObjectId(value, expectedKind) {
  const match = typeof value === 'string' ? idPattern.exec(value) : null;
  if (!match) throw new V1Error('INVALID_ARGUMENT');
  const [, kind, version, hex] = match;
  assertName(kind, 48);
  assertVersion(version);
  if (expectedKind !== undefined) {
    assertName(expectedKind, 48);
    if (kind !== expectedKind) throw new V1Error('INTEGRITY_MISMATCH');
  }
  return Object.freeze({
    kind,
    algorithm: 'sha256',
    schema_version: SCHEMA_VERSION,
    hex,
    digest: 'sha256:object-' + kind + ':v1:' + hex,
  });
}

/** The 128-character bound is a v1 protocol choice, not a provider limit. */
export function assertIdempotencyKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    throw new V1Error('INVALID_ARGUMENT');
  }
  return key;
}

function scopeBytes(value) {
  if (typeof value !== 'string' || !value.length) throw new V1Error('INVALID_ARGUMENT');
  // TextEncoder replaces unpaired surrogates. Reject them to keep distinct IDs distinct.
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new V1Error('INVALID_ARGUMENT');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new V1Error('INVALID_ARGUMENT');
    }
  }
  return encoder.encode(value);
}

/**
 * Identify a logical attempt across retries. Authorization and request-digest
 * binding must be checked by the consumer; this identifier grants no permission.
 */
export async function operationId(scope) {
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    !['tenant_id', 'resource_id', 'action', 'idempotency_key'].every((field) =>
      Object.hasOwn(scope, field),
    )
  ) {
    throw new V1Error('INVALID_ARGUMENT');
  }
  const { tenant_id, resource_id, action, idempotency_key } = scope;
  assertIdempotencyKey(idempotency_key);
  if (
    typeof action !== 'string' ||
    action.length > 64 ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(action)
  ) {
    throw new V1Error('INVALID_ARGUMENT');
  }
  const fields = [tenant_id, resource_id, action, idempotency_key].map(scopeBytes);
  // Length-prefix the fixed-order tuple so separators in scope IDs cannot collide.
  const encoded = new Uint8Array(
    4 + fields.reduce((length, field) => length + 4 + field.length, 0),
  );
  const view = new DataView(encoded.buffer);
  view.setUint32(0, fields.length, false);
  let offset = 4;
  for (const field of fields) {
    view.setUint32(offset, field.length, false);
    offset += 4;
    encoded.set(field, offset);
    offset += field.length;
  }
  return objectId('operation', await digestBytes('object-operation', encoded));
}
