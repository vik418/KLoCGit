import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { git } from '../../server/git.mjs';
import { LocalCandidateGitStore } from '../../adapters/local/candidate-git-store.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { PromotionService } from '../../core/v1/promotion.mjs';
import { buildDecisionBasis } from '../../core/v1/decisions.mjs';
import { createCandidatePolicy } from '../../core/v1/decision-policy.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { objectId } from '../../core/v1/conventions.mjs';
import { compositionFixture } from './support/composition.mjs';

async function fixture(t, format = 'sha1', overrides = {}) {
  const f = await compositionFixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, format);
  await f.future('producer-a', { 'a.txt': 'updated a\n', 'b.txt': 'b\n' });
  await f.future('producer-b', { 'a.txt': 'a\n', 'b.txt': 'updated b\n' });
  const candidate = await f.materializer.materialize(await f.spec(), f.context);
  const target = candidate.materialization_record.repo_commit_oids.canonical;
  const directory = f.adapter.dir(f.repositories.get('canonical'));
  const resolveSource = async (repo_id, oid) => {
    if (repo_id !== 'canonical' || oid !== target) return null;
    return f.materializer.promotionSource(candidate, repo_id);
  };
  const provider = new LocalCandidateGitStore({
    adapter: f.adapter,
    repository: f.repositories.get('canonical'),
    workspaceSource: f.sources.get('canonical'),
    resolvePromotionSource: resolveSource,
    limits: { max_objects: 1000, max_bytes: 8 * 1024 * 1024, max_history_commits: 100 },
    ...overrides,
  });
  const ref = 'refs/heads/main';
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'REF',
    resource_id: { repo_id: 'canonical', ref },
  };
  const backend = new SqliteCoordinationBackend({
    filename: join(f.root, 'promotion.sqlite'),
    busy_timeout_ms: 1000,
  });
  t.after(() => backend.close());
  const store = new CoordinationStore(backend);
  const requirements = {
    schema_version: 1,
    policy_digest: await digestCanonical('policy', { required_checks: [] }),
    checks: [],
  };
  // This fixture tests transfer/CAS, with an explicit policy requiring no behavioral checks.
  // Evidence eligibility and required analysis are covered by their integration tests.
  const policy = await createCandidatePolicy({
    candidate,
    requirements,
    required_analysis: [],
    evidence: [],
    verifyProvenance: () => false,
    canReuse: () => false,
    max_evidence: 10,
  });
  const basis = await buildDecisionBasis({
    schema_version: 1,
    candidate_digests: [candidate.digest],
    evidence_digests: [],
    material_effect_digest: await digestCanonical('material-effect', { changes: [] }),
    policy_digest: requirements.policy_digest,
    canonical_ref_oids: { canonical: { [ref]: f.baseline.commit_oid } },
    required_analysis_status: {},
  });
  const decision_id = objectId(
    'decision',
    await digestCanonical('object-decision', { candidate: candidate.digest }),
  );
  await store.createDecision(scope, {
    schema_version: 1,
    id: decision_id,
    state: 'DISCOVERED',
    basis: null,
    resolution: null,
  });
  await store.transitionDecision(scope, decision_id, 'REVIEWABLE', basis);
  await store.transitionDecision(scope, decision_id, 'RESOLVABLE', basis, {
    policyEvaluator: policy,
    subject: candidate,
    effects: [],
  });
  await store.transaction(scope, (tx) =>
    tx.put('inputs:' + decision_id, {
      schema_version: 1,
      basis,
      candidate,
      target_commit_oid: target,
      subject: candidate,
      effects: [],
    }),
  );
  let allowed = true;
  const service = new PromotionService({
    store,
    gitStore: new GitStore({ repo_id: 'canonical', provider }),
    observeSnapshot: (repo, oid) => {
      assert.equal(repo, 'canonical');
      return provider.snapshot(oid);
    },
    basisProvider: { current: (tx, context) => tx.get('inputs:' + context.request.decision_id) },
    policyEvaluator: policy,
    authorize: (principal, request) =>
      allowed && principal.tenant_id === request.tenant_id && principal.actor_id === 'owner',
  });
  const request = {
    schema_version: 1,
    tenant_id: scope.tenant_id,
    system_id: scope.system_id,
    repo_id: 'canonical',
    ref,
    decision_id,
    basis_digest: basis.digest,
    candidate_digest: candidate.digest,
    expected_oid: f.baseline.commit_oid,
    idempotency_key: 'accept-candidate',
  };
  return {
    ...f,
    candidate,
    target,
    provider,
    resolveSource,
    directory,
    request,
    service,
    promote: () =>
      service.promote(request, { principal: { tenant_id: scope.tenant_id, actor_id: 'owner' } }),
    revoke: () => {
      allowed = false;
    },
  };
}

for (const format of ['sha1', 'sha256']) {
  test(`local ${format} composition reaches canonical Git only through reviewed CAS`, async (t) => {
    const f = await fixture(t, format);
    const before = await f.sourceState();
    await assert.rejects(git(f.directory, ['cat-file', '-e', f.target]));
    assert.equal((await f.provider.snapshot(f.target)).tree_oid.length, f.target.length);
    assert.deepEqual(await f.sourceState(), before);
    const result = await f.promote();
    assert.equal(result.state, 'APPLIED');
    assert.equal(await git(f.directory, ['rev-parse', 'refs/heads/main']), f.target);
    assert.equal(await git(f.directory, ['show', f.target + ':a.txt']), 'updated a');
    assert.equal(await git(f.directory, ['show', f.target + ':b.txt']), 'updated b');
    assert.deepEqual(
      (await f.sourceState()).filter(({ id }) => id !== 'canonical'),
      before.filter(({ id }) => id !== 'canonical'),
    );
    assert.deepEqual(await f.promote(), result);
  });
}

test('stale and revoked promotion never import candidate objects', async (t) => {
  const f = await fixture(t);
  const before = await f.sourceState();
  f.revoke();
  await assert.rejects(f.promote(), { code: 'FORBIDDEN' });
  assert.deepEqual(await f.sourceState(), before);
  const moved = await f.commit(
    'canonical',
    { 'a.txt': 'external\n', 'b.txt': 'b\n' },
    f.baseline.commit_oid,
  );
  assert.equal(
    await f.provider.compare_and_swap_ref('refs/heads/main', f.baseline.commit_oid, f.target, {
      idempotency_key: 'stale',
    }),
    false,
  );
  assert.equal(await git(f.directory, ['rev-parse', 'refs/heads/main']), moved.commit_oid);
  await assert.rejects(git(f.directory, ['cat-file', '-e', f.target]));
});

test('transfer budgets and missing materializations leave canonical objects unchanged', async (t) => {
  const f = await fixture(t, 'sha1', {
    limits: { max_objects: 1, max_bytes: 1, max_history_commits: 1 },
  });
  const before = await f.sourceState();
  await assert.rejects(f.promote(), { code: 'INCOMPLETE_ANALYSIS' });
  assert.deepEqual(await f.sourceState(), before);
  await f.materializer.release(f.candidate.digest);
  await assert.rejects(f.provider.snapshot(f.target), { code: 'NOT_FOUND' });
  assert.deepEqual(await f.sourceState(), before);
});
