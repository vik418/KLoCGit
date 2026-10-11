/** Bind resolution policy to one selected exact Candidate and authenticated Evidence. */
import { V1Error, parseDigest } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { verifyCandidateContent } from './promotion.mjs';
import {
  candidateEvidenceSubject,
  evidenceEligibility,
  evidenceRequirements,
} from './evidence.mjs';
import { verifyDecisionBasis } from './decisions.mjs';

export async function createCandidatePolicy({
  candidate: candidateInput,
  requirements: requirementsInput,
  required_analysis,
  evidence: evidenceInput,
  verifyProvenance,
  canReuse,
  max_evidence,
}) {
  const candidate = await verifyCandidateContent(candidateInput),
    requirements = evidenceRequirements(requirementsInput);
  const subject = await candidateEvidenceSubject(candidate);
  const analysis = copyJsonData(required_analysis),
    evidence = copyJsonData(evidenceInput);
  if (
    !Array.isArray(analysis) ||
    analysis.some((key) => typeof key !== 'string' || !key.trim()) ||
    new Set(analysis).size !== analysis.length ||
    !Array.isArray(evidence) ||
    !Number.isSafeInteger(max_evidence) ||
    max_evidence < 1 ||
    typeof verifyProvenance !== 'function' ||
    typeof canReuse !== 'function'
  )
    throw new V1Error('INVALID_ARGUMENT');
  if (evidence.length > max_evidence) throw new V1Error('INCOMPLETE_ANALYSIS');
  parseDigest(requirements.policy_digest);
  return Object.freeze({
    required_analysis: () => analysis.slice(),
    can_resolve: async (input) => {
      const basis = await verifyDecisionBasis(input);
      if (
        basis.policy_digest !== requirements.policy_digest ||
        !basis.candidate_digests.includes(candidate.digest)
      )
        return false;
      const passing = new Set(),
        reviewed = new Set();
      for (const item of evidence) {
        const report = await evidenceEligibility(item, subject.digest, requirements, {
          verifyProvenance,
          policyEvaluator: { can_reuse: canReuse },
        });
        if (!basis.evidence_digests.includes(report.evidence_digest)) return false;
        reviewed.add(report.evidence_digest);
        if (!report.eligible_for.length) continue;
        // Conflicting observations stay unresolved. A passing sibling state or
        // a producer's claim cannot erase a failure for the selected state.
        if (
          report.evidence.result.basis !== 'OBSERVED' ||
          report.evidence.result.status !== 'PASSING'
        )
          return false;
        report.eligible_for.forEach((id) => passing.add(id));
      }
      return (
        reviewed.size === basis.evidence_digests.length &&
        requirements.checks.every((check) => passing.has(check.id))
      );
    },
  });
}
