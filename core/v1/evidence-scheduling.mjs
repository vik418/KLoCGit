/** Reuse exact-state observations before scheduling policy-required checks. */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import {
  candidateEvidenceSubject,
  evidenceEligibility,
  evidenceRequirements,
} from './evidence.mjs';
import { verifyCandidateContent } from './promotion.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

export class EvidenceScheduler {
  constructor({ provider, verifyProvenance, policyEvaluator, limits }) {
    valid(
      typeof provider?.find_reusable === 'function' && typeof provider?.evaluate === 'function',
    );
    valid(
      typeof verifyProvenance === 'function' && typeof policyEvaluator?.can_reuse === 'function',
    );
    const budget = copyJsonData(limits);
    assertSchemaVersion(budget);
    valid(Object.keys(budget).length === 4);
    for (const field of ['max_checks', 'max_records', 'max_evaluations'])
      valid(Number.isSafeInteger(budget[field]) && budget[field] > 0);
    this.find = provider.find_reusable.bind(provider);
    this.run = provider.evaluate.bind(provider);
    this.options = Object.freeze({
      verifyProvenance,
      policyEvaluator: Object.freeze({
        can_reuse: policyEvaluator.can_reuse.bind(policyEvaluator),
      }),
    });
    this.limits = freeze(budget);
    Object.freeze(this);
  }

  async evaluate(candidateInput, requirementsInput) {
    const data = copyJsonData(candidateInput);
    const requirements = evidenceRequirements(requirementsInput);
    if (requirements.checks.length > this.limits.max_checks)
      throw new V1Error('INCOMPLETE_ANALYSIS');
    const candidate = await verifyCandidateContent(data);
    const subject = await candidateEvidenceSubject(candidate);
    const records = new Map();
    const byCheck = new Map(requirements.checks.map(({ id }) => [id, new Set()]));
    const collect = async (input, requestedCheck) => {
      valid(Array.isArray(input));
      if (input.length > this.limits.max_records) throw new V1Error('INCOMPLETE_ANALYSIS');
      const snapshots = copyJsonData(input);
      for (const snapshot of snapshots) {
        const report = await evidenceEligibility(
          snapshot,
          subject.digest,
          requirements,
          this.options,
        );
        if (requestedCheck && !report.eligible_for.includes(requestedCheck))
          throw new V1Error('POLICY_REJECTED');
        if (!report.eligible_for.length) continue;
        records.set(report.evidence.id, report.evidence);
        if (records.size > this.limits.max_records) throw new V1Error('INCOMPLETE_ANALYSIS');
        for (const id of report.eligible_for) byCheck.get(id).add(report.evidence.id);
      }
    };
    if (requirements.checks.length)
      await collect(await trustedCall(() => this.find(subject.digest, requirements)));
    const checks = [];
    let evaluations = 0;
    for (const check of requirements.checks) {
      const matching = byCheck.get(check.id);
      let state;
      if (matching.size) state = 'REUSED';
      else if (evaluations === this.limits.max_evaluations) state = 'DEFERRED';
      else {
        evaluations += 1;
        // No implicit full-suite request: the current policy names every check.
        const required = evidenceRequirements({ ...requirements, checks: [check] });
        await collect(await trustedCall(() => this.run(candidate, required)), check.id);
        state = matching.size ? 'EVALUATED' : 'MISSING';
      }
      checks.push({ schema_version: 1, check_id: check.id, state });
    }
    // This is a rebuildable scheduling report, never a resolution authorization.
    // Conflicting authenticated observations remain in the report for policy/review.
    const evidence = [...records.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const body = {
      schema_version: 1,
      subject_digest: subject.digest,
      policy_digest: requirements.policy_digest,
      evidence_ids: evidence.map(({ id }) => id),
      checks: checks.map((check) => ({
        ...check,
        evidence_ids: [...byCheck.get(check.check_id)].sort(),
      })),
    };
    return freeze({
      plan: { ...body, digest: await digestCanonical('evidence-schedule', body) },
      evidence,
    });
  }
}
