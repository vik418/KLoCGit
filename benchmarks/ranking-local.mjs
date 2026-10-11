/** Compare priorities against real Git compositions and trusted sandbox checks. */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { benchmarkRankingExperiment } from './ranking.mjs';
import { createBehaviorExperiment } from './support/behavior.mjs';
import { encodeCanonical } from '../core/v1/encoding.mjs';

export async function benchmarkLocalRanking({
  max_evaluations,
  repetitions,
  timeout_ms,
  ranker = null,
  onProgress = () => {},
}) {
  if (
    !Number.isSafeInteger(max_evaluations) ||
    max_evaluations < 1 ||
    max_evaluations > 7 ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 2 ||
    !Number.isSafeInteger(timeout_ms) ||
    timeout_ms < 1 ||
    (ranker !== null && typeof ranker?.rank !== 'function')
  )
    throw new TypeError(
      'An explicit budget, repetition count, timeout and registered Ranker are required.',
    );
  const experiment = await createBehaviorExperiment({ telemetry: true });
  try {
    const { a, b, c, f, compose, native, requirements, stored } = experiment;
    const beforeSources = JSON.stringify(await f.sourceState());
    // Seven plans exhaust this three-Future fixture, not the product's reducer.
    const selections = [[a], [b], [c], [a, c], [b, c], [a, b], [a, b, c]];
    const entries = [];
    for (const revisions of selections) entries.push(await compose(revisions));
    const byId = new Map(entries.map((entry) => [entry.spec.id, entry]));
    const source = async (revision) => {
      const workspace = await f.sources.get(revision.repo_id).fetch(revision);
      return workspace.loadProject();
    };
    const sources = [];
    for (const revision of [a, b, c])
      sources.push({ future_revision_id: revision.id, ...(await source(revision)) });
    const high_risk_spec_ids = selections.flatMap((revisions, index) =>
      revisions.includes(a) && revisions.includes(b) ? [entries[index].spec.id] : [],
    );
    const report = await benchmarkRankingExperiment({
      candidate_specs: entries.map(({ spec }) => spec),
      evidence_summary: {
        schema_version: 1,
        basis: 'OBSERVED',
        check: experiment.configuration,
        baseline: await source(f.baseline),
        sources,
      },
      high_risk_spec_ids,
      ranker,
      max_evaluations,
      repetitions,
      timeout_ms,
      onProgress,
      evaluate: async (spec) => {
        const candidate = byId.get(spec.id).candidate;
        const start = performance.now();
        const evidence = await native.evaluate(candidate, requirements);
        return {
          schema_version: 1,
          candidate,
          evidence,
          evaluation_metrics: {
            schema_version: 1,
            basis: 'OBSERVED',
            elapsed_ms: performance.now() - start,
          },
        };
      },
      verifyProvenance: (record) => {
        const registered = stored.get(record.id);
        return (
          registered !== undefined &&
          Buffer.from(encodeCanonical(registered)).equals(Buffer.from(encodeCanonical(record)))
        );
      },
    });
    return {
      ...report,
      ranker_metadata: ranker?.metadata ?? null,
      workload: {
        schema_version: 1,
        kind: 'retry-response-loss',
        runtime_digest: experiment.runtime_digest,
        config_digest: experiment.config_digest,
        environment_digest: experiment.environment_digest,
        high_risk_spec_ids,
        materialization: 'local-git',
        execution: 'linux-bubblewrap-denied-network',
        source_git_unchanged: JSON.stringify(await f.sourceState()) === beforeSources,
      },
    };
  } finally {
    await experiment.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [budget, repetitions, timeout, modulePath] = process.argv.slice(2);
  const trace_id = randomUUID();
  // Only an operator-selected module is loaded. Producer code cannot install a Ranker.
  const ranker = modulePath
    ? await (await import(pathToFileURL(resolve(modulePath)).href)).createRanker()
    : null;
  const report = await benchmarkLocalRanking({
    max_evaluations: Number(budget),
    repetitions: Number(repetitions),
    timeout_ms: Number(timeout),
    ranker,
    onProgress: ({ repeat, phase, candidate_spec_id }) =>
      process.stderr.write(
        JSON.stringify({
          schema_version: 1,
          event: 'ranking.evaluated',
          trace_id,
          repeat,
          phase,
          candidate_spec_id,
        }) + '\n',
      ),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.workload.source_git_unchanged) process.exitCode = 1;
  else if (modulePath && report.status !== 'MEASURED') process.exitCode = 2;
}
