import assert from 'node:assert/strict';
import test from 'node:test';
import {
  benchmarkReduction,
  reductionMeasurements,
  reductionWorkload,
} from '../../benchmarks/candidate-reduction.mjs';
import { CandidateReducer } from '../../core/v1/candidate-reducer.mjs';

const budget = {
  schema_version: 1,
  max_candidate_specs: 4,
  max_selections_per_spec: 8,
  max_dependency_visits: 32,
};

test('seeded workloads reproduce inputs and exercise duplicates within their canonical target', async () => {
  const workload = await reductionWorkload(100, 'reproducible-work');
  assert.deepEqual(await reductionWorkload(100, 'reproducible-work'), workload);
  assert.notDeepEqual(await reductionWorkload(100, 'different-work'), workload);
  const result = await new CandidateReducer({ verifyRejection: () => false }).reduce(
    workload.revisions,
    workload.effects,
    workload.policy,
    budget,
  );
  assert.ok(result.metrics.exact_implementations < workload.revisions.length);
  assert.ok(result.effect_index.suppressed.length > 0);
  assert.equal(reductionMeasurements(workload, result, budget).falsified, false);
});

test('measurement detects lost security interactions and origins rather than trusting reducer counters', async () => {
  const workload = await reductionWorkload(20, 'negative-controls');
  const result = await new CandidateReducer({ verifyRejection: () => false }).reduce(
    workload.revisions,
    workload.effects,
    workload.policy,
    budget,
  );
  const missingEdges = structuredClone(result);
  missingEdges.effect_index.interactions = [];
  assert.equal(reductionMeasurements(workload, missingEdges, budget).falsified, true);
  assert.equal(
    reductionMeasurements(workload, missingEdges, budget).missed_seeded_high_severity_interactions,
    workload.seededInteractions.length,
  );
  const lostOrigins = structuredClone(result);
  lostOrigins.implementation_frontier.pop();
  assert.ok(reductionMeasurements(workload, lostOrigins, budget).lost_revision_origins > 0);
  assert.equal(reductionMeasurements(workload, lostOrigins, budget).falsified, true);
  assert.equal(
    reductionMeasurements(workload, result, { ...budget, max_candidate_specs: 1 }).falsified,
    true,
  );
});

test('benchmark executes ingestion, duplicate and reordered delivery with bounded claim-check events', async () => {
  const report = await benchmarkReduction({ counts: [10], seed: 'event-checks', budget });
  const [row] = report.rows;
  assert.equal(row.futures, 10);
  assert.equal(row.falsified, false);
  assert.equal(row.events.first_deliveries, row.futures);
  assert.equal(row.events.replay_deliveries, row.futures);
  assert.ok(row.events.out_of_order_deliveries > 0);
  assert.ok(row.events.claim_objects > 0);
  assert.ok(row.events.max_envelope_bytes <= report.event_limits.max_event_bytes);
  assert.equal(row.events.irreversible_effects, 0);
  assert.ok(row.generation_ms >= 0 && row.reduction_ms >= 0 && row.events.elapsed_ms >= 0);
  await assert.rejects(
    benchmarkReduction({ counts: [10, 10], seed: 'invalid', budget }),
    TypeError,
  );
  await assert.rejects(reductionWorkload(2, 'invalid'), TypeError);
});
