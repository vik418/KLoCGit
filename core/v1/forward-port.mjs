/** Rematerialize on a changed base; preserve review only after exact comparison. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import {
  ConditionalReview,
  buildDecisionBasis,
  markStale,
  verifyDecisionBasis,
} from './decisions.mjs';
import { Decision, SystemRevision, copyJsonData } from './domain.mjs';
import { digestCanonical, materialEffectProjection } from './encoding.mjs';
import { buildCandidateSpec, verifyCandidateSpec } from './reduction.mjs';
import { materializationInputs } from './materialization.mjs';
import { verifyCandidateContent } from './promotion.mjs';
import { verifyEffectSet } from './extractors.mjs';
import { candidateEvidenceSubject, evidenceRequirements, verifyEvidence } from './evidence.mjs';

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
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function baseRevision(input) {
  const record = SystemRevision(input);
  const { id, digest, ...body } = record;
  if (
    (await digestCanonical('object-system-revision', body)) !== digest ||
    objectId('system-revision', digest) !== id
  )
    throw new V1Error('INTEGRITY_MISMATCH');
  return record;
}

/** Compare actual Git entries; no blobs or speculative durable Git writes are needed. */
export class ReviewedDeltaReader {
  constructor({ resolveSource, materializer, max_files }) {
    valid(typeof resolveSource === 'function' && typeof materializer?.open === 'function');
    valid(Number.isSafeInteger(max_files) && max_files > 0);
    Object.assign(this, { resolveSource, materializer, max_files });
  }

  async read(baseInput, candidateInput) {
    const base = await baseRevision(baseInput),
      candidate = await verifyCandidateContent(candidateInput);
    if (Object.keys(base.repositories).length !== Object.keys(candidate.repo_tree_oids).length)
      throw new V1Error('INTEGRITY_MISMATCH');
    const changes = [];
    let entries = 0;
    for (const repo_id of Object.keys(base.repositories).sort()) {
      valid(Object.hasOwn(candidate.repo_tree_oids, repo_id));
      const source = await trustedCall(() => this.resolveSource(repo_id));
      const before = await source.fetch(
        { schema_version: 1, repo_id, commit_oid: base.repositories[repo_id] },
        { blobs: 'none' },
      );
      const after = await this.materializer.open(candidate, repo_id);
      if (
        before.identity.repo_id !== repo_id ||
        before.identity.commit_oid !== base.repositories[repo_id] ||
        after.identity.repo_id !== repo_id ||
        after.identity.tree_oid !== candidate.repo_tree_oids[repo_id] ||
        after.identity.commit_oid !== candidate.materialization_record.repo_commit_oids[repo_id]
      )
        throw new V1Error('INTEGRITY_MISMATCH');
      if (!before.status().metadata_complete || !after.status().metadata_complete)
        throw new V1Error('INCOMPLETE_ANALYSIS');
      const left = before.listFiles(),
        right = after.listFiles();
      entries += left.length + right.length;
      if (entries > this.max_files) throw new V1Error('INCOMPLETE_ANALYSIS');
      const old = new Map(left.map((entry) => [entry.path, entry])),
        next = new Map(right.map((entry) => [entry.path, entry]));
      for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
        const a = old.get(path),
          b = next.get(path);
        if (a?.oid === b?.oid && a?.mode === b?.mode && a?.kind === b?.kind) continue;
        changes.push({ schema_version: 1, repo_id, path, before: a ?? null, after: b ?? null });
      }
    }
    const body = { schema_version: 1, changes };
    return freeze({ ...body, digest: await digestCanonical('reviewed-delta', body) });
  }
}

async function analyzed(input, base, candidate) {
  const report = copyJsonData(input);
  assertSchemaVersion(report);
  valid(Object.keys(report).length === 4 && Array.isArray(report.effects));
  if (report.base_revision_digest !== base.digest || report.candidate_digest !== candidate.digest)
    throw new V1Error('INTEGRITY_MISMATCH');
  const effects = [],
    keys = new Set();
  for (const entry of report.effects) {
    assertSchemaVersion(entry);
    valid(Object.keys(entry).length === 3 && Object.hasOwn(base.repositories, entry.repo_id));
    const set = await verifyEffectSet(entry.effect_set);
    const key = entry.repo_id + '/' + set.extractor_id;
    valid(!keys.has(key));
    keys.add(key);
    effects.push({ schema_version: 1, repo_id: entry.repo_id, effect_set: set });
  }
  effects.sort((a, b) =>
    order(a.repo_id + '/' + a.effect_set.extractor_id, b.repo_id + '/' + b.effect_set.extractor_id),
  );
  // Subject IDs differ after rematerialization. Compare normalized observations
  // separately from their immutable input bindings, retained in both reports.
  const material = effects.map(({ repo_id, effect_set }) => {
    const { future_revision_id, ...projection } = materialEffectProjection(effect_set);
    valid(future_revision_id);
    return { repo_id, effect_set: projection };
  });
  return freeze({
    ...report,
    effects,
    comparison_digest: await digestCanonical('reviewed-material-effect', {
      schema_version: 1,
      effects: material,
    }),
  });
}

export class ForwardPortPipeline {
  constructor({
    intersection,
    materializer,
    deltaReader,
    analyzeEffects,
    scheduler,
    policyEvaluator,
    predicateEvaluator,
  }) {
    valid(
      typeof intersection?.compare === 'function' &&
        typeof materializer?.materialize === 'function',
    );
    valid(typeof deltaReader?.read === 'function' && typeof analyzeEffects === 'function');
    valid(
      typeof scheduler?.evaluate === 'function' &&
        typeof policyEvaluator?.required_analysis === 'function',
    );
    valid(predicateEvaluator === undefined || typeof predicateEvaluator === 'function');
    Object.assign(this, {
      intersection,
      materializer,
      deltaReader,
      analyzeEffects,
      scheduler,
      required: policyEvaluator.required_analysis.bind(policyEvaluator),
      predicateEvaluator,
    });
  }

  async forward(input) {
    const request = freeze(copyJsonData(input));
    assertSchemaVersion(request);
    valid(Object.keys(request).length === 11);
    const decision = Decision(request.decision),
      review = ConditionalReview(request.review);
    const basis = await verifyDecisionBasis(decision.basis);
    if (!['REVIEWABLE', 'RESOLVABLE'].includes(decision.state)) throw new V1Error('CONFLICT');
    if (review.decision_id !== decision.id || review.basis.digest !== basis.digest)
      throw new V1Error('STALE_BASIS');
    await verifyDecisionBasis(review.basis);
    const candidate = await verifyCandidateContent(request.candidate),
      spec = await verifyCandidateSpec(request.candidate_spec);
    if (
      candidate.candidate_spec_id !== spec.id ||
      !basis.candidate_digests.includes(candidate.digest)
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    const previous = await materializationInputs(spec, request.previous_context);
    if (candidate.materialization_record.base_revision_digest !== previous.base_revision.digest)
      throw new V1Error('INTEGRITY_MISMATCH');
    for (const [repo, refs] of Object.entries(basis.canonical_ref_oids)) {
      if (
        !Object.hasOwn(previous.base_revision.repositories, repo) ||
        Object.values(refs).some((oid) => oid !== previous.base_revision.repositories[repo])
      )
        throw new V1Error('STALE_BASIS');
    }
    const nextBase = await baseRevision(request.next_context.base_revision);
    const requirements = evidenceRequirements(request.requirements);
    const stale = async (reason, details = {}) =>
      freeze({
        schema_version: 1,
        state: 'STALE',
        reason,
        decision: await markStale(decision),
        review,
        preserved: false,
        ...details,
      });
    if (basis.candidate_digests.length !== 1) return stale('GROUP_REQUIRES_REDISCOVERY');
    if (requirements.policy_digest !== basis.policy_digest) return stale('POLICY_CHANGED');
    if (previous.base_revision.id === nextBase.id) throw new V1Error('CONFLICT');
    const intersection = await trustedCall(() =>
      this.intersection.compare({
        schema_version: 1,
        proposed_effects: request.proposed_effects,
        intervening_effects: request.intervening_effects,
        targets: request.targets,
      }),
    );
    if (intersection.classification !== 'DISJOINT')
      return stale('POSSIBLE_INTERACTION', { intersection });
    const originalDelta = await this.deltaReader.read(previous.base_revision, candidate);
    if (originalDelta.digest !== review.reviewed_delta_digest)
      return stale('REVIEWED_DELTA_MISMATCH');
    const { id, ...body } = spec;
    valid(id);
    const nextSpec = await buildCandidateSpec({ ...body, base_revision: nextBase.id });
    const next = await materializationInputs(nextSpec, request.next_context);
    if (
      (await digestCanonical('forward-port-sources', {
        revisions: previous.revisions,
        bindings: previous.bindings,
      })) !==
      (await digestCanonical('forward-port-sources', {
        revisions: next.revisions,
        bindings: next.bindings,
      }))
    )
      return stale('SOURCE_INPUTS_CHANGED');
    let rematerialized;
    try {
      rematerialized = await this.materializer.materialize(nextSpec, request.next_context);
    } catch (error) {
      if (error instanceof V1Error && error.code === 'CONFLICT') return stale('TEXTUAL_CONFLICT');
      throw error;
    }
    const delta = await this.deltaReader.read(nextBase, rematerialized);
    if (delta.digest !== originalDelta.digest)
      return stale('REVIEWED_DELTA_CHANGED', { candidate: rematerialized });
    const [before, after] = await Promise.all([
      trustedCall(() => this.analyzeEffects(previous.base_revision, candidate)).then((report) =>
        analyzed(report, previous.base_revision, candidate),
      ),
      trustedCall(() => this.analyzeEffects(nextBase, rematerialized)).then((report) =>
        analyzed(report, nextBase, rematerialized),
      ),
    ]);
    if (
      before.comparison_digest !== after.comparison_digest ||
      [...before.effects, ...after.effects].some(
        ({ effect_set }) => effect_set.status !== 'COMPLETE',
      )
    )
      return stale('MATERIAL_EFFECTS_CHANGED', {
        candidate: rematerialized,
        analyses: [before, after],
      });
    for (const repo of Object.keys(nextBase.repositories)) {
      const capabilities = new Set(
        after.effects
          .filter((entry) => entry.repo_id === repo)
          .map(({ effect_set }) => effect_set.capability),
      );
      if (!capabilities.has('PATH') || !capabilities.has('SEMANTIC'))
        return stale('INCOMPLETE_ANALYSIS', { candidate: rematerialized });
    }
    for (const predicate of review.predicates) {
      if (
        !this.predicateEvaluator ||
        (await trustedCall(() =>
          this.predicateEvaluator(
            predicate,
            freeze({
              review,
              previous_candidate: candidate,
              candidate: rematerialized,
              previous_base: previous.base_revision,
              base: nextBase,
            }),
          ),
        )) !== true
      )
        return stale('PREDICATE_CHANGED', { candidate: rematerialized });
    }
    // Exact-state scheduling cannot reuse the old whole-state evidence merely
    // because the reviewed delta survived. Base-sensitive checks must run anew.
    const evaluation = await this.scheduler.evaluate(rematerialized, requirements);
    const subject = await candidateEvidenceSubject(rematerialized);
    if (
      evaluation.plan.subject_digest !== subject.digest ||
      evaluation.plan.policy_digest !== requirements.policy_digest
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    const evidenceDigests = [];
    for (const item of evaluation.evidence) {
      const verified = await verifyEvidence(item);
      if (verified.evidence.subject_digest !== subject.digest)
        throw new V1Error('INTEGRITY_MISMATCH');
      evidenceDigests.push(verified.digest);
    }
    const effects = after.effects.map(({ effect_set }) => effect_set);
    const required = copyJsonData(await trustedCall(() => this.required(subject, effects)));
    valid(
      Array.isArray(required) && required.every((name) => typeof name === 'string' && name.trim()),
    );
    const statuses = new Map(
      effects.map((set) => [set.future_revision_id + '/' + set.extractor_id, set.status]),
    );
    const refs = {};
    for (const [repo, entries] of Object.entries(basis.canonical_ref_oids)) {
      valid(Object.hasOwn(nextBase.repositories, repo));
      // One accepted OID per repository; the reviewed target ref is preserved.
      valid(Object.keys(entries).length === 1);
      refs[repo] = { [Object.keys(entries)[0]]: nextBase.repositories[repo] };
    }
    const nextBasis = await buildDecisionBasis({
      schema_version: 1,
      candidate_digests: [rematerialized.digest],
      evidence_digests: evidenceDigests,
      material_effect_digest: await digestCanonical('material-effect', {
        schema_version: 1,
        effect_sets: effects.map(materialEffectProjection),
      }),
      policy_digest: requirements.policy_digest,
      canonical_ref_oids: refs,
      required_analysis_status: Object.fromEntries(
        required.sort().map((name) => [name, statuses.get(name) ?? 'UNSUPPORTED']),
      ),
    });
    return freeze({
      schema_version: 1,
      state: 'REVIEW_PRESERVED',
      preserved: true,
      decision: Decision({ ...decision, state: 'REVIEWABLE', basis: nextBasis, resolution: null }),
      review,
      previous_basis_digest: basis.digest,
      candidate_spec: nextSpec,
      candidate: rematerialized,
      reviewed_delta: delta,
      analyses: [before, after],
      evaluation,
      intersection,
    });
  }
}
