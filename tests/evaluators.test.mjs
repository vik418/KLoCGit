import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, emptyState } from '../core/engine.mjs';
import { Evaluators } from '../core/evaluators.mjs';
import { hash, record, stable } from '../core/hash.mjs';
import { LocalGit, git } from '../server/git.mjs';

const baseline = '1'.repeat(40);
const commit = '2'.repeat(40);
const tree = '3'.repeat(40);
const policyHead = '4'.repeat(40);
const secret = 'test-owned-secret-with-at-least-16-characters';

async function fixture(options = {}) {
  let clock = 1000000;
  let sourcesCurrent = true;
  const refs = { app: baseline, policy: policyHead };
  const calls = [];
  const adapter = {
    configHash: 'trusted-validator-v0',
    async ref(repo) {
      return refs[repo.id];
    },
    async facts(repo, head) {
      return { head, tree: repo.id === 'app' ? tree : '5'.repeat(40) };
    },
    async validate(repo, head, constraints, heads) {
      calls.push({ repo, head, constraints, heads });
      return {
        passed: true,
        checks: [{ name: 'trusted integration', passed: true }],
        limitations: ['Only this finite test-owned assertion is established.'],
      };
    },
  };
  const candidate = await record('candidate', {
    selection_ids: [],
    base_heads: { app: baseline, policy: policyHead },
    repositories: [
      { repo_id: 'app', base_commit: baseline, base_tree: '6'.repeat(40), commit, tree },
    ],
  });
  const state = {
    ...emptyState(),
    repositories: [
      {
        id: 'app',
        head: baseline,
        tree: '6'.repeat(40),
        baseline,
        canonical_ref: 'refs/heads/main',
      },
      {
        id: 'policy',
        head: policyHead,
        tree: '5'.repeat(40),
        baseline: policyHead,
        canonical_ref: 'refs/heads/main',
      },
    ],
    candidateStates: [candidate],
  };
  let saves = 0;
  const engine = new Engine(state, adapter, async () => saves++);
  // These unit tests isolate evaluator policy. Authentication and role tests
  // belong to AccessControl; the signed callbacks below still use real HMAC.
  delete engine.access;
  engine.pipeline.sourceValidity = async () => sourcesCurrent;
  const services = { ci: { secret, key_id: 'ci-key-v1', repo_ids: ['app', 'policy'] } };
  const evaluator = new Evaluators(engine, {
    services,
    clock: () => clock,
    ...options,
  });
  const profile = (
    await evaluator.register(
      {
        key: 'independent-ci',
        repo_ids: ['app', 'policy'],
        mode: 'external',
        service_id: 'ci',
        config_hash: 'ci-config-v0',
        required_checks: ['trusted integration'],
      },
      'owner',
    )
  ).profile;
  let sequence = 0;
  return {
    engine,
    evaluator,
    adapter,
    candidate,
    profile,
    state,
    services,
    refs,
    calls,
    saves: () => saves,
    tick: (ms) => {
      clock += ms;
    },
    sources: (current) => {
      sourcesCurrent = current;
    },
    async issue(profileId = profile.id, requestId = 'run-' + sequence++) {
      return (
        await evaluator.run(candidate.id, { profile_id: profileId, request_id: requestId }, 'owner')
      ).run;
    },
    body(run, state = 'passing', event = 'callback-' + sequence++) {
      return {
        event_id: event,
        run_id: run.id,
        pins: structuredClone(run.pins),
        pins_hash: run.pins_hash,
        state,
        result: {
          checks: [
            { id: 'trusted integration', state: state === 'passing' ? 'passing' : 'failed' },
          ],
        },
      };
    },
  };
}

async function signed(body, serviceSecret = secret, serviceId = 'ci') {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(serviceSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(stable({ run_id: body.run_id, body })),
  );
  return {
    service_id: serviceId,
    signature: [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  };
}

test('operator profile revisions are immutable and administration is scoped', async () => {
  const f = await fixture();
  assert.equal(Object.isFrozen(f.state.evaluatorProfiles[0]), true);
  const calls = [];
  f.engine.access = {
    require(principal, operation, ids) {
      calls.push({ principal, operation, ids });
    },
  };
  await assert.rejects(
    () =>
      f.evaluator.register(
        {
          ...f.profile,
          config_hash: 'next',
        },
        'producer',
      ),
    { code: 'UNAUTHENTICATED' },
  );
  const principal = { actor_id: 'admin', kind: 'human', auth_method: 'fixture' };
  await f.evaluator.register({ ...f.profile, config_hash: 'next' }, 'admin', principal);
  assert.equal(calls[0].operation, 'policy.write');
  assert.deepEqual(calls[0].ids, ['app', 'policy']);
  assert.equal(f.state.evaluatorProfiles[0].config_hash, 'ci-config-v0');
});

test('issued runs pin exact trees, dependencies, constraints, profile and credentials', async () => {
  const f = await fixture();
  f.state.constraints.push({ id: 'constraint-v1', active: true, kind: 'checkable' });
  const run = await f.issue();
  assert.deepEqual(run.pins.dependency_heads, { app: commit, policy: policyHead });
  assert.deepEqual(run.pins.canonical_heads, { app: baseline, policy: policyHead });
  assert.equal(run.pins.repositories[0].tree, tree);
  assert.deepEqual(run.pins.constraint_versions, ['constraint-v1']);
  assert.equal(run.pins.evaluator_config_hash, 'ci-config-v0');
  assert.equal(run.pins.service_key_id, 'ci-key-v1');
  assert.equal(f.evaluator.latest(run.id).state, 'pending');
  assert.equal(Object.isFrozen(run.pins), true);
  assert.equal(JSON.stringify(f.evaluator.view()).includes(secret), false);
  assert.equal((await f.evaluator.eligibility(f.candidate.id)).passing, false);
});

test('valid callbacks require real HMAC and cannot become trusted from producer claims', async () => {
  const f = await fixture();
  const run = await f.issue();
  const body = f.body(run);
  await assert.rejects(
    async () => f.evaluator.report(run.id, body, { service_id: 'ci', signature: '0'.repeat(64) }),
    { code: 'UNAUTHENTICATED_EVALUATOR' },
  );
  await assert.rejects(
    async () => f.evaluator.report(run.id, body, { authenticated: true, trusted: true }),
    { code: 'UNAUTHENTICATED_EVALUATOR' },
  );
  await f.evaluator.declaration(
    f.candidate.id,
    { summary: 'All tests passed.', passed: true },
    'producer',
  );
  assert.equal((await f.evaluator.eligibility(f.candidate.id)).passing, false);
  const receipt = await f.evaluator.report(run.id, body, await signed(body));
  assert.equal(receipt.evidence.basis, 'observed');
  assert.equal(receipt.evidence.result.passed, true);
  assert.equal((await f.evaluator.eligibility(f.candidate.id)).passing, true);
});

test('signed callbacks with changed tree, config, constraint or dependency pins are rejected', async () => {
  const f = await fixture();
  const run = await f.issue();
  for (const alter of [
    (body) => {
      body.pins.repositories[0].tree = 'a'.repeat(40);
    },
    (body) => {
      body.pins.evaluator_config_hash = 'different-ci-config';
    },
    (body) => {
      body.pins.constraint_versions = ['different-constraint'];
    },
    (body) => {
      body.pins.dependency_heads.policy = 'b'.repeat(40);
    },
  ]) {
    const body = f.body(run);
    alter(body);
    body.pins_hash = await hash(body.pins);
    await assert.rejects(
      async () =>
        f.evaluator.report(run.id, body, {
          service_id: 'ci',
          signature: (await signed(body)).signature,
        }),
      { code: 'EVALUATION_INPUT_MISMATCH' },
    );
  }
  assert.equal(f.state.evidence.length, 0);
});

test('lost callback acknowledgments replay without overwriting or duplicating evidence', async () => {
  const f = await fixture();
  const run = await f.issue();
  const body = f.body(run, 'passing', 'fixed-event');
  const auth = await signed(body);
  const first = await f.evaluator.report(run.id, body, auth);
  const evidenceCount = f.state.evidence.length;
  const duplicate = await f.evaluator.report(run.id, body, auth);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, first.event.id);
  assert.equal(f.state.evidence.length, evidenceCount);
  body.result.checks[0].summary = 'Conflicting duplicate.';
  await assert.rejects(
    async () =>
      f.evaluator.report(run.id, body, {
        service_id: 'ci',
        signature: (await signed(body)).signature,
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('later pending, running, failed, cancelled and skipped reruns never reuse an older pass', async () => {
  const f = await fixture();
  const first = await f.issue();
  const pass = f.body(first);
  await f.evaluator.report(first.id, pass, await signed(pass));
  for (const state of ['pending', 'running', 'failed', 'cancelled', 'skipped']) {
    const run = await f.issue();
    if (state === 'cancelled')
      await f.evaluator.cancel(run.id, { reason: 'New input is required.' }, 'owner');
    else if (state !== 'pending') {
      const body = f.body(run, state);
      if (state === 'skipped') body.result.checks[0].state = 'skipped';
      await f.evaluator.report(run.id, body, await signed(body));
    }
    const eligibility = await f.evaluator.eligibility(f.candidate.id);
    assert.equal(eligibility.passing, false, state);
    assert.equal(eligibility.basis.required_evaluations[0].run.id, run.id);
  }
});

test('stale constraints, dependencies, source versions and configuration invalidate a pass', async () => {
  for (const mutate of [
    (f) => {
      f.state.constraints.push({ id: 'constraint-next', active: true });
    },
    (f) => {
      f.refs.policy = 'a'.repeat(40);
    },
    (f) => {
      f.sources(false);
    },
    (f) => {
      f.adapter.configHash = 'next-validator';
    },
    (f) => {
      f.services.ci.key_id = 'rotated-key';
    },
  ]) {
    const f = await fixture();
    const run = await f.issue();
    const body = f.body(run);
    await f.evaluator.report(run.id, body, await signed(body));
    mutate(f);
    const result = await f.evaluator.eligibility(f.candidate.id);
    assert.equal(result.passing, false);
    assert.equal(result.runs.at(-1).state, 'stale');
  }
});

test('new profile bindings cannot revive an old pass and exact request repeats are idempotent', async () => {
  const f = await fixture();
  const run = await f.issue(f.profile.id, 'one-request');
  assert.equal((await f.issue(f.profile.id, 'one-request')).id, run.id);
  const body = f.body(run);
  await f.evaluator.report(run.id, body, await signed(body));
  const next = (await f.evaluator.register({ ...f.profile, config_hash: 'ci-config-v1' }, 'owner'))
    .profile;
  await assert.rejects(() => f.issue(next.id, 'one-request'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.evaluator.eligibility(f.candidate.id)).passing, false);
  await assert.rejects(() => f.issue(f.profile.id), { code: 'EVALUATOR_STALE' });
});

test('cancellation preserves history and rejects a later passing callback', async () => {
  const f = await fixture();
  const run = await f.issue();
  const cancelled = await f.evaluator.cancel(run.id, { reason: 'Cancel this result.' }, 'owner');
  assert.match(cancelled.event.claim, /does not claim/);
  const body = f.body(run);
  await assert.rejects(
    async () =>
      f.evaluator.report(run.id, body, {
        service_id: 'ci',
        signature: (await signed(body)).signature,
      }),
    { code: 'EVALUATION_COMPLETE' },
  );
  assert.deepEqual(
    f.state.evaluationEvents.filter((event) => event.run_id === run.id).map((event) => event.state),
    ['pending', 'cancelled'],
  );
});

test('missing callbacks expire and cannot authorize promotion', async () => {
  const f = await fixture();
  const run = await f.issue();
  f.tick(900000);
  assert.equal((await f.evaluator.eligibility(f.candidate.id)).passing, false);
  assert.equal((await f.evaluator.review(f.candidate.id)).runs[0].state, 'stale');
  const body = f.body(run);
  await assert.rejects(
    async () =>
      f.evaluator.report(run.id, body, {
        service_id: 'ci',
        signature: (await signed(body)).signature,
      }),
    { code: 'EVALUATION_EXPIRED' },
  );
});

test('admission budgets bound active work and charged evaluation units', async () => {
  const f = await fixture({ limits: { max_active_runs: 1, max_units_per_day: 2 } });
  const first = await f.issue();
  await assert.rejects(() => f.issue(), { code: 'EVALUATION_BUDGET_EXCEEDED' });
  await f.evaluator.cancel(first.id, { reason: 'Release active slot.' }, 'owner');
  const second = await f.issue();
  await f.evaluator.cancel(second.id, { reason: 'Release second slot.' }, 'owner');
  await assert.rejects(() => f.issue(), { code: 'EVALUATION_BUDGET_EXCEEDED' });
  assert.equal(f.state.evaluationRuns.length, 2);
});

test('bounded JUnit/SARIF metadata does not ingest raw reports or authorize contradictory results', async () => {
  const f = await fixture();
  const run = await f.issue();
  const body = f.body(run);
  body.result.reports = [
    {
      format: 'junit',
      tests: 3,
      failures: 0,
      artifact_sha256: 'a'.repeat(64),
      xml: '<do-not-store/>',
    },
    { format: 'sarif', findings: 0, sarif: { doNotStore: true } },
  ];
  const result = await f.evaluator.report(run.id, body, await signed(body));
  assert.equal(JSON.stringify(result.evidence).includes('do-not-store'), false);
  assert.equal('sarif' in result.evidence.result.reports[1], false);
  const next = await f.issue();
  const contradictory = f.body(next);
  contradictory.result.reports = [{ format: 'junit', failures: 1 }];
  await assert.rejects(
    async () =>
      f.evaluator.report(next.id, contradictory, {
        service_id: 'ci',
        signature: (await signed(contradictory)).signature,
      }),
    { code: 'INVALID_EVALUATION_REPORT' },
  );
  const tooLarge = f.body(next);
  tooLarge.padding = 'x'.repeat(70000);
  await assert.rejects(
    async () =>
      f.evaluator.report(next.id, tooLarge, { service_id: 'ci', signature: 'a'.repeat(64) }),
    { code: 'REPORT_TOO_LARGE' },
  );
});

test('required independent checks cannot be omitted and service scopes cannot be expanded', async () => {
  const f = await fixture();
  const run = await f.issue();
  const body = f.body(run);
  body.result.checks = [{ id: 'producer-only-test', state: 'passing' }];
  await assert.rejects(
    async () =>
      f.evaluator.report(run.id, body, {
        service_id: 'ci',
        signature: (await signed(body)).signature,
      }),
    { code: 'INVALID_EVALUATION_REPORT' },
  );
  f.services.ci.repo_ids = ['app'];
  await assert.rejects(
    async () =>
      f.evaluator.report(run.id, f.body(run), { service_id: 'ci', signature: 'a'.repeat(64) }),
    { code: 'EVALUATOR_SERVICE_UNAVAILABLE' },
  );
});

test('built-in dispatch delegates to exact candidate dependencies and preserves canonical validity', async () => {
  const f = await fixture();
  const profile = (
    await f.evaluator.register(
      {
        key: 'builtin-profile',
        repo_ids: ['app', 'policy'],
        mode: 'builtin',
        config_hash: f.adapter.configHash,
        required_checks: ['trusted integration'],
      },
      'owner',
    )
  ).profile;
  const run = await f.issue(profile.id);
  const result = await f.evaluator.dispatch(run.id);
  assert.equal(result.event.state, 'passing');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].head, commit);
  assert.deepEqual(f.calls[0].heads, { app: commit, policy: policyHead });
  assert.deepEqual(result.evidence[0].validity_heads, { app: baseline, policy: policyHead });
  assert.deepEqual(result.evidence[0].evaluation_heads, { app: commit, policy: policyHead });
  await assert.rejects(() => f.evaluator.dispatch(run.id), { code: 'EVALUATION_NOT_PENDING' });
});

test('builtin exceptions and empty assertions fail without leaking execution secrets', async () => {
  for (const validate of [
    async () => {
      throw new Error(secret);
    },
    async () => ({ passed: true, checks: [] }),
  ]) {
    const f = await fixture();
    f.adapter.validate = validate;
    const profile = (
      await f.evaluator.register(
        {
          key: 'baseline',
          repo_ids: ['app'],
          mode: 'builtin',
          config_hash: 'runner-v0',
        },
        'owner',
      )
    ).profile;
    const result = await f.evaluator.dispatch((await f.issue(profile.id)).id);
    assert.equal(result.event.state, 'failed');
    assert.equal(JSON.stringify(f.evaluator.view()).includes(secret), false);
  }
});

test('rollout overlays only its expected canonical vector while keeping original evidence pins', async () => {
  const f = await fixture();
  const run = await f.issue();
  const body = f.body(run);
  await f.evaluator.report(run.id, body, await signed(body));
  f.refs.app = commit;
  assert.equal((await f.evaluator.eligibility(f.candidate.id)).passing, false);
  const during = await f.evaluator.eligibility(f.candidate.id, {
    canonical_heads: { app: commit, policy: policyHead },
  });
  assert.equal(during.passing, true);
  assert.deepEqual(during.basis.required_evaluations[0].run.pins.canonical_heads, {
    app: baseline,
    policy: policyHead,
  });
  await assert.rejects(
    () => f.evaluator.eligibility(f.candidate.id, { canonical_heads: { app: commit } }),
    { code: 'INVALID_EVALUATION_BASE' },
  );
});

test('builtin baseline uses real Git policy validation without executing producer commands', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-evaluator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  await mkdir(work);
  await mkdir(path.join(root, 'repositories'));
  await git(work, ['init', '--quiet', '-b', 'main']);
  await writeFile(
    path.join(work, 'checkout-policy.json'),
    JSON.stringify({ maxChargesPerOrder: 1, maxConfirmationsPerOrder: 1, allowed_values: [] }),
  );
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'versioned policy']);
  const head = await git(work, ['rev-parse', 'HEAD']);
  const exactTree = await git(work, ['rev-parse', 'HEAD^{tree}']);
  const adapter = new LocalGit(root);
  adapter.configHash = 'policy-document-fixture-v0';
  await git(root, ['clone', '--bare', '--quiet', work, adapter.dir({ id: 'policy' })]);
  const candidate = await record('candidate', {
    selection_ids: [],
    base_heads: { policy: head },
    repositories: [
      { repo_id: 'policy', base_commit: head, base_tree: exactTree, commit: head, tree: exactTree },
    ],
  });
  const state = {
    ...emptyState(),
    repositories: [
      {
        id: 'policy',
        head,
        tree: exactTree,
        baseline: head,
        canonical_ref: 'refs/heads/main',
        validation_profile: 'context-document-v0',
      },
    ],
    candidateStates: [candidate],
  };
  const engine = new Engine(state, adapter);
  delete engine.access;
  engine.pipeline.sourceValidity = async () => true;
  const evaluator = new Evaluators(engine);
  const profile = (
    await evaluator.register(
      {
        key: 'policy-schema',
        repo_ids: ['policy'],
        mode: 'builtin',
        config_hash: adapter.configHash,
        required_checks: ['Versioned exactly-once policy is supported'],
      },
      'owner',
    )
  ).profile;
  const run = (
    await evaluator.run(
      candidate.id,
      { profile_id: profile.id, request_id: 'real-policy-check' },
      'owner',
    )
  ).run;
  const result = await evaluator.dispatch(run.id);
  assert.equal(result.event.state, 'passing');
  assert.equal(result.evidence[0].tree_hash, exactTree);
  assert.match(result.evidence[0].result.limitations[0], /Only this versioned policy schema/);
});

test('deployment observations pin exact code and version without claiming preview provisioning', async () => {
  const f = await fixture();
  const run = await f.issue();
  const body = f.body(run);
  body.deployment = {
    repo_id: 'app',
    commit,
    tree,
    version: 'deployment-001',
    url: 'https://candidate.example.org/',
  };
  const receipt = await f.evaluator.report(run.id, body, await signed(body));
  assert.equal(receipt.evidence.deployment.basis, 'observed');
  assert.equal(receipt.evidence.deployment.commit, commit);
  assert.match(receipt.evidence.deployment.claim, /did not provision/);
  for (const deployment of [
    { ...body.deployment, commit: 'a'.repeat(40) },
    { ...body.deployment, version: '' },
    { ...body.deployment, url: 'https://candidate.example.org/?token=private' },
    { ...body.deployment, url: 'http://candidate.example.org/' },
  ]) {
    const next = await f.issue();
    const report = f.body(next);
    report.deployment = deployment;
    await assert.rejects(async () => f.evaluator.report(next.id, report, await signed(report)), {
      code: 'INVALID_EVALUATION_REPORT',
    });
  }
});

test('callback count budgets preserve duplicate receipts and bound repeated running observations', async () => {
  const f = await fixture({ limits: { max_callbacks_per_run: 1 } });
  const run = await f.issue();
  const running = f.body(run, 'running');
  const auth = await signed(running);
  await f.evaluator.report(run.id, running, auth);
  assert.equal((await f.evaluator.report(run.id, running, auth)).duplicate, true);
  const another = f.body(run, 'running');
  await assert.rejects(async () => f.evaluator.report(run.id, another, await signed(another)), {
    code: 'REPORT_BUDGET_EXCEEDED',
  });
  assert.equal(f.state.evaluationEvents.filter((event) => event.callback_id).length, 1);
});

test('pending quotas count active runs and allow replay and completed history', async () => {
  const f = await fixture();
  const counts = [];
  f.engine.access = {
    assertQuota(name, count) {
      assert.equal(name, 'pending_runs');
      counts.push(count);
      if (count >= 1)
        throw Object.assign(new Error('Active run limit'), { code: 'QUOTA_EXCEEDED' });
    },
  };
  const first = await f.issue(f.profile.id, 'quota-first');
  const repeated = await f.issue(f.profile.id, 'quota-first');
  assert.equal(repeated.id, first.id);
  assert.deepEqual(counts, [0]);
  await assert.rejects(() => f.issue(f.profile.id, 'quota-second'), { code: 'QUOTA_EXCEEDED' });
  await f.evaluator.cancel(first.id, { reason: 'Release the active slot' }, 'owner');
  await f.issue(f.profile.id, 'quota-second');
  assert.deepEqual(counts, [0, 1, 0]);
});
