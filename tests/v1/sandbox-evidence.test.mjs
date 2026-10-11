import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { LocalWorkspaceSource } from '../../adapters/local/workspace-source.mjs';
import { LinuxSandbox } from '../../adapters/local/sandbox.mjs';
import { SandboxEvidenceProvider } from '../../adapters/local/sandbox-evidence.mjs';
import { V1Error, digestBytes } from '../../core/v1/conventions.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';

const limits = Object.freeze({
  schema_version: 1,
  timeout_ms: 4000,
  cpu_seconds: 2,
  address_space_bytes: 2147483648,
  open_files: 64,
  max_output_bytes: 16384,
  max_input_bytes: 16384,
  max_workspace_bytes: 1048576,
  max_files: 100,
});
const scope = Object.freeze({
  schema_version: 1,
  tenant_id: 'tenant',
  system_id: 'group',
  candidate_digest: 'sha256:object-candidate:v1:' + 'a'.repeat(64),
  trace_id: 'trace-1',
});

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-sandbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const repository = { id: 'canonical', canonical_ref: 'refs/heads/main' };
  const directory = adapter.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet']);
  const blob = await git(directory, ['hash-object', '-w', '--stdin'], script);
  const tree = await git(directory, ['mktree'], `100644 blob ${blob}\tentry.mjs\n`);
  const commit = await git(directory, ['commit-tree', tree, '-m', 'sandbox input']);
  await git(directory, ['update-ref', repository.canonical_ref, commit]);
  const source = new LocalWorkspaceSource({ adapter, repository });
  const workspace = await source.fetch({
    schema_version: 1,
    repo_id: repository.id,
    commit_oid: commit,
    tree_oid: tree,
  });
  const runtime = await realpath(process.execPath);
  const runtimeDigest = await digestBytes(
    'sandbox-runtime',
    new Uint8Array(await readFile(runtime)),
  );
  const audit = [];
  const resource = new TextEncoder().encode('registered resource');
  const sandbox = new LinuxSandbox({
    root: join(root, 'execution'),
    runtimes: { node: { schema_version: 1, binary: runtime, digest: runtimeDigest } },
    limits,
    secretGuard: async (bytes) =>
      !Buffer.from(bytes).includes(Buffer.from('private-object-canary')),
    broker: {
      read: async (id) => {
        if (id !== 'dependency') throw new V1Error('FORBIDDEN');
        return resource;
      },
    },
    audit: async (event) => audit.push(event),
  });
  const request = {
    schema_version: 1,
    runtime_id: 'node',
    argv: ['--max-old-space-size=64', '--max-semi-space-size=4', 'entry.mjs'],
    stdin: '',
    files: [
      { schema_version: 1, repo_id: 'canonical', path: 'entry.mjs', destination: 'entry.mjs' },
    ],
  };
  const workspaces = new Map([['canonical', workspace]]);
  return {
    root,
    directory,
    workspace,
    sandbox,
    request,
    workspaces,
    audit,
    resource,
    tree,
    commit,
  };
}

test('native isolation evaluates selected exact files without writing source Git', async (t) => {
  const f = await fixture(t, "process.stdout.write('observed answer');\n");
  const before = await git(f.directory, ['count-objects', '-v']);
  const result = await f.sandbox.run(f.request, { workspaces: f.workspaces, scope });
  assert.equal(result.exit_code, 0);
  assert.equal(new TextDecoder().decode(result.stdout), 'observed answer');
  assert.equal(await git(f.directory, ['count-objects', '-v']), before);
});

test('inherited credentials, host files, host networking and writes to selected files are unavailable', async (t) => {
  const privateRoot = await mkdtemp(join(tmpdir(), 'klocgit-private-'));
  const filename = join(privateRoot, 'credential');
  await writeFile(filename, 'private-object-canary');
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.end('host');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const script = `import fs from 'node:fs';
const result = { credential: Boolean(process.env.KLOCGIT_CANONICAL_CANARY), host: false, network: false, writable: false };
try { fs.readFileSync(${JSON.stringify(filename)}); result.host = true; } catch {}
try { await fetch('http://127.0.0.1:${server.address().port}', { signal: AbortSignal.timeout(500) }); result.network = true; } catch {}
try { fs.writeFileSync('/candidate/entry.mjs', 'changed'); result.writable = true; } catch {}
process.stdout.write(JSON.stringify(result));`;
  const f = await fixture(t, script);
  const previous = process.env.KLOCGIT_CANONICAL_CANARY;
  process.env.KLOCGIT_CANONICAL_CANARY = 'private-object-canary';
  try {
    const result = await f.sandbox.run(f.request, { workspaces: f.workspaces, scope });
    assert.equal(result.exit_code, 0);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), {
      credential: false,
      host: false,
      network: false,
      writable: false,
    });
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.KLOCGIT_CANONICAL_CANARY;
    else process.env.KLOCGIT_CANONICAL_CANARY = previous;
  }
});

test('output and wall-time exhaustion never become successful observations', async (t) => {
  const output = await fixture(t, "process.stdout.write('x'.repeat(100000));\n");
  await assert.rejects(
    output.sandbox.run(output.request, { workspaces: output.workspaces, scope }),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
  const looping = await fixture(t, 'setInterval(() => {}, 100);\n');
  await assert.rejects(
    looping.sandbox.run(looping.request, { workspaces: looping.workspaces, scope }),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
});

test('explicit broker requests are digest-checked, scoped and audited; unregistered resources remain denied', async (t) => {
  const f = await fixture(t, 'process.stdout.write("ok");');
  const digest = await digestBytes('broker-resource', f.resource);
  const request = { schema_version: 1, resource_id: 'dependency', digest };
  assert.deepEqual(await f.sandbox.readBrokeredResource(request, scope), f.resource);
  assert.deepEqual(
    f.audit.map(({ state }) => state),
    ['REQUESTED', 'VERIFIED'],
  );
  assert.equal(f.audit[0].tenant_id, scope.tenant_id);
  await assert.rejects(
    f.sandbox.readBrokeredResource({ ...request, resource_id: 'unregistered' }, scope),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    f.sandbox.readBrokeredResource(
      { ...request, digest: await digestBytes('broker-resource', new Uint8Array()) },
      scope,
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  assert.equal(f.audit.at(-1).state, 'REJECTED');
  const auditCount = f.audit.length;
  await assert.rejects(f.sandbox.readBrokeredResource(request, { ...scope, tenant_id: '' }), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(
    f.sandbox.readBrokeredResource(
      { ...request, digest: await digestBytes('evidence-payload', f.resource) },
      scope,
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  assert.equal(f.audit.length, auditCount);
});

test('canonical secret injection and traversal are rejected before producer execution', async (t) => {
  const f = await fixture(t, 'process.stdout.write("ok");');
  await assert.rejects(
    f.sandbox.run(
      { ...f.request, stdin: 'private-object-canary' },
      { workspaces: f.workspaces, scope },
    ),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    f.sandbox.run(
      { ...f.request, files: [{ ...f.request.files[0], destination: '../outside' }] },
      { workspaces: f.workspaces, scope },
    ),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    f.sandbox.run(
      { ...f.request, argv: ['x'.repeat(limits.max_input_bytes + 1)] },
      { workspaces: f.workspaces, scope },
    ),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
});

test('a trusted evaluator uses observed I/O and cannot inherit a producer-supplied passing verdict', async (t) => {
  const f = await fixture(
    t,
    "process.stdout.write(JSON.stringify({ status: 'PASSING', answer: 0 }));\n",
  );
  const configuration = {
    schema_version: 1,
    id: 'answer',
    type: 'behavior',
    version: '1.0',
    expected_answer: 42,
    brokered_resources: [],
  };
  const environment_digest = await digestCanonical('evaluation-environment', {
    sandbox: 'native',
    runtime: await digestBytes('sandbox-runtime', new Uint8Array(await readFile(process.execPath))),
  });
  const stored = new Map(),
    payloads = new Map();
  const provider = new SandboxEvidenceProvider({
    tenant_id: 'tenant',
    system_id: 'group',
    principal: { actor_id: 'evaluator' },
    authorize: async (principal) => principal.actor_id === 'evaluator',
    producer_identity: 'trusted-evaluator',
    producer_version: '1.0',
    environment_digest,
    materializer: { open: async () => f.workspace },
    sandbox: f.sandbox,
    retention_class: 'DECISION_RECORD',
    max_payload_bytes: 16384,
    now: () => '2026-10-11T00:00:00Z',
    payloadStore: {
      put: async ({ digest, bytes }) => {
        payloads.set(digest, bytes.slice());
        return { schema_version: 1, digest, ref: 'payload:' + digest };
      },
    },
    evidenceStore: {
      put: async ({ evidence }) => stored.set(evidence.id, evidence),
      find: async () => [...stored.values()],
    },
    recipes: [
      {
        configuration,
        evaluate: async ({ run }) => {
          const observation = await run(f.request);
          const output = JSON.parse(new TextDecoder().decode(observation.stdout));
          return {
            schema_version: 1,
            basis: 'OBSERVED',
            status:
              observation.exit_code === 0 && output.answer === configuration.expected_answer
                ? 'PASSING'
                : 'FAILED',
            claims: ['Observed the returned answer for the registered input.'],
            observed_answer: output.answer,
          };
        },
      },
    ],
  });
  const candidate = await materializedCandidate(
    'klocgit:candidate-spec:v1:sha256:' + 'a'.repeat(64),
    { canonical: f.tree },
    { schema_version: 1, repo_commit_oids: { canonical: f.commit } },
  );
  const requirements = {
    schema_version: 1,
    policy_digest: await digestCanonical('policy', { required: ['answer'] }),
    checks: [
      {
        schema_version: 1,
        id: 'answer',
        type: 'behavior',
        config_digest: await digestCanonical('evaluation-config', configuration),
        environment_digest,
        producers: [{ schema_version: 1, identity: 'trusted-evaluator', versions: ['1.0'] }],
      },
    ],
  };
  const records = await provider.evaluate(candidate, requirements);
  assert.equal(records[0].result.status, 'FAILED');
  assert.equal(records[0].result.observed_answer, 0);
  assert.equal(payloads.size, 1);
  assert.deepEqual(await provider.find_reusable(records[0].subject_digest, requirements), records);
  await assert.rejects(
    provider.evaluate(candidate, {
      ...requirements,
      checks: [{ ...requirements.checks[0], id: 'unregistered' }],
    }),
    { code: 'UNSUPPORTED_CAPABILITY' },
  );
  const substituted = await fixture(t, 'process.stdout.write("different state");');
  provider.materializer = { open: async () => substituted.workspace };
  await assert.rejects(provider.evaluate(candidate, requirements), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(payloads.size, 1);
});
