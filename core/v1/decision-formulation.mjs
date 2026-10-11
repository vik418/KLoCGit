/** Discover bounded review components from exact candidates, effects and observations. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import { Decision, copyJsonData } from './domain.mjs';
import { digestCanonical, encodeCanonical, materialEffectProjection } from './encoding.mjs';
import { verifyCandidateSpec } from './reduction.mjs';
import { verifyCandidateContent } from './promotion.mjs';
import { verifyEffectSet } from './extractors.mjs';
import {
  candidateEvidenceSubject,
  evidenceEligibility,
  evidenceRequirements,
  verifyEvidence,
} from './evidence.mjs';
import { indexEffects } from './effect-index.mjs';
import { buildDecisionBasis, makeReviewable } from './decisions.mjs';

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

const sorted = (values) => [...new Set(values)].sort();
const effectKey = (effect) => effect.future_revision_id + '/' + effect.extractor_id;
const observationKey = (record) =>
  JSON.stringify([
    record.type,
    record.config_digest,
    record.environment_digest,
    record.producer_identity,
    record.producer_version,
  ]);
const selectionKey = (spec, revision) =>
  JSON.stringify([
    ...encodeCanonical(
      spec.selections.filter((selection) => selection.future_revision_id === revision),
    ),
  ]);

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

export class DecisionFormulator {
  constructor({ limits, verifyProvenance, policyEvaluator }) {
    valid(
      typeof verifyProvenance === 'function' &&
        typeof policyEvaluator?.can_reuse === 'function' &&
        typeof policyEvaluator?.required_analysis === 'function',
    );
    const budget = copyJsonData(limits);
    assertSchemaVersion(budget);
    const fields = [
      'max_candidates',
      'max_effect_sets',
      'max_evidence',
      'max_decisions',
      'max_slices',
      'max_links',
      'hub_min_degree',
    ];
    valid(Object.keys(budget).length === fields.length + 1);
    for (const field of fields) valid(Number.isSafeInteger(budget[field]) && budget[field] > 0);
    valid(budget.hub_min_degree >= 2);
    Object.assign(this, {
      limits: freeze(budget),
      verifyProvenance,
      policyEvaluator: Object.freeze({
        can_reuse: policyEvaluator.can_reuse.bind(policyEvaluator),
        required_analysis: policyEvaluator.required_analysis.bind(policyEvaluator),
      }),
    });
    Object.freeze(this);
  }

  async formulate(input) {
    const request = freeze(copyJsonData(input));
    assertSchemaVersion(request);
    valid(Object.keys(request).length === 8 && request.targets && request.canonical_ref_oids);
    for (const field of ['candidate_specs', 'candidates', 'effects', 'evidence'])
      valid(Array.isArray(request[field]));
    if (
      request.candidates.length > this.limits.max_candidates ||
      request.candidate_specs.length > this.limits.max_candidates ||
      request.effects.length > this.limits.max_effect_sets ||
      request.evidence.length > this.limits.max_evidence
    )
      throw new V1Error('INCOMPLETE_ANALYSIS');
    const requirements = evidenceRequirements(request.requirements);
    const candidates = (await Promise.all(request.candidates.map(verifyCandidateContent))).sort(
      (a, b) => (a.digest < b.digest ? -1 : 1),
    );
    valid(new Set(candidates.map(({ digest }) => digest)).size === candidates.length);
    const specs = await Promise.all(request.candidate_specs.map(verifyCandidateSpec));
    const specById = new Map(specs.map((spec) => [spec.id, spec]));
    valid(specById.size === specs.length);
    const bases = new Set(
      candidates.map((candidate) => specById.get(candidate.candidate_spec_id)?.base_revision),
    );
    if (bases.size > 1) throw new V1Error('STALE_BASIS');
    const effects = (await Promise.all(request.effects.map(verifyEffectSet))).sort((a, b) =>
      effectKey(a) < effectKey(b) ? -1 : effectKey(a) > effectKey(b) ? 1 : 0,
    );
    const effectsByRevision = new Map();
    for (const effect of effects) {
      if (!effectsByRevision.has(effect.future_revision_id))
        effectsByRevision.set(effect.future_revision_id, []);
      effectsByRevision.get(effect.future_revision_id).push(effect);
    }
    const owners = new Map();
    const subjects = new Map();
    const subjectsByCandidate = new Map();
    for (const candidate of candidates) {
      const spec = specById.get(candidate.candidate_spec_id);
      valid(spec && spec.selected_future_revisions.length > 0);
      for (const repo of Object.keys(candidate.repo_tree_oids))
        valid(
          request.canonical_ref_oids?.[repo] &&
            Object.keys(request.canonical_ref_oids[repo]).length > 0,
        );
      for (const id of spec.selected_future_revisions) {
        valid(typeof request.targets[id] === 'string' && request.targets[id].trim());
        if (!owners.has(id)) owners.set(id, []);
        owners.get(id).push(candidate.digest);
      }
      const subject = await candidateEvidenceSubject(candidate);
      subjectsByCandidate.set(candidate.digest, subject.digest);
      if (!subjects.has(subject.digest)) subjects.set(subject.digest, []);
      subjects.get(subject.digest).push(candidate.digest);
    }
    valid(effects.every(({ future_revision_id }) => owners.has(future_revision_id)));
    const index = await indexEffects(effects, request.targets, {
      schema_version: 1,
      hub_min_degree: this.limits.hub_min_degree,
    });
    const parent = new Map(candidates.map(({ digest }) => [digest, digest]));
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== id) {
        const next = parent.get(id);
        parent.set(id, root);
        id = next;
      }
      return root;
    };
    const reasons = [],
      uncertain = new Set();
    let links = 0;
    const connect = (ids, reason) => {
      const members = sorted(ids);
      if (members.length < 2) return;
      // A spanning hyperedge is sufficient for component discovery. Do not
      // enumerate pairwise relationships or invent unevaluated combinations.
      if (links + members.length - 1 > this.limits.max_links) {
        members.forEach((id) => uncertain.add(id));
        return;
      }
      for (const id of members.slice(1)) {
        const left = find(members[0]),
          right = find(id);
        if (left !== right) parent.set(left < right ? right : left, left < right ? left : right);
        links += 1;
      }
      reasons.push({ schema_version: 1, ...reason, candidate_digests: members });
    };
    for (const edge of index.interactions)
      connect(
        edge.member_revision_ids.flatMap((id) => owners.get(id)),
        {
          kind: 'POSSIBLE_INTERACTION',
          basis: 'INFERRED',
          repo_id: edge.repo_id,
          target: edge.target,
          security_sensitive: edge.security_sensitive,
          evidence_digests: [],
          statement: 'These candidates affect the same target; compatibility is not established.',
        },
      );
    for (const candidate of candidates) {
      const spec = specById.get(candidate.candidate_spec_id);
      for (const dependency of spec.required_dependencies) {
        const required = owners.get(dependency);
        if (required)
          connect([candidate.digest, ...required], {
            kind: 'DEPENDENCY',
            basis: 'DECLARED',
            future_revision_id: dependency,
            evidence_digests: [],
            statement: 'The composition plan explicitly requires this revision.',
          });
        else uncertain.add(candidate.digest);
      }
    }
    const recordsBySubject = new Map();
    for (const record of request.evidence) {
      const verified = await verifyEvidence(record);
      if (!subjects.has(verified.evidence.subject_digest)) continue;
      const report = await evidenceEligibility(
        verified.evidence,
        verified.evidence.subject_digest,
        requirements,
        this,
      );
      if (!recordsBySubject.has(report.evidence.subject_digest))
        recordsBySubject.set(report.evidence.subject_digest, []);
      recordsBySubject.get(report.evidence.subject_digest).push(report);
    }
    const passing = new Map();
    for (const candidate of candidates) {
      const spec = specById.get(candidate.candidate_spec_id);
      if (spec.selected_future_revisions.length !== 1) continue;
      for (const report of recordsBySubject.get(subjectsByCandidate.get(candidate.digest)) ?? []) {
        if (
          !report.eligible_for.length ||
          report.evidence.result?.basis !== 'OBSERVED' ||
          report.evidence.result.status !== 'PASSING'
        )
          continue;
        const key = JSON.stringify([
          spec.base_revision,
          spec.selected_future_revisions[0],
          selectionKey(spec, spec.selected_future_revisions[0]),
          observationKey(report.evidence),
        ]);
        const previous = passing.get(key);
        if (!previous || report.evidence_digest < previous.evidence_digest)
          passing.set(key, report);
      }
    }
    for (const candidate of candidates) {
      const spec = specById.get(candidate.candidate_spec_id);
      if (spec.selected_future_revisions.length < 2) continue;
      for (const report of recordsBySubject.get(subjectsByCandidate.get(candidate.digest)) ?? []) {
        if (
          !report.eligible_for.length ||
          report.evidence.result?.basis !== 'OBSERVED' ||
          report.evidence.result.status !== 'FAILED'
        )
          continue;
        const isolated = spec.selected_future_revisions.map((id) =>
          passing.get(
            JSON.stringify([
              spec.base_revision,
              id,
              selectionKey(spec, id),
              observationKey(report.evidence),
            ]),
          ),
        );
        if (!isolated.every(Boolean)) continue;
        connect(
          [candidate.digest, ...spec.selected_future_revisions.flatMap((id) => owners.get(id))],
          {
            kind: 'COMPOSED_CHECK_FAILURE',
            basis: 'OBSERVED',
            evidence_digests: sorted([
              report.evidence_digest,
              ...isolated.map((record) => record.evidence_digest),
            ]),
            statement:
              'The registered check passed on each isolated state and failed on this composition. These observations do not establish the cause or global correctness.',
          },
        );
      }
    }
    const groups = new Map(),
      reasonsByGroup = new Map();
    for (const candidate of candidates) {
      const root = find(candidate.digest);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(candidate);
    }
    for (const reason of reasons) {
      const root = find(reason.candidate_digests[0]);
      if (!reasonsByGroup.has(root)) reasonsByGroup.set(root, []);
      reasonsByGroup.get(root).push(reason);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const decisions = [];
    for (const [root, members] of ordered.slice(0, this.limits.max_decisions)) {
      const candidate_digests = members.map(({ digest }) => digest);
      const selected = new Set(
        members.flatMap(
          (candidate) => specById.get(candidate.candidate_spec_id).selected_future_revisions,
        ),
      );
      const relevantEffects = [...selected]
        .flatMap((id) => effectsByRevision.get(id) ?? [])
        .sort((a, b) => (effectKey(a) < effectKey(b) ? -1 : 1));
      const componentEvidence = sorted(
        members.flatMap((candidate) =>
          (recordsBySubject.get(subjectsByCandidate.get(candidate.digest)) ?? []).map(
            ({ evidence_digest }) => evidence_digest,
          ),
        ),
      );
      const subject = freeze({
        schema_version: 1,
        candidate_digests,
        selected_future_revisions: [...selected].sort(),
      });
      const required = copyJsonData(
        await trustedCall(() =>
          this.policyEvaluator.required_analysis(subject, freeze(relevantEffects)),
        ),
      );
      valid(
        Array.isArray(required) &&
          required.every((name) => typeof name === 'string' && name.trim()) &&
          new Set(required).size === required.length,
      );
      const observed = new Map(relevantEffects.map((effect) => [effectKey(effect), effect.status]));
      const required_analysis_status = Object.fromEntries(
        required.sort().map((name) => [name, observed.get(name) ?? 'UNSUPPORTED']),
      );
      if (members.some(({ digest }) => uncertain.has(digest)))
        required_analysis_status['decision-discovery'] = 'PARTIAL';
      const basis = await buildDecisionBasis({
        schema_version: 1,
        candidate_digests,
        evidence_digests: componentEvidence,
        material_effect_digest: await digestCanonical('material-effect', {
          schema_version: 1,
          effect_sets: relevantEffects.map(materialEffectProjection),
        }),
        policy_digest: requirements.policy_digest,
        canonical_ref_oids: request.canonical_ref_oids,
        required_analysis_status,
      });
      const identity = await digestCanonical('object-decision', {
        schema_version: 1,
        candidate_spec_ids: members.map(({ candidate_spec_id }) => candidate_spec_id).sort(),
      });
      const discovered = Decision({
        schema_version: 1,
        id: objectId('decision', identity),
        state: 'DISCOVERED',
        basis: null,
        resolution: null,
      });
      const componentReasons = reasonsByGroup.get(root) ?? [];
      const question = componentReasons.some(({ kind }) => kind === 'COMPOSED_CHECK_FAILURE')
        ? 'Which candidate should be accepted after the composition check failed?'
        : members.length > 1
          ? 'Which candidate should be accepted for the shared effects?'
          : 'Should this candidate be accepted?';
      const alternatives = members.map((candidate) => {
        const spec = specById.get(candidate.candidate_spec_id);
        const slices = spec.selected_future_revisions.flatMap((id) =>
          (effectsByRevision.get(id) ?? []).flatMap((set) =>
            [...set.effects, ...set.security_effects].map((effect) => ({
              schema_version: 1,
              future_revision_id: id,
              repo_id: request.targets[id],
              target: effect.target,
              kind: effect.kind,
              basis: effect.attributes.basis ?? 'UNKNOWN',
            })),
          ),
        );
        return {
          schema_version: 1,
          candidate_digest: candidate.digest,
          candidate_spec_id: spec.id,
          subject_digest: subjectsByCandidate.get(candidate.digest),
          selected_future_revisions: spec.selected_future_revisions,
          code_slices: slices.slice(0, this.limits.max_slices),
          slices_truncated: slices.length > this.limits.max_slices,
          evidence_digests: sorted(
            (recordsBySubject.get(subjectsByCandidate.get(candidate.digest)) ?? []).map(
              ({ evidence_digest }) => evidence_digest,
            ),
          ),
        };
      });
      decisions.push({
        schema_version: 1,
        decision: await makeReviewable(discovered, basis),
        question,
        alternatives,
        reasons: componentReasons,
        evidence: [
          ...new Map(
            members.flatMap((candidate) =>
              (recordsBySubject.get(subjectsByCandidate.get(candidate.digest)) ?? []).map(
                (report) => [report.evidence.id, report],
              ),
            ),
          ).values(),
        ].sort((a, b) => (a.evidence.id < b.evidence.id ? -1 : 1)),
        uncertainty: Object.entries(required_analysis_status)
          .filter(([, status]) => status !== 'COMPLETE')
          .map(([requirement, status]) => ({ schema_version: 1, requirement, status })),
      });
    }
    return freeze({
      schema_version: 1,
      decisions,
      deferred_candidate_digests: ordered
        .slice(this.limits.max_decisions)
        .flatMap(([, group]) => group.map(({ digest }) => digest))
        .sort(),
      suppressed: index.suppressed,
      metrics: { schema_version: 1, ...index.metrics, links },
    });
  }
}
