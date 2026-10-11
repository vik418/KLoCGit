import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableRequest, durableRuntime } from '../support/durable-runtime.mjs';

const scope = {
  schema_version: 1,
  tenant_id: 'tenant',
  system_id: 'system',
  kind: 'OBJECTIVE',
  resource_id: 'objective',
};

test('Durable Object state survives complete runtime eviction and restart', async (t) => {
  const persist = await mkdtemp(join(tmpdir(), 'klocgit-do-restart-'));
  let runtime;
  t.after(async () => {
    await runtime?.dispose();
    await rm(persist, { recursive: true, force: true });
  });
  runtime = await durableRuntime(persist);
  const value = {
    schema_version: 1,
    authorization: { expected_oid: 'a'.repeat(40), basis: 'reviewed' },
  };
  assert.equal((await durableRequest(runtime, { scope, operation: 'put', value })).status, 200);
  await runtime.dispose();
  runtime = await durableRuntime(persist);
  assert.deepEqual((await durableRequest(runtime, { scope, operation: 'get' })).body, value);
});

test('Durable Object concurrent transactions and aborts preserve exact state', async (t) => {
  const runtime = await durableRuntime(false);
  t.after(() => runtime.dispose());
  const responses = await Promise.all(
    Array.from({ length: 32 }, () => durableRequest(runtime, { scope, operation: 'increment' })),
  );
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(
    responses.map((response) => response.body.value).sort((a, b) => a - b),
    Array.from({ length: 32 }, (_, i) => i + 1),
  );
  assert.equal((await durableRequest(runtime, { scope, operation: 'abort' })).status, 409);
  assert.equal((await durableRequest(runtime, { scope, operation: 'increment' })).body.value, 33);
});

test('Durable Object binding rejects routing a second tenant into the same object', async (t) => {
  const runtime = await durableRuntime(false);
  t.after(() => runtime.dispose());
  const object_override = 'intentionally-misrouted-object';
  const value = { schema_version: 1, confidential: true };
  await durableRequest(runtime, { scope, object_override, operation: 'put', value });
  const result = await durableRequest(runtime, {
    scope: { ...scope, tenant_id: 'other' },
    object_override,
    operation: 'get',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'FORBIDDEN');
});
