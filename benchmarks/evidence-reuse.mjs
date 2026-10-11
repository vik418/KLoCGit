/** Actual sandbox observations seed signed CI; the scheduler measures additional work. */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compositionFixture } from '../tests/v1/support/composition.mjs';
import { wholeFutureSelection } from '../core/v1/reduction.mjs';
import { candidateEvidenceSubject } from '../core/v1/evidence.mjs';
import { digestCanonical } from '../core/v1/encoding.mjs';
import { digestBytes, V1Error } from '../core/v1/conventions.mjs';
import { EvidenceScheduler } from '../core/v1/evidence-scheduling.mjs';
import { LinuxSandbox } from '../adapters/local/sandbox.mjs';
import { SandboxEvidenceProvider } from '../adapters/local/sandbox-evidence.mjs';
import {
  ExternalCIReceiptAdapter,
  ciReceiptSigningBytes,
} from '../adapters/ci/signed-evidence.mjs';

const baseline = {
  'retry.mjs': 'export async function request(operation){return operation();}\n',
  'charge.mjs':
    'export function handler(){let charges=0;return {execute:async()=>{throw new Error("response lost")},count:()=>charges};}\n',
  'app.mjs':
    'import {request} from "./retry.mjs";import {handler} from "./charge.mjs";const service=handler();try{await request(service.execute);}catch{}process.stdout.write(JSON.stringify({charges:service.count(),status:"PASSING"}));\n',
};
const retry =
  'export async function request(operation){try{return await operation();}catch{return operation();}}\n';
const charge =
  'export function handler(){let charges=0;return {execute:async()=>{charges++;throw new Error("response lost")},count:()=>charges};}\n';

export async function benchmarkEvidenceReuse({ repetitions, onProgress = () => {} }) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new TypeError('A positive repetition count is required.');
  const cleanup = [],
    f = await compositionFixture({ after: (work) => cleanup.push(work) }, baseline);
  try {
    const a = await f.future('retry', { ...baseline, 'retry.mjs': retry });
    const b = await f.future('charge', { ...baseline, 'charge.mjs': charge });
    const selected = (revision) => wholeFutureSelection(revision, f.context.bindings[revision.id]);
    const isolated = [];
    for (const revision of [a, b])
      isolated.push({
        revision,
        candidate: await f.materializer.materialize(
          await f.spec([selected(revision)], { selected_future_revisions: [revision.id] }),
          f.context,
        ),
      });
    const composed = await f.materializer.materialize(await f.spec(), f.context);
    const runtime = await realpath(process.execPath);
    const runtime_digest = await digestBytes(
      'sandbox-runtime',
      new Uint8Array(await readFile(runtime)),
    );
    const configuration = {
      schema_version: 1,
      id: 'single-charge',
      type: 'behavior',
      version: '1',
      max_charges: 1,
      brokered_resources: [],
    };
    const config_digest = await digestCanonical('evaluation-config', configuration);
    const environment_digest = await digestCanonical('evaluation-environment', {
      runtime_digest,
      adapter: 'linux-bubblewrap-v1',
    });
    const tenant_id = 'benchmark',
      system_id = 'benchmark',
      principal = { actor_id: 'evaluator' };
    const stored = new Map(),
      payloads = new Map(),
      receipts = new Map(),
      generated = new Map(),
      executions = [];
    const sandbox = new LinuxSandbox({
      root: join(f.root, 'sandbox'),
      runtimes: { node: { schema_version: 1, binary: runtime, digest: runtime_digest } },
      limits: {
        schema_version: 1,
        timeout_ms: 4000,
        cpu_seconds: 2,
        address_space_bytes: 2147483648,
        open_files: 64,
        max_output_bytes: 16384,
        max_input_bytes: 16384,
        max_workspace_bytes: 1048576,
        max_files: 100,
      },
      secretGuard: () => true,
      broker: {
        read: () => {
          throw new V1Error('FORBIDDEN');
        },
      },
      audit: () => {},
    });
    const native = new SandboxEvidenceProvider({
      tenant_id,
      system_id,
      principal,
      authorize: (actor) => actor.actor_id === principal.actor_id,
      materializer: f.materializer,
      sandbox,
      producer_identity: 'benchmark-sandbox',
      producer_version: '1',
      environment_digest,
      retention_class: 'DECISION_RECORD',
      max_payload_bytes: 16384,
      now: () => new Date().toISOString(),
      payloadStore: {
        put: async ({ digest, bytes }) => {
          payloads.set(digest, bytes.slice());
          return { schema_version: 1, digest, ref: 'benchmark:' + digest };
        },
      },
      evidenceStore: {
        put: async ({ evidence }) => stored.set(evidence.id, evidence),
        find: async () => [...generated.values()],
      },
      recipes: [
        {
          configuration,
          evaluate: async ({ run }) => {
            const start = performance.now();
            const observed = await run({
              schema_version: 1,
              runtime_id: 'node',
              argv: ['--max-old-space-size=64', 'app.mjs'],
              stdin: '',
              files: Object.keys(baseline).map((path) => ({
                schema_version: 1,
                repo_id: 'canonical',
                path,
                destination: path,
              })),
            });
            const response = JSON.parse(new TextDecoder().decode(observed.stdout));
            executions.push({
              schema_version: 1,
              elapsed_ms: performance.now() - start,
              exit_code: observed.exit_code,
              charges: response.charges,
            });
            return {
              schema_version: 1,
              basis: 'OBSERVED',
              status:
                observed.exit_code === 0 &&
                Number.isSafeInteger(response.charges) &&
                response.charges >= 0 &&
                response.charges <= configuration.max_charges
                  ? 'PASSING'
                  : 'FAILED',
              charges: response.charges,
              claims: [
                'Observed at most one charge when the response is lost for the registered input.',
              ],
            };
          },
        },
      ],
    });
    const requirements = {
      schema_version: 1,
      policy_digest: await digestCanonical('policy', { checks: [configuration.id] }),
      checks: [
        {
          schema_version: 1,
          id: configuration.id,
          type: configuration.type,
          config_digest,
          environment_digest,
          producers: [
            { schema_version: 1, identity: 'benchmark-ci', versions: ['1'] },
            {
              schema_version: 1,
              identity: native.producer_identity,
              versions: [native.producer_version],
            },
          ],
        },
      ],
    };
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
    for (const work of cleanup.reverse()) await work();
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
