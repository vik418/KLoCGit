/** Measurements can select an implementation only within proven equal Git states. */
import { V1Error, assertSchemaVersion, parseDigest } from './conventions.mjs';
import { copyJsonData, FutureRevision } from './domain.mjs';
import { encodeCanonical } from './encoding.mjs';
import { reductionBindings, verifyCandidateSpec } from './reduction.mjs';

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

function stateKey(spec, revisions, bindings) {
  const targets = new Set();
  const states = [];
  if (!spec.selections.length) return null;
  for (const selection of spec.selections) {
    const revision = revisions.get(selection.future_revision_id);
    if (selection.kind !== 'future' || !revision || targets.has(selection.target_repo_id))
      return null;
    const binding = bindings[revision.id];
    if (
      selection.source_repo_id !== revision.repo_id ||
      selection.head_commit_oid !== revision.commit_oid ||
      selection.tree_oid !== revision.tree_oid ||
      selection.target_repo_id !== binding.repo_id ||
      selection.base_commit_oid !== binding.base_commit_oid
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    targets.add(binding.repo_id);
    states.push([
      binding.repo_id,
      binding.base_commit_oid,
      binding.base_tree_oid,
      revision.tree_oid,
    ]);
  }
  states.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  return [...encodeCanonical([spec.base_revision, states, spec.required_dependencies])].join(',');
}

export async function pruneDeterministicDominance(inputs, context, options) {
  const source = copyJsonData(context);
  const settings = freeze(
    copyJsonData({
      dimensions: options.dimensions,
      measurements: options.measurements,
      max_comparisons: options.max_comparisons,
    }),
  );
  valid(Number.isSafeInteger(settings.max_comparisons) && settings.max_comparisons >= 0);
  const verifyMeasurement = options.verifyMeasurement;
  valid(typeof verifyMeasurement === 'function');
  const specs = await Promise.all(copyJsonData(inputs).map(verifyCandidateSpec));
  valid(new Set(specs.map(({ id }) => id)).size === specs.length);
  const revisions = source.revisions.map(FutureRevision);
  const bindings = reductionBindings(source.bindings, revisions);
  const byRevision = new Map(revisions.map((revision) => [revision.id, revision]));
  valid(Array.isArray(settings.dimensions) && Array.isArray(settings.measurements));
  const names = new Set();
  for (const dimension of settings.dimensions) {
    assertSchemaVersion(dimension);
    valid(
      Object.keys(dimension).length === 3 &&
        typeof dimension.name === 'string' &&
        dimension.name.trim(),
    );
    valid(['MINIMIZE', 'MAXIMIZE'].includes(dimension.direction) && !names.has(dimension.name));
    names.add(dimension.name);
  }
  const bySpec = new Map(specs.map((spec) => [spec.id, spec]));
  const measurements = new Map();
  const measurementRecords = new Map();
  for (const measurement of settings.measurements) {
    assertSchemaVersion(measurement);
    valid(Object.keys(measurement).length === 4 && bySpec.has(measurement.candidate_spec_id));
    valid(!measurements.has(measurement.candidate_spec_id));
    valid(!measurementRecords.has(measurement.candidate_spec_id));
    measurementRecords.set(measurement.candidate_spec_id, measurement);
    parseDigest(measurement.evidence_digest, 'object-evidence');
    const values = measurement.dimensions;
    valid(values && typeof values === 'object' && !Array.isArray(values));
    const deterministic =
      settings.dimensions.length > 0 &&
      settings.dimensions.every(({ name }) => {
        const item = values[name];
        return (
          item &&
          ['OBSERVED', 'DETERMINISTIC'].includes(item.basis) &&
          Number.isFinite(item.value) &&
          typeof item.value === 'number'
        );
      });
    if (
      deterministic &&
      (await verifyMeasurement(measurement, bySpec.get(measurement.candidate_spec_id))) === true
    )
      measurements.set(measurement.candidate_spec_id, values);
  }
  const groups = new Map(),
    retained = new Set(specs.map(({ id }) => id)),
    dominated = [];
  for (const spec of specs) {
    const key = stateKey(spec, byRevision, bindings);
    if (key !== null) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(spec.id);
    }
  }
  let comparisons = 0,
    budgetExhausted = false;
  const better = (left, right) => {
    if (comparisons >= settings.max_comparisons) return false;
    comparisons += 1;
    const before = measurements.get(left),
      after = measurements.get(right);
    if (!before || !after) return false;
    let strict = false;
    for (const { name, direction } of settings.dimensions) {
      const difference =
        (before[name].value - after[name].value) * (direction === 'MINIMIZE' ? 1 : -1);
      if (difference > 0) return false;
      strict ||= difference < 0;
    }
    return strict;
  };
  // Exact-state groups may be large. A hard comparison budget bounds the
  // conservative frontier; unexamined plans remain available, never pruned.
  for (const group of groups.values()) {
    const frontier = [];
    for (const [index, id] of group.sort().entries()) {
      if (index > 0 && comparisons >= settings.max_comparisons) budgetExhausted = true;
      let winner = null;
      for (const other of frontier) {
        if (comparisons >= settings.max_comparisons) break;
        if (better(other, id)) {
          winner = other;
          break;
        }
      }
      if (winner) {
        retained.delete(id);
        dominated.push({
          schema_version: 1,
          candidate_spec_id: id,
          preferred_spec_id: winner,
          evidence_digests: [
            measurementRecords.get(id).evidence_digest,
            measurementRecords.get(winner).evidence_digest,
          ].sort(),
        });
        continue;
      }
      // Keep earlier members even if this one dominates them. This avoids
      // rewriting already recorded winners and remains a conservative reduction.
      if (comparisons < settings.max_comparisons) frontier.push(id);
    }
  }
  return freeze({
    schema_version: 1,
    candidate_specs: specs.filter(({ id }) => retained.has(id)),
    dominated,
    comparisons,
    budget_exhausted: budgetExhausted,
  });
}
