import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsService } from '../../core/v1/operations.mjs';
import { createOperationsHandler } from '../../api/operations.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';

function fixture() {
  const scope = { schema_version: 1, tenant_id: 'tenant', system_id: 'group' };
  const principal = { actor_id: 'operator', tenant_id: 'tenant' };
  let records = [],
    reads = 0,
    permitted = true,
    failure;
  const observation = (kind, state, version = 1) => ({
    ...scope,
    kind,
    state,
    subject_id: kind.toLowerCase(),
    subject_version: version,
    trace_id: 'trace',
    count: 1,
    occurred_at_ms: version,
    failure_class: null,
  });
  const service = new OperationsService({
    scope,
    registry: {
      read: (queried) => {
        assert.deepEqual(queried, scope);
        reads++;
        if (failure) throw failure;
        return records;
      },
    },
    authorize: (actor, resource) =>
      permitted && actor.actor_id === principal.actor_id && actor.tenant_id === resource.tenant_id,
    max_records: 20,
  });
  const handler = createOperationsHandler({
    service,
    authenticate: (request) =>
      request.headers.get('authorization') === 'Bearer operator' ? principal : null,
  });
  return {
    scope,
    principal,
    service,
    handler,
    observation,
    records: (value) => {
      records = value;
    },
    reads: () => reads,
    revoke: () => {
      permitted = false;
    },
    fail: (error) => {
      failure = error;
    },
  };
}

test('each operational failure points to a bounded read-only recovery view', async () => {
  const f = fixture();
  f.records(
    [
      ['PROVIDER', 'UNAVAILABLE'],
      ['QUEUE', 'DEADLETTERED'],
      ['EXTRACTOR', 'PARTIAL'],
      ['SANDBOX', 'AT_CAPACITY'],
      ['GIT_STORE', 'RATE_LIMITED'],
      ['DEPLOYMENT', 'UNKNOWN'],
      ['ATTESTATION', 'REJECTED'],
    ].map(([kind, state]) => f.observation(kind, state)),
  );
  const report = await f.service.read(f.principal);
  assert.equal(report.derived, true);
  assert.equal(report.status, 'ATTENTION_REQUIRED');
  assert.equal(report.incidents.length, 7);
  assert.equal(new Set(report.incidents.map((incident) => incident.runbook_id)).size, 7);
  assert.equal(
    report.incidents.find((incident) => incident.kind === 'DEPLOYMENT').state,
    'UNKNOWN',
  );
  assert.equal(
    report.incidents.every((incident) => incident.trace_id === 'trace'),
    true,
  );
});

test('order, duplicate rows and older versions do not alter the current operational snapshot', async () => {
  const f = fixture(),
    old = f.observation('PROVIDER', 'UNAVAILABLE'),
    current = f.observation('PROVIDER', 'AVAILABLE', 2),
    queue = f.observation('QUEUE', 'BACKLOG');
  f.records([old, current, queue, current]);
  const first = await f.service.read(f.principal);
  f.records([queue, current, old]);
  const second = await f.service.read(f.principal);
  assert.equal(first.snapshot_digest, second.snapshot_digest);
  assert.deepEqual(first.incidents, second.incidents);
  assert.equal(first.incidents.length, 1);
  assert.equal(first.incidents[0].kind, 'QUEUE');
  f.records([current, { ...current, state: 'UNAVAILABLE' }]);
  await assert.rejects(f.service.read(f.principal), { code: 'INTEGRITY_MISMATCH' });
});

test('an empty or healthy projection makes only a bounded observation claim', async () => {
  const f = fixture();
  assert.equal((await f.service.read(f.principal)).status, 'NO_OBSERVATIONS');
  f.records([f.observation('DEPLOYMENT', 'RUNNING'), f.observation('EXTRACTOR', 'COMPLETE')]);
  const report = await f.service.read(f.principal);
  assert.equal(report.status, 'NO_REPORTED_INCIDENTS');
  assert.equal(report.incidents.length, 0);
  assert.equal(report.retention_class, 'REBUILDABLE');
});

test('tenant authorization precedes reads and rejects mixed-tenant projections', async () => {
  const f = fixture();
  await assert.rejects(f.service.read({ ...f.principal, tenant_id: 'other' }), {
    code: 'FORBIDDEN',
  });
  assert.equal(f.reads(), 0);
  f.records([{ ...f.observation('PROVIDER', 'UNAVAILABLE'), tenant_id: 'other' }]);
  await assert.rejects(f.service.read(f.principal), { code: 'FORBIDDEN' });
  f.revoke();
  await assert.rejects(f.service.read(f.principal), { code: 'FORBIDDEN' });
  assert.equal(f.reads(), 1);
});

test('HTTP operational reads require authentication, reject mutation and sanitize outages', async () => {
  const f = fixture();
  let response = await f.handler(new Request('https://klocgit.test/operations'));
  assert.equal(response.status, 401);
  assert.equal(f.reads(), 0);
  response = await f.handler(new Request('https://klocgit.test/operations', { method: 'POST' }));
  assert.equal(response.status, 405);
  f.records([f.observation('GIT_STORE', 'UNAVAILABLE')]);
  const request = () =>
    new Request('https://klocgit.test/operations', {
      headers: { authorization: 'Bearer operator' },
    });
  response = await f.handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).incidents[0].kind, 'GIT_STORE');
  f.fail(new Error('private-provider-credential'));
  response = await f.handler(request());
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('private-provider-credential'), false);
  f.fail(new V1Error('PROVIDER_UNAVAILABLE'));
  assert.equal((await f.handler(request())).status, 503);
});

test('capacity and schema errors cannot silently truncate or invent incident information', async () => {
  const f = fixture();
  f.records(Array.from({ length: 21 }, (_, i) => f.observation('QUEUE', 'BACKLOG', i + 1)));
  await assert.rejects(f.service.read(f.principal), { code: 'INCOMPLETE_ANALYSIS' });
  f.records([{ ...f.observation('PROVIDER', 'UNAVAILABLE'), response_body: 'secret' }]);
  await assert.rejects(f.service.read(f.principal), { code: 'INVALID_ARGUMENT' });
  f.records([f.observation('DEPLOYMENT', 'INFERRED_FAILURE')]);
  await assert.rejects(f.service.read(f.principal), { code: 'INVALID_ARGUMENT' });
});
