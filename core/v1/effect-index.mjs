/** Shared effects are hyperedges: dense workloads need not expand into pairs. */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
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

async function records(inputs, targetRepos) {
  const effects = await Promise.all(copyJsonData(inputs).map(verifyEffectSet));
  const targets = copyJsonData(targetRepos);
  const identities = new Set();
  for (const record of effects) {
    valid(
      typeof targets[record.future_revision_id] === 'string' &&
        targets[record.future_revision_id].trim(),
    );
    const identity = JSON.stringify([record.future_revision_id, record.extractor_id]);
    valid(!identities.has(identity));
    identities.add(identity);
  }
  return { effects, targets };
}

/** Even inferred security hints bypass heuristics; they do not authorize actions. */
export async function securityOverride(inputs) {
  const effects = await Promise.all(copyJsonData(inputs).map(verifyEffectSet));
  return freeze({
    schema_version: 1,
    protected_revision_ids: [
      ...new Set(
        effects
          .filter((record) => record.security_effects.length)
          .map((record) => record.future_revision_id),
      ),
    ].sort(),
  });
}

export async function indexEffects(inputs, targetRepos, options) {
  const settings = copyJsonData(options);
  assertSchemaVersion(settings);
  valid(
    Object.keys(settings).length === 2 &&
      Number.isSafeInteger(settings.hub_min_degree) &&
      settings.hub_min_degree >= 2,
  );
  const { effects, targets } = await records(inputs, targetRepos);
  const index = new Map();
  const incomplete = new Set();
  for (const record of effects) {
    if (record.status !== 'COMPLETE') incomplete.add(record.future_revision_id);
    const append = (effect, security) => {
      const repo = targets[record.future_revision_id];
      const key = JSON.stringify([repo, effect.target]);
      if (!index.has(key))
        index.set(key, {
          repo_id: repo,
          target: effect.target,
          members: new Set(),
          security_sensitive: false,
          kinds: new Set(),
        });
      const item = index.get(key);
      item.members.add(record.future_revision_id);
      item.kinds.add(effect.kind);
      item.security_sensitive ||= security;
    };
    record.effects.forEach((effect) => append(effect, false));
    record.security_effects.forEach((effect) => append(effect, true));
  }
  const interactions = [],
    suppressed = [];
  let memberships = 0,
    comparisonsAvoided = 0;
  for (const key of [...index.keys()].sort()) {
    const entry = index.get(key);
    memberships += entry.members.size;
    if (entry.members.size < 2) continue;
    const edge = {
      schema_version: 1,
      repo_id: entry.repo_id,
      target: entry.target,
      member_revision_ids: [...entry.members].sort(),
      security_sensitive: entry.security_sensitive,
      effect_kinds: [...entry.kinds].sort(),
    };
    comparisonsAvoided += (entry.members.size * (entry.members.size - 1)) / 2;
    if (!entry.security_sensitive && entry.members.size >= settings.hub_min_degree)
      suppressed.push({ ...edge, reason: 'non-critical-hub' });
    else interactions.push(edge);
  }
  return freeze({
    schema_version: 1,
    interactions,
    suppressed,
    incomplete_revision_ids: [...incomplete].sort(),
    metrics: {
      effect_targets: index.size,
      memberships,
      pairwise_expansions: 0,
      pairwise_comparisons_avoided: comparisonsAvoided,
    },
  });
}
