import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { hashProjection } from '../../../packages/contracts/src/index.ts';
import { signToken } from '../src/auth.ts';
import type { Principal } from '../src/auth.ts';
import { packEvent, unpackEvent, INLINE_LIMIT } from '../src/events.ts';
import type { Scope, Bindings } from '../src/runtime.ts';

const scope: Scope = { tenant_id: 'tenant', organization_id: 'organization', repo_id: 'repo', objective_id: 'objective' };
const endpoint = 'https://klocgit.test/api/tenants/tenant/organizations/organization/repos/repo/objectives/objective';
const root = resolve(import.meta.dirname, '../../..');

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'klocgit-coordination-'));
  const driver = join(directory, 'driver');
  const remote = join(directory, 'remote.git');
  const receipts = join(directory, 'receipts');
  mkdirSync(receipts);
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', remote]);
  git(['init', driver]);
  git(['-C', driver, 'config', 'user.name', 'Fixture']);
  git(['-C', driver, 'config', 'user.email', 'fixture@example.org']);
  writeFileSync(join(driver, 'retry.ts'), 'export function RetryLimit() { return 0; }\n');
  git(['-C', driver, 'add', '.']);
  git(['-C', driver, 'commit', '-m', 'baseline']);
  git(['-C', driver, 'branch', '-M', 'main']);
  git(['-C', driver, 'remote', 'add', 'origin', remote]);
  git(['-C', driver, 'push', 'origin', 'main']);
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  const base = git(['-C', driver, 'rev-parse', 'HEAD']);

  function commit(path: string, content: string, ref?: string): string {
    git(['-C', driver, 'checkout', '--detach', base]);
    writeFileSync(join(driver, path), content);
    git(['-C', driver, 'add', '.']);
    git(['-C', driver, 'commit', '-m', 'change-' + randomUUID(), '--allow-empty']);
    const oid = git(['-C', driver, 'rev-parse', 'HEAD']);
    if (ref) git(['-C', driver, 'push', 'origin', oid + ':' + ref]);
    return oid;
  }
  const actorRefs = ['a', 'duplicate', 'alternative', 'telemetry', 'security'].map((actor) => 'refs/futures/' + actor + '/task');
  const commits = [
    commit('retry.ts', 'export function RetryLimit() { return 1; }\n', actorRefs[0]),
    commit('retry.ts', 'export function RetryLimit() { return 1; }\n', actorRefs[1]),
    commit('retry.ts', 'export function RetryLimit() { return 2; }\n', actorRefs[2]),
    commit('telemetry.ts', 'export const Telemetry = true;\n', actorRefs[3]),
    commit('auth.ts', 'export const Secure = true;\n', actorRefs[4]),
  ];
  const authKey = randomBytes(32).toString('hex');
  const internalKey = randomBytes(32).toString('hex');
  const bundle = await build({ entryPoints: [join(root, 'apps/worker/src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  let obscureNextReceipt = false;
  let engineCalls = 0;
  function receiptPath(id: string) { return join(receipts, Buffer.from(id).toString('hex') + '.json'); }
  const serviceBindings = {
    GIT_EXECUTOR: async (request: Request) => {
      const input = await request.json() as { scope: Scope; ref: string; expected_oid?: string; target_oid?: string; idempotency_key?: string; operation_digest?: string };
      if (input.scope.tenant_id !== scope.tenant_id || input.scope.repo_id !== scope.repo_id || input.scope.organization_id !== scope.organization_id) return new WorkerResponse('forbidden', { status: 403 });
      const path = new URL(request.url).pathname;
      if (path === '/observe') {
        const oid = git(['--git-dir', remote, 'rev-parse', '--verify', input.ref]);
        const tree = git(['--git-dir', remote, 'rev-parse', oid + '^{tree}']);
        const parents = git(['--git-dir', remote, 'rev-list', '--parents', '-n', '1', oid]).split(' ').slice(1);
        return WorkerResponse.json({ commit_oid: oid, tree_oid: tree, parent_oids: parents });
      }
      if (path === '/operation') {
        const path = receiptPath(input.idempotency_key!);
        return WorkerResponse.json(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { status: 'UNKNOWN' });
      }
      if (path === '/cas') {
        try {
          git(['-C', driver, 'push', '--porcelain', '--force-with-lease=' + input.ref + ':' + input.expected_oid, 'origin', input.target_oid + ':' + input.ref]);
          const record = { status: 'APPLIED', expected_oid: input.expected_oid, target_oid: input.target_oid, operation_digest: input.operation_digest };
          const path = receiptPath(input.idempotency_key!);
          writeFileSync(path + '.tmp', JSON.stringify(record));
          renameSync(path + '.tmp', path);
          if (obscureNextReceipt) { obscureNextReceipt = false; return new WorkerResponse('connection lost', { status: 503 }); }
          return WorkerResponse.json(record);
        } catch {
          writeFileSync(receiptPath(input.idempotency_key!), JSON.stringify({ status: 'NO_EFFECT', operation_digest: input.operation_digest }));
          return new WorkerResponse('stale', { status: 409 });
        }
      }
      return new WorkerResponse('not found', { status: 404 });
    },
    ENGINE: async (request: Request) => {
      const input = await request.json() as { input_payload_digest: string; state: { commit_oid: string }; revision: { id: string } };
      const paths = git(['--git-dir', remote, 'diff', '--name-only', base, input.state.commit_oid]).split('\n').filter(Boolean);
      const changes = paths.map((path) => {
        let before: string | null = null;
        let after: string | null = null;
        try { before = git(['--git-dir', remote, 'show', base + ':' + path]); } catch {}
        try { after = git(['--git-dir', remote, 'show', input.state.commit_oid + ':' + path]); } catch {}
        return { path, before, after };
      });
      const effects = JSON.parse(execFileSync('cargo', ['run', '--quiet', '-p', 'klocgit-engine', '--bin', 'klocgit-engine'], {
        cwd: root, input: JSON.stringify({ operation: 'analyze', future_revision_id: input.revision.id, language: 'typescript', changes }), encoding: 'utf8',
      }));
      engineCalls++;
      return WorkerResponse.json({ schema_version: 1, input_payload_digest: input.input_payload_digest, effects });
    },
  };
  const options = {
    modules: true as const, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01',
    durableObjects: { OBJECTIVES: { className: 'ObjectiveCoordinator', useSQLite: true }, REFS: { className: 'RefCoordinator', useSQLite: true } },
    durableObjectsPersist: join(directory, 'durable'),
    r2Buckets: ['PAYLOADS'],
    r2Persist: join(directory, 'r2'),
    queueProducers: { ANALYSIS_QUEUE: 'analysis', DEAD_LETTER_QUEUE: 'dlq' },
    queueConsumers: { analysis: { maxBatchSize: 5, maxBatchTimeout: 1, maxRetries: 5, deadLetterQueue: 'dlq' } },
    bindings: { AUTH_SIGNING_KEY: authKey, INTERNAL_SIGNING_KEY: internalKey, AUTH_ISSUER: 'klocgit', AUTH_AUDIENCE: 'klocgit-api' },
    serviceBindings,
  };
  let mf = new Miniflare(options);
  t.after(async () => { await mf.dispose(); rmSync(directory, { recursive: true, force: true }); });
  const now = Math.floor(Date.now() / 1000);
  const principal: Principal = { sub: 'reviewer', actor_type: 'human', iss: 'klocgit', aud: 'klocgit-api', iat: now, exp: now + 3600, grants: [{ scope, actions: ['read', 'ingest', 'promote'] }] };
  async function token(claims = principal) { return signToken(claims, authKey); }
  async function request(path = endpoint, method = 'GET', body?: unknown, claims = principal, id = randomUUID()) {
    return mf.dispatchFetch(path, { method, headers: { authorization: 'Bearer ' + await token(claims), 'content-type': 'application/json', 'Idempotency-Key': id }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function status() { return (await request()).json() as Promise<any>; }
  async function refCall(command: any, action: string) {
    const namespace = await mf.getDurableObjectNamespace('REFS');
    const name = await hashProjection('klocgit.ref-scope', { tenant_id: command.scope.tenant_id, organization_id: command.scope.organization_id, repo_id: command.scope.repo_id, ref: command.ref });
    const grant = { schema_version: 1, aud: 'ref', action, scope: command.scope, actor_id: command.actor_id, expires_at: Date.now() + 60_000, subject_digest: await hashProjection('klocgit.promotion-command', command) };
    return namespace.getByName(name).fetch('https://ref.internal/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-klocgit-internal': await signToken(grant, internalKey) }, body: JSON.stringify(command),
    });
  }
  function promotion(decision: string, target: string) {
    return { schema_version: 1, scope, ref: 'refs/heads/main', decision_id: decision, basis_digest: 'sha256:' + 'a'.repeat(64), expected_oid: base, target_oid: target, actor_id: 'reviewer', idempotency_key: randomUUID() };
  }
  return {
    directory, base, commits, actorRefs, authKey, internalKey, principal, request, status, refCall, promotion, git, commit,
    get mf() { return mf; }, get engineCalls() { return engineCalls; },
    obscureReceipt() { obscureNextReceipt = true; },
    async restart() { await mf.dispose(); mf = new Miniflare(options); },
  };
}

async function until(check: () => Promise<boolean>, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() >= end) throw new Error('Condition did not become true'); await new Promise((resolve) => setTimeout(resolve, 50)); }
}

test('five concurrent Git pushes are ingested, analyzed and clustered without scripted groups', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(f.actorRefs.map((ref, index) => f.request(endpoint + '/futures', 'POST', { system_id: 'product', ref, producer: { actor_id: 'producer-' + index } })));
  for (const response of responses) assert.equal(response.status, 200, await response.text());
  await until(async () => (await f.status()).futures.filter((future: any) => future.effects).length === 5);
  const observed = await f.status();
  const inputs = observed.futures.map((future: any) => ({
    state: future.state, revision: future.revision, effects: future.effects,
    changed_paths: f.git(['--git-dir', join(f.directory, 'remote.git'), 'diff', '--name-only', f.base, future.state.commit_oid]).split('\n').filter(Boolean),
    required_future_ids: [],
  }));
  const result = JSON.parse(execFileSync('cargo', ['run', '--quiet', '-p', 'klocgit-engine', '--bin', 'klocgit-engine'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ operation: 'reduce', base_revisions: { repo: f.base }, futures: inputs, budget: { max_candidates: 16, max_futures: 100, max_footprint_entries: 1000, max_output_bytes: 1_000_000 } }),
  }));
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.candidate_specs.length, 2);
  assert.equal(result.groups.reduce((count: number, group: any) => count + Object.values(group.duplicate_members).reduce((sum: number, members: any) => sum + members.length, 0), 0), 5);
  await f.restart();
  assert.equal((await f.status()).futures.length, 5);
});

test('authentication, tenant isolation, capability expiry and durable budgets deny invalid work', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.mf.dispatchFetch(endpoint)).status, 401);
  assert.equal((await f.request(endpoint.replace('/tenant/', '/foreign/'))).status, 403);
  const forged = await signToken(f.principal, randomBytes(32).toString('hex'));
  assert.equal((await f.mf.dispatchFetch(endpoint, { headers: { authorization: 'Bearer ' + forged } })).status, 401);
  const agent: Principal = { ...f.principal, sub: 'agent', actor_type: 'agent', grants: [{ scope, actions: ['read', 'ingest'] }], capability: { id: randomUUID(), scope, budget: 1 } };
  const id = randomUUID();
  const first = { system_id: 'product', ref: f.actorRefs[0], producer: { actor_id: 'agent' } };
  assert.equal((await f.request(endpoint + '/futures', 'POST', first, agent, id)).status, 200);
  assert.equal((await f.request(endpoint + '/futures', 'POST', first, agent, id)).status, 200);
  await f.restart();
  assert.equal((await f.request(endpoint + '/futures', 'POST', { ...first, ref: f.actorRefs[1] }, agent)).status, 403);
  assert.equal((await f.request(endpoint, 'GET', undefined, { ...agent, exp: Math.floor(Date.now() / 1000) - 1 })).status, 401);
});

test('R2 claim checks enforce inline bounds, exact byte digests and authorization', async (t) => {
  const f = await fixture(t);
  const bindings = await f.mf.getBindings() as unknown as Bindings;
  const payload = { text: 'x'.repeat(INLINE_LIMIT) };
  const envelope = await packEvent(bindings, { type: 'fixture', scope, subject_version: 1, payload, idempotency_key: randomUUID(), trace_id: randomUUID(), actor_id: 'reviewer', expires_at: Date.now() + 60_000 });
  assert.ok(envelope.payload_ref);
  assert.equal(envelope.payload, undefined);
  assert.deepEqual(await unpackEvent(bindings, envelope), payload);
  await bindings.PAYLOADS.put(envelope.payload_ref!, 'substituted');
  await assert.rejects(unpackEvent(bindings, envelope), /digest verification failed/);
  await assert.rejects(unpackEvent(bindings, { ...envelope, scope: { ...scope, tenant_id: 'foreign' } }));
});

test('concurrent authorized promotions use real receive-pack CAS and preserve the winning ref', async (t) => {
  const f = await fixture(t);
  const a = f.promotion('decision-a', f.commits[0]);
  const b = f.promotion('decision-b', f.commits[2]);
  assert.equal((await f.refCall(a, 'authorize')).status, 200);
  assert.equal((await f.refCall(b, 'authorize')).status, 200);
  const results = await Promise.all([f.refCall(a, 'promote'), f.refCall(b, 'promote')]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  const actual = f.git(['--git-dir', join(f.directory, 'remote.git'), 'rev-parse', 'refs/heads/main']);
  assert.ok([a.target_oid, b.target_oid].includes(actual));
  await f.restart();
  const winner = actual === a.target_oid ? a : b;
  assert.equal((await f.refCall(winner, 'promote')).status, 200);
  assert.equal(f.git(['--git-dir', join(f.directory, 'remote.git'), 'rev-parse', 'refs/heads/main']), actual);
});

test('changed basis and external Git pushes reject stale authorization', async (t) => {
  const f = await fixture(t);
  const old = f.promotion('decision', f.commits[0]);
  assert.equal((await f.refCall(old, 'authorize')).status, 200);
  const changed = { ...old, basis_digest: 'sha256:' + 'b'.repeat(64), target_oid: f.commits[2] };
  assert.equal((await f.refCall(changed, 'authorize')).status, 200);
  assert.equal((await f.refCall(old, 'promote')).status, 409);
  f.git(['-C', join(f.directory, 'driver'), 'push', '--force-with-lease=refs/heads/main:' + f.base, 'origin', f.commits[4] + ':refs/heads/main']);
  assert.equal((await f.refCall(changed, 'promote')).status, 409);
  assert.equal(f.git(['--git-dir', join(f.directory, 'remote.git'), 'rev-parse', 'refs/heads/main']), f.commits[4]);
});

test('lost Git receipt remains UNKNOWN and recovers after coordinator restart', async (t) => {
  const f = await fixture(t);
  const command = f.promotion('decision', f.commits[0]);
  assert.equal((await f.refCall(command, 'authorize')).status, 200);
  f.obscureReceipt();
  assert.equal((await f.refCall(command, 'promote')).status, 503);
  assert.equal(f.git(['--git-dir', join(f.directory, 'remote.git'), 'rev-parse', 'refs/heads/main']), command.target_oid);
  assert.equal((await f.refCall(f.promotion('other', f.commits[2]), 'authorize')).status, 409);
  await f.restart();
  assert.equal((await f.refCall(command, 'reconcile')).status, 200);
  assert.equal((await f.refCall(command, 'promote')).status, 200);
});
