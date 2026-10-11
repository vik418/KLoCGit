import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { DeploymentCoordinator } from '../../core/v1/deployment-reconciliation.mjs';
import { buildDeploymentObservation } from '../../core/v1/deployment.mjs';
import { buildSystemRevision } from '../../core/v1/releases.mjs';
import { operationId } from '../../core/v1/conventions.mjs';
import { releaseFixture, deploymentAdapter } from './support/deployment.mjs';

async function fixture(t, settings = {}) {
  const f = await releaseFixture();
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-deployment-'));
  const backends = [];
  const connect = () => {
    const backend = new SqliteCoordinationBackend({
      filename: join(directory, 'state.sqlite'),
      busy_timeout_ms: 1000,
    });
    backends.push(backend);
    return new CoordinationStore(backend);
  };
  t.after(async () => {
    backends.forEach((backend) => backend.close());
    await rm(directory, { recursive: true, force: true });
  });
  let now = 0,
    submitted = 0,
    observed = 0,
    status = 'RUNNING',
    submitHook,
    observeHook,
    allowed = true,
    eventAllowed = true;
  const adapter = deploymentAdapter(
    {
      submit: async () => {
        submitted += 1;
        if (submitHook) await submitHook();
        return { schema_version: 1, external_run_id: 'run' };
      },
      observe: async () => {
        observed += 1;
        if (observeHook) await observeHook();
        return { schema_version: 1, status, method: 'external-api', observed_repositories: null };
      },
    },
    'provider',
  );
  const store = connect();
  const create = (store) =>
    new DeploymentCoordinator({
      store,
      providers: { provider: { adapter, verify_event: () => eventAllowed } },
      authorize: (actor, resource) => allowed && actor.tenant_id === resource.tenant_id,
      policyEvaluator: { can_promote: () => true },
      now: () => now,
      random: () => 0.5,
      settings: {
        schema_version: 1,
        webhook_grace_ms: 100,
        poll_base_ms: 100,
        poll_max_ms: 800,
        lease_ms: 1000,
        concurrency_cap: 2,
        max_calls_per_window: 20,
        rate_window_ms: 1000,
        max_event_bytes: 8192,
        ...settings,
      },
    });
  const service = create(store);
  const event = async (record, version, status = 'SUCCEEDED') => ({
    schema_version: 1,
    event_id: 'event-' + version,
    version,
    operation_id: record.operation_id,
    handle: record.handle,
    report: {
      schema_version: 1,
      observation: await buildDeploymentObservation({
        schema_version: 1,
        system_revision_digest: f.revision.digest,
        external_run_id: 'run',
        status,
        observed_at: '2026-10-11T00:00:00Z',
        method: 'authenticated-event',
      }),
      observed_repositories: status === 'SUCCEEDED' ? f.revision.repositories : null,
    },
  });
  return {
    ...f,
    store,
    service,
    event,
    create,
    connect,
    submitted: () => submitted,
    observed: () => observed,
    clock: (value) => {
      now = value;
    },
    status: (value) => {
      status = value;
    },
    onSubmit: (hook) => {
      submitHook = hook;
    },
    onObserve: (hook) => {
      observeHook = hook;
    },
    authorize: (value) => {
      allowed = value;
    },
    eventAllowed: (value) => {
      eventAllowed = value;
    },
  };
}

test('durable submission receipts survive restart and concurrent retries never dispatch twice', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.service.submit('provider', f.revision, f.constraints, f.context),
    ),
  );
  assert.equal(f.submitted(), 1);
  const record = await f.service.get('provider', results[0].operation_id, f.context);
  const restarted = f.create(f.connect());
  assert.deepEqual(
    await restarted.submit('provider', f.revision, f.constraints, f.context),
    record,
  );
  assert.equal(f.submitted(), 1);
  const changed = await buildSystemRevision({
    schema_version: 1,
    repositories: { app: 'b'.repeat(40) },
    configuration_digests: {},
    accepted_decisions: [],
  });
  await assert.rejects(
    restarted.submit(
      'provider',
      changed,
      { ...f.constraints, system_revision_digest: changed.digest },
      f.context,
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  await assert.rejects(
    restarted.submit('provider', f.revision, f.constraints, {
      ...f.context,
      principal: { ...f.context.principal, actor_id: 'other' },
    }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('ambiguous dispatch stays UNKNOWN across restart and is never automatically resubmitted', async (t) => {
  const f = await fixture(t);
  f.onSubmit(() => {
    throw new Error('reply lost');
  });
  const record = await f.service.submit('provider', f.revision, f.constraints, f.context);
  assert.equal(record.status, 'UNKNOWN');
  const restarted = f.create(f.connect());
  assert.equal(
    (await restarted.submit('provider', f.revision, f.constraints, f.context)).status,
    'UNKNOWN',
  );
  f.clock(10000);
  assert.equal(
    (await restarted.reconcile('provider', record.operation_id, f.context)).status,
    'UNKNOWN',
  );
  assert.equal(f.submitted(), 1);
});

test('authenticated events arrive before polling, gate versions and reject substituted handles', async (t) => {
  const f = await fixture(t);
  const record = await f.service.submit('provider', f.revision, f.constraints, f.context);
  assert.equal(
    (await f.service.reconcile('provider', record.operation_id, f.context)).status,
    'SUBMITTED',
  );
  assert.equal(f.observed(), 0);
  const event = await f.event(record, 2);
  const accepted = await f.service.accept_event('provider', event, f.context);
  assert.equal(accepted.status, 'SUCCEEDED');
  assert.deepEqual(await f.service.accept_event('provider', event, f.context), accepted);
  assert.deepEqual(
    await f.service.accept_event('provider', await f.event(record, 1, 'RUNNING'), f.context),
    accepted,
  );
  f.clock(10000);
  assert.equal(
    (await f.service.reconcile('provider', record.operation_id, f.context)).status,
    'SUCCEEDED',
  );
  assert.equal(f.observed(), 0);
  await assert.rejects(
    f.service.accept_event(
      'provider',
      { ...event, version: 3, handle: { ...event.handle, external_run_id: 'other' } },
      f.context,
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  f.eventAllowed(false);
  await assert.rejects(f.service.accept_event('provider', event, f.context), { code: 'FORBIDDEN' });
});

test('polling is fallback only, uses bounded exponential jitter and recovers UNKNOWN', async (t) => {
  const f = await fixture(t);
  const record = await f.service.submit('provider', f.revision, f.constraints, f.context);
  f.clock(99);
  await f.service.reconcile('provider', record.operation_id, f.context);
  assert.equal(f.observed(), 0);
  f.onObserve(() => {
    throw new Error('timeout');
  });
  f.clock(100);
  const first = await f.service.reconcile('provider', record.operation_id, f.context);
  assert.equal(first.status, 'UNKNOWN');
  assert.equal(first.next_poll_at - 100, 150);
  f.clock(first.next_poll_at);
  const second = await f.service.reconcile('provider', record.operation_id, f.context);
  assert.equal(second.next_poll_at - first.next_poll_at, 300);
  f.onObserve(null);
  f.status('SUCCEEDED');
  f.clock(second.next_poll_at);
  const recovered = await f.service.reconcile('provider', record.operation_id, f.context);
  assert.equal(recovered.status, 'SUCCEEDED');
  assert.equal(recovered.next_poll_at, null);
});

test('provider waits hold no canonical transaction and persisted caps bound concurrent calls', async (t) => {
  const f = await fixture(t, { concurrency_cap: 1 });
  let release, started;
  const ready = new Promise((done) => {
    started = done;
  });
  f.onSubmit(
    () =>
      new Promise((done) => {
        release = done;
        started();
      }),
  );
  const pending = f.service.submit('provider', f.revision, f.constraints, f.context);
  await ready;
  await f.store.transaction(
    {
      schema_version: 1,
      tenant_id: 'tenant',
      system_id: 'group',
      kind: 'REF',
      resource_id: { repo_id: 'app', ref: 'refs/heads/main' },
    },
    (tx) => tx.put('canonical', { schema_version: 1, oid: f.revision.repositories.app }),
  );
  await assert.rejects(
    f.service.submit('provider', f.revision, f.constraints, {
      ...f.context,
      idempotency_key: 'second',
    }),
    { code: 'RATE_LIMITED' },
  );
  release();
  await pending;
  assert.equal(f.submitted(), 1);
});

test('rate windows survive process restart and access is checked on historical receipts', async (t) => {
  const f = await fixture(t, { max_calls_per_window: 1 });
  const record = await f.service.submit('provider', f.revision, f.constraints, f.context);
  const restarted = f.create(f.connect());
  f.clock(100);
  await assert.rejects(restarted.reconcile('provider', record.operation_id, f.context), {
    code: 'RATE_LIMITED',
  });
  f.clock(1001);
  assert.equal(
    (await restarted.reconcile('provider', record.operation_id, f.context)).status,
    'RUNNING',
  );
  f.authorize(false);
  await assert.rejects(restarted.get('provider', record.operation_id, f.context), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(restarted.submit('provider', f.revision, f.constraints, f.context), {
    code: 'FORBIDDEN',
  });
});

test('a newer event wins against a delayed poll and contradictory terminal observations remain UNKNOWN', async (t) => {
  const f = await fixture(t);
  const record = await f.service.submit('provider', f.revision, f.constraints, f.context);
  let release, started;
  const ready = new Promise((done) => {
    started = done;
  });
  f.onObserve(
    () =>
      new Promise((done) => {
        release = done;
        started();
      }),
  );
  f.clock(100);
  const pending = f.service.reconcile('provider', record.operation_id, f.context);
  await ready;
  const accepted = await f.service.accept_event('provider', await f.event(record, 1), f.context);
  release();
  assert.deepEqual(await pending, accepted);
  const conflict = await f.service.accept_event(
    'provider',
    await f.event(record, 2, 'FAILED'),
    f.context,
  );
  assert.equal(conflict.status, 'UNKNOWN');
});

test('crash after durable dispatch preparation blocks redispatch and an authenticated receipt recovers the run', async (t) => {
  const f = await fixture(t);
  let release, started;
  const ready = new Promise((done) => {
    started = done;
  });
  f.onSubmit(
    () =>
      new Promise((done) => {
        release = done;
        started();
      }),
  );
  const pending = f.service.submit('provider', f.revision, f.constraints, f.context);
  await ready;
  const id = await operationId({
    tenant_id: f.context.tenant_id,
    resource_id: f.context.system_id,
    action: 'deployment.submit',
    idempotency_key: f.context.idempotency_key,
  });
  const prepared = await f.service.get('provider', id, f.context);
  f.store.backend.close();
  f.clock(1001);
  const restarted = f.create(f.connect());
  const unknown = await restarted.reconcile('provider', id, f.context);
  assert.equal(unknown.status, 'UNKNOWN');
  await restarted.submit('provider', f.revision, f.constraints, f.context);
  assert.equal(f.submitted(), 1);
  release();
  await assert.rejects(pending, { code: 'PROVIDER_UNAVAILABLE' });
  const handle = {
    schema_version: 1,
    tenant_id: f.context.tenant_id,
    system_id: f.context.system_id,
    provider_id: 'provider',
    operation_id: id,
    external_run_id: 'run',
    system_revision_digest: f.revision.digest,
    release_constraints_digest: f.constraints.digest,
  };
  const recovered = await restarted.accept_event(
    'provider',
    await f.event({ ...prepared, handle }, 1),
    f.context,
  );
  assert.equal(recovered.status, 'SUCCEEDED');
  assert.equal(recovered.handle.external_run_id, 'run');
  assert.equal(f.submitted(), 1);
});
