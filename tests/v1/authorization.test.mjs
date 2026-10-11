import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthorizationPolicy,
  PrincipalResolver,
  authorizationGrant,
} from '../../core/v1/authorization.mjs';

function fixture() {
  const principal = {
    schema_version: 1,
    actor_id: 'agent',
    tenant_id: 'tenant',
    kind: 'agent',
    capability_id: 'capability',
  };
  const permission = {
    schema_version: 1,
    system_id: 'group',
    action: 'future.observe',
    scope: 'EXACT',
    resources: { repo_id: 'fork', ref: 'refs/heads/main' },
  };
  let grants = [
      {
        schema_version: 1,
        grant_id: 'capability',
        version: 1,
        tenant_id: 'tenant',
        actor_id: 'agent',
        kind: 'agent',
        permissions: [permission],
        not_before_ms: 10,
        expires_at_ms: 100,
        revoked: false,
      },
    ],
    now = 20,
    reads = 0;
  const policy = new AuthorizationPolicy({
    resolveGrants: () => {
      reads += 1;
      return grants;
    },
    now: () => now,
    max_grants: 10,
    max_permissions: 20,
  });
  const request = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    action: 'future.observe',
    repo_id: 'fork',
    ref: 'refs/heads/main',
  };
  return {
    principal,
    permission,
    policy,
    request,
    grants: () => grants,
    setGrants: (value) => {
      grants = value;
    },
    clock: (value) => {
      now = value;
    },
    reads: () => reads,
  };
}

test('agent capabilities match the complete explicit action and resource scope', async () => {
  const f = fixture();
  assert.equal(await f.policy.authorize(f.principal, f.request), true);
  for (const change of [
    { repo_id: 'canonical' },
    { ref: 'refs/heads/other' },
    { action: 'canonical.promote' },
    { system_id: 'other' },
    { tenant_id: 'other' },
    { candidate_digest: 'another-subject' },
  ])
    assert.equal(await f.policy.authorize(f.principal, { ...f.request, ...change }), false);
  assert.equal(
    await f.policy.authorize(f.principal, {
      schema_version: 1,
      tenant_id: 'tenant',
      system_id: 'group',
      kind: 'REF',
      resource_id: { repo_id: 'fork', ref: 'refs/heads/main' },
      action: 'future.observe',
    }),
    true,
  );
  await assert.rejects(
    f.policy.authorize(f.principal, {
      ...f.request,
      kind: 'REF',
      resource_id: { repo_id: 'other', ref: f.request.ref },
    }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('revocation, validity windows and authoritative grant changes apply immediately', async () => {
  const f = fixture();
  assert.equal(await f.policy.authorize(f.principal, f.request), true);
  f.clock(100);
  assert.equal(await f.policy.authorize(f.principal, f.request), false);
  f.clock(9);
  assert.equal(await f.policy.authorize(f.principal, f.request), false);
  f.clock(20);
  f.setGrants(f.grants().map((grant) => ({ ...grant, version: 2, revoked: true })));
  assert.equal(await f.policy.authorize(f.principal, f.request), false);
  assert.equal(f.reads(), 4);
});

test('another principal, capability or foreign grant cannot authorize the request', async () => {
  const f = fixture();
  for (const change of [
    { actor_id: 'other' },
    { capability_id: 'other' },
    { kind: 'service' },
    { tenant_id: 'other' },
  ])
    assert.equal(await f.policy.authorize({ ...f.principal, ...change }, f.request), false);
  f.setGrants(f.grants().map((grant) => ({ ...grant, tenant_id: 'other' })));
  assert.equal(await f.policy.authorize(f.principal, f.request), false);
});

test('system-wide human/service grants are explicit and unavailable to agent capabilities', async () => {
  const f = fixture();
  const grant = {
    ...f.grants()[0],
    kind: 'human',
    permissions: [{ ...f.permission, scope: 'SYSTEM', resources: {} }],
  };
  f.setGrants([grant]);
  assert.equal(
    await f.policy.authorize(
      { ...f.principal, kind: 'human', capability_id: null },
      { ...f.request, repo_id: 'other' },
    ),
    true,
  );
  assert.throws(() => authorizationGrant({ ...grant, kind: 'agent' }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.throws(
    () => authorizationGrant({ ...grant, permissions: [{ ...grant.permissions[0], action: '*' }] }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('grants are immutable snapshots and unresolved registry capacity cannot partially authorize', async () => {
  const f = fixture();
  const grant = authorizationGrant(f.grants()[0]);
  f.grants()[0].permissions[0].resources.repo_id = 'changed';
  assert.equal(grant.permissions[0].resources.repo_id, 'fork');
  f.setGrants(Array.from({ length: 11 }, () => grant));
  await assert.rejects(f.policy.authorize(f.principal, f.request), { code: 'INCOMPLETE_ANALYSIS' });
});

test('identity registry owns tenancy and agent capability instead of token/header claims', async () => {
  const f = fixture();
  const resolver = new PrincipalResolver({
    authenticate: () => ({ actor_id: 'agent', tenant_id: 'spoofed', kind: 'human' }),
    resolveIdentity: () => f.principal,
  });
  assert.deepEqual(
    await resolver.resolve(
      new Request('https://api.example', { headers: { 'X-Tenant-ID': 'spoofed' } }),
    ),
    f.principal,
  );
  const unknown = new PrincipalResolver({
    authenticate: () => ({ actor_id: 'unregistered' }),
    resolveIdentity: () => null,
  });
  await assert.rejects(unknown.resolve(new Request('https://api.example')), { code: 'FORBIDDEN' });
  const substituted = new PrincipalResolver({
    authenticate: () => ({ actor_id: 'other' }),
    resolveIdentity: () => f.principal,
  });
  await assert.rejects(substituted.resolve(new Request('https://api.example')), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('untrusted accessors are never executed and registry outages do not disclose errors', async () => {
  const f = fixture();
  let calls = 0;
  const request = { ...f.request };
  Object.defineProperty(request, 'repo_id', {
    enumerable: true,
    get() {
      calls += 1;
      return 'fork';
    },
  });
  await assert.rejects(f.policy.authorize(f.principal, request), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
  const policy = new AuthorizationPolicy({
    resolveGrants: () => {
      throw new Error('credential=private');
    },
    now: () => 20,
    max_grants: 10,
    max_permissions: 20,
  });
  await assert.rejects(policy.authorize(f.principal, f.request), {
    code: 'PROVIDER_UNAVAILABLE',
    message: 'The provider is unavailable.',
  });
});
