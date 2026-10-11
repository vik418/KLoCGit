import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Telemetry,
  summarizeMetrics,
  estimateCost,
  verifyMetricObservation,
} from '../../core/v1/telemetry.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';

const context = {
  schema_version: 1,
  tenant_id: 'tenant',
  system_id: 'group',
  trace_id: 'trace',
  subject_id: 'candidate',
};

function fixture(sink) {
  const events = [];
  let time = 0;
  const telemetry = new Telemetry({
    sink: sink ?? ((event) => events.push(event)),
    now: () => time,
    max_event_bytes: 4096,
    flush_timeout_ms: 50,
  });
  return {
    telemetry,
    events,
    time: (value) => {
      time = value;
    },
  };
}

test('measured operations retain their result, trace and sanitized failure class', async () => {
  const f = fixture();
  assert.equal(
    await f.telemetry.measure('candidate_materialization_ms', context, () => {
      f.time(7);
      return 42;
    }),
    42,
  );
  assert.equal(f.events[0].value, 7);
  assert.equal(f.events[0].context.trace_id, context.trace_id);
  assert.equal(f.events[0].basis, 'OBSERVED');
  await assert.rejects(
    f.telemetry.measure('ingestion_latency_ms', context, () => {
      f.time(9);
      throw new Error('private-provider-credential');
    }),
  );
  assert.equal(f.events[1].failure_class, 'INTERNAL');
  assert.equal(JSON.stringify(f.events).includes('private-provider-credential'), false);
  await assert.rejects(
    f.telemetry.measure('resolvable_latency_ms', context, () => {
      throw new V1Error('OUTCOME_UNKNOWN');
    }),
    { code: 'OUTCOME_UNKNOWN' },
  );
  assert.equal(f.events[2].to_state, 'UNKNOWN');
});

test('sink failure, timeout and invalid measurements cannot alter successful work', async () => {
  for (const sink of [
    () => {
      throw new Error('outage');
    },
    () => new Promise(() => {}),
  ]) {
    const f = fixture(sink);
    assert.equal(
      await f.telemetry.measure('ingestion_latency_ms', context, () => 'accepted'),
      'accepted',
    );
    assert.equal(f.telemetry.dropped, 1);
  }
  const f = fixture();
  assert.equal(await f.telemetry.record('invented_metric', 10, context), false);
  assert.equal(await f.telemetry.record('candidate_materialization_ms', -1, context), false);
  assert.equal(
    await f.telemetry.record('candidate_materialization_ms', 1, { ...context, payload: 'secret' }),
    false,
  );
  const bounded = new Telemetry({
    sink: () => assert.fail('oversized event reached sink'),
    now: () => 0,
    max_event_bytes: 1,
    flush_timeout_ms: 50,
  });
  assert.equal(await bounded.record('accepted_change', 1, context), false);
  assert.equal(f.events.length, 0);
});

test('latency, byte, queue, forward-port and cost summaries remain scoped and reproducible', async () => {
  const f = fixture();
  for (const latency of [10, 20, 30, 40, 100])
    await f.telemetry.record('candidate_materialization_ms', latency, context);
  for (const metric of [
    'ingestion_latency_ms',
    'reviewable_latency_ms',
    'resolvable_latency_ms',
    'evidence_queue_latency_ms',
  ]) {
    f.time(100);
    await f.telemetry.since(metric, 70, context);
  }
  await f.telemetry.record('hydrated_bytes_cold', 4096, context);
  await f.telemetry.record('hydrated_bytes_warm', 64, context);
  await f.telemetry.record('forward_port_success', 3, context);
  await f.telemetry.record('forward_port_stale', 1, context);
  await f.telemetry.record('accepted_change', 2, context);
  const cost = estimateCost(1250, {
    schema_version: 1,
    units: 1000,
    microunits: 200,
    currency: 'USD',
  });
  await f.telemetry.record('estimated_cost_microunits', cost.microunits, context, {
    currency: cost.currency,
  });
  const report = await summarizeMetrics([...f.events, ...f.events], {
    tenant_id: 'tenant',
    system_id: 'group',
    max_events: 100,
  });
  assert.equal(report.observation_count, f.events.length);
  assert.equal(report.metrics.candidate_materialization_ms.p50, 30);
  assert.equal(report.metrics.candidate_materialization_ms.p95, 100);
  assert.equal(report.metrics.hydrated_bytes_cold.sum, 4096);
  assert.equal(report.metrics.hydrated_bytes_warm.sum, 64);
  assert.equal(report.metrics.evidence_queue_latency_ms.sum, 30);
  assert.equal(report.forward_port.success_rate, 0.75);
  assert.equal(report.estimated_cost_per_accepted_change.USD, 125);
  assert.equal(f.events.at(-1).basis, 'ESTIMATED');
  await assert.rejects(
    summarizeMetrics(f.events, { tenant_id: 'other', system_id: 'group', max_events: 100 }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    summarizeMetrics(f.events, { tenant_id: 'tenant', system_id: 'group', max_events: 1 }),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
  await assert.rejects(verifyMetricObservation({ ...f.events[0], value: 999 }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('coordinator measurements release the authoritative transaction before sink I/O', async (t) => {
  const backend = new SqliteCoordinationBackend({ filename: ':memory:', busy_timeout_ms: 1000 });
  t.after(() => backend.close());
  const store = new CoordinationStore(backend);
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'OBJECTIVE',
    resource_id: 'objective',
  };
  const events = [];
  const telemetry = new Telemetry({
    now: Date.now,
    max_event_bytes: 4096,
    flush_timeout_ms: 1000,
    sink: async (event) => {
      await store.transaction(scope, (tx) => tx.get('record'));
      events.push(event);
    },
  });
  await telemetry.coordinate(store, scope, context, (tx) =>
    tx.put('record', { schema_version: 1, accepted: true }),
  );
  assert.deepEqual(
    events.map((event) => event.metric),
    ['coordinator_wait_ms', 'coordinator_transaction_ms'],
  );
  assert.equal(
    events.every((event) => event.value >= 0 && event.to_state === 'SUCCEEDED'),
    true,
  );
  assert.deepEqual(await store.transaction(scope, (tx) => tx.get('record')), {
    schema_version: 1,
    accepted: true,
  });
});

test('explicit cost estimates round safely without mixing currencies or inventing zero-cost results', async () => {
  assert.equal(
    estimateCost(1, { schema_version: 1, units: 3, microunits: 10, currency: 'USD' }).microunits,
    4,
  );
  assert.equal(
    estimateCost(Number.MAX_SAFE_INTEGER, {
      schema_version: 1,
      units: Number.MAX_SAFE_INTEGER,
      microunits: 100,
      currency: 'USD',
    }).microunits,
    100,
  );
  assert.throws(
    () =>
      estimateCost(Number.MAX_SAFE_INTEGER, {
        schema_version: 1,
        units: 1,
        microunits: 100,
        currency: 'USD',
      }),
    { code: 'INVALID_ARGUMENT' },
  );
  const empty = await summarizeMetrics([], {
    tenant_id: 'tenant',
    system_id: 'group',
    max_events: 10,
  });
  assert.equal(empty.forward_port.success_rate, null);
  assert.deepEqual(empty.estimated_cost_per_accepted_change, {});
});
