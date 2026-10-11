/** A real Git workload whose isolated changes pass and composed behavior fails. */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compositionFixture } from '../../tests/v1/support/composition.mjs';
import { wholeFutureSelection } from '../../core/v1/reduction.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { digestBytes, V1Error } from '../../core/v1/conventions.mjs';
import { LinuxSandbox } from '../../adapters/local/sandbox.mjs';
import { SandboxEvidenceProvider } from '../../adapters/local/sandbox-evidence.mjs';

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

export async function createBehaviorExperiment({ telemetry = false } = {}) {
  const cleanup = [];
  const f = await compositionFixture(
    { after: (work) => cleanup.push(work) },
    telemetry ? { ...baseline, 'telemetry.mjs': 'export const version = 1;\n' } : baseline,
  );
  const close = async () => {
    while (cleanup.length) await cleanup.pop()();
  };
  try {
    const initial = telemetry
      ? { ...baseline, 'telemetry.mjs': 'export const version = 1;\n' }
      : baseline;
    const a = await f.future('retry', { ...initial, 'retry.mjs': retry });
    const b = await f.future('charge', { ...initial, 'charge.mjs': charge });
    const c = telemetry
      ? await f.future('telemetry', { ...initial, 'telemetry.mjs': 'export const version = 2;\n' })
      : null;
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
    const compose = async (revisions) => {
      const spec = await f.spec(revisions.map(selected), {
        selected_future_revisions: revisions.map(({ id }) => id),
      });
      return { spec, candidate: await f.materializer.materialize(spec, f.context) };
    };
    const { candidate: composed } = await compose([a, b]);
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
    return {
      f,
      a,
      b,
      c,
      isolated,
      composed,
      compose,
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
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
