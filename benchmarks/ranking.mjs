/** Compare asynchronous priorities at the same evaluation budget; labels stay private. */
import { performance } from 'node:perf_hooks';
import { copyJsonData } from '../core/v1/domain.mjs';
import { digestCanonical } from '../core/v1/encoding.mjs';
import { verifyCandidateSpec } from '../core/v1/reduction.mjs';
import { scheduleOptionalRanking, acceptRanking } from '../core/v1/ranking.mjs';
import { verifyCandidateContent } from '../core/v1/promotion.mjs';
import { candidateEvidenceSubject, verifyEvidence } from '../core/v1/evidence.mjs';

export async function benchmarkRanking({
  candidate_specs,
  evidence_summary,
  high_risk_spec_ids,
  evaluate,
  verifyProvenance,
  ranker,
  max_evaluations,
  timeout_ms,
  onProgress = () => {},
}) {
  const specs = await Promise.all(copyJsonData(candidate_specs).map(verifyCandidateSpec));
  const labels = new Set(high_risk_spec_ids),
    known = new Set(specs.map(({ id }) => id));
  if (
    !specs.length ||
    known.size !== specs.length ||
    !Array.isArray(high_risk_spec_ids) ||
    labels.size !== high_risk_spec_ids.length ||
    [...labels].some((id) => !known.has(id)) ||
    typeof evaluate !== 'function' ||
    typeof verifyProvenance !== 'function' ||
    !Number.isSafeInteger(max_evaluations) ||
    max_evaluations < 1 ||
    max_evaluations > specs.length
  )
    throw new TypeError(
      'An explicit workload, independent labels and evaluation budget are required.',
    );
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const pool_digest = await digestCanonical('ranking-experiment-pool', [...known].sort());
  const run = async (provider, phase) => {
    const started = performance.now();
    const job = await scheduleOptionalRanking(specs, evidence_summary, {
      ranker: provider,
      timeout_ms,
    });
    let current = job.initial,
      ranked_at_ms = null;
    const completion = job.completion.then((projection) => {
      ranked_at_ms = performance.now() - started;
      current = acceptRanking(job.initial, projection);
      return projection;
    });
    const evaluated = new Set(),
      rows = [];
    for (let step = 0; step < max_evaluations; step++) {
      const id = current.priorities.find((id) => !evaluated.has(id));
      if (!known.has(id)) throw new Error('Ranking substituted the evaluation pool');
      const entryStarted = performance.now();
      const observation = copyJsonData(await evaluate(byId.get(id), { phase, step }));
      if (
        observation?.schema_version !== 1 ||
        !Array.isArray(observation.evidence) ||
        !observation.evidence.length
      )
        throw new Error('The evaluator returned no exact-state observations');
      const candidate = await verifyCandidateContent(observation.candidate);
      if (candidate.candidate_spec_id !== id)
        throw new Error('Evaluation substituted its CandidateSpec');
      const subject = await candidateEvidenceSubject(candidate);
      for (const input of observation.evidence) {
        const { evidence } = await verifyEvidence(input);
        if (
          evidence.subject_digest !== subject.digest ||
          evidence.result.basis !== 'OBSERVED' ||
          (await verifyProvenance(evidence)) !== true
        )
          throw new Error('Ranking measurements require authenticated exact-state Evidence');
      }
      const metrics = observation.evaluation_metrics;
      if (
        metrics?.schema_version !== 1 ||
        metrics.basis !== 'OBSERVED' ||
        typeof metrics.elapsed_ms !== 'number' ||
        !Number.isFinite(metrics.elapsed_ms) ||
        metrics.elapsed_ms < 0
      )
        throw new Error('Evaluation cost must come from measured execution');
      evaluated.add(id);
      const row = {
        schema_version: 1,
        step,
        candidate_spec_id: id,
        candidate_digest: candidate.digest,
        high_risk: labels.has(id),
        elapsed_ms: performance.now() - entryStarted,
        observed_at_ms: performance.now() - started,
        new_compute_ms: metrics.elapsed_ms,
        evidence_ids: observation.evidence.map(({ id }) => id),
      };
      rows.push(row);
      await onProgress({ phase, ...row });
    }
    const execution_elapsed_ms = performance.now() - started;
    const projection = await completion;
    if (
      new Set(projection.priorities).size !== known.size ||
      projection.priorities.some((id) => !known.has(id))
    )
      throw new Error('Ranking changed the evaluation pool');
    const found = rows.filter(({ high_risk }) => high_risk);
    return {
      schema_version: 1,
      phase,
      pool_digest,
      ranking_status: projection.status,
      ranking_elapsed_ms: ranked_at_ms,
      execution_elapsed_ms,
      high_risk_found: found.length,
      high_risk_recall: labels.size ? found.length / labels.size : null,
      first_high_risk_evidence_ms: found[0]?.observed_at_ms ?? null,
      new_compute_ms: rows.reduce((sum, row) => sum + row.new_compute_ms, 0),
      evaluated_spec_ids: rows.map(({ candidate_spec_id }) => candidate_spec_id),
      rows,
    };
  };
  const deterministic = await run(null, 'deterministic');
  const ranked = ranker === null ? null : await run(ranker, 'asynchronous-ranking');
  return {
    schema_version: 1,
    measured_at: new Date().toISOString(),
    hypothesis: 'H5',
    status: ranked?.ranking_status === 'COMPLETE' ? 'MEASURED' : 'UNMEASURED',
    max_evaluations,
    total_candidates: specs.length,
    total_high_risk: labels.size,
    pool_digest,
    scope:
      'One explicit fixture workload; labels are withheld from ranking. Evaluation and provenance callbacks must use independent trusted observations.',
    deterministic,
    ranked,
    compute_saved_ms:
      ranked?.ranking_status === 'COMPLETE'
        ? deterministic.new_compute_ms - ranked.new_compute_ms
        : null,
  };
}
