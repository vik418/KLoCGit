import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkEvidenceReuse } from '../../benchmarks/evidence-reuse.mjs';

test('signed isolated CI is reused and a clean textual composition gets its own failing observation', async () => {
  const report = await benchmarkEvidenceReuse({ repetitions: 2 });
  assert.equal(report.initial_ci_runs, 2);
  assert.equal(report.isolated_reuse_rate, 1);
  assert.equal(report.semantic_interaction_observed, true);
  assert.deepEqual(report.composed_first_evaluation, ['EVALUATED']);
  assert.equal(report.new_evaluations, 1);
  assert.ok(report.new_compute_ms > 0);
  const repeated = report.rows.filter(({ kind, repeat }) => kind === 'composed' && repeat > 0);
  assert.ok(repeated.every((row) => row.new_evaluations === 0 && row.results.includes('FAILED')));
  assert.ok(report.rows.every(({ exact_state_evidence }) => exact_state_evidence));
  assert.ok(report.git_reads > report.initial_ci_runs);
  await assert.rejects(benchmarkEvidenceReuse({ repetitions: 0 }), TypeError);
});
