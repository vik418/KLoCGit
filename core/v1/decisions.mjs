/** Pure Decision transitions. Persistence, actor authorization and Git CAS are separate boundaries. */
import {
  SCHEMA_VERSION,
  V1Error,
  assertSchemaVersion,
  parseDigest,
  parseObjectId,
} from './conventions.mjs';
import { Decision, copyJsonData } from './domain.mjs';
import { digestCanonical, encodeCanonical, normalizeDomain } from './encoding.mjs';

const validationDigest = 'sha256:decision-basis:v1:' + '0'.repeat(64);

function assertValid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function basisProjection(basis) {
  const projection = { ...basis };
  delete projection.digest;
  return projection;
}

/** Build an identity from every basis field, with the self digest excluded. */
export async function buildDecisionBasis(input) {
  const projection = copyJsonData(input);
  assertValid(projection !== null && typeof projection === 'object' && !Array.isArray(projection));
  assertValid(!Object.hasOwn(projection, 'digest'));
  // The placeholder satisfies representation validation; it never enters the hash.
  const normalized = normalizeDomain('DecisionBasis', { ...projection, digest: validationDigest });
  const digest = await digestCanonical('decision-basis', basisProjection(normalized));
  return normalizeDomain('DecisionBasis', { ...normalized, digest });
}

/** A syntactically valid supplied digest is not proof that its fields are unchanged. */
export async function verifyDecisionBasis(input) {
  const normalized = normalizeDomain('DecisionBasis', input);
  const expected = await digestCanonical('decision-basis', basisProjection(normalized));
  if (normalized.digest !== expected) throw new V1Error('INTEGRITY_MISMATCH');
  return normalized;
}

async function verifiedDecision(input) {
  const record = Decision(input);
  if (record.basis === null) return record;
  return Decision({ ...record, basis: await verifyDecisionBasis(record.basis) });
}

function requireState(decision, states) {
  if (!states.includes(decision.state)) throw new V1Error('CONFLICT');
}

function requireCurrentBasis(decision, currentBasis) {
  if (decision.basis?.digest !== currentBasis.digest) throw new V1Error('STALE_BASIS');
}

function policyContext({ policyEvaluator, subject, effects } = {}) {
  assertValid(
    policyEvaluator !== null &&
      typeof policyEvaluator === 'object' &&
      typeof policyEvaluator.required_analysis === 'function' &&
      typeof policyEvaluator.can_resolve === 'function',
  );
  // These methods come from trusted application wiring, never producer JSON.
  return Object.freeze({
    requiredAnalysis: policyEvaluator.required_analysis.bind(policyEvaluator),
    canResolve: policyEvaluator.can_resolve.bind(policyEvaluator),
    subject: freeze(copyJsonData(subject)),
    effects: freeze(copyJsonData(effects)),
  });
}

async function requirePolicy(basis, dependencies) {
  const required = copyJsonData(
    await dependencies.requiredAnalysis(dependencies.subject, dependencies.effects),
  );
  assertValid(Array.isArray(required));
  assertValid(required.every((key) => typeof key === 'string' && key.trim().length > 0));
  assertValid(new Set(required).size === required.length);
  if (
    Object.values(basis.required_analysis_status).some((status) => status !== 'COMPLETE') ||
    required.some(
      (key) =>
        !Object.hasOwn(basis.required_analysis_status, key) ||
        basis.required_analysis_status[key] !== 'COMPLETE',
    )
  ) {
    throw new V1Error('INCOMPLETE_ANALYSIS');
  }
  // The evaluator owns evidence eligibility and completeness for this exact policy digest.
  if ((await dependencies.canResolve(basis)) !== true) throw new V1Error('POLICY_REJECTED');
}

export async function makeReviewable(input, basis) {
  const [decision, current] = await Promise.all([
    verifiedDecision(input),
    verifyDecisionBasis(basis),
  ]);
  requireState(decision, ['DISCOVERED']);
  return Decision({ ...decision, state: 'REVIEWABLE', basis: current });
}

export async function makeResolvable(input, basis, options) {
  const dependencies = policyContext(options);
  const [decision, current] = await Promise.all([
    verifiedDecision(input),
    verifyDecisionBasis(basis),
  ]);
  requireState(decision, ['REVIEWABLE']);
  requireCurrentBasis(decision, current);
  await requirePolicy(current, dependencies);
  return Decision({ ...decision, state: 'RESOLVABLE', basis: current });
}

/** Resolution is a new snapshot, not authorization to mutate canonical Git. */
export async function resolveDecision(input, basis, options) {
  const dependencies = policyContext(options);
  const { expectedBasisDigest } = options;
  parseDigest(expectedBasisDigest, 'decision-basis');
  const resolution = copyJsonData(options.resolution);
  const [decision, current] = await Promise.all([
    verifiedDecision(input),
    verifyDecisionBasis(basis),
  ]);
  requireState(decision, ['RESOLVABLE']);
  requireCurrentBasis(decision, current);
  if (expectedBasisDigest !== current.digest) throw new V1Error('STALE_BASIS');
  await requirePolicy(current, dependencies);
  return Decision({ ...decision, state: 'RESOLVED', basis: current, resolution });
}

export async function markStale(input) {
  const decision = await verifiedDecision(input);
  requireState(decision, ['REVIEWABLE', 'RESOLVABLE']);
  return Decision({ ...decision, state: 'STALE' });
}

/** A stored review preserves what was reviewed, rather than floating to a new revision. */
export function ConditionalReview(input) {
  const record = copyJsonData(input);
  assertValid(record !== null && typeof record === 'object' && !Array.isArray(record));
  assertSchemaVersion(record);
  const fields = [
    'schema_version',
    'decision_id',
    'basis',
    'reviewed_delta_digest',
    'allow_late_non_material_evidence',
    'predicates',
  ];
  assertValid(Object.keys(record).length === fields.length);
  assertValid(fields.every((key) => Object.hasOwn(record, key)));
  parseObjectId(record.decision_id, 'decision');
  record.basis = normalizeDomain('DecisionBasis', record.basis);
  parseDigest(record.reviewed_delta_digest, 'reviewed-delta');
  assertValid(typeof record.allow_late_non_material_evidence === 'boolean');
  assertValid(Array.isArray(record.predicates));
  assertValid(record.predicates.every((key) => typeof key === 'string' && key.trim().length > 0));
  assertValid(new Set(record.predicates).size === record.predicates.length);
  return freeze(record);
}

export async function createConditionalReview(input, options) {
  const { reviewedDeltaDigest, allowLateNonMaterialEvidence = false } = options;
  const predicates = copyJsonData(options.predicates);
  const decision = await verifiedDecision(input);
  requireState(decision, ['REVIEWABLE', 'RESOLVABLE']);
  return ConditionalReview({
    schema_version: SCHEMA_VERSION,
    decision_id: decision.id,
    basis: decision.basis,
    reviewed_delta_digest: reviewedDeltaDigest,
    allow_late_non_material_evidence: allowLateNonMaterialEvidence,
    predicates,
  });
}

function sameValue(left, right) {
  const leftBytes = encodeCanonical(left);
  const rightBytes = encodeCanonical(right);
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

function sameMaterialBasis(left, right) {
  return [
    'candidate_digests',
    'material_effect_digest',
    'policy_digest',
    'canonical_ref_oids',
    'required_analysis_status',
  ].every((field) => sameValue(left[field], right[field]));
}

function containsEvidence(basis, previous) {
  const current = new Set(basis.evidence_digests);
  return previous.evidence_digests.every((value) => current.has(value));
}

/**
 * Trusted callbacks classify late evidence and evaluate declared predicates.
 * Unknown classification or an unavailable predicate invalidates eligibility.
 * Preserving review never permits resolution against its obsolete basis digest.
 */
export async function reconcileReview(input, basis, review, options) {
  const snapshot = Decision(input);
  requireState(snapshot, ['REVIEWABLE', 'RESOLVABLE']);
  const captured = ConditionalReview(review);
  const { reviewedDeltaDigest, predicateEvaluator, evidenceClassifier } = options;
  parseDigest(reviewedDeltaDigest, 'reviewed-delta');
  const dependencies = snapshot.state === 'RESOLVABLE' ? policyContext(options) : null;
  const [decision, current, reviewedBasis] = await Promise.all([
    verifiedDecision(snapshot),
    verifyDecisionBasis(basis),
    verifyDecisionBasis(captured.basis),
  ]);
  if (captured.decision_id !== decision.id) throw new V1Error('INTEGRITY_MISMATCH');
  const stale = () =>
    Object.freeze({
      decision: Decision({ ...decision, state: 'STALE' }),
      review: captured,
      preserved: false,
      basis_digest: null,
    });
  if (
    !sameMaterialBasis(reviewedBasis, decision.basis) ||
    !sameMaterialBasis(decision.basis, current) ||
    reviewedDeltaDigest !== captured.reviewed_delta_digest ||
    !containsEvidence(decision.basis, reviewedBasis) ||
    !containsEvidence(current, decision.basis)
  ) {
    return stale();
  }
  const reviewedEvidence = new Set(reviewedBasis.evidence_digests);
  const additions = current.evidence_digests.filter((value) => !reviewedEvidence.has(value));
  if (
    additions.length > 0 &&
    (!captured.allow_late_non_material_evidence || typeof evidenceClassifier !== 'function')
  ) {
    return stale();
  }
  if (captured.predicates.length > 0 && typeof predicateEvaluator !== 'function') return stale();
  const context = Object.freeze({
    review: captured,
    reviewed_basis: reviewedBasis,
    current_basis: current,
    reviewed_delta_digest: reviewedDeltaDigest,
  });
  try {
    for (const addition of additions) {
      if ((await evidenceClassifier(addition, context)) !== 'NON_MATERIAL') return stale();
    }
    for (const predicate of captured.predicates) {
      if ((await predicateEvaluator(predicate, context)) !== true) return stale();
    }
    if (dependencies !== null) await requirePolicy(current, dependencies);
  } catch {
    // Availability failures are uncertainty, not permission to retain a review.
    return stale();
  }
  return Object.freeze({
    decision: Decision({ ...decision, basis: current }),
    review: captured,
    preserved: true,
    basis_digest: current.digest,
  });
}
