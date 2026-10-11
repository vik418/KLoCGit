import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { createV1Application } from '../../api/application.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { LocalCandidateGitStore } from '../../adapters/local/candidate-git-store.mjs';
import { LocalGitStore } from '../../adapters/local/git-store.mjs';
import { createGitPathExtractor } from '../../adapters/analysis/path.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { digestCanonical, encodeCanonical } from '../../core/v1/encoding.mjs';
import { buildEffectSet } from '../../core/v1/extractors.mjs';
import { objectId, V1Error } from '../../core/v1/conventions.mjs';
import { createBehaviorExperiment } from '../../benchmarks/support/behavior.mjs';
import { git } from '../../server/git.mjs';

async function fixture(t) {
  const experiment = await createBehaviorExperiment({ telemetry: true });
  t.after(() => experiment.close());
  const { f, a, b, c, native, stored, payloads, requirements } = experiment;
  const ref = 'refs/heads/main';
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'REF',
    resource_id: { repo_id: 'canonical', ref },
  };
  const principal = { actor_id: 'owner', tenant_id: scope.tenant_id };
  const effects = [];
  for (const revision of [a, b, c]) {
    const provider = new LocalGitStore({
      adapter: f.adapter,
      repository: f.repositories.get(revision.repo_id),
      workspaceSource: f.sources.get(revision.repo_id),
    });
    const baseBody = {
      ...(await provider.snapshot(f.baseline.commit_oid)),
      system_id: revision.system_id,
      ref,
      producer: null,
      observed_at: revision.observed_at,
    };
    const base = FutureRevision({
      ...baseBody,
      id: objectId('future-revision', await digestCanonical('object-future-revision', baseBody)),
    });
    const extractor = createGitPathExtractor({
      gitStore: new GitStore({ repo_id: revision.repo_id, provider }),
      max_entries: 1000,
      loadProject: async (subject, filter) =>
        (await f.sources.get(subject.repo_id).fetch(subject, { blobs: 'none' })).loadProject(
          filter,
        ),
    });
    effects.push(await extractor.analyze(base, revision));
  }
  const composition = await experiment.compose([a, b]);
  const work = {
    schema_version: 1,
    context: f.context,
    effects,
    reduction_policy: {
      schema_version: 1,
      base_revision: f.context.base_revision.id,
      bindings: f.context.bindings,
      supersession: [],
      dependencies: [],
      rejections: [],
      completed_revision_ids: [],
      hub_min_degree: 100,
    },
    budget: {
      schema_version: 1,
      max_candidate_specs: 10,
      max_selections_per_spec: 10,
      max_dependency_visits: 100,
    },
    requirements,
    canonical_ref_oids: { canonical: { [ref]: f.baseline.commit_oid } },
    compositions: [composition.spec],
  };
  const filename = join(f.root, 'application.sqlite');
  let backend = new SqliteCoordinationBackend({ filename, busy_timeout_ms: 1000 });
  t.after(() => backend.close());
  const materialized = new Map();
  let evaluations = 0,
    observations = 0,
    workReads = 0;
  const materializer = {
    materialize: async (...args) => {
      const candidate = await f.materializer.materialize(...args);
      materialized.set(candidate.materialization_record.repo_commit_oids.canonical, candidate);
      return candidate;
    },
  };
  const provider = new LocalCandidateGitStore({
    adapter: f.adapter,
    repository: f.repositories.get('canonical'),
    workspaceSource: f.sources.get('canonical'),
    resolvePromotionSource: (repo, oid) =>
      materialized.has(oid) ? f.materializer.promotionSource(materialized.get(oid), repo) : null,
    limits: { max_objects: 1000, max_bytes: 8 * 1024 * 1024, max_history_commits: 100 },
  });
  const gitStore = new GitStore({ repo_id: 'canonical', provider });
  const pins = new Set();
  let mutate = null,
    allowed = true,
    acceptedEvidence = true;
  const options = {
    scope,
    backend,
    materializer,
    gitStore,
    observeSnapshot: (repo, oid) => {
      assert.equal(repo, 'canonical');
      return provider.snapshot(oid);
    },
    authorize: (actor, resource) =>
      allowed && actor.actor_id === principal.actor_id && actor.tenant_id === resource.tenant_id,
    authenticate: (request) =>
      request.headers.get('authorization') === 'Bearer test-owner' ? principal : null,
    workProvider: {
      current: (tx) => {
        workReads += 1;
        return tx.get('work');
      },
      payloadDigest: async (_tx, evidence) => {
        const digest = await digestCanonical('evidence-payload', evidence.result);
        if (!payloads.has(digest) || evidence.payload_ref !== 'benchmark:' + digest)
          throw new V1Error('INTEGRITY_MISMATCH');
        assert.deepEqual(payloads.get(digest), encodeCanonical(evidence.result));
        return digest;
      },
    },
    payloadStore: {
      pin: async ({ digest, payload_ref }) => {
        assert.equal(payload_ref, 'benchmark:' + digest);
        assert.ok(payloads.has(digest));
        pins.add(digest);
      },
    },
    verifyProvenance: (record) =>
      acceptedEvidence &&
      stored.has(record.id) &&
      Buffer.from(encodeCanonical(record)).equals(
        Buffer.from(encodeCanonical(stored.get(record.id))),
      ),
    verifyRejection: () => false,
    canReuse: () => true,
    requiredAnalysis: (_subject, sets) =>
      sets.map((effect) => effect.future_revision_id + '/' + effect.extractor_id),
    evidenceProvider: {
      find_reusable: () => [...stored.values()],
      evaluate: async (...args) => {
        evaluations += 1;
        const records = await native.evaluate(...args);
        if (mutate) {
          const effect = mutate;
          mutate = null;
          await effect();
        }
        return records;
      },
    },
    limits: {
      max_request_bytes: 32768,
      convergence: {
        schema_version: 1,
        max_work_bytes: 1048576,
        max_candidates: 10,
        max_evidence: 100,
        max_decisions: 10,
      },
      evidence: { schema_version: 1, max_checks: 10, max_records: 100, max_evaluations: 10 },
      formulation: {
        schema_version: 1,
        max_candidates: 10,
        max_effect_sets: 100,
        max_evidence: 100,
        max_decisions: 10,
        max_slices: 10,
        max_links: 100,
        hub_min_degree: 100,
      },
    },
  };
  let app = createV1Application(options);
  const originalObserve = provider.observe_ref.bind(provider);
  provider.observe_ref = (...args) => {
    observations += 1;
    return originalObserve(...args);
  };
  await app.store.transaction(scope, (tx) => tx.put('work', work));
  const call = async (path, body, headers = {}) => {
    const response = await app.fetch(
      new Request('https://test.invalid/api/v1/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: 'Bearer test-owner',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const discover = (key = 'discover-work') =>
    call('convergence', { schema_version: 1, idempotency_key: key, trace_id: 'application-test' });
  const update = async (change) =>
    app.store.transaction(scope, async (tx) => tx.put('work', await change(await tx.get('work'))));
  const restart = () => {
    backend.close();
    backend = new SqliteCoordinationBackend({ filename, busy_timeout_ms: 1000 });
    app = createV1Application({ ...options, backend });
  };
  return {
    ...f,
    experiment,
    effects,
    provider,
    work,
    principal,
    scope,
    call,
    discover,
    update,
    restart,
    pins,
    app: () => app,
    mutateDuringCheck: (effect) => {
      mutate = effect;
    },
    revoke: () => {
      allowed = false;
    },
    revokeEvidence: () => {
      acceptedEvidence = false;
    },
    counters: () => ({ evaluations, observations, workReads }),
  };
}

function passingAlternative(component) {
  return component.alternatives.find((alternative) =>
    component.evidence.some(
      (report) =>
        report.evidence.subject_digest === alternative.subject_digest &&
        report.evidence.result.status === 'PASSING',
    ),
  );
}

test('ordinary Git work discovers decisions, resolves exact Evidence and promotes through v1 routes', async (t) => {
  const f = await fixture(t);
  const before = await f.sourceState();
  const discovered = await f.discover();
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.decisions.length, 2);
  const interaction = discovered.body.decisions.find((component) =>
    component.reasons.some((reason) => reason.kind === 'COMPOSED_CHECK_FAILURE'),
  );
  assert.ok(interaction);
  assert.equal(interaction.alternatives.length, 3);
  assert.deepEqual(await f.sourceState(), before, 'analysis leaves all source Git objects intact');
  const alternative = passingAlternative(interaction);
  const basis = interaction.decision.basis;
  const resolution = {
    schema_version: 1,
    basis_digest: basis.digest,
    candidate_digest: alternative.candidate_digest,
    canonical_ref_oids: basis.canonical_ref_oids,
    idempotency_key: 'resolve',
    trace_id: 'resolve-test',
  };
  assert.equal(
    (await f.call('decisions/' + interaction.decision.id + '/resolve', resolution)).body.state,
    'RESOLVED',
  );
  assert.equal(f.pins.size, 3);
  const promotion = {
    schema_version: 1,
    basis_digest: basis.digest,
    candidate_digest: alternative.candidate_digest,
    expected_oid: f.baseline.commit_oid,
    idempotency_key: 'promote',
  };
  const accepted = await f.call('decisions/' + interaction.decision.id + '/promote', promotion);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.state, 'APPLIED');
  assert.equal(
    await git(f.adapter.dir(f.repositories.get('canonical')), ['rev-parse', 'refs/heads/main']),
    accepted.body.target_oid,
  );
  assert.deepEqual(
    (await f.sourceState()).filter(({ id }) => id !== 'canonical'),
    before.filter(({ id }) => id !== 'canonical'),
  );
  f.restart();
  assert.deepEqual(
    await f.call('decisions/' + interaction.decision.id + '/promote', promotion),
    accepted,
  );
});

test('discovery retries reuse persisted records and exact Evidence without another evaluation', async (t) => {
  const f = await fixture(t);
  const first = await f.discover();
  assert.equal(first.status, 200);
  const count = f.counters().evaluations;
  f.restart();
  assert.deepEqual(await f.discover(), first);
  assert.equal(f.counters().evaluations, count);
  const refreshed = await f.discover('rediscover');
  assert.equal(refreshed.status, 200);
  assert.equal(f.counters().evaluations, count);
});

test('policy changes during evaluation cannot publish an obsolete review', async (t) => {
  const f = await fixture(t);
  f.mutateDuringCheck(() =>
    f.update(async (work) => ({
      ...work,
      requirements: {
        ...work.requirements,
        policy_digest: await digestCanonical('policy', { changed: true }),
      },
    })),
  );
  const result = await f.discover();
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'STALE_BASIS');
  assert.equal(await f.app().store.transaction(f.scope, (tx) => tx.get('audit-head')), undefined);
  assert.equal(
    await git(f.adapter.dir(f.repositories.get('canonical')), ['rev-parse', 'refs/heads/main']),
    f.baseline.commit_oid,
  );
});

test('required incomplete analysis is visible and blocks resolution through the actual route', async (t) => {
  const f = await fixture(t);
  await f.update(async (work) => ({
    ...work,
    effects: await Promise.all(
      work.effects.map(({ digest, ...effect }) => {
        assert.ok(digest);
        return buildEffectSet({ ...effect, status: 'PARTIAL' });
      }),
    ),
  }));
  const discovery = await f.discover();
  assert.equal(discovery.status, 200);
  const component = discovery.body.decisions.find((entry) => entry.uncertainty.length);
  const result = await f.call('decisions/' + component.decision.id + '/resolve', {
    schema_version: 1,
    basis_digest: component.decision.basis.digest,
    candidate_digest: passingAlternative(component).candidate_digest,
    canonical_ref_oids: component.decision.basis.canonical_ref_oids,
    idempotency_key: 'blocked',
    trace_id: 'partial-test',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'INCOMPLETE_ANALYSIS');
});

test('authentication, scoped identity and current provenance cannot be overridden by JSON', async (t) => {
  const f = await fixture(t);
  const body = { schema_version: 1, idempotency_key: 'discover', trace_id: 'test' };
  assert.equal((await f.call('convergence', body, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal(
    (await f.call('convergence', { ...body, scope: { tenant_id: 'other' } })).status,
    400,
  );
  assert.equal(
    (await f.call('convergence', { ...body, requirements: { checks: [] } })).status,
    400,
  );
  assert.equal(f.counters().workReads, 0);
  const discovery = await f.discover();
  const component = discovery.body.decisions.find((entry) => entry.alternatives.length === 1);
  f.revokeEvidence();
  const result = await f.call('decisions/' + component.decision.id + '/resolve', {
    schema_version: 1,
    basis_digest: component.decision.basis.digest,
    candidate_digest: component.alternatives[0].candidate_digest,
    canonical_ref_oids: component.decision.basis.canonical_ref_oids,
    idempotency_key: 'revoked-evidence',
    trace_id: 'revocation-test',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'POLICY_REJECTED');
  f.revoke();
  const reads = f.counters().workReads;
  assert.equal((await f.discover('denied')).status, 403);
  assert.equal(f.counters().workReads, reads);
});

test('external pushes make a reviewed decision stale and preserve the external head', async (t) => {
  const f = await fixture(t);
  const discovery = await f.discover();
  const component = discovery.body.decisions.find((entry) => entry.alternatives.length === 1);
  const moved = await f.commit(
    'canonical',
    { 'outside.txt': 'external push\n' },
    f.baseline.commit_oid,
  );
  assert.equal((await f.call('decisions/' + component.decision.id)).status, 409);
  const result = await f.call('decisions/' + component.decision.id + '/resolve', {
    schema_version: 1,
    basis_digest: component.decision.basis.digest,
    candidate_digest: component.alternatives[0].candidate_digest,
    canonical_ref_oids: component.decision.basis.canonical_ref_oids,
    idempotency_key: 'external-race',
    trace_id: 'external-test',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'STALE_BASIS');
  assert.equal(
    await git(f.adapter.dir(f.repositories.get('canonical')), ['rev-parse', 'refs/heads/main']),
    moved.commit_oid,
  );
});
