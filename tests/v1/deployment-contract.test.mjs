import assert from 'node:assert/strict';
import test from 'node:test';
import { DeploymentAdapter, buildDeploymentObservation } from '../../core/v1/deployment.mjs';
import { buildSystemRevision, buildReleaseConstraints } from '../../core/v1/releases.mjs';

async function fixture() {
  const revision = await buildSystemRevision({
    schema_version: 1,
    repositories: { app: 'a'.repeat(40) },
    configuration_digests: {},
    accepted_decisions: [],
  });
  const constraints = await buildReleaseConstraints({
    schema_version: 1,
    system_revision_digest: revision.digest,
    ordering_constraints: [],
    compatibility_requirements: [],
    preconditions: [],
    postconditions: [],
    forward_only_operations: [],
  });
  const context = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    principal: { tenant_id: 'tenant', actor_id: 'owner' },
    idempotency_key: 'release',
    trace_id: 'trace',
  };
  let calls = 0,
    captured;
  const transport = {
    async submit(state, contract, options) {
      calls += 1;
      captured = { state, contract, options };
      return { schema_version: 1, external_run_id: 'run-1' };
    },
    async observe() {
      return {
        schema_version: 1,
        status: 'RUNNING',
        method: 'provider-api',
        observed_repositories: null,
      };
    },
  };
  const adapter = (overrides = {}) =>
    new DeploymentAdapter({
      provider_id: 'external',
      transport,
      authorize: (actor, resource) => actor.tenant_id === resource.tenant_id,
      policyEvaluator: { can_promote: () => true },
      now: () => '2026-10-11T00:00:00Z',
      ...overrides,
    });
  return {
    revision,
    constraints,
    context,
    transport,
    adapter,
    calls: () => calls,
    captured: () => captured,
  };
}

test('submission keeps exact state and constraints at the external provider boundary', async () => {
  const f = await fixture();
  const handle = await f.adapter().submit(f.revision, f.constraints, f.context);
  assert.equal(handle.system_revision_digest, f.revision.digest);
  assert.equal(handle.release_constraints_digest, f.constraints.digest);
  assert.equal(handle.external_run_id, 'run-1');
  assert.deepEqual(f.captured().state, f.revision);
  assert.deepEqual(f.captured().contract, f.constraints);
  assert.equal(f.captured().options.operation_id, handle.operation_id);
  assert.equal(Object.isFrozen(f.captured().state.repositories), true);
  assert.equal(
    (await f.adapter().submit(f.revision, f.constraints, { ...f.context, trace_id: 'retry' }))
      .operation_id,
    handle.operation_id,
  );
});

test('substitution, wrong tenant and current policy rejection fail before submission', async () => {
  const f = await fixture();
  await assert.rejects(
    f
      .adapter()
      .submit({ ...f.revision, repositories: { app: 'b'.repeat(40) } }, f.constraints, f.context),
    { code: 'INTEGRITY_MISMATCH' },
  );
  await assert.rejects(
    f
      .adapter()
      .submit(f.revision, f.constraints, {
        ...f.context,
        principal: { tenant_id: 'other', actor_id: 'owner' },
      }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    f
      .adapter({ policyEvaluator: { can_promote: () => false } })
      .submit(f.revision, f.constraints, f.context),
    { code: 'POLICY_REJECTED' },
  );
  assert.equal(f.calls(), 0);
});

test('provider execution observations remain separate from exact deployed state', async () => {
  const f = await fixture();
  const adapter = f.adapter();
  const handle = await adapter.submit(f.revision, f.constraints, f.context);
  const report = await adapter.observe(handle, f.context);
  assert.equal(report.observation.status, 'RUNNING');
  assert.equal(report.observed_repositories, null);
  assert.equal(report.observation.system_revision_digest, f.revision.digest);
  await assert.rejects(adapter.observe({ ...handle, tenant_id: 'other' }, f.context), {
    code: 'FORBIDDEN',
  });
});

test('an unavailable observation yields UNKNOWN without exposing provider errors', async () => {
  const f = await fixture();
  const adapter = f.adapter();
  const handle = await adapter.submit(f.revision, f.constraints, f.context);
  f.transport.observe = async () => {
    throw new Error('token=secret');
  };
  const report = await adapter.observe(handle, f.context);
  assert.equal(report.observation.status, 'UNKNOWN');
  assert.equal(JSON.stringify(report).includes('secret'), false);
  f.transport.submit = async () => {
    throw new Error('token=secret');
  };
  await assert.rejects(adapter.submit(f.revision, f.constraints, f.context), {
    code: 'OUTCOME_UNKNOWN',
    message: 'The operation outcome requires reconciliation.',
  });
});

test('observation identities bind method, time, run and accepted state', async () => {
  const f = await fixture();
  const body = {
    schema_version: 1,
    system_revision_digest: f.revision.digest,
    external_run_id: 'run',
    status: 'UNKNOWN',
    observed_at: '2026-10-11T00:00:00Z',
    method: 'timeout',
  };
  const first = await buildDeploymentObservation(body);
  assert.deepEqual(await buildDeploymentObservation(body), first);
  assert.notEqual(
    (await buildDeploymentObservation({ ...body, status: 'FAILED' })).digest,
    first.digest,
  );
  await assert.rejects(buildDeploymentObservation({ ...body, status: 'TIMED_OUT' }), {
    code: 'INVALID_ARGUMENT',
  });
});
