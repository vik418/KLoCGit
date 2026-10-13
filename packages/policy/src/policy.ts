import {
  hashProjection,
  sealCandidate,
  sealCandidateSpec,
  sealDecisionBasis,
  sealEffectSet,
  sealEvidence,
} from "../../contracts/src/index.ts";
import type {
  Candidate,
  CandidateSpec,
  Decision,
  DecisionBasis,
  EffectSet,
  Evidence,
  Predicate,
} from "../../contracts/src/index.ts";

export interface EvidenceRequirement {
  evaluator_id: string;
  evaluator_version: string;
  config_digest: string;
  environment_digests: string[];
}

export interface ReviewPolicy {
  schema_version: 1;
  required_capability: EffectSet["capability"];
  evidence_requirements: EvidenceRequirement[];
  reviewer_actor_ids: string[];
  minimum_reviewers: number;
}

export interface Review {
  schema_version: 1;
  actor_id: string;
  actor_type: "human";
  candidate_digest: string;
  candidate_digests?: string[];
  basis_digest: string;
  policy_digest: string;
  material_effect_digest: string;
  predicates: Predicate[];
}

export interface CandidateAnalysis {
  spec: CandidateSpec;
  candidate: Candidate;
  effects: EffectSet[];
}

export interface EvaluationContext extends CandidateAnalysis {
  alternatives?: CandidateAnalysis[];
  evidence: Evidence[];
  reviews: Review[];
}

export interface PolicyResult {
  basis_digest: string;
  candidate_digest: string;
  allowed: boolean;
  blockers: { code: string; subject: string }[];
}

export async function policyDigest(policy: ReviewPolicy): Promise<string> {
  const capabilities = ["PATH", "STRUCTURAL", "SEMANTIC"];
  if (
    policy.schema_version !== 1 ||
    !capabilities.includes(policy.required_capability) ||
    !Number.isSafeInteger(policy.minimum_reviewers) ||
    policy.minimum_reviewers < 1 ||
    !policy.reviewer_actor_ids.length ||
    !policy.evidence_requirements.length
  )
    throw new Error("Review policy is incomplete");
  const requirements = policy.evidence_requirements.map((requirement) => {
    if (
      !requirement.evaluator_id ||
      !requirement.evaluator_version ||
      !/^sha256:[0-9a-f]{64}$/.test(requirement.config_digest) ||
      !requirement.environment_digests.length ||
      requirement.environment_digests.some(
        (value) => !/^sha256:[0-9a-f]{64}$/.test(value),
      )
    )
      throw new Error("Evidence requirement is incomplete");
    return {
      ...requirement,
      environment_digests: [...new Set(requirement.environment_digests)].sort(),
    };
  });
  const keyed = await Promise.all(
    requirements.map(async (requirement) => ({
      requirement,
      identity: await hashProjection(
        "klocgit.policy.evidence-requirement",
        requirement,
      ),
    })),
  );
  keyed.sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
  );
  return hashProjection("klocgit.review-policy", {
    schema_version: 1,
    required_capability: policy.required_capability,
    evidence_requirements: keyed.map((item) => item.requirement),
    reviewer_actor_ids: [...new Set(policy.reviewer_actor_ids)].sort(),
    minimum_reviewers: policy.minimum_reviewers,
  });
}

function predicateSatisfied(
  predicate: Predicate,
  basis: DecisionBasis,
  context: EvaluationContext,
): boolean {
  switch (predicate.kind) {
    case "ANALYSIS_COMPLETE":
      return (
        basis.required_analysis_status[predicate.subject] === "COMPLETE" &&
        (predicate.expected === undefined || predicate.expected === "COMPLETE")
      );
    case "EVIDENCE_PASSED":
      return (
        basis.evidence_digests.includes(predicate.subject) &&
        context.evidence.some(
          (evidence) =>
            evidence.evidence_digest === predicate.subject &&
            evidence.subject_digest === context.candidate.candidate_digest &&
            evidence.result === "PASSED",
        ) &&
        (predicate.expected === undefined || predicate.expected === "PASSED")
      );
    case "CANDIDATE_UNCHANGED":
      return (
        context.candidate.candidate_digest ===
        (predicate.expected ?? predicate.subject)
      );
    case "EFFECTS_UNCHANGED":
      return (
        basis.material_effect_digest ===
        (predicate.expected ?? predicate.subject)
      );
    default:
      return false;
  }
}

/** Required facts are supplied from authoritative records, never producer claims. */
export class PolicyEvaluator {
  private policy: ReviewPolicy;
  constructor(policy: ReviewPolicy) {
    this.policy = structuredClone(policy);
  }

  canResolve(
    basis: DecisionBasis,
    context: EvaluationContext,
  ): Promise<PolicyResult> {
    return this.evaluate(basis, context, true);
  }

  evaluateRequirements(
    basis: DecisionBasis,
    context: EvaluationContext,
  ): Promise<PolicyResult> {
    return this.evaluate(basis, context, false);
  }

  private async evaluate(
    basis: DecisionBasis,
    context: EvaluationContext,
    requireReviews: boolean,
  ): Promise<PolicyResult> {
    basis = structuredClone(basis);
    context = structuredClone(context);
    const blockers: PolicyResult["blockers"] = [];
    const block = (code: string, subject: string) =>
      blockers.push({ code, subject });
    try {
      if ((await sealDecisionBasis(basis)).basis_digest !== basis.basis_digest)
        block("BASIS_CORRUPT", basis.basis_digest);
      if ((await policyDigest(this.policy)) !== basis.policy_digest)
        block("POLICY_CHANGED", basis.policy_digest);
      // A review covers the choices shown, not just the selected implementation.
      const analyses: CandidateAnalysis[] = [
        context,
        ...(context.alternatives ?? []),
      ];
      const candidates = new Set<string>();
      const effects = new Map<string, EffectSet>();
      const levels = ["PATH", "STRUCTURAL", "SEMANTIC"];
      for (const analysis of analyses) {
        const spec = await sealCandidateSpec(analysis.spec);
        const candidate = await sealCandidate(analysis.candidate);
        if (
          spec.id !== analysis.spec.id ||
          spec.spec_digest !== analysis.spec.spec_digest ||
          candidate.candidate_spec_id !== spec.id
        )
          block("SPEC_CHANGED", analysis.spec.id);
        if (
          candidate.id !== analysis.candidate.id ||
          candidate.candidate_digest !== analysis.candidate.candidate_digest ||
          !basis.candidate_digests.includes(candidate.candidate_digest) ||
          candidates.has(candidate.candidate_digest)
        )
          block("CANDIDATE_CHANGED", analysis.candidate.candidate_digest);
        candidates.add(candidate.candidate_digest);
        if (
          (await hashProjection("klocgit.review-base", spec.base_revisions)) !==
            (await hashProjection(
              "klocgit.review-base",
              basis.canonical_ref_oids,
            )) ||
          Object.keys(spec.base_revisions).length !==
            Object.keys(candidate.repo_tree_oids).length ||
          Object.keys(spec.base_revisions).some(
            (repo) => !Object.hasOwn(candidate.repo_tree_oids, repo),
          )
        )
          block("BASE_CHANGED", candidate.candidate_digest);
        const observed = new Set(
          analysis.effects.map((effect) => effect.future_revision_id),
        );
        if (
          !analysis.effects.length ||
          observed.size !== spec.selected_future_revisions.length ||
          spec.selected_future_revisions.some((id) => !observed.has(id))
        )
          block("ANALYSIS_MISSING", spec.id);
        const selectedDigests = new Set<string>();
        for (const effect of analysis.effects) {
          const sealed = await sealEffectSet(effect);
          if (sealed.effect_digest !== effect.effect_digest)
            block("EFFECT_CORRUPT", effect.future_revision_id);
          selectedDigests.add(sealed.effect_digest);
          effects.set(sealed.effect_digest, sealed);
          if (
            basis.required_analysis_status[sealed.effect_digest] !==
            sealed.status
          )
            block("ANALYSIS_BINDING_CHANGED", effect.future_revision_id);
          if (sealed.status !== "COMPLETE")
            block("ANALYSIS_" + sealed.status, effect.future_revision_id);
          if (
            levels.indexOf(sealed.capability) <
            levels.indexOf(this.policy.required_capability)
          )
            block("CAPABILITY_REQUIRED", effect.future_revision_id);
        }
        if (
          (await hashProjection(
            "klocgit.effect-summary",
            [...selectedDigests].sort(),
          )) !== analysis.spec.effect_summary_digest
        )
          block("SPEC_EFFECTS_CHANGED", spec.id);
      }
      if (
        candidates.size !== basis.candidate_digests.length ||
        basis.candidate_digests.some((digest) => !candidates.has(digest))
      )
        block("CANDIDATE_ANALYSIS_MISSING", basis.basis_digest);
      if (
        !effects.size ||
        Object.keys(basis.required_analysis_status).length !== effects.size
      )
        block("ANALYSIS_BINDING_CHANGED", basis.basis_digest);
      for (const [subject, status] of Object.entries(
        basis.required_analysis_status,
      )) {
        if (!effects.has(subject)) block("ANALYSIS_MISSING", subject);
        if (status !== "COMPLETE") block("ANALYSIS_" + status, subject);
      }
      if (
        (await hashProjection(
          "klocgit.effect-summary",
          [...effects.keys()].sort(),
        )) !== basis.material_effect_digest
      )
        block("EFFECTS_CHANGED", basis.material_effect_digest);
      for (const evidence of context.evidence) {
        const sealed = await sealEvidence(evidence);
        if (
          sealed.evidence_digest !== evidence.evidence_digest ||
          sealed.id !== evidence.id
        )
          block("EVIDENCE_CORRUPT", evidence.evidence_digest);
      }
      for (const requirement of this.policy.evidence_requirements) {
        const matching = context.evidence.filter(
          (evidence) =>
            basis.evidence_digests.includes(evidence.evidence_digest) &&
            evidence.subject_digest === context.candidate.candidate_digest &&
            evidence.evaluator_id === requirement.evaluator_id &&
            evidence.evaluator_version === requirement.evaluator_version &&
            evidence.config_digest === requirement.config_digest &&
            requirement.environment_digests.includes(
              evidence.environment_digest,
            ),
        );
        if (!matching.length)
          block("EVIDENCE_MISSING", requirement.evaluator_id);
        else if (matching.some((evidence) => evidence.result !== "PASSED"))
          block("EVIDENCE_NOT_PASSED", requirement.evaluator_id);
      }
      if (requireReviews) {
        const reviewers = new Set<string>();
        for (const review of context.reviews) {
          if (
            review.schema_version !== 1 ||
            review.actor_type !== "human" ||
            !this.policy.reviewer_actor_ids.includes(review.actor_id) ||
            review.candidate_digest !== context.candidate.candidate_digest ||
            review.policy_digest !== basis.policy_digest ||
            review.material_effect_digest !== basis.material_effect_digest
          )
            continue;
          const current = review.basis_digest === basis.basis_digest;
          const reviewedCandidates = new Set(
            review.candidate_digests ?? [review.candidate_digest],
          );
          const conditionallyValid =
            reviewedCandidates.size === basis.candidate_digests.length &&
            basis.candidate_digests.every((digest) =>
              reviewedCandidates.has(digest),
            ) &&
            review.predicates.length > 0 &&
            review.predicates.some(
              (predicate) => predicate.kind === "CANDIDATE_UNCHANGED",
            ) &&
            review.predicates.some(
              (predicate) => predicate.kind === "EFFECTS_UNCHANGED",
            );
          if (
            (current || conditionallyValid) &&
            review.predicates.every((predicate) =>
              predicateSatisfied(predicate, basis, context),
            )
          )
            reviewers.add(review.actor_id);
        }
        if (reviewers.size < this.policy.minimum_reviewers)
          block("REVIEW_REQUIRED", context.candidate.candidate_digest);
      }
    } catch {
      block("INVALID_POLICY_INPUT", basis.basis_digest);
    }
    return {
      basis_digest: basis.basis_digest,
      candidate_digest: context.candidate.candidate_digest,
      allowed: blockers.length === 0,
      blockers,
    };
  }
}

export class DecisionConflict extends Error {
  readonly code = "STALE_BASIS";
}

/** Promotion receipts, not button clicks, finalize resolution. */
export class DecisionLifecycle {
  static inspect(decision: Decision): Decision {
    if (decision.state !== "DISCOVERED")
      throw new Error("Decision cannot become reviewable from this state");
    return { ...decision, state: "REVIEWABLE" };
  }

  static ready(decision: Decision, result: PolicyResult): Decision {
    if (!["REVIEWABLE", "RESOLVABLE"].includes(decision.state))
      throw new Error("Decision cannot be evaluated from this state");
    if (
      result.basis_digest !== decision.basis.basis_digest ||
      !decision.basis.candidate_digests.includes(result.candidate_digest)
    )
      throw new DecisionConflict(
        "Policy result belongs to another reviewed state",
      );
    return { ...decision, state: result.allowed ? "RESOLVABLE" : "REVIEWABLE" };
  }

  static resolve(
    decision: Decision,
    expectedBasis: string,
    actor: string,
    receipt: {
      status: "APPLIED";
      decision_id: string;
      basis_digest: string;
    },
  ): Decision {
    if (
      decision.state !== "RESOLVABLE" ||
      decision.basis.basis_digest !== expectedBasis ||
      receipt.status !== "APPLIED" ||
      receipt.decision_id !== decision.id ||
      receipt.basis_digest !== expectedBasis
    )
      throw new DecisionConflict("Reviewed and promoted states differ");
    return {
      ...decision,
      state: "RESOLVED",
      resolved_by: actor,
      resolved_at: new Date().toISOString(),
    };
  }

  static stale(decision: Decision): Decision {
    if (decision.state === "RESOLVED")
      throw new Error("Resolved history cannot be made stale");
    return { ...decision, state: "STALE" };
  }
}
