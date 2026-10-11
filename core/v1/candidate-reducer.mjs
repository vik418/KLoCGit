/** Bound evaluation work without treating deferred implementations as rejected. */
import { V1Error, assertSchemaVersion, parseDigest, parseObjectId } from './conventions.mjs';
import { copyJsonData, FutureRevision } from './domain.mjs';
import { digestCanonical, materialEffectProjection } from './encoding.mjs';
import { indexEffects, securityOverride } from './effect-index.mjs';
import { verifyEffectSet } from './extractors.mjs';
import {
  buildCandidateSpec,
  reduceExactImplementations,
  reductionBindings,
  wholeFutureSelection,
} from './reduction.mjs';

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

function checkedRecord(value, fields) {
  assertSchemaVersion(value);
  valid(
    Object.keys(value).length === fields.length + 1 &&
      fields.every((field) => Object.hasOwn(value, field)),
  );
}

/** Security work goes first; round-robin targets prevent a busy repo monopolizing a batch. */
function schedule(groups, protectedIds) {
  const ordered = [];
  for (const protectedWork of [true, false]) {
    const repos = new Map();
    for (const group of groups) {
      if (group.future_revision_ids.some((id) => protectedIds.has(id)) !== protectedWork) continue;
      if (!repos.has(group.repo_id)) repos.set(group.repo_id, []);
      repos.get(group.repo_id).push(group);
    }
    let queues = [...repos.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([, queue]) => queue);
    for (let offset = 0; queues.length; offset += 1) {
      for (const queue of queues) {
        ordered.push(queue[offset]);
      }
      queues = queues.filter((queue) => offset + 1 < queue.length);
    }
  }
  return ordered;
}

export class CandidateReducer {
  constructor({ verifyRejection }) {
    valid(typeof verifyRejection === 'function');
    this.verifyRejection = verifyRejection;
    Object.freeze(this);
  }

  async reduce(revisionInputs, effectInputs, policyInput, budgetInput) {
    const revisions = copyJsonData(revisionInputs).map(FutureRevision);
    const policy = freeze(copyJsonData(policyInput));
    const budget = freeze(copyJsonData(budgetInput));
    const copiedEffects = copyJsonData(effectInputs);
    checkedRecord(policy, [
      'base_revision',
      'bindings',
      'supersession',
      'dependencies',
      'rejections',
      'completed_revision_ids',
      'hub_min_degree',
    ]);
    checkedRecord(budget, [
      'max_candidate_specs',
      'max_selections_per_spec',
      'max_dependency_visits',
    ]);
    for (const field of Object.keys(budget).filter((key) => key !== 'schema_version'))
      valid(Number.isSafeInteger(budget[field]) && budget[field] > 0);
    parseObjectId(policy.base_revision, 'system-revision');
    const byId = new Map(revisions.map((revision) => [revision.id, revision]));
    valid(
      byId.size === revisions.length &&
        new Set(revisions.map(({ system_id }) => system_id)).size <= 1,
    );
    const bindings = reductionBindings(policy.bindings, revisions);
    valid(
      [
        policy.supersession,
        policy.dependencies,
        policy.rejections,
        policy.completed_revision_ids,
      ].every(Array.isArray),
    );
    valid(policy.completed_revision_ids.every((id) => byId.has(id)));
    const completed = new Set(policy.completed_revision_ids);
    const effects = await Promise.all(copiedEffects.map(verifyEffectSet));
    valid(effects.every(({ future_revision_id }) => byId.has(future_revision_id)));
    const targets = Object.fromEntries(revisions.map(({ id }) => [id, bindings[id].repo_id]));
    const index = await indexEffects(effects, targets, {
      schema_version: 1,
      hub_min_degree: policy.hub_min_degree,
    });
    const security = await securityOverride(effects);
    const protectedIds = new Set(security.protected_revision_ids);
    const rejected = [],
      unverified = [],
      rejectedIds = new Set();
    const rejectionKeys = new Set();
    for (const rejection of policy.rejections) {
      checkedRecord(rejection, [
        'future_revision_id',
        'kind',
        'basis',
        'check_ref',
        'evidence_digest',
      ]);
      valid(byId.has(rejection.future_revision_id));
      valid(['checkable', 'advisory'].includes(rejection.kind));
      valid(
        ['DECLARED', 'OBSERVED', 'RETRIEVED', 'INFERRED', 'DETERMINISTIC'].includes(
          rejection.basis,
        ),
      );
      valid(typeof rejection.check_ref === 'string' && rejection.check_ref.trim());
      parseDigest(rejection.evidence_digest, 'object-evidence');
      const key = JSON.stringify([
        rejection.future_revision_id,
        rejection.check_ref,
        rejection.evidence_digest,
      ]);
      valid(!rejectionKeys.has(key));
      rejectionKeys.add(key);
      if (
        rejection.kind === 'checkable' &&
        rejection.basis === 'DETERMINISTIC' &&
        (await this.verifyRejection(rejection, byId.get(rejection.future_revision_id))) === true
      ) {
        rejectedIds.add(rejection.future_revision_id);
        rejected.push(rejection);
      } else unverified.push(rejection);
    }
    // Verify supersession against all observations, including rejected revisions.
    const original = reduceExactImplementations(revisions, {
      bindings,
      supersession: policy.supersession,
    });
    const superseded = new Set(original.superseded.map(({ from_revision }) => from_revision));
    const eligible = revisions.filter(({ id }) => !rejectedIds.has(id) && !superseded.has(id));
    const reduced = reduceExactImplementations(eligible, {
      bindings: Object.fromEntries(eligible.map(({ id }) => [id, bindings[id]])),
      supersession: [],
    });
    const groupsById = new Map();
    for (const group of reduced.implementations)
      for (const id of group.future_revision_ids) groupsById.set(id, group);
    const dependencies = new Map();
    const edgeIds = new Set();
    for (const edge of policy.dependencies) {
      checkedRecord(edge, ['from_revision', 'to_revision']);
      valid(byId.has(edge.from_revision) && edge.from_revision !== edge.to_revision);
      parseObjectId(edge.to_revision, 'future-revision');
      const key = JSON.stringify([edge.from_revision, edge.to_revision]);
      valid(!edgeIds.has(key));
      edgeIds.add(key);
      if (!dependencies.has(edge.from_revision)) dependencies.set(edge.from_revision, []);
      dependencies.get(edge.from_revision).push(edge.to_revision);
    }
    for (const list of dependencies.values()) list.sort();
    const effectsById = new Map();
    for (const effect of effects) {
      if (!effectsById.has(effect.future_revision_id))
        effectsById.set(effect.future_revision_id, []);
      effectsById.get(effect.future_revision_id).push(effect);
    }
    let visits = 0;
    const closure = (root) => {
      const selected = [],
        required = new Set(),
        seen = new Set(),
        visiting = new Set();
      const stack = [{ group: root, leaving: false }];
      while (stack.length) {
        const entry = stack.pop(),
          id = entry.group.representative_revision_id;
        if (entry.leaving) {
          visiting.delete(id);
          seen.add(id);
          selected.push(entry.group);
          continue;
        }
        if (seen.has(id)) continue;
        if (visiting.has(id)) return { reason: 'DEPENDENCY_CYCLE' };
        if (visits >= budget.max_dependency_visits) return { reason: 'DEPENDENCY_BUDGET' };
        visits += 1;
        visiting.add(id);
        if (visiting.size + seen.size > budget.max_selections_per_spec)
          return { reason: 'SELECTION_BUDGET' };
        stack.push({ group: entry.group, leaving: true });
        const pending = new Map();
        for (const origin of entry.group.future_revision_ids) {
          for (const dependency of dependencies.get(origin) || []) {
            const group = groupsById.get(dependency);
            if (!group)
              return {
                reason: superseded.has(dependency)
                  ? 'STALE_DEPENDENCY'
                  : rejectedIds.has(dependency)
                    ? 'REJECTED_DEPENDENCY'
                    : 'MISSING_DEPENDENCY',
              };
            if (group === entry.group) continue;
            required.add(dependency);
            pending.set(group.representative_revision_id, group);
          }
        }
        for (const group of [...pending.values()].sort((left, right) =>
          left.representative_revision_id < right.representative_revision_id ? 1 : -1,
        ))
          stack.push({ group, leaving: false });
      }
      return { selected, required: [...required].sort() };
    };
    const candidateSpecs = [],
      frontier = [];
    for (const group of schedule(reduced.implementations, protectedIds)) {
      const record = {
        ...group,
        security_sensitive: group.future_revision_ids.some((id) => protectedIds.has(id)),
      };
      if (group.future_revision_ids.every((id) => completed.has(id))) {
        frontier.push({ ...record, status: 'EVALUATED' });
        continue;
      }
      if (candidateSpecs.length >= budget.max_candidate_specs) {
        frontier.push({ ...record, status: 'DEFERRED', reason: 'CANDIDATE_BUDGET' });
        continue;
      }
      const plan = closure(group);
      if (plan.reason) {
        frontier.push({ ...record, status: 'DEFERRED', reason: plan.reason });
        continue;
      }
      const origins = plan.selected
        .flatMap(({ future_revision_ids }) => future_revision_ids)
        .sort();
      const selectedEffects = origins
        .flatMap((id) => effectsById.get(id) || [])
        .sort((left, right) =>
          left.future_revision_id < right.future_revision_id
            ? -1
            : left.future_revision_id > right.future_revision_id
              ? 1
              : left.extractor_id < right.extractor_id
                ? -1
                : 1,
        );
      const spec = await buildCandidateSpec({
        schema_version: 1,
        base_revision: policy.base_revision,
        selected_future_revisions: origins,
        selections: plan.selected.map(({ representative_revision_id: id }) =>
          wholeFutureSelection(byId.get(id), bindings[id]),
        ),
        required_dependencies: plan.required,
        effect_summary_digest: await digestCanonical('effect-summary', {
          schema_version: 1,
          effects: selectedEffects.map(materialEffectProjection),
        }),
        creation_reason: 'Observed implementation with its declared dependencies',
      });
      candidateSpecs.push(spec);
      frontier.push({ ...record, status: 'SCHEDULED', candidate_spec_id: spec.id });
    }
    const unknownAnalysis = revisions.filter(({ id }) => !effectsById.has(id)).map(({ id }) => id);
    return freeze({
      schema_version: 1,
      candidate_specs: candidateSpecs,
      implementation_frontier: frontier,
      rejected,
      unverified_rejections: unverified,
      superseded: original.superseded,
      effect_index: index,
      incomplete_revision_ids: [
        ...new Set([...index.incomplete_revision_ids, ...unknownAnalysis]),
      ].sort(),
      complete: frontier.every(({ status }) => status !== 'DEFERRED'),
      metrics: {
        raw_revisions: revisions.length,
        exact_implementations: reduced.implementations.length,
        candidate_specs: candidateSpecs.length,
        dependency_visits: visits,
        deferred_implementations: frontier.filter(({ status }) => status === 'DEFERRED').length,
      },
    });
  }
}
