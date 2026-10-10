import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSION, objectId } from '../../core/v1/conventions.mjs';
import { Decision } from '../../core/v1/domain.mjs';
import {
  ConditionalReview,
  buildDecisionBasis,
  createConditionalReview,
  makeResolvable,
  makeReviewable,
  markStale,
  reconcileReview,
  resolveDecision,
  verifyDecisionBasis,
} from '../../core/v1/decisions.mjs';

const digest = (domain, hex = '1') => 'sha256:' + domain + ':v1:' + hex.repeat(64);
const oid = (hex = 'a') => hex.repeat(40);

function discovered() {
  return Decision({
    schema_version: SCHEMA_VERSION,
    id: objectId('decision', digest('object-decision')),
    state: 'DISCOVERED',
    basis: null,
    resolution: null,
  });
}

async function basis(changes = {}) {
  return buildDecisionBasis({
    schema_version: SCHEMA_VERSION,
    candidate_digests: [digest('object-candidate')],
    evidence_digests: [digest('object-evidence')],
    material_effect_digest: digest('material-effect'),
    policy_digest: digest('policy'),
    canonical_ref_oids: { 'repo-a': { 'refs/heads/main': oid() } },
    required_analysis_status: { semantic: 'COMPLETE' },
    ...changes,
  });
}

function policy(overrides = {}) {
  return {
    required_analysis: () => ['semantic'],
    can_resolve: () => true,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    policyEvaluator: policy(),
    subject: { system_id: 'system-a' },
    effects: [],
    ...overrides,
  };
}

async function reviewable(inputBasis) {
  return makeReviewable(discovered(), inputBasis ?? (await basis()));
}

async function review(decision, overrides = {}) {
  return createConditionalReview(decision, {
    reviewedDeltaDigest: digest('reviewed-delta'),
    allowLateNonMaterialEvidence: true,
    predicates: ['behavior-unchanged'],
    ...overrides,
  });
}

function reviewOptions(overrides = {}) {
  return {
    reviewedDeltaDigest: digest('reviewed-delta'),
    predicateEvaluator: () => true,
    evidenceClassifier: () => 'NON_MATERIAL',
    ...options(),
    ...overrides,
  };
}

test('basis hashing is deterministic and normalizes only declared sets', async () => {
  const left = await basis({
    candidate_digests: [digest('object-candidate', '2'), digest('object-candidate')],
    evidence_digests: [digest('object-evidence', '2'), digest('object-evidence')],
  });
  const right = await basis({
    candidate_digests: [...left.candidate_digests].reverse(),
    evidence_digests: [...left.evidence_digests].reverse(),
  });
  assert.deepEqual(left, right);
  assert.equal(Object.isFrozen(left.canonical_ref_oids['repo-a']), true);
  assert.deepEqual(await verifyDecisionBasis(left), left);
  await assert.rejects(buildDecisionBasis(left), { code: 'INVALID_ARGUMENT' });
});

const changes = {
  candidate_digests: [digest('object-candidate', '2')],
  evidence_digests: [digest('object-evidence', '2')],
  material_effect_digest: digest('material-effect', '2'),
  policy_digest: digest('policy', '2'),
  canonical_ref_oids: { 'repo-a': { 'refs/heads/main': oid('b') } },
  required_analysis_status: { semantic: 'PARTIAL' },
};

for (const [field, value] of Object.entries(changes)) {
  test('basis verification detects copied digest after changing ' + field, async () => {
    const original = await basis();
    const changed = await basis({ [field]: value });
    assert.notEqual(original.digest, changed.digest);
    await assert.rejects(verifyDecisionBasis({ ...original, [field]: value }), {
      code: 'INTEGRITY_MISMATCH',
    });
  });
}

test('the legal transition sequence preserves immutable input snapshots', async () => {
  const initial = discovered();
  const current = await basis();
  const shown = await makeReviewable(initial, current);
  const resolvable = await makeResolvable(shown, current, options());
  const resolution = { candidate_digest: current.candidate_digests[0], actor: 'human-a' };
  const resolved = await resolveDecision(resolvable, current, {
    ...options(),
    expectedBasisDigest: current.digest,
    resolution,
  });
  resolution.actor = 'changed-after-resolution';
  assert.equal(initial.state, 'DISCOVERED');
  assert.equal(shown.state, 'REVIEWABLE');
  assert.equal(resolvable.state, 'RESOLVABLE');
  assert.equal(resolved.state, 'RESOLVED');
  assert.equal(resolved.resolution.actor, 'human-a');
  assert.equal(Object.isFrozen(resolved.resolution), true);
});

for (const status of ['PARTIAL', 'FAILED', 'UNSUPPORTED']) {
  test(status + ' is reviewable but cannot become resolvable when required', async () => {
    const current = await basis({ required_analysis_status: { semantic: status } });
    const shown = await reviewable(current);
    assert.equal(shown.state, 'REVIEWABLE');
    await assert.rejects(makeResolvable(shown, current, options()), {
      code: 'INCOMPLETE_ANALYSIS',
    });
  });
}

test('policy-required analysis cannot be hidden by omitting its status', async () => {
  const current = await basis({ required_analysis_status: {} });
  const shown = await reviewable(current);
  await assert.rejects(makeResolvable(shown, current, options()), {
    code: 'INCOMPLETE_ANALYSIS',
  });
  assert.equal(
    (
      await makeResolvable(
        shown,
        current,
        options({ policyEvaluator: policy({ required_analysis: () => [] }) }),
      )
    ).state,
    'RESOLVABLE',
  );
});

test('required status keys and trusted evidence policy are checked independently', async () => {
  const current = await basis();
  const shown = await reviewable(current);
  const seen = [];
  const dependencies = options({
    policyEvaluator: policy({
      required_analysis(subject, effects) {
        seen.push([subject, effects]);
        return ['semantic'];
      },
      can_resolve(input) {
        seen.push(input);
        return false;
      },
    }),
  });
  await assert.rejects(makeResolvable(shown, current, dependencies), { code: 'POLICY_REJECTED' });
  assert.deepEqual(seen[0], [dependencies.subject, dependencies.effects]);
  assert.deepEqual(seen[1], current);
  assert.equal(Object.isFrozen(seen[0][0]), true);
  assert.equal(Object.isFrozen(seen[0][1]), true);
});

test('truthy policy claims or absent policy methods do not satisfy trusted evaluation', async () => {
  const current = await basis();
  const shown = await reviewable(current);
  for (const result of [undefined, null, 'PASSING', { allowed: true }]) {
    await assert.rejects(
      makeResolvable(
        shown,
        current,
        options({ policyEvaluator: policy({ can_resolve: () => result }) }),
      ),
      { code: 'POLICY_REJECTED' },
    );
  }
  for (const policyEvaluator of [null, {}, { can_resolve: true }]) {
    await assert.rejects(makeResolvable(shown, current, options({ policyEvaluator })), {
      code: 'INVALID_ARGUMENT',
    });
  }
  for (const requirements of [undefined, {}, ['semantic', 'semantic'], [''], [1]]) {
    await assert.rejects(
      makeResolvable(
        shown,
        current,
        options({ policyEvaluator: policy({ required_analysis: () => requirements }) }),
      ),
      { code: 'INVALID_ARGUMENT' },
    );
  }
});

test('policy context is copied before asynchronous evaluation', async () => {
  const current = await basis();
  const shown = await reviewable(current);
  const subject = { system_id: 'system-a' };
  const effects = [{ kind: 'path' }];
  let seen;
  const transition = makeResolvable(
    shown,
    current,
    options({
      subject,
      effects,
      policyEvaluator: policy({
        required_analysis(observedSubject, observedEffects) {
          seen = [observedSubject, observedEffects];
          return ['semantic'];
        },
      }),
    }),
  );
  subject.system_id = 'different-system';
  effects[0].kind = 'semantic';
  await transition;
  assert.deepEqual(seen, [{ system_id: 'system-a' }, [{ kind: 'path' }]]);
});

test('all terminal and skipped state transitions are rejected', async () => {
  const current = await basis();
  const shown = await reviewable(current);
  const resolvable = await makeResolvable(shown, current, options());
  const resolved = await resolveDecision(resolvable, current, {
    ...options(),
    expectedBasisDigest: current.digest,
    resolution: { candidate_digest: current.candidate_digests[0] },
  });
  const stale = await markStale(shown);
  for (const input of [shown, resolvable, resolved, stale]) {
    await assert.rejects(makeReviewable(input, current), { code: 'CONFLICT' });
  }
  for (const input of [discovered(), resolvable, resolved, stale]) {
    await assert.rejects(makeResolvable(input, current, options()), { code: 'CONFLICT' });
  }
  for (const input of [discovered(), shown, resolved, stale]) {
    await assert.rejects(
      resolveDecision(input, current, {
        ...options(),
        expectedBasisDigest: current.digest,
        resolution: { candidate_digest: current.candidate_digests[0] },
      }),
      { code: 'CONFLICT' },
    );
  }
  for (const input of [discovered(), resolved, stale]) {
    await assert.rejects(markStale(input), { code: 'CONFLICT' });
  }
  assert.equal((await markStale(resolvable)).state, 'STALE');
});

for (const [field, value] of Object.entries(changes)) {
  test('a newly computed changed ' + field + ' cannot reuse an old basis', async () => {
    const current = await basis();
    const shown = await reviewable(current);
    const resolvable = await makeResolvable(shown, current, options());
    const changed = await basis({ [field]: value });
    await assert.rejects(makeResolvable(shown, changed, options()), { code: 'STALE_BASIS' });
    await assert.rejects(
      resolveDecision(resolvable, changed, {
        ...options(),
        expectedBasisDigest: current.digest,
        resolution: { candidate_digest: current.candidate_digests[0] },
      }),
      { code: 'STALE_BASIS' },
    );
  });
}

test('resolve rejects an obsolete reviewed digest and rechecks current policy', async () => {
  const current = await basis();
  const shown = await reviewable(current);
  const resolvable = await makeResolvable(shown, current, options());
  const resolution = { candidate_digest: current.candidate_digests[0] };
  await assert.rejects(
    resolveDecision(resolvable, current, {
      ...options(),
      expectedBasisDigest: digest('decision-basis'),
      resolution,
    }),
    { code: 'STALE_BASIS' },
  );
  await assert.rejects(
    resolveDecision(resolvable, current, {
      ...options({ policyEvaluator: policy({ can_resolve: () => false }) }),
      expectedBasisDigest: current.digest,
      resolution,
    }),
    { code: 'POLICY_REJECTED' },
  );
  await assert.rejects(
    resolveDecision(resolvable, current, {
      ...options({
        policyEvaluator: policy({ required_analysis: () => ['semantic', 'security'] }),
      }),
      expectedBasisDigest: current.digest,
      resolution,
    }),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
});

test('a replacement candidate cannot be substituted into the resolution', async () => {
  const current = await basis();
  const resolvable = await makeResolvable(await reviewable(current), current, options());
  await assert.rejects(
    resolveDecision(resolvable, current, {
      ...options(),
      expectedBasisDigest: current.digest,
      resolution: { candidate_digest: digest('object-candidate', 'f') },
    }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('conditional review records exact reviewed material and explicit allowance', async () => {
  const shown = await reviewable();
  const captured = await review(shown);
  assert.equal(captured.schema_version, 1);
  assert.equal(captured.decision_id, shown.id);
  assert.deepEqual(captured.basis, shown.basis);
  assert.equal(captured.reviewed_delta_digest, digest('reviewed-delta'));
  assert.equal(captured.allow_late_non_material_evidence, true);
  assert.deepEqual(ConditionalReview(JSON.parse(JSON.stringify(captured))), captured);
  assert.equal(Object.isFrozen(captured.predicates), true);
  const strict = await createConditionalReview(shown, {
    reviewedDeltaDigest: digest('reviewed-delta'),
    predicates: [],
  });
  assert.equal(strict.allow_late_non_material_evidence, false);
});

test('late non-material evidence preserves history but links eligibility to latest basis', async () => {
  const original = await basis();
  const shown = await reviewable(original);
  const captured = await review(shown);
  const lateDigest = digest('object-evidence', '2');
  const latest = await basis({ evidence_digests: [...original.evidence_digests, lateDigest] });
  const observed = [];
  const result = await reconcileReview(
    shown,
    latest,
    captured,
    reviewOptions({
      evidenceClassifier(evidenceDigest, context) {
        observed.push([evidenceDigest, context]);
        return 'NON_MATERIAL';
      },
    }),
  );
  assert.equal(result.preserved, true);
  assert.equal(result.decision.state, 'REVIEWABLE');
  assert.deepEqual(result.decision.basis, latest);
  assert.equal(result.basis_digest, latest.digest);
  assert.deepEqual(result.review, captured);
  assert.notEqual(result.review.basis.digest, latest.digest);
  assert.deepEqual(
    observed.map(([value]) => value),
    [lateDigest],
  );
  assert.equal(Object.isFrozen(observed[0][1].current_basis), true);
  const resolvable = await makeResolvable(result.decision, latest, options());
  await assert.rejects(
    resolveDecision(resolvable, latest, {
      ...options(),
      expectedBasisDigest: original.digest,
      resolution: { candidate_digest: original.candidate_digests[0] },
    }),
    { code: 'STALE_BASIS' },
  );
});

test('repeated late evidence is classified against the immutable original review', async () => {
  const original = await basis();
  const shown = await reviewable(original);
  const captured = await review(shown);
  const firstBasis = await basis({
    evidence_digests: [...original.evidence_digests, digest('object-evidence', '2')],
  });
  const first = await reconcileReview(shown, firstBasis, captured, reviewOptions());
  const latest = await basis({
    evidence_digests: [...firstBasis.evidence_digests, digest('object-evidence', '3')],
  });
  const classified = [];
  const repeated = await reconcileReview(
    first.decision,
    latest,
    captured,
    reviewOptions({
      evidenceClassifier(value) {
        classified.push(value);
        return 'NON_MATERIAL';
      },
    }),
  );
  assert.equal(repeated.preserved, true);
  assert.deepEqual(classified, [digest('object-evidence', '2'), digest('object-evidence', '3')]);
});

test('conditional review does not permit undeclared late evidence or absent classifiers', async () => {
  const original = await basis();
  const shown = await reviewable(original);
  const strict = await review(shown, { allowLateNonMaterialEvidence: false });
  const captured = await review(shown);
  const latest = await basis({
    evidence_digests: [...original.evidence_digests, digest('object-evidence', '2')],
  });
  for (const [record, dependencies] of [
    [strict, reviewOptions()],
    [captured, reviewOptions({ evidenceClassifier: undefined })],
    [captured, reviewOptions({ evidenceClassifier: () => 'INFERRED_NON_MATERIAL' })],
    [captured, reviewOptions({ evidenceClassifier: () => true })],
    [captured, reviewOptions({ evidenceClassifier: () => 'MATERIAL' })],
    [
      captured,
      reviewOptions({
        evidenceClassifier: () => {
          throw new Error('unavailable');
        },
      }),
    ],
  ]) {
    const result = await reconcileReview(shown, latest, record, dependencies);
    assert.equal(result.preserved, false);
    assert.equal(result.decision.state, 'STALE');
    assert.equal(result.basis_digest, null);
  }
});

test('declared predicates must all be evaluated and remain true', async () => {
  const shown = await reviewable();
  const captured = await review(shown, { predicates: ['behavior-unchanged', 'scope-unchanged'] });
  const latest = await basis({
    evidence_digests: [...shown.basis.evidence_digests, digest('object-evidence', '2')],
  });
  for (const predicateEvaluator of [
    undefined,
    () => false,
    () => undefined,
    () => 'TRUE',
    (id) => id === 'behavior-unchanged',
    () => {
      throw new Error('predicate unavailable');
    },
  ]) {
    const result = await reconcileReview(
      shown,
      latest,
      captured,
      reviewOptions({ predicateEvaluator }),
    );
    assert.equal(result.decision.state, 'STALE');
    assert.equal(result.preserved, false);
  }
});

for (const [field, value] of Object.entries(changes)) {
  test('conditional review stales on material change to ' + field, async () => {
    const original = await basis();
    const shown = await reviewable(original);
    const captured = await review(shown);
    const latest = await basis({ [field]: value });
    const result = await reconcileReview(shown, latest, captured, reviewOptions());
    assert.equal(result.decision.state, 'STALE');
    assert.equal(result.preserved, false);
    assert.deepEqual(result.decision.basis, original);
  });
}

test('changed reviewed delta or removed evidence requires a fresh review', async () => {
  const original = await basis();
  const shown = await reviewable(original);
  const captured = await review(shown);
  const latest = await basis({ evidence_digests: [] });
  const changedDelta = await reconcileReview(
    shown,
    original,
    captured,
    reviewOptions({ reviewedDeltaDigest: digest('reviewed-delta', '2') }),
  );
  const removedEvidence = await reconcileReview(shown, latest, captured, reviewOptions());
  assert.equal(changedDelta.preserved, false);
  assert.equal(removedEvidence.preserved, false);
});

test('resolvable review preservation rechecks policy instead of inventing a downgrade edge', async () => {
  const original = await basis();
  const resolvable = await makeResolvable(await reviewable(original), original, options());
  const captured = await review(resolvable);
  const latest = await basis({
    evidence_digests: [...original.evidence_digests, digest('object-evidence', '2')],
  });
  const retained = await reconcileReview(resolvable, latest, captured, reviewOptions());
  assert.equal(retained.decision.state, 'RESOLVABLE');
  const stale = await reconcileReview(
    resolvable,
    latest,
    captured,
    reviewOptions({ policyEvaluator: policy({ can_resolve: () => false }) }),
  );
  assert.equal(stale.decision.state, 'STALE');
  assert.equal(stale.preserved, false);
});

test('conditional review cannot float between decisions or carry an unverified basis', async () => {
  const shown = await reviewable();
  const captured = await review(shown);
  const another = Decision({ ...shown, id: objectId('decision', digest('object-decision', '2')) });
  await assert.rejects(reconcileReview(another, shown.basis, captured, reviewOptions()), {
    code: 'INTEGRITY_MISMATCH',
  });
  await assert.rejects(
    reconcileReview(
      shown,
      shown.basis,
      {
        ...captured,
        basis: { ...captured.basis, canonical_ref_oids: changes.canonical_ref_oids },
      },
      reviewOptions(),
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
});

test('conditional review schema rejects executable and ambiguous records', async () => {
  const shown = await reviewable();
  const captured = await review(shown);
  for (const change of [
    { schema_version: 2 },
    { extra: 'claim' },
    { predicates: ['same', 'same'] },
    { predicates: [null] },
    { reviewed_delta_digest: 'HEAD' },
    { allow_late_non_material_evidence: 'true' },
    { basis: null },
  ]) {
    assert.throws(() => ConditionalReview({ ...captured, ...change }));
  }
  const missingAllowance = { ...captured };
  delete missingAllowance.allow_late_non_material_evidence;
  assert.throws(() => ConditionalReview(missingAllowance), { code: 'INVALID_ARGUMENT' });
  let calls = 0;
  const accessor = { ...captured };
  Object.defineProperty(accessor, 'predicates', {
    enumerable: true,
    get() {
      calls += 1;
      return [];
    },
  });
  assert.throws(() => ConditionalReview(accessor), { code: 'INVALID_ARGUMENT' });
  assert.equal(calls, 0);
});
