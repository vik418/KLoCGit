import assert from "node:assert/strict";
import test from "node:test";
import {
  hashProjection,
  sealCandidate,
  sealCandidateSpec,
  sealDecisionBasis,
  sealEffectSet,
  sealEvidence,
} from "../../contracts/src/index.ts";
import {
  DecisionConflict,
  DecisionLifecycle,
  PolicyEvaluator,
  policyDigest,
} from "../src/policy.ts";
import type { Review, ReviewPolicy } from "../src/policy.ts";
import type { Decision } from "../../contracts/src/index.ts";

async function fixture() {
  const effect = await sealEffectSet({
    future_revision_id: "future",
    extractor_id: "extractor",
    extractor_version: "1",
    capability: "STRUCTURAL",
    status: "COMPLETE",
    modified_exports: ["api"],
    added_dependencies: {},
    db_migrations_detected: false,
    security_effects: [],
  });
  const effect_summary_digest = await hashProjection("klocgit.effect-summary", [
    effect.effect_digest,
  ]);
  const spec = await sealCandidateSpec({
    base_revisions: { repo: "2".repeat(40) },
    selected_future_revisions: [effect.future_revision_id],
    composition_manifest: [],
    creation_reason: "test",
    effect_summary_digest,
  });
  const candidate = await sealCandidate({
    candidate_spec_id: spec.id,
    repo_tree_oids: { repo: "1".repeat(40) },
    materialization_record: {
      executor_id: "executor",
      materialized_at: new Date().toISOString(),
      conflicts_encountered: [],
    },
  });
  const config_digest = await hashProjection("test.config", {}),
    environment_digest = await hashProjection("test.environment", {});
  const evidence = await sealEvidence({
    subject_digest: candidate.candidate_digest,
    evaluator_id: "trusted",
    evaluator_version: "1",
    config_digest,
    environment_digest,
    result: "PASSED",
    payload_digest: await hashProjection("test.payload", {}),
    payload_ref: "payload",
    retention_class: "DECISION_RECORD",
    created_at: new Date().toISOString(),
  });
  const policy: ReviewPolicy = {
    schema_version: 1,
    required_capability: "STRUCTURAL",
    minimum_reviewers: 1,
    reviewer_actor_ids: ["owner"],
    evidence_requirements: [
      {
        evaluator_id: evidence.evaluator_id,
        evaluator_version: evidence.evaluator_version,
        config_digest,
        environment_digests: [environment_digest],
      },
    ],
  };
  const basis = await sealDecisionBasis({
    candidate_digests: [candidate.candidate_digest],
    evidence_digests: [evidence.evidence_digest],
    policy_digest: await policyDigest(policy),
    material_effect_digest: await hashProjection("klocgit.effect-summary", [
      effect.effect_digest,
    ]),
    canonical_ref_oids: { repo: "2".repeat(40) },
    required_analysis_status: { [effect.effect_digest]: "COMPLETE" },
  });
  const review: Review = {
    schema_version: 1,
    actor_id: "owner",
    actor_type: "human",
    candidate_digest: candidate.candidate_digest,
    basis_digest: basis.basis_digest,
    policy_digest: basis.policy_digest,
    material_effect_digest: basis.material_effect_digest,
    predicates: [],
  };
  return {
    basis,
    policy,
    spec,
    candidate,
    effect,
    evidence,
    review,
    context: {
      spec,
      candidate,
      effects: [effect],
      evidence: [evidence],
      reviews: [review],
    },
  };
}

test("incomplete analysis, missing capabilities, and wrong evidence cannot resolve", async () => {
  const f = await fixture(),
    evaluator = new PolicyEvaluator(f.policy);
  assert((await evaluator.canResolve(f.basis, f.context)).allowed);
  for (const status of ["PARTIAL", "FAILED", "UNSUPPORTED"] as const) {
    const basis = await sealDecisionBasis({
      ...f.basis,
      required_analysis_status: { [f.effect.effect_digest]: status },
    });
    assert(!(await evaluator.canResolve(basis, f.context)).allowed);
  }
  assert(
    !(
      await new PolicyEvaluator({
        ...f.policy,
        required_capability: "SEMANTIC",
      }).canResolve(f.basis, f.context)
    ).allowed,
  );
  for (const patch of [
    { subject_digest: await hashProjection("test.other-state", {}) },
    { result: "FAILED" as const },
    { environment_digest: await hashProjection("test.other-environment", {}) },
    { config_digest: await hashProjection("test.other-config", {}) },
  ]) {
    const evidence = await sealEvidence({ ...f.evidence, ...patch });
    const basis = await sealDecisionBasis({
      ...f.basis,
      evidence_digests: [evidence.evidence_digest],
    });
    assert(
      !(
        await evaluator.canResolve(basis, {
          ...f.context,
          evidence: [evidence],
        })
      ).allowed,
    );
  }
  const tampered = {
    ...f.evidence,
    result: "PASSED" as const,
    subject_digest: await hashProjection("test.substitution", {}),
  };
  assert(
    !(
      await evaluator.canResolve(f.basis, {
        ...f.context,
        evidence: [tampered],
      })
    ).allowed,
  );
});

test("distinct authorized humans count once and agents cannot impersonate reviewers", async () => {
  const f = await fixture();
  const policy = {
    ...f.policy,
    minimum_reviewers: 2,
    reviewer_actor_ids: ["owner", "second"],
  };
  const basis = await sealDecisionBasis({
    ...f.basis,
    policy_digest: await policyDigest(policy),
  });
  const review = {
    ...f.review,
    basis_digest: basis.basis_digest,
    policy_digest: basis.policy_digest,
  };
  const evaluator = new PolicyEvaluator(policy);
  assert(
    !(
      await evaluator.canResolve(basis, {
        ...f.context,
        reviews: [review, review],
      })
    ).allowed,
  );
  assert(
    !(
      await evaluator.canResolve(basis, {
        ...f.context,
        reviews: [
          review,
          {
            ...review,
            actor_id: "second",
            actor_type: "agent",
          } as unknown as Review,
        ],
      })
    ).allowed,
  );
  assert(
    (
      await evaluator.canResolve(basis, {
        ...f.context,
        reviews: [review, { ...review, actor_id: "second" }],
      })
    ).allowed,
  );
});

test("late evidence preserves only explicitly conditional unchanged-state review", async () => {
  const f = await fixture();
  const later = await sealEvidence({
    ...f.evidence,
    payload_digest: await hashProjection("test.later-log", {}),
  });
  const basis = await sealDecisionBasis({
    ...f.basis,
    evidence_digests: [f.evidence.evidence_digest, later.evidence_digest],
  });
  const context = { ...f.context, evidence: [f.evidence, later] };
  const evaluator = new PolicyEvaluator(f.policy);
  assert(!(await evaluator.canResolve(basis, context)).allowed);
  const review = {
    ...f.review,
    predicates: [
      {
        kind: "CANDIDATE_UNCHANGED" as const,
        subject: f.candidate.candidate_digest,
      },
      {
        kind: "EFFECTS_UNCHANGED" as const,
        subject: f.basis.material_effect_digest,
      },
      { kind: "EVIDENCE_PASSED" as const, subject: f.evidence.evidence_digest },
    ],
  };
  assert(
    (await evaluator.canResolve(basis, { ...context, reviews: [review] }))
      .allowed,
  );
  const invalid = {
    ...review,
    predicates: [
      ...review.predicates,
      { kind: "ANALYSIS_COMPLETE" as const, subject: "unobserved" },
    ],
  };
  assert(
    !(await evaluator.canResolve(basis, { ...context, reviews: [invalid] }))
      .allowed,
  );
});

test("resolution needs a matching promotion receipt and never mutates history", async () => {
  const f = await fixture();
  const original: Decision = {
    id: "decision",
    objective_id: "objective",
    basis: f.basis,
    state: "DISCOVERED",
    conditional_predicates: [],
  };
  const reviewed = DecisionLifecycle.inspect(original);
  const ready = DecisionLifecycle.ready(
    reviewed,
    await new PolicyEvaluator(f.policy).canResolve(f.basis, f.context),
  );
  assert.equal(ready.state, "RESOLVABLE");
  const receipt = {
    status: "APPLIED" as const,
    decision_id: original.id,
    basis_digest: f.basis.basis_digest,
  };
  assert.throws(
    () => DecisionLifecycle.resolve(ready, "stale", "owner", receipt),
    DecisionConflict,
  );
  assert.throws(
    () =>
      DecisionLifecycle.resolve(
        DecisionLifecycle.stale(ready),
        f.basis.basis_digest,
        "owner",
        receipt,
      ),
    DecisionConflict,
  );
  assert.equal(
    DecisionLifecycle.resolve(ready, f.basis.basis_digest, "owner", receipt)
      .state,
    "RESOLVED",
  );
  assert.equal(original.state, "DISCOVERED");
});

test("changing only expected heads or omitting selected-future analysis never preserves authorization", async () => {
  const f = await fixture(),
    evaluator = new PolicyEvaluator(f.policy);
  const moved = await sealDecisionBasis({
    ...f.basis,
    canonical_ref_oids: { repo: "3".repeat(40) },
  });
  assert(!(await evaluator.evaluateRequirements(moved, f.context)).allowed);
  const spec = await sealCandidateSpec({
    ...f.spec,
    selected_future_revisions: [
      f.effect.future_revision_id,
      "unobserved-future",
    ],
  });
  const candidate = await sealCandidate({
    ...f.candidate,
    candidate_spec_id: spec.id,
  });
  const basis = await sealDecisionBasis({
    ...f.basis,
    candidate_digests: [candidate.candidate_digest],
  });
  assert(
    !(
      await evaluator.evaluateRequirements(basis, {
        ...f.context,
        spec,
        candidate,
      })
    ).allowed,
  );
});

test("policy results bind an immutable input snapshot and cannot authorize another basis", async () => {
  const f = await fixture(),
    evaluator = new PolicyEvaluator(f.policy);
  const pending = evaluator.canResolve(f.basis, f.context);
  f.context.candidate.repo_tree_oids.repo = "9".repeat(40);
  const result = await pending;
  assert(result.allowed);
  assert.equal(result.basis_digest, f.basis.basis_digest);
  const changed = await sealDecisionBasis({
    ...f.basis,
    canonical_ref_oids: { repo: "3".repeat(40) },
  });
  const decision: Decision = {
    id: "decision",
    objective_id: "objective",
    basis: changed,
    state: "REVIEWABLE",
    conditional_predicates: [],
  };
  assert.throws(
    () => DecisionLifecycle.ready(decision, result),
    DecisionConflict,
  );
});

test("a multi-candidate decision binds every alternative but requires selected-state evidence", async () => {
  const f = await fixture();
  const effect = await sealEffectSet({
    ...f.effect,
    future_revision_id: "alternative",
    modified_exports: ["api", "telemetry"],
  });
  const spec = await sealCandidateSpec({
    ...f.spec,
    selected_future_revisions: [effect.future_revision_id],
    effect_summary_digest: await hashProjection("klocgit.effect-summary", [
      effect.effect_digest,
    ]),
  });
  const candidate = await sealCandidate({
    ...f.candidate,
    candidate_spec_id: spec.id,
    repo_tree_oids: { repo: "4".repeat(40) },
  });
  const basis = await sealDecisionBasis({
    ...f.basis,
    candidate_digests: [
      f.candidate.candidate_digest,
      candidate.candidate_digest,
    ],
    material_effect_digest: await hashProjection(
      "klocgit.effect-summary",
      [f.effect.effect_digest, effect.effect_digest].sort(),
    ),
    required_analysis_status: {
      [f.effect.effect_digest]: "COMPLETE",
      [effect.effect_digest]: "COMPLETE",
    },
  });
  const review = {
    ...f.review,
    basis_digest: basis.basis_digest,
    material_effect_digest: basis.material_effect_digest,
    candidate_digests: basis.candidate_digests,
  };
  const context = {
    ...f.context,
    reviews: [review],
    alternatives: [{ spec, candidate, effects: [effect] }],
  };
  const evaluator = new PolicyEvaluator(f.policy);
  assert((await evaluator.canResolve(basis, context)).allowed);
  const omitted = await evaluator.canResolve(basis, {
    ...context,
    alternatives: [],
  });
  assert(!omitted.allowed);
  assert(
    omitted.blockers.some(
      (blocker) => blocker.code === "CANDIDATE_ANALYSIS_MISSING",
    ),
  );
  const substituted = await evaluator.canResolve(basis, {
    ...context,
    alternatives: [
      {
        ...context.alternatives[0],
        candidate: {
          ...candidate,
          repo_tree_oids: { repo: "5".repeat(40) },
        },
      },
    ],
  });
  assert(!substituted.allowed);
  const otherEvidence = await sealEvidence({
    ...f.evidence,
    subject_digest: candidate.candidate_digest,
  });
  const otherBasis = await sealDecisionBasis({
    ...basis,
    evidence_digests: [otherEvidence.evidence_digest],
  });
  const wrongEvidence = await evaluator.evaluateRequirements(otherBasis, {
    ...context,
    evidence: [otherEvidence],
  });
  assert(!wrongEvidence.allowed);
  assert(
    wrongEvidence.blockers.some(
      (blocker) => blocker.code === "EVIDENCE_MISSING",
    ),
  );
  const partial = await sealEffectSet({ ...effect, status: "PARTIAL" });
  const partialSpec = await sealCandidateSpec({
    ...spec,
    effect_summary_digest: await hashProjection("klocgit.effect-summary", [
      partial.effect_digest,
    ]),
  });
  const partialBasis = await sealDecisionBasis({
    ...basis,
    material_effect_digest: await hashProjection(
      "klocgit.effect-summary",
      [f.effect.effect_digest, partial.effect_digest].sort(),
    ),
    required_analysis_status: {
      [f.effect.effect_digest]: "COMPLETE",
      [partial.effect_digest]: "PARTIAL",
    },
  });
  assert(
    !(
      await evaluator.evaluateRequirements(partialBasis, {
        ...context,
        alternatives: [{ spec: partialSpec, candidate, effects: [partial] }],
      })
    ).allowed,
  );
});

test("conditional approval cannot float across changed alternatives with identical structural effects", async () => {
  const f = await fixture();
  const alternative = await sealCandidate({
    ...f.candidate,
    repo_tree_oids: { repo: "4".repeat(40) },
  });
  const basis = await sealDecisionBasis({
    ...f.basis,
    candidate_digests: [
      f.candidate.candidate_digest,
      alternative.candidate_digest,
    ],
  });
  const conditional = {
    ...f.review,
    predicates: [
      {
        kind: "CANDIDATE_UNCHANGED" as const,
        subject: f.candidate.candidate_digest,
      },
      {
        kind: "EFFECTS_UNCHANGED" as const,
        subject: basis.material_effect_digest,
      },
    ],
  };
  const context = {
    ...f.context,
    reviews: [conditional],
    alternatives: [
      { spec: f.spec, candidate: alternative, effects: [f.effect] },
    ],
  };
  const evaluator = new PolicyEvaluator(f.policy);
  assert((await evaluator.evaluateRequirements(basis, context)).allowed);
  assert(!(await evaluator.canResolve(basis, context)).allowed);
});
