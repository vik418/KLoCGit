/** Actual sandbox observations seed signed CI; the scheduler measures additional work. */
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createBehaviorExperiment } from './support/behavior.mjs';
import { candidateEvidenceSubject } from '../core/v1/evidence.mjs';
import { EvidenceScheduler } from '../core/v1/evidence-scheduling.mjs';
import {
  ExternalCIReceiptAdapter,
  ciReceiptSigningBytes,
} from '../adapters/ci/signed-evidence.mjs';

export async function benchmarkEvidenceReuse({ repetitions, onProgress = () => {} }) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new TypeError('A positive repetition count is required.');
  const experiment = await createBehaviorExperiment();
  const {
    f,
    isolated,
    composed,
    runtime_digest,
    configuration,
    config_digest,
    environment_digest,
    tenant_id,
    system_id,
    principal,
    stored,
    payloads,
    generated,
    executions,
    native,
    requirements,
  } = experiment;
  const receipts = new Map();
  try {
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const registry = {
      schema_version: 1,
      issuer: 'benchmark-ci',
      key_id: 'local-experiment',
      public_key: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString(
        'base64url',
      ),
      producer_version: '1',
      repository_bindings: { retry: 'canonical', charge: 'canonical' },
      allowed_config_digests: [config_digest],
    };
    let git_reads = 0;
    const ci = new ExternalCIReceiptAdapter({
      tenant_id,
      system_id,
      retention_class: 'DECISION_RECORD',
      max_receipt_bytes: 16384,
      resolveEvaluator: ({ issuer, key_id }) =>
        issuer === registry.issuer && key_id === registry.key_id ? registry : null,
      observeSnapshot: async (repo_id, commit_oid) => {
        git_reads++;
        return (await f.sources.get(repo_id).fetch({ schema_version: 1, repo_id, commit_oid }))
          .identity;
      },
      authorize: (actor) => actor.actor_id === principal.actor_id,
    });
    const seeding = performance.now();
    const external = [];
    for (const { revision, candidate } of isolated) {
      const [record] = await native.evaluate(candidate, requirements);
      const unsigned = {
        schema_version: 1,
        issuer: registry.issuer,
        key_id: registry.key_id,
        observation: {
          schema_version: 1,
          tenant_id,
          system_id,
          run_id: revision.repo_id,
          type: configuration.type,
          config_digest,
          environment_digest,
          result: record.result,
          payload_ref: record.payload_ref,
          created_at: record.created_at,
          sources: [
            {
              schema_version: 1,
              repo_id: revision.repo_id,
              commit_oid: revision.commit_oid,
              tree_oid: revision.tree_oid,
              parent_oids: revision.parent_oids,
            },
          ],
        },
      };
      const receipt = {
        ...unsigned,
        signature: Buffer.from(
          await crypto.subtle.sign('Ed25519', keys.privateKey, ciReceiptSigningBytes(unsigned)),
        ).toString('base64url'),
      };
      const imported = await ci.ingest(receipt, { principal });
      external.push(imported.evidence);
      receipts.set(imported.evidence.id, receipt);
    }
    const initial_ci_elapsed_ms = performance.now() - seeding,
      initial_ci_runs = executions.length;
    const scheduler = new EvidenceScheduler({
      provider: {
        find_reusable: async () => [...external, ...generated.values()],
        evaluate: async (candidate, required) => {
          const records = await native.evaluate(candidate, required);
          for (const record of records) generated.set(record.id, record);
          return records;
        },
      },
      verifyProvenance: (record) =>
        receipts.has(record.id)
          ? ci.verifyProvenance(record, receipts.get(record.id), { principal })
          : stored.get(record.id)?.subject_digest === record.subject_digest &&
            generated.has(record.id),
      policyEvaluator: {
        can_reuse: (record) =>
          record.result.basis === 'OBSERVED' &&
          ['PASSING', 'FAILED'].includes(record.result.status),
      },
      limits: { schema_version: 1, max_checks: 4, max_records: 16, max_evaluations: 4 },
    });
    const rows = [];
    for (let repeat = 0; repeat < repetitions; repeat++) {
      for (const { kind, candidate } of [
        ...isolated.map((entry) => ({ ...entry, kind: 'isolated' })),
        { kind: 'composed', candidate: composed },
      ]) {
        const before = executions.length,
          start = performance.now();
        const result = await scheduler.evaluate(candidate, requirements);
        const added = executions.slice(before),
          subject = await candidateEvidenceSubject(candidate);
        const row = {
          schema_version: 1,
          kind,
          repeat,
          subject_digest: subject.digest,
          elapsed_ms: performance.now() - start,
          check_states: result.plan.checks.map(({ state }) => state),
          results: result.evidence.map(({ result }) => result.status),
          new_evaluations: added.length,
          new_compute_ms: added.reduce((sum, row) => sum + row.elapsed_ms, 0),
          exact_state_evidence: result.evidence.every(
            (record) => record.subject_digest === subject.digest,
          ),
        };
        rows.push(row);
        await onProgress(row);
      }
    }
    const isolatedRows = rows.filter(({ kind }) => kind === 'isolated'),
      compositionRows = rows.filter(({ kind }) => kind === 'composed');
    const newlyEvaluated = rows.reduce((sum, row) => sum + row.new_evaluations, 0);
    return {
      schema_version: 1,
      measured_at: new Date().toISOString(),
      hypothesis: 'H4',
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        runtime_digest,
      },
      scope:
        'Local signed CI receipt ingestion, real Git materialization and denied-network Linux execution; no live CI or provider billing measurement.',
      repetitions,
      initial_ci_runs,
      initial_ci_elapsed_ms,
      git_reads,
      payload_objects: payloads.size,
      isolated_reuse_rate:
        isolatedRows.filter((row) => row.check_states.every((state) => state === 'REUSED')).length /
        isolatedRows.length,
      composed_first_evaluation: compositionRows[0].check_states,
      new_evaluations: newlyEvaluated,
      new_compute_ms: rows.reduce((sum, row) => sum + row.new_compute_ms, 0),
      semantic_interaction_observed:
        external.every(({ result }) => result.status === 'PASSING') &&
        compositionRows[0].results.includes('FAILED'),
      rows,
    };
  } finally {
    await experiment.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await benchmarkEvidenceReuse({
    repetitions: Number(process.argv[2]),
    onProgress: (row) =>
      process.stderr.write(
        JSON.stringify({
          event: 'evidence.measured',
          kind: row.kind,
          repeat: row.repeat,
          new_evaluations: row.new_evaluations,
        }) + '\n',
      ),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.semantic_interaction_observed || report.rows.some((row) => !row.exact_state_evidence))
    process.exitCode = 1;
}
