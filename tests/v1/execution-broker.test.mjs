import assert from 'node:assert/strict';
import test from 'node:test';
import { SecretNetworkBroker, containsSecret } from '../../core/v1/execution-broker.mjs';
import { digestBytes } from '../../core/v1/conventions.mjs';

async function fixture() {
  const bytes = new TextEncoder().encode('registered public resource');
  const digest = await digestBytes('broker-resource', bytes);
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    candidate_digest: await digestBytes('object-candidate', bytes),
    trace_id: 'trace',
  };
  const resource = {
    schema_version: 1,
    id: 'resource',
    tenant_id: 'tenant',
    system_id: 'group',
    candidate_digest: scope.candidate_digest,
    digest,
    kind: 'HTTP_READ',
    url: 'https://resources.example/data',
    credential_id: 'read-only-credential',
  };
  const audit = [],
    requests = [],
    secret = new TextEncoder().encode('private-read-token');
  let permitted = true,
    publicBytes = bytes,
    purpose = 'sandbox-resource-read',
    resourceId = 'resource';
  const broker = new SecretNetworkBroker({
    tenant_id: 'tenant',
    system_id: 'group',
    principal: {
      schema_version: 1,
      actor_id: 'evaluator',
      tenant_id: 'tenant',
      kind: 'service',
      capability_id: null,
    },
    authorize: () => permitted,
    resolveResource: () => resource,
    readObject: () => publicBytes,
    resolveSecret: () => ({
      schema_version: 1,
      purpose,
      resource_id: resourceId,
      expires_ms: 100,
      bytes: secret,
    }),
    secretGuard: (bytes) => !containsSecret(bytes, [secret]),
    audit: (record) => {
      audit.push(record);
    },
    allowed_origins: ['https://resources.example'],
    fetch: (url, options) => {
      requests.push({ url, headers: { ...options.headers }, redirect: options.redirect });
      return new Response(publicBytes);
    },
    max_bytes: 1024,
    timeout_ms: 1000,
    now: () => 0,
  });
  return {
    broker,
    bytes,
    scope,
    resource,
    audit,
    requests,
    secret,
    allow: (value) => {
      permitted = value;
    },
    response: (value) => {
      publicBytes = value;
    },
    purpose: (value) => {
      purpose = value;
    },
    secretResource: (value) => {
      resourceId = value;
    },
  };
}

test('registered broker reads use host credentials without returning or auditing them', async () => {
  const f = await fixture();
  const returned = await f.broker.read('resource', f.scope);
  assert.deepEqual(returned, f.bytes);
  assert.equal(f.requests[0].headers.authorization, 'Bearer private-read-token');
  assert.equal(f.requests[0].redirect, 'error');
  assert.equal(JSON.stringify(f.audit).includes('private-read-token'), false);
  assert.equal(new TextDecoder().decode(f.secret), 'private-read-token');
  assert.deepEqual(
    f.audit.map((record) => record.to_state),
    ['REQUESTED', 'VERIFIED'],
  );
});

test('missing grants, foreign tenants, wrong candidates and unregistered origins deny network access', async () => {
  const f = await fixture();
  f.allow(false);
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
  f.allow(true);
  await assert.rejects(f.broker.read('resource', { ...f.scope, tenant_id: 'other' }), {
    code: 'FORBIDDEN',
  });
  f.resource.candidate_digest = await digestBytes('object-candidate', new Uint8Array([1]));
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
  f.resource.candidate_digest = f.scope.candidate_digest;
  f.resource.url = 'https://unregistered.example';
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
  assert.equal(f.requests.length, 0);
});

test('canonical-purpose and differently scoped secrets cannot enter broker operations', async () => {
  const f = await fixture();
  f.purpose('canonical-git');
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
  assert.equal(new TextDecoder().decode(f.secret), 'private-read-token');
  f.purpose('sandbox-resource-read');
  f.secretResource('another-resource');
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
  assert.equal(f.requests.length, 0);
  assert.equal(new TextDecoder().decode(f.secret), 'private-read-token');
});

test('echoed credentials, common encodings, substituted content and oversized responses are rejected', async () => {
  const f = await fixture();
  for (const value of [
    'private-read-token',
    btoa('private-read-token'),
    encodeURIComponent('private-read-token'),
    [...f.secret].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  ]) {
    f.response(new TextEncoder().encode(value));
    await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
  }
  f.response(new Uint8Array([1]));
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'INTEGRITY_MISMATCH' });
  f.response(new Uint8Array(1025));
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'INCOMPLETE_ANALYSIS' });
});

test('object resources also require exact digest and secret screening without network fallback', async () => {
  const f = await fixture();
  Object.assign(f.resource, { kind: 'OBJECT', payload_ref: 'registered-object' });
  assert.deepEqual(await f.broker.read('resource', f.scope), f.bytes);
  assert.equal(f.requests.length, 0);
  f.response(f.secret);
  f.resource.digest = await digestBytes('broker-resource', f.secret);
  await assert.rejects(f.broker.read('resource', f.scope), { code: 'FORBIDDEN' });
});
