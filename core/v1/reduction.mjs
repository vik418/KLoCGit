/** Exact implementation sharing never discards the histories that produced it. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import { CandidateSpec, FutureRevision, copyJsonData, gitOid } from './domain.mjs';
import { digestCanonical, encodeCanonical, normalizeDomain } from './encoding.mjs';

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

/** Bind a producer's immutable state to the repository it proposes changing. */
export function reductionBindings(input, revisions) {
  const bindings = copyJsonData(input);
  const ids = new Set(revisions.map(({ id }) => id));
  valid(Object.keys(bindings).length === ids.size);
  for (const revision of revisions) {
    const binding = bindings[revision.id];
    assertSchemaVersion(binding);
    valid(Object.keys(binding).length === 4);
    valid(typeof binding.repo_id === 'string' && binding.repo_id.trim());
    gitOid(binding.base_commit_oid, revision.commit_oid.length);
    gitOid(binding.base_tree_oid, revision.tree_oid.length);
  }
  return freeze(bindings);
}

export async function buildCandidateSpec(input) {
  const body = copyJsonData(input);
  valid(!Object.hasOwn(body, 'id'));
  const normalized = normalizeDomain('CandidateSpec', {
    ...body,
    id: 'klocgit:candidate-spec:v1:sha256:' + '0'.repeat(64),
  });
  const projection = { ...normalized };
  delete projection.id;
  return CandidateSpec({
    ...projection,
    id: objectId('candidate-spec', await digestCanonical('object-candidate-spec', projection)),
  });
}

export async function verifyCandidateSpec(input) {
  const spec = normalizeDomain('CandidateSpec', input);
  const { id, ...body } = spec;
  if (objectId('candidate-spec', await digestCanonical('object-candidate-spec', body)) !== id)
    throw new V1Error('INTEGRITY_MISMATCH');
  return spec;
}

/** Supersession is supplied by authoritative revision tracking, never timestamps. */
export function reduceExactImplementations(inputs, options) {
  const revisions = copyJsonData(inputs).map(FutureRevision);
  valid(new Set(revisions.map(({ id }) => id)).size === revisions.length);
  valid(new Set(revisions.map(({ system_id }) => system_id)).size <= 1);
  const request = copyJsonData(options);
  valid(Object.keys(request).length === 2 && Array.isArray(request.supersession));
  const bindings = reductionBindings(request.bindings, revisions);
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const successors = new Map();
  for (const edge of request.supersession) {
    assertSchemaVersion(edge);
    valid(Object.keys(edge).length === 3);
    const before = byId.get(edge.from_revision),
      after = byId.get(edge.to_revision);
    valid(before && after && before.id !== after.id && !successors.has(before.id));
    valid(before.repo_id === after.repo_id && before.ref === after.ref);
    valid(bindings[before.id].repo_id === bindings[after.id].repo_id);
    successors.set(before.id, after.id);
  }
  for (const id of successors.keys()) {
    const visited = new Set();
    let current = id;
    while (successors.has(current)) {
      valid(!visited.has(current));
      visited.add(current);
      current = successors.get(current);
    }
  }
  const groups = new Map();
  for (const revision of revisions) {
    if (successors.has(revision.id)) continue;
    const binding = bindings[revision.id];
    // Different baselines remain distinct composition plans even with equal output.
    const key = [
      ...encodeCanonical([
        binding.repo_id,
        binding.base_commit_oid,
        binding.base_tree_oid,
        revision.tree_oid,
      ]),
    ].join(',');
    if (!groups.has(key))
      groups.set(key, {
        repo_id: binding.repo_id,
        base_commit_oid: binding.base_commit_oid,
        base_tree_oid: binding.base_tree_oid,
        tree_oid: revision.tree_oid,
        future_revision_ids: [],
      });
    groups.get(key).future_revision_ids.push(revision.id);
  }
  const implementations = [...groups.values()]
    .map((group) => {
      const origins = group.future_revision_ids.sort();
      return { schema_version: 1, ...group, representative_revision_id: origins[0] };
    })
    .sort((left, right) =>
      left.representative_revision_id < right.representative_revision_id ? -1 : 1,
    );
  const superseded = [...successors.entries()]
    .map(([from_revision, to_revision]) => ({
      schema_version: 1,
      from_revision,
      to_revision,
    }))
    .sort((left, right) => (left.from_revision < right.from_revision ? -1 : 1));
  return freeze({ schema_version: 1, implementations, superseded });
}

/** Materialization selections reference exact Git inputs, rather than copied patches. */
export function wholeFutureSelection(revisionInput, bindingInput) {
  const revision = FutureRevision(revisionInput);
  const binding = reductionBindings({ [revision.id]: bindingInput }, [revision])[revision.id];
  return freeze({
    schema_version: 1,
    kind: 'future',
    future_revision_id: revision.id,
    source_repo_id: revision.repo_id,
    target_repo_id: binding.repo_id,
    base_commit_oid: binding.base_commit_oid,
    head_commit_oid: revision.commit_oid,
    tree_oid: revision.tree_oid,
  });
}
