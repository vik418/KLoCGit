import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkRanking } from '../../benchmarks/ranking.mjs';
import { buildCandidateSpec } from '../../core/v1/reduction.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';
import { buildEvidence, candidateEvidenceSubject } from '../../core/v1/evidence.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { commitOid, treeOid } from '../../benchmarks/support/git-objects.mjs';

async function fixture() {
  const tree = await treeOid({ 'value.txt': 'input\n' }),
    commit = await commitOid(tree, null, 'baseline');
  const base = 'klocgit:system-revision:v1:sha256:' + 'a'.repeat(64);
  const specs = await Promise.all(
    [1, 2, 3].map((index) =>
      buildCandidateSpec({
        schema_version: 1,
        base_revision: base,
        selected_future_revisions: [],
        selections: [],
        required_dependencies: [],
        effect_summary_digest: 'sha256:effect-summary:v1:' + 'b'.repeat(64),
        creation_reason: 'Experiment ' + index,
      }),
    ),
  );
  const trusted = new Map(),
    calls = [];
  const evaluate = async (spec, { phase }) => {
    calls.push([phase, spec.id]);
    const candidate = await materializedCandidate(
      spec.id,
      { repo: tree },
      { schema_version: 1, repo_commit_oids: { repo: commit } },
    );
    const subject = await candidateEvidenceSubject(candidate);
    const evidence = await buildEvidence({
      schema_version: 1,
      subject_digest: subject.digest,
      type: 'fixture-observation',
      producer_identity: 'trusted-test',
      producer_version: '1',
      config_digest: await digestCanonical('evaluation-config', { check: 'fixture' }),
      environment_digest: await digestCanonical('evaluation-environment', { runtime: 'fixture' }),
      result: { basis: 'OBSERVED', status: spec.id === specs[2].id ? 'FAILED' : 'PASSING' },
      payload_ref: 'fixture:' + spec.id,
      created_at: '2026-10-11T00:00:00Z',
      retention_class: 'DECISION_RECORD',
    });
    trusted.set(evidence.id, evidence);
    return {
      schema_version: 1,
      candidate,
      evidence: [evidence],
      evaluation_metrics: { schema_version: 1, basis: 'OBSERVED', elapsed_ms: 1 },
    };
  };
  return {
    specs,
    calls,
    evaluate,
    options: {
      candidate_specs: specs,
      evidence_summary: { schema_version: 1, observations: [] },
      high_risk_spec_ids: [specs[2].id],
      evaluate,
      verifyProvenance: (record) => trusted.has(record.id),
      max_evaluations: 2,
      timeout_ms: 1000,
    },
  };
}

test('asynchronous ranking preserves the first deterministic evaluation and only reorders remaining work', async () => {
  const f = await fixture();
  const report = await benchmarkRanking({
    ...f.options,
    ranker: {
      rank: async (inputs, summary) => {
        assert.equal(summary.high_risk_spec_ids, undefined);
        return { schema_version: 1, priorities: inputs.map(({ id }) => id).reverse() };
      },
    },
  });
  assert.deepEqual(
    report.deterministic.evaluated_spec_ids,
    f.specs.slice(0, 2).map(({ id }) => id),
  );
  assert.equal(report.ranked.evaluated_spec_ids[0], f.specs[0].id);
  assert.equal(report.ranked.evaluated_spec_ids[1], f.specs[2].id);
  assert.equal(report.deterministic.high_risk_recall, 0);
  assert.equal(report.ranked.high_risk_recall, 1);
  assert.equal(report.deterministic.pool_digest, report.ranked.pool_digest);
  assert.equal(report.status, 'MEASURED');
});

test('missing or failed models never stand in for a successful model experiment', async () => {
  const f = await fixture();
  const disabled = await benchmarkRanking({ ...f.options, ranker: null });
  assert.equal(disabled.status, 'UNMEASURED');
  assert.equal(disabled.ranked, null);
  assert.equal(disabled.compute_saved_ms, null);
  const failed = await benchmarkRanking({
    ...f.options,
    ranker: {
      rank: () => {
        throw new Error('outage');
      },
    },
  });
  assert.equal(failed.ranked.ranking_status, 'FAILED');
  assert.equal(failed.status, 'UNMEASURED');
  assert.equal(failed.compute_saved_ms, null);
  assert.deepEqual(failed.ranked.evaluated_spec_ids, failed.deterministic.evaluated_spec_ids);
});

test('substituted or unverified observations cannot count as useful Evidence', async () => {
  const f = await fixture();
  await assert.rejects(
    benchmarkRanking({ ...f.options, ranker: null, verifyProvenance: () => false }),
    /authenticated exact-state Evidence/,
  );
  await assert.rejects(
    benchmarkRanking({
      ...f.options,
      ranker: null,
      evaluate: async (spec, context) => {
        const result = await f.evaluate(spec, context);
        return {
          ...result,
          evaluation_metrics: { ...result.evaluation_metrics, basis: 'INFERRED' },
        };
      },
    }),
    /measured execution/,
  );
});
