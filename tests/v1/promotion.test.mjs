import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { LocalGitStore } from '../../adapters/local/git-store.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { CoordinationStore, coordinationScope } from '../../core/v1/coordination.mjs';
import { GitRefRejection, GitStore } from '../../core/v1/git-store.mjs';
import { Candidate } from '../../core/v1/domain.mjs';
import { objectId } from '../../core/v1/conventions.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { buildDecisionBasis } from '../../core/v1/decisions.mjs';
import { PromotionService } from '../../core/v1/promotion.mjs';
import { AuditStream } from '../../core/v1/audit.mjs';

const digest = (domain, hex = 'a') => 'sha256:' + domain + ':v1:' + hex.repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-promotion-'));
  const filename = join(directory, 'coordination.sqlite');
  const backends = [];
  t.after(async () => {
    backends.forEach((backend) => backend.close());
    await rm(directory, { recursive: true, force: true });
  });
  const local = new LocalGit(directory);
  const repo_id = 'repo';
  const ref = 'refs/heads/main';
  const repository = { id: repo_id, canonical_ref: ref };
  const gitDirectory = local.dir(repository);
  await mkdir(gitDirectory, { recursive: true });
  await git(gitDirectory, ['init', '--bare', '--quiet']);
  let provider;
  provider = new LocalGitStore({
    adapter: local,
    repository,
    workspaceSource: {
      fetch: async (revision) => ({ identity: await provider.snapshot(revision.commit_oid) }),
    },
  });
  const create = async (message, parents = []) => {
    const blob = await git(gitDirectory, ['hash-object', '-w', '--stdin'], message);
    const tree = await git(gitDirectory, ['mktree'], `100644 blob ${blob}\tfile.txt\n`);
    const oid = await git(gitDirectory, [
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      message,
    ]);
    return provider.snapshot(oid);
  };
  const initial = await create('initial');
  const target = await create('candidate', [initial.commit_oid]);
  const external = await create('external', [initial.commit_oid]);
  await git(gitDirectory, ['update-ref', ref, initial.commit_oid]);
  const candidateProjection = {
    schema_version: 1,
    candidate_spec_id: objectId('candidate-spec', digest('object-candidate-spec')),
    repo_tree_oids: { [repo_id]: target.tree_oid },
    materialization_record: {
      schema_version: 1,
      repo_commit_oids: { [repo_id]: target.commit_oid },
    },
  };
  const candidateDigest = await digestCanonical('object-candidate', candidateProjection);
  const candidate = Candidate({
    ...candidateProjection,
    id: objectId('candidate', candidateDigest),
    digest: candidateDigest,
  });
  const decision_id = objectId('decision', digest('object-decision'));
  const basis = await buildDecisionBasis({
    schema_version: 1,
    candidate_digests: [candidateDigest],
    evidence_digests: [],
    material_effect_digest: digest('material-effect'),
    policy_digest: digest('policy'),
    canonical_ref_oids: { [repo_id]: { [ref]: initial.commit_oid } },
    required_analysis_status: { semantic: 'COMPLETE' },
  });
  const scope = coordinationScope({
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'system',
    kind: 'REF',
    resource_id: { repo_id, ref },
  });
  const request = {
    schema_version: 1,
    tenant_id: scope.tenant_id,
    system_id: scope.system_id,
    repo_id,
    ref,
    decision_id,
    basis_digest: basis.digest,
    candidate_digest: candidateDigest,
    expected_oid: initial.commit_oid,
    idempotency_key: 'promotion',
  };
  const principal = { actor_id: 'owner', tenant_id: 'tenant' };
  const commits = [];
  let fault = false;
  let afterPrepared;
  let casHook;
  let casMode = 'normal';
  let casCalls = 0;
  let reads = 0;
  let allowed = true;
  let required = ['semantic'];
  let policyAllows = true;
  const policyEvaluator = { required_analysis: () => required, can_resolve: () => policyAllows };
  const gitStore = new GitStore({
    repo_id,
    provider: {
      observe_ref: async (...args) => {
        reads += 1;
        return provider.observe_ref(...args);
      },
      fetch: (...args) => provider.fetch(...args),
      read_tree: (...args) => provider.read_tree(...args),
      compare_and_swap_ref: async (...args) => {
        casCalls += 1;
        assert.ok(
          commits.some((record) => record.state === 'PREPARED'),
          'authorization committed before Git write',
        );
        if (casHook) await casHook();
        if (casMode === 'fail-before-write') throw new Error('transport unavailable');
        const result = await provider.compare_and_swap_ref(...args);
        if (casMode === 'lose-reply') throw new Error('acknowledgement lost');
        return result;
      },
    },
  });
  const open = () => {
    const backend = new SqliteCoordinationBackend({ filename, busy_timeout_ms: 1000 });
    backends.push(backend);
    const store = new CoordinationStore({
      transaction: async (key, callback) => {
        const writes = [];
        const result = await backend.transaction(key, async (tx) =>
          callback({
            ...tx,
            put: async (name, value) => {
              if (fault && value.state === 'APPLIED')
                throw new Error('storage failed after Git write');
              writes.push(value);
              return tx.put(name, value);
            },
          }),
        );
        commits.push(...writes);
        if (afterPrepared && writes.some((value) => value.state === 'PREPARED')) {
          const callback = afterPrepared;
          afterPrepared = undefined;
          await callback();
        }
        return result;
      },
    });
    const service = new PromotionService({
      store,
      gitStore,
      observeSnapshot: async (repo, oid) => {
        assert.equal(repo, repo_id);
        reads += 1;
        return provider.snapshot(oid);
      },
      basisProvider: { current: (tx, { request: query }) => tx.get('inputs:' + query.decision_id) },
      policyEvaluator,
      authorize: (identity, query) =>
        allowed && identity.actor_id === 'owner' && identity.tenant_id === query.tenant_id,
    });
    return { backend, store, service };
  };
  const connection = open();
  await connection.store.createDecision(scope, {
    schema_version: 1,
    id: decision_id,
    state: 'DISCOVERED',
    basis: null,
    resolution: null,
  });
  await connection.store.transitionDecision(scope, decision_id, 'REVIEWABLE', basis);
  await connection.store.transitionDecision(scope, decision_id, 'RESOLVABLE', basis, {
    policyEvaluator,
    subject: {},
    effects: {},
  });
  const inputs = {
    schema_version: 1,
    basis,
    candidate,
    target_commit_oid: target.commit_oid,
    subject: { system_id: 'system' },
    effects: [],
  };
  await connection.store.transaction(scope, (tx) => tx.put('inputs:' + decision_id, inputs));
  return {
    ...connection,
    open,
    scope,
    request,
    principal,
    initial,
    target,
    external,
    inputs,
    candidate,
    sameTreeCommit: () =>
      git(gitDirectory, [
        'commit-tree',
        target.tree_oid,
        '-p',
        target.commit_oid,
        '-m',
        'different history',
      ]),
    basis,
    repo_id,
    ref,
    advance: (oid) => git(gitDirectory, ['update-ref', ref, oid]),
    head: () => provider.observe_ref(repo_id, ref),
    decision: (store = connection.store) =>
      store.transaction(scope, (tx) => tx.get('decision:' + decision_id)),
    changeInputs: (changes) =>
      connection.store.transaction(scope, (tx) =>
        tx.put('inputs:' + decision_id, { ...inputs, ...changes }),
      ),
    afterPrepared: (callback) => {
      afterPrepared = callback;
    },
    beforeCas: (callback) => {
      casHook = callback;
    },
    casMode: (mode) => {
      casMode = mode;
    },
    storageFault: () => {
      fault = true;
    },
    revoke: () => {
      allowed = false;
    },
    require: (capabilities) => {
      required = capabilities;
    },
    denyPolicy: () => {
      policyAllows = false;
    },
    counts: () => ({ casCalls, reads }),
  };
}

test('promotion durably prepares authorization, performs CAS and resolves the exact Decision', async (t) => {
  const f = await fixture(t);
  const outcome = await f.service.promote(f.request, { principal: f.principal });
  assert.equal(outcome.state, 'APPLIED');
  assert.equal(outcome.write_acknowledged, true);
  assert.equal(await f.head(), f.target.commit_oid);
  const decision = await f.decision();
  assert.equal(decision.state, 'RESOLVED');
  assert.equal(decision.resolution.actor_id, f.principal.actor_id);
  assert.equal(decision.resolution.candidate_digest, f.candidate.digest);
  assert.deepEqual(await f.service.promote(f.request, { principal: f.principal }), outcome);
  assert.equal(f.counts().casCalls, 1);
  const audit = await new AuditStream({
    store: f.store,
    authorize: () => true,
    max_page_size: 10,
  }).read(f.scope, { schema_version: 1, after: 0, limit: 10, expected_digest: null }, f.principal);
  assert.deepEqual(
    audit.entries.map((entry) => entry.event.to_state),
    ['PREPARED', 'APPLIED'],
  );
  assert.equal(audit.entries[1].event.bindings.observed_oid, f.target.commit_oid);
});

test('verified preflight rejection permits another promotion attempt', async (t) => {
  const f = await fixture(t);
  f.beforeCas(() => {
    throw new GitRefRejection('INCOMPLETE_ANALYSIS');
  });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'INCOMPLETE_ANALYSIS',
  });
  assert.equal(await f.head(), f.initial.commit_oid);
  assert.equal((await f.decision()).state, 'RESOLVABLE');
  const audit = await new AuditStream({
    store: f.store,
    authorize: () => true,
    max_page_size: 10,
  }).read(f.scope, { schema_version: 1, after: 0, limit: 10, expected_digest: null }, f.principal);
  assert.equal(audit.entries.at(-1).event.to_state, 'REJECTED');
  f.beforeCas(null);
  const result = await f.service.promote(
    { ...f.request, idempotency_key: 'retry-after-preflight' },
    { principal: f.principal },
  );
  assert.equal(result.state, 'APPLIED');
});

test('stale basis, policy version and expected OID never authorize Git mutation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.promote(
      { ...f.request, basis_digest: digest('decision-basis') },
      { principal: f.principal },
    ),
    { code: 'STALE_BASIS' },
  );
  await assert.rejects(
    f.service.promote(
      { ...f.request, expected_oid: f.external.commit_oid },
      { principal: f.principal },
    ),
    { code: 'STALE_BASIS' },
  );
  const projection = { ...f.basis };
  delete projection.digest;
  await f.changeInputs({
    basis: await buildDecisionBasis({ ...projection, policy_digest: digest('policy', 'b') }),
  });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'STALE_BASIS',
  });
  assert.equal(f.counts().casCalls, 0);
  assert.equal(await f.head(), f.initial.commit_oid);
});

test('required incomplete analysis and failed policy block otherwise resolvable Decisions', async (t) => {
  const f = await fixture(t);
  f.require(['semantic', 'security']);
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'INCOMPLETE_ANALYSIS',
  });
  f.require(['semantic']);
  f.denyPolicy();
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'POLICY_REJECTED',
  });
  assert.equal(f.counts().casCalls, 0);
});

test('policy and actor authorization are rechecked after the prepared journal commits', async (t) => {
  for (const revoke of [false, true]) {
    const f = await fixture(t);
    f.afterPrepared(() => (revoke ? f.revoke() : f.denyPolicy()));
    await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
      code: revoke ? 'FORBIDDEN' : 'POLICY_REJECTED',
    });
    assert.equal(await f.head(), f.initial.commit_oid);
    assert.equal(f.counts().casCalls, 0);
  }
});

test('a changed authoritative basis after preparation cannot reuse earlier authorization', async (t) => {
  const f = await fixture(t);
  const projection = { ...f.basis };
  delete projection.digest;
  const changed = await buildDecisionBasis({ ...projection, policy_digest: digest('policy', 'b') });
  f.afterPrepared(() => f.changeInputs({ basis: changed }));
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'STALE_BASIS',
  });
  assert.equal(f.counts().casCalls, 0);
  assert.equal(await f.head(), f.initial.commit_oid);
});

test('single-ref promotion explicitly rejects broader canonical coordination', async (t) => {
  for (const otherRepository of [false, true]) {
    const f = await fixture(t);
    const projection = { ...f.basis };
    delete projection.digest;
    const refs = otherRepository
      ? { ...projection.canonical_ref_oids, other: { [f.ref]: f.initial.commit_oid } }
      : {
          [f.repo_id]: {
            ...projection.canonical_ref_oids[f.repo_id],
            'refs/heads/release': f.initial.commit_oid,
          },
        };
    const basis = await buildDecisionBasis({ ...projection, canonical_ref_oids: refs });
    await f.changeInputs({ basis });
    await assert.rejects(
      f.service.promote({ ...f.request, basis_digest: basis.digest }, { principal: f.principal }),
      { code: 'UNSUPPORTED_CAPABILITY' },
    );
    assert.equal(f.counts().casCalls, 0);
    assert.equal(await f.head(), f.initial.commit_oid);
  }
});

test('concurrent resolutions through separate durable connections apply at most one write', async (t) => {
  const f = await fixture(t);
  const services = [f.service, f.open().service];
  const outcomes = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) =>
      services[index % 2].promote(
        { ...f.request, idempotency_key: 'concurrent-' + index },
        { principal: f.principal },
      ),
    ),
  );
  assert.equal(
    outcomes.filter(
      (outcome) => outcome.status === 'fulfilled' && outcome.value.state === 'APPLIED',
    ).length,
    1,
  );
  assert.equal(f.counts().casCalls, 1);
  assert.equal(await f.head(), f.target.commit_oid);
});

test('an external push between validation and CAS cannot be overwritten', async (t) => {
  const f = await fixture(t);
  f.beforeCas(() => f.advance(f.external.commit_oid));
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'STALE_BASIS',
  });
  assert.equal(await f.head(), f.external.commit_oid);
  assert.equal((await f.decision()).state, 'RESOLVABLE');
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'STALE_BASIS',
  });
  assert.equal(f.counts().casCalls, 1);
});

test('lost write acknowledgement survives restart and reconciles state without inferring authorship', async (t) => {
  const f = await fixture(t);
  f.casMode('lose-reply');
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  f.backend.close();
  const resumed = f.open();
  const observation = await resumed.service.reconcile(f.request, { principal: f.principal });
  assert.equal(observation.state, 'OBSERVED_TARGET');
  assert.equal(observation.write_acknowledged, false);
  assert.equal(observation.observed_oid, f.target.commit_oid);
  assert.equal((await f.decision(resumed.store)).state, 'RESOLVED');
  assert.equal(f.counts().casCalls, 1);
});

test('a crash after Git update before metadata commit recovers from the prepared record', async (t) => {
  const f = await fixture(t);
  f.storageFault();
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  assert.equal(await f.head(), f.target.commit_oid);
  assert.equal((await f.decision()).state, 'RESOLVABLE');
  f.backend.close();
  const resumed = f.open();
  assert.equal(
    (await resumed.service.reconcile(f.request, { principal: f.principal })).state,
    'OBSERVED_TARGET',
  );
  assert.equal(f.counts().casCalls, 1);
  const audit = await new AuditStream({
    store: resumed.store,
    authorize: () => true,
    max_page_size: 10,
  }).read(f.scope, { schema_version: 1, after: 0, limit: 10, expected_digest: null }, f.principal);
  assert.deepEqual(
    audit.entries.map((entry) => entry.event.to_state),
    ['PREPARED', 'OBSERVED_TARGET'],
  );
});

test('recovery and replay preserve a later unrelated external push', async (t) => {
  const f = await fixture(t);
  f.casMode('lose-reply');
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  await f.advance(f.external.commit_oid);
  const observed = await f.service.reconcile(f.request, { principal: f.principal });
  assert.equal(observed.state, 'EXTERNAL_MOVEMENT');
  assert.equal(observed.observed_oid, f.external.commit_oid);
  assert.equal(observed.write_acknowledged, false);
  assert.deepEqual(await f.service.promote(f.request, { principal: f.principal }), observed);
  assert.equal(await f.head(), f.external.commit_oid);
  assert.equal(f.counts().casCalls, 1);
});

test('an unchanged head cannot settle an uncertain in-flight operation or unblock another promotion', async (t) => {
  const f = await fixture(t);
  f.casMode('fail-before-write');
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  await assert.rejects(f.service.reconcile(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  await assert.rejects(
    f.service.promote({ ...f.request, idempotency_key: 'another' }, { principal: f.principal }),
    { code: 'OUTCOME_UNKNOWN' },
  );
  assert.equal(await f.head(), f.initial.commit_oid);
  assert.equal(f.counts().casCalls, 1);
});

test('idempotency binds the original reviewed input and authenticated actor', async (t) => {
  const f = await fixture(t);
  await f.service.promote(f.request, { principal: f.principal });
  await assert.rejects(
    f.service.promote(
      { ...f.request, candidate_digest: digest('object-candidate', 'b') },
      { principal: f.principal },
    ),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(f.counts().casCalls, 1);
});

test('tenant authorization precedes metadata and Git reads; producer identity cannot substitute for it', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.promote(f.request, { principal: { actor_id: 'agent', tenant_id: 'tenant' } }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    f.service.promote({ ...f.request, tenant_id: 'other' }, { principal: f.principal }),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(f.service.promote(f.request, { principal: {} }), {
    code: 'UNAUTHENTICATED',
  });
  assert.deepEqual(f.counts(), { casCalls: 0, reads: 0 });
});

test('trusted target mapping is checked against actual immutable Git tree identity', async (t) => {
  const f = await fixture(t);
  await f.changeInputs({ target_commit_oid: f.external.commit_oid });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(f.counts().casCalls, 0);
  assert.equal(await f.head(), f.initial.commit_oid);
});

test('a copied Candidate digest cannot authorize a substituted body and matching target tree', async (t) => {
  const f = await fixture(t);
  await f.changeInputs({
    candidate: { ...f.candidate, repo_tree_oids: { [f.repo_id]: f.external.tree_oid } },
    target_commit_oid: f.external.commit_oid,
  });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(f.counts().casCalls, 0);
  assert.equal(await f.head(), f.initial.commit_oid);
  await f.changeInputs({
    candidate: { ...f.candidate, materialization_record: { selected_source: 'different' } },
  });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(f.counts().casCalls, 0);
});

test('request and actor mutation while awaiting authorization cannot change the approved write', async (t) => {
  const f = await fixture(t);
  const request = structuredClone(f.request);
  const principal = structuredClone(f.principal);
  const result = f.service.promote(request, { principal });
  request.expected_oid = f.external.commit_oid;
  request.candidate_digest = digest('object-candidate', 'b');
  principal.actor_id = 'untrusted-agent';
  assert.equal((await result).state, 'APPLIED');
  assert.equal((await f.decision()).resolution.actor_id, 'owner');
  assert.equal(await f.head(), f.target.commit_oid);
});

test('reconciliation does not overwrite an explicitly stale Decision transition', async (t) => {
  const f = await fixture(t);
  f.casMode('lose-reply');
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'OUTCOME_UNKNOWN',
  });
  await f.store.transitionDecision(f.scope, f.request.decision_id, 'STALE');
  assert.equal(
    (await f.service.reconcile(f.request, { principal: f.principal })).state,
    'OBSERVED_TARGET',
  );
  assert.equal((await f.decision()).state, 'STALE');
});

test('the same tree at another commit cannot substitute for evaluated Git history', async (t) => {
  const f = await fixture(t);
  await f.changeInputs({ target_commit_oid: await f.sameTreeCommit() });
  await assert.rejects(f.service.promote(f.request, { principal: f.principal }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.equal(f.counts().casCalls, 0);
  assert.equal(await f.head(), f.initial.commit_oid);
});

test('promotion preserves the resolved reviewer choice and rechecks current eligibility', async (t) => {
  const f = await fixture(t);
  const resolved = await f.store.transitionDecision(
    f.scope,
    f.request.decision_id,
    'RESOLVED',
    f.basis,
    {
      policyEvaluator: { required_analysis: () => ['semantic'], can_resolve: () => true },
      subject: {},
      effects: [],
      expectedBasisDigest: f.basis.digest,
      resolution: {
        candidate_digest: f.candidate.digest,
        actor_id: 'reviewer',
        operation_id: 'review-operation',
      },
    },
  );
  assert.equal((await f.service.promote(f.request, { principal: f.principal })).state, 'APPLIED');
  assert.deepEqual((await f.decision()).resolution, resolved.resolution);
});
