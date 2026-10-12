import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { hashProjection, payloadDigest, sealCandidate, sealFutureRevision } from '../../../packages/contracts/src/index.ts';
import { EvidenceStore } from '../src/evidence-store.ts';

const root = resolve(import.meta.dirname, '../../..');
const fixtures = join(root, 'tests/fixtures/sandbox');
const image_oid = process.env.KLOCGIT_SANDBOX_IMAGE;
assert.match(image_oid ?? '', /^sha256:[0-9a-f]{64}$/);

async function snapshot(directory: string): Promise<{ location: string; tree_oid: string; dispose(): void }> {
  const location = mkdtempSync(join(tmpdir(), 'klocgit-state-'));
  cpSync(directory, location, { recursive: true });
  chmodSync(location, 0o755);
  execFileSync('git', ['init', location], { stdio: 'ignore' });
  execFileSync('git', ['-C', location, 'add', '.'], { stdio: 'ignore' });
  const tree_oid = execFileSync('git', ['-C', location, 'write-tree'], { encoding: 'utf8' }).trim();
  return { location, tree_oid, dispose() { rmSync(location, { recursive: true, force: true }); } };
}

async function evaluate(workspace: string, suite: string, checks: { id: string; command: string[] }[], overrides = {}) {
  const code = await snapshot(workspace);
  const trusted = await snapshot(suite);
  const spec_digest = await hashProjection('klocgit.fixture-spec', { repo: code.tree_oid });
  const candidate = await sealCandidate({
    candidate_spec_id: spec_digest, repo_tree_oids: { repo: code.tree_oid },
    materialization_record: { executor_id: 'fixture', materialized_at: new Date().toISOString(), conflicts_encountered: [] },
  });
  const policy = {
    schema_version: 1, evaluator_id: 'trusted-sandbox', evaluator_version: '1', image_oid,
    trusted_suite_state_digest: await hashProjection('klocgit.trusted-suite', { tree_oid: trusted.tree_oid }), checks,
    timeout_ms: 60_000, memory_bytes: 536870912, pids_limit: 256, max_log_bytes: 65536,
    ...overrides,
  };
  try { return JSON.parse(execFileSync('cargo', ['run', '--quiet', '-p', 'klocgit-engine', '--bin', 'klocgit-engine'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({
      operation: 'evaluate', workspace: code.location, trusted_suite: trusted.location, subject_digest: candidate.candidate_digest, policy,
    }), timeout: 180_000,
  })); } finally { code.dispose(); trusted.dispose(); }
}

test('Node, Python and Go execute real trusted checks and produce immutable R2 receipts', async (t) => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2026-08-06', r2Buckets: ['EVIDENCE'] });
  t.after(() => mf.dispose());
  const bucket = await mf.getR2Bucket('EVIDENCE');
  const store = new EvidenceStore(bucket as unknown as R2Bucket);
  const cases = [
    { language: 'typescript', checks: [
      { id: 'vitest', command: ['node', '/opt/node-tools/node_modules/vitest/vitest.mjs', 'run', '--globals', '--root', '/checks', '--config', '/checks/vitest.config.cjs'] },
      { id: 'tsc', command: ['node', '/opt/node-tools/node_modules/typescript/bin/tsc', '--noEmit', '--project', '/workspace/tsconfig.json'] },
    ] },
    { language: 'python', checks: [
      { id: 'pytest', command: ['python', '-c', 'import sys,pytest; sys.path.insert(0,"/workspace"); raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","/checks"]))'] },
      { id: 'pyright', command: ['node', '/opt/node-tools/node_modules/pyright/index.js', '--project', '/checks/pyrightconfig.json'] },
    ] },
    { language: 'go', checks: [
      { id: 'go-test', command: ['go', 'test', '-v', '-race', './...'] },
    ] },
  ];
  for (const item of cases) {
    const result = await evaluate(join(fixtures, item.language), join(fixtures, item.language + '-checks'), item.checks);
    assert.equal(result.evidence.result, 'PASSED', JSON.stringify(result.receipt));
    assert.equal(result.receipt.checks.length, item.checks.length);
    for (const check of result.receipt.checks) assert.equal(check.exit_code, 0, check.stderr);
    const payload = Uint8Array.from(result.payload);
    assert.equal(await payloadDigest(payload), result.evidence.payload_digest);
    const persisted = await store.persist('tenant', result.evidence, payload);
    const second = await store.persist('tenant', { ...result.evidence, retention_class: 'CANONICAL' }, payload);
    assert.equal(persisted.evidence_digest, second.evidence_digest);
    assert.deepEqual((await store.load('tenant', persisted.evidence_digest)).payload, payload);
  }
});

test('untrusted execution cannot use egress, canonical credentials or writable source', async () => {
  const command = [
    'node', '-e',
    'const fs=require("fs");const assert=require("assert/strict");assert.equal(process.env.AUTH_SIGNING_KEY,undefined);assert.equal(process.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);assert.equal(fs.readFileSync("/proc/net/route","utf8").trim().split("\\n").length,1);assert.throws(()=>fs.writeFileSync("/workspace/api.ts","changed"));console.log("isolation checks passed");',
  ];
  const result = evaluate(join(fixtures, 'typescript'), join(fixtures, 'typescript-checks'), [{ id: 'isolation', command }]);
  assert.equal(result.evidence.result, 'PASSED', JSON.stringify(result.receipt));
});

test('timeouts terminate execution and failed tests remain failed evidence', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'klocgit-failed-check-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  cpSync(join(fixtures, 'typescript'), workspace, { recursive: true });
  writeFileSync(join(workspace, 'api.ts'), 'export function retries(): number { return 2; }\n');
  const failed = await evaluate(workspace, join(fixtures, 'typescript-checks'), [{
    id: 'vitest', command: ['node', '/opt/node-tools/node_modules/vitest/vitest.mjs', 'run', '--globals', '--root', '/checks', '--config', '/checks/vitest.config.cjs'],
  }]);
  assert.equal(failed.evidence.result, 'FAILED');
  const timed = await evaluate(workspace, join(fixtures, 'typescript-checks'), [{ id: 'timeout', command: ['node', '-e', 'while(true){}'] }], { timeout_ms: 300 });
  assert.equal(timed.evidence.result, 'ERROR');
  assert.equal(timed.receipt.checks[0].timed_out, true);
});

test('isolated futures pass while their clean composition exposes a semantic interaction', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'klocgit-interaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(fixtures, 'interaction'), directory, { recursive: true });
  chmodSync(directory, 0o755);
  const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.org']);
  git(['add', '.']);
  git(['commit', '-m', 'baseline']);
  const base = git(['rev-parse', 'HEAD']);
  const retryBefore = readFileSync(join(directory, 'retry.ts'), 'utf8');
  const ledgerBefore = readFileSync(join(directory, 'ledger.ts'), 'utf8');
  const retryAfter = retryBefore.replace('const attempts = 1;', 'const attempts = 2;');
  writeFileSync(join(directory, 'retry.ts'), retryAfter);
  git(['add', '.']);
  git(['commit', '-m', 'retry uncertain delivery']);
  const a = git(['rev-parse', 'HEAD']);
  git(['checkout', '--detach', base]);
  const ledgerAfter = ledgerBefore.replace('  if (charged.has(id)) return;\n', '');
  writeFileSync(join(directory, 'ledger.ts'), ledgerAfter);
  git(['add', '.']);
  git(['commit', '-m', 'record each attempt']);
  const b = git(['rev-parse', 'HEAD']);
  const native = (input: unknown) => JSON.parse(execFileSync('cargo', ['run', '--quiet', '-p', 'klocgit-engine', '--bin', 'klocgit-engine'], { cwd: root, input: JSON.stringify(input), encoding: 'utf8', timeout: 180_000 }));
  const makeSource = async (oid: string, actor: string, path: string, before: string, after: string) => {
    const state = { repo_id: 'repo', commit_oid: oid, tree_oid: git(['rev-parse', oid + '^{tree}']), parent_oids: git(['show', '-s', '--format=%P', oid]).split(' ').filter(Boolean) };
    const revision = await sealFutureRevision(state, { system_id: 'product', ref: 'refs/futures/' + actor + '/task', producer: { actor_id: actor }, observed_at: new Date().toISOString() });
    const effects = native({ operation: 'analyze', future_revision_id: revision.id, language: 'typescript', changes: [{ path, before, after }] });
    return { repository_path: directory, state, revision, effects, changed_paths: [path], required_future_ids: [] };
  };
  const sources = [await makeSource(a, 'retry', 'retry.ts', retryBefore, retryAfter), await makeSource(b, 'ledger', 'ledger.ts', ledgerBefore, ledgerAfter)];
  const trusted = await snapshot(join(fixtures, 'interaction-checks'));
  t.after(() => trusted.dispose());
  const policy = {
    schema_version: 1, evaluator_id: 'trusted-payment-checks', evaluator_version: '1', image_oid,
    trusted_suite_state_digest: await hashProjection('klocgit.trusted-suite', { tree_oid: trusted.tree_oid }),
    checks: [{ id: 'at-most-once-charge', command: ['node', '/opt/node-tools/node_modules/vitest/vitest.mjs', 'run', '--globals', '--root', '/checks', '--config', '/checks/vitest.config.cjs'] }],
    timeout_ms: 60_000, memory_bytes: 536870912, pids_limit: 256, max_log_bytes: 65536,
  };
  const outcomes = [];
  for (const selected of [[sources[0]], [sources[1]], sources]) {
    const reduction = native({
      operation: 'reduce', base_revisions: { repo: base },
      futures: selected.map(({ repository_path: _path, ...future }) => future),
      budget: { max_candidates: 16, max_futures: 100, max_footprint_entries: 1000, max_output_bytes: 1_000_000 },
    });
    assert.equal(reduction.candidate_specs.length, 1);
    const result = native({
      operation: 'evaluate_candidate', base_repository: directory, repo_id: 'repo',
      candidate_spec: reduction.candidate_specs[0],
      sources: selected.map(({ changed_paths: _changed, required_future_ids: _required, ...record }) => record),
      trusted_suite: trusted.location, policy,
    });
    assert.equal(result.evidence.subject_digest, result.candidate.candidate_digest);
    outcomes.push(result.evidence.result);
  }
  assert.deepEqual(outcomes, ['PASSED', 'PASSED', 'FAILED']);
});
