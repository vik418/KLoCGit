import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  SCHEMA_VERSION,
  ERROR_TAXONOMY,
  V1Error,
  publicError,
  assertSchemaVersion,
  digestBytes,
  parseDigest,
  objectId,
  parseObjectId,
  assertIdempotencyKey,
  operationId,
} from '../../core/v1/conventions.mjs';

const golden = JSON.parse(
  await readFile(new URL('./conventions.golden.json', import.meta.url), 'utf8'),
);
const candidateVector = golden.digest_vectors.find((vector) => vector.id?.includes(':candidate:'));
const scope = golden.operation_vectors[0].scope;

test('literal digest vectors agree with both Web Crypto and Node SHA-256', async () => {
  for (const vector of [...golden.digest_vectors, ...golden.operation_vectors]) {
    const bytes = Buffer.from(vector.payload_hex, 'hex');
    const framed = Buffer.concat([
      Buffer.from('klocgit:v1:' + vector.domain + '\0', 'utf8'),
      bytes,
    ]);
    assert.equal(framed.toString('hex'), vector.framed_hex, vector.label);
    assert.equal(
      'sha256:' + vector.domain + ':v1:' + createHash('sha256').update(framed).digest('hex'),
      vector.digest,
      vector.label,
    );
    assert.equal(await digestBytes(vector.domain, bytes), vector.digest, vector.label);
  }
});

test('content-addressed IDs and parsed identities match literal vectors', () => {
  for (const vector of golden.digest_vectors.filter((entry) => entry.id)) {
    const kind = vector.domain.slice('object-'.length);
    assert.equal(objectId(kind, vector.digest), vector.id);
    assert.deepEqual(parseObjectId(vector.id, kind), {
      kind,
      algorithm: 'sha256',
      schema_version: 1,
      hex: vector.digest.split(':').at(-1),
      digest: vector.digest,
    });
  }
});

test('identical bytes in different domains have different identities', async () => {
  const bytes = Buffer.from('abc');
  assert.notEqual(
    await digestBytes('object-candidate', bytes),
    await digestBytes('object-evidence', bytes),
  );
  assert.throws(() => objectId('evidence', candidateVector.digest), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.throws(() => parseObjectId(candidateVector.id, 'evidence'), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('digest input is captured before an asynchronous caller mutation', async () => {
  const bytes = new Uint8Array([97, 98, 99]);
  const pending = digestBytes('object-candidate', bytes);
  bytes.fill(0);
  assert.equal(await pending, candidateVector.digest);
});

test('hashing accepts encoded bytes and rejects implicit object or string encoding', async () => {
  for (const input of ['abc', { schema_version: 1 }, [97, 98, 99], new ArrayBuffer(3), null]) {
    await assert.rejects(digestBytes('object-candidate', input), { code: 'INVALID_ARGUMENT' });
  }
});

test('v1 parsers reject malformed, noncanonical and historical v0 identities', () => {
  for (const digest of [
    candidateVector.digest.replace('sha256:', 'sha512:'),
    candidateVector.digest.toUpperCase(),
    candidateVector.digest.replace(':v1:', ':v01:'),
    candidateVector.digest.slice(0, -1),
    candidateVector.digest + '\n',
    'sha256:object-candidate:v1:' + 'f'.repeat(63) + 'g',
  ]) {
    assert.throws(() => parseDigest(digest), { code: 'INVALID_ARGUMENT' });
  }
  for (const id of [
    candidateVector.id.replace(':sha256:', ':sha512:'),
    candidateVector.id.replace(':v1:', ':v01:'),
    candidateVector.id.toUpperCase(),
    candidateVector.id + '\n',
    'candidate_' + 'a'.repeat(64),
  ]) {
    assert.throws(() => parseObjectId(id), { code: 'INVALID_ARGUMENT' });
  }
});

test('future wire versions fail explicitly instead of being interpreted as v1', () => {
  assert.throws(() => parseDigest(candidateVector.digest.replace(':v1:', ':v2:')), {
    code: 'UNSUPPORTED_SCHEMA_VERSION',
  });
  assert.throws(() => parseObjectId(candidateVector.id.replace(':v1:', ':v2:')), {
    code: 'UNSUPPORTED_SCHEMA_VERSION',
  });
});

test('domain and kind grammar excludes separator and Unicode ambiguity', async () => {
  for (const domain of ['', 'Object', 'a:b', 'a\0b', 'a/b', 'évidence', 'a--b', 'a'.repeat(65)]) {
    await assert.rejects(digestBytes(domain, new Uint8Array()), { code: 'INVALID_ARGUMENT' });
  }
  for (const kind of ['', 'Candidate', 'a:b', 'a\0b', 'évidence', 'a'.repeat(49)]) {
    assert.throws(() => objectId(kind, candidateVector.digest), { code: 'INVALID_ARGUMENT' });
  }
});

test('lexical validators require the entire input including line terminators', async () => {
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    await assert.rejects(digestBytes('object-candidate' + terminator, new Uint8Array()), {
      code: 'INVALID_ARGUMENT',
    });
    assert.throws(() => objectId('candidate' + terminator, candidateVector.digest), {
      code: 'INVALID_ARGUMENT',
    });
    assert.throws(() => parseDigest(candidateVector.digest + terminator), {
      code: 'INVALID_ARGUMENT',
    });
    assert.throws(() => parseObjectId(candidateVector.id + terminator), {
      code: 'INVALID_ARGUMENT',
    });
    assert.throws(() => assertIdempotencyKey(scope.idempotency_key + terminator), {
      code: 'INVALID_ARGUMENT',
    });
    await assert.rejects(operationId({ ...scope, action: scope.action + terminator }), {
      code: 'INVALID_ARGUMENT',
    });
  }
});

test('schema_version must be an own positive integer field with supported value', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(assertSchemaVersion({ schema_version: 1 }), 1);
  for (const value of [
    null,
    [],
    {},
    { schema_version: '1' },
    { schema_version: 0 },
    { schema_version: 1.5 },
    { schema_version: Infinity },
    Object.create({ schema_version: 1 }),
  ]) {
    assert.throws(() => assertSchemaVersion(value), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => assertSchemaVersion({ schema_version: 2 }), {
    code: 'UNSUPPORTED_SCHEMA_VERSION',
  });
});

test('public errors match literal golden records with safe retry classification', () => {
  for (const vector of golden.error_vectors) {
    const error = vector.input_code ? new V1Error(vector.input_code) : new Error('private value');
    assert.deepEqual(publicError(error), vector.record);
    assert.equal(Object.isFrozen(publicError(error)), true);
  }
  assert.equal(publicError(new V1Error('OUTCOME_UNKNOWN')).retry_strategy, 'RECONCILE');
});

test('untrusted errors cannot choose public messages or expose private fields', () => {
  const secret = 'private-provider-credential';
  const error = new Error(secret, { cause: new Error(secret) });
  error.code = 'FORBIDDEN';
  error.details = { authorization: secret };
  error.stack = secret;
  const record = publicError(error);
  assert.equal(record.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(record).includes(secret));
  assert.deepEqual(Object.keys(record), [
    'schema_version',
    'code',
    'failure_class',
    'retry_strategy',
    'message',
  ]);
});

test('prototype-shaped errors and code accessors cannot escape the taxonomy', () => {
  const unknown = Object.assign(Object.create(V1Error.prototype), {
    code: 'private-provider-token',
  });
  const accessor = Object.create(V1Error.prototype);
  Object.defineProperty(accessor, 'code', {
    get() {
      throw new Error('private-provider-token');
    },
  });
  for (const error of [unknown, accessor, Object.create(V1Error.prototype)]) {
    assert.equal(publicError(error).code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(publicError(error)).includes('private-provider-token'));
  }
});

test('the error taxonomy is closed and its definitions cannot be mutated', () => {
  assert.deepEqual(Object.keys(ERROR_TAXONOMY), [
    'INVALID_ARGUMENT',
    'UNSUPPORTED_SCHEMA_VERSION',
    'UNSUPPORTED_CAPABILITY',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'STALE_BASIS',
    'IDEMPOTENCY_CONFLICT',
    'INCOMPLETE_ANALYSIS',
    'POLICY_REJECTED',
    'INTEGRITY_MISMATCH',
    'RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'OUTCOME_UNKNOWN',
    'INTERNAL_ERROR',
  ]);
  assert.throws(() => new V1Error('PROVIDER_SECRET'), TypeError);
  const error = new V1Error('STALE_BASIS');
  assert.throws(() => {
    error.code = 'FORBIDDEN';
  }, TypeError);
  assert.throws(() => {
    ERROR_TAXONOMY.STALE_BASIS.message = 'changed';
  }, TypeError);
});

test('scoped operation IDs match ASCII and Unicode golden vectors', async () => {
  for (const vector of golden.operation_vectors) {
    assert.equal(await operationId(vector.scope), vector.id);
    assert.equal(await operationId({ ...vector.scope }), vector.id);
  }
});

test('an operation key is scoped by tenant, resource and action', async () => {
  const original = await operationId(scope);
  for (const change of [
    { tenant_id: 'tenant-b' },
    { resource_id: 'repo-b' },
    { action: 'candidate.evaluate' },
    { idempotency_key: 'another-key' },
  ]) {
    assert.notEqual(await operationId({ ...scope, ...change }), original);
  }
});

test('length prefixes prevent delimiter and field-boundary collisions', async () => {
  assert.notEqual(
    await operationId({ ...scope, tenant_id: 'a', resource_id: 'bc' }),
    await operationId({ ...scope, tenant_id: 'ab', resource_id: 'c' }),
  );
  assert.notEqual(
    await operationId({ ...scope, tenant_id: 'a:b', resource_id: 'c' }),
    await operationId({ ...scope, tenant_id: 'a', resource_id: 'b:c' }),
  );
});

test('scope identity preserves case and Unicode without lossy normalization', async () => {
  assert.notEqual(
    await operationId({ ...scope, tenant_id: 'Tenant' }),
    await operationId({ ...scope, tenant_id: 'tenant' }),
  );
  assert.notEqual(
    await operationId({ ...scope, resource_id: '\u00e9' }),
    await operationId({ ...scope, resource_id: 'e\u0301' }),
  );
  for (const invalid of ['\ud800', '\udfff', 'a\ud800b', '\ud800\ud800']) {
    await assert.rejects(operationId({ ...scope, resource_id: invalid }), {
      code: 'INVALID_ARGUMENT',
    });
  }
});

test('caller idempotency keys are bounded ASCII values and never normalized', () => {
  for (const key of ['a', 'a'.repeat(128), scope.idempotency_key, 'Key._~-']) {
    assert.equal(assertIdempotencyKey(key), key);
  }
  for (const key of ['', 'a'.repeat(129), 'a b', '\nkey', 'a:b', 'é', null, 1]) {
    assert.throws(() => assertIdempotencyKey(key), { code: 'INVALID_ARGUMENT' });
  }
});

test('operation identity rejects missing scope and malformed action', async () => {
  for (const invalid of [null, [], {}, Object.create(scope)]) {
    await assert.rejects(operationId(invalid), { code: 'INVALID_ARGUMENT' });
  }
  for (const change of [
    { tenant_id: '' },
    { resource_id: null },
    { action: 'Candidate.Promote' },
    { action: 'candidate/promote' },
    { action: 'a'.repeat(65) },
    { idempotency_key: '' },
  ]) {
    await assert.rejects(operationId({ ...scope, ...change }), { code: 'INVALID_ARGUMENT' });
  }
});
