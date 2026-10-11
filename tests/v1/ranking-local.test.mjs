import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkLocalRanking } from '../../benchmarks/ranking-local.mjs';

test('ranking observes exact composed Git behavior without changing source repositories', async () => {
  let rankings = 0;
  const report = await benchmarkLocalRanking({
    max_evaluations: 2,
    repetitions: 2,
    timeout_ms: 1000,
    ranker: {
      rank: async (specs, summary) => {
        rankings++;
        assert.equal(summary.basis, 'OBSERVED');
        assert.equal(summary.high_risk_spec_ids, undefined);
        assert.ok(summary.sources.every((source) => source.complete && source.files.length));
        return { schema_version: 1, priorities: specs.map(({ id }) => id).reverse() };
      },
    },
  });
  assert.equal(rankings, report.repetitions);
  assert.equal(report.status, 'MEASURED');
  assert.equal(report.workload.source_git_unchanged, true);
  assert.ok(report.deterministic.mean_new_compute_ms > 0);
  assert.ok(report.ranked.mean_new_compute_ms > 0);
  for (const run of report.runs) {
    assert.equal(run.deterministic.high_risk_recall, 0);
    assert.ok(run.ranked.high_risk_recall > 0);
    assert.ok(
      run.deterministic.rows.every((row) =>
        row.evidence_results.every(({ status }) => status === 'PASSING'),
      ),
    );
    assert.ok(
      run.ranked.rows.some((row) => row.evidence_results.some(({ status }) => status === 'FAILED')),
    );
    assert.equal(run.ranked.evaluated_spec_ids[0], run.deterministic.evaluated_spec_ids[0]);
    assert.equal(run.deterministic.pool_digest, run.ranked.pool_digest);
  }
});

test('an absent ranking provider produces actual baseline observations and no model claim', async () => {
  const report = await benchmarkLocalRanking({
    max_evaluations: 1,
    repetitions: 2,
    timeout_ms: 1000,
  });
  assert.equal(report.status, 'UNMEASURED');
  assert.equal(report.ranked, null);
  assert.equal(report.workload.source_git_unchanged, true);
  assert.ok(report.runs.every(({ ranked }) => ranked === null));
  assert.ok(report.deterministic.mean_new_compute_ms > 0);
});
