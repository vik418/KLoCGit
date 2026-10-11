/** Conservative static intersection. DISJOINT is bounded by the declared analysis scope. */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { encodeCanonical } from './encoding.mjs';
import { verifyEffectSet } from './extractors.mjs';

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

function same(left, right) {
  const a = encodeCanonical(left),
    b = encodeCanonical(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

const key = (set) => set.future_revision_id + '/' + set.extractor_id;
const ordered = (values) => [...new Set(values)].sort();

export class ConservativeIntersection {
  constructor({ policyEvaluator, max_effect_sets, max_targets }) {
    valid(typeof policyEvaluator?.required_analysis === 'function');
    valid(
      [max_effect_sets, max_targets].every((value) => Number.isSafeInteger(value) && value > 0),
    );
    this.required = policyEvaluator.required_analysis.bind(policyEvaluator);
    this.max_effect_sets = max_effect_sets;
    this.max_targets = max_targets;
  }

  async compare(input) {
    const request = freeze(copyJsonData(input));
    assertSchemaVersion(request);
    valid(
      Object.keys(request).length === 4 &&
        Array.isArray(request.proposed_effects) &&
        Array.isArray(request.intervening_effects),
    );
    valid(
      request.targets && typeof request.targets === 'object' && !Array.isArray(request.targets),
    );
    const raw = [...request.proposed_effects, ...request.intervening_effects];
    if (raw.length > this.max_effect_sets) throw new V1Error('INCOMPLETE_ANALYSIS');
    const checked = await Promise.all(raw.map(verifyEffectSet));
    const left = checked.slice(0, request.proposed_effects.length),
      right = checked.slice(request.proposed_effects.length);
    const reasons = new Set(),
      shared = new Set();
    if (!left.length || !right.length) reasons.add('MISSING_ANALYSIS');
    const revisionCapabilities = new Map(),
      byKey = new Map();
    for (const record of checked) {
      valid(
        typeof request.targets[record.future_revision_id] === 'string' &&
          request.targets[record.future_revision_id].trim(),
      );
      const previous = byKey.get(key(record));
      if (previous && previous.digest !== record.digest) throw new V1Error('INTEGRITY_MISMATCH');
      byKey.set(key(record), record);
      if (record.status !== 'COMPLETE') reasons.add('INCOMPLETE_ANALYSIS');
      if (!revisionCapabilities.has(record.future_revision_id))
        revisionCapabilities.set(record.future_revision_id, new Set());
      revisionCapabilities.get(record.future_revision_id).add(record.capability);
    }
    // Path separation alone cannot establish semantic independence. A plugin's
    // COMPLETE status still describes only its published static analysis scope.
    for (const capabilities of revisionCapabilities.values()) {
      if (!capabilities.has('PATH') || !capabilities.has('SEMANTIC'))
        reasons.add('MISSING_CAPABILITY');
    }
    let required;
    try {
      required = copyJsonData(
        await this.required(
          freeze({
            schema_version: 1,
            future_revision_ids: ordered(checked.map((set) => set.future_revision_id)),
          }),
          freeze(checked),
        ),
      );
    } catch (error) {
      if (error instanceof V1Error) throw error;
      throw new V1Error('PROVIDER_UNAVAILABLE');
    }
    valid(
      Array.isArray(required) && required.every((name) => typeof name === 'string' && name.trim()),
    );
    if (required.some((name) => byKey.get(name)?.status !== 'COMPLETE'))
      reasons.add('REQUIRED_ANALYSIS_INCOMPLETE');
    const repositories = ordered(checked.map((set) => request.targets[set.future_revision_id]));
    // Extractor references are repo-local. Cross-repository absence requires a
    // complete contract/dependency observation, which this interface does not supply.
    if (repositories.length > 1) reasons.add('CROSS_REPOSITORY_UNCERTAINTY');
    let count = 0;
    const footprint = (sets) => {
      const result = new Set();
      for (const record of sets) {
        if (record.security_effects.length) reasons.add('SECURITY_SENSITIVE_CHANGE');
        for (const effect of [...record.effects, ...record.security_effects]) {
          if (++count > this.max_targets) {
            reasons.add('BUDGET_EXHAUSTED');
            return result;
          }
          if (effect.operation === 'observed' && effect.kind === 'semantic-scope') {
            if (!same(effect.attributes.before, effect.attributes.after))
              reasons.add('ANALYSIS_SCOPE_CHANGED');
            continue;
          }
          if (effect.attributes.basis !== 'OBSERVED' || effect.operation === 'unavailable')
            reasons.add('UNCERTAIN_EFFECT');
          const repo = request.targets[record.future_revision_id];
          result.add(JSON.stringify([repo, effect.target]));
          for (const reference of effect.references) {
            if (++count > this.max_targets) {
              reasons.add('BUDGET_EXHAUSTED');
              break;
            }
            result.add(JSON.stringify([repo, reference]));
          }
        }
      }
      return result;
    };
    const leftTargets = footprint(left),
      rightTargets = footprint(right);
    for (const target of leftTargets) if (rightTargets.has(target)) shared.add(target);
    if (shared.size) reasons.add('SHARED_EFFECT_OR_REFERENCE');
    return freeze({
      schema_version: 1,
      classification: reasons.size ? 'POSSIBLE_INTERACTION' : 'DISJOINT',
      basis: 'OBSERVED',
      scope: 'complete-registered-static-extractor-footprints',
      reasons: [...reasons].sort(),
      shared_targets: [...shared].sort().map((target) => {
        const [repo_id, target_id] = JSON.parse(target);
        return { schema_version: 1, repo_id, target: target_id };
      }),
      effect_digests: ordered(checked.map(({ digest }) => digest)),
      claims: [
        'This compares the supplied static effects and references. It does not establish runtime compatibility.',
      ],
    });
  }
}
