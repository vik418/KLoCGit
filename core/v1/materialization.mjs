/** Immutable composition inputs. Local paths and hydration metrics are not identity. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import { Candidate, FutureRevision, copyJsonData, gitOid } from './domain.mjs';
import { digestCanonical, encodeCanonical, normalizeDomain } from './encoding.mjs';
import { gitSnapshot } from './git-store.mjs';
import { reductionBindings, verifyCandidateSpec, wholeFutureSelection } from './reduction.mjs';

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

/** A merge commit needs an explicit mainline; a root commit has no parent. */
export function commitSelection(revisionInput, bindingInput, snapshotInput, parent_commit_oid) {
  const revision = FutureRevision(revisionInput);
  const binding = reductionBindings({ [revision.id]: bindingInput }, [revision])[revision.id];
  const snapshot = gitSnapshot(snapshotInput);
  valid(snapshot.repo_id === revision.repo_id);
  if (snapshot.parent_oids.length === 0) valid(parent_commit_oid === null);
  else valid(snapshot.parent_oids.includes(parent_commit_oid));
  return freeze({
    schema_version: 1,
    kind: 'commit',
    future_revision_id: revision.id,
    source_repo_id: revision.repo_id,
    target_repo_id: binding.repo_id,
    commit_oid: snapshot.commit_oid,
    parent_commit_oid,
    tree_oid: snapshot.tree_oid,
  });
}

export async function materializationInputs(specInput, contextInput) {
  // Snapshot both arguments before the first await.
  const specData = copyJsonData(specInput);
  const context = copyJsonData(contextInput);
  assertSchemaVersion(context);
  valid(Object.keys(context).length === 5);
  valid(Array.isArray(context.revisions));
  const revisions = context.revisions.map(FutureRevision);
  valid(new Set(revisions.map(({ id }) => id)).size === revisions.length);
  valid(new Set(revisions.map(({ system_id }) => system_id)).size <= 1);
  const bindings = reductionBindings(context.bindings, revisions);
  const base = normalizeDomain('SystemRevision', context.base_revision);
  const { id: baseId, digest: baseDigest, ...baseBody } = base;
  if (
    (await digestCanonical('object-system-revision', baseBody)) !== baseDigest ||
    objectId('system-revision', baseDigest) !== baseId
  )
    throw new V1Error('INTEGRITY_MISMATCH');
  const spec = await verifyCandidateSpec(specData);
  if (spec.base_revision !== base.id) throw new V1Error('STALE_BASIS');
  const identity = context.commit_identity;
  assertSchemaVersion(identity);
  valid(Object.keys(identity).length === 4);
  for (const key of ['name', 'email'])
    valid(
      typeof identity[key] === 'string' &&
        identity[key].trim() &&
        !/[\x00-\x1f\x7f<>]/.test(identity[key]),
    );
  valid(Number.isSafeInteger(identity.timestamp) && identity.timestamp >= 0);
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const selected = new Set(spec.selected_future_revisions);
  valid(spec.selections.length > 0 && selected.size > 0);
  const whole = new Set();
  const represented = new Set();
  const selections = new Set();
  for (const selection of spec.selections) {
    const key = Array.from(encodeCanonical(selection)).join(',');
    valid(!selections.has(key));
    selections.add(key);
    assertSchemaVersion(selection);
    const revision = byId.get(selection.future_revision_id);
    valid(revision && selected.has(revision.id));
    const binding = bindings[revision.id];
    valid(Object.hasOwn(base.repositories, binding.repo_id));
    gitOid(base.repositories[binding.repo_id], revision.commit_oid.length);
    if (selection.kind === 'future') {
      const expected = wholeFutureSelection(revision, binding);
      valid(Object.keys(selection).length === Object.keys(expected).length);
      if (Object.entries(expected).some(([key, value]) => selection[key] !== value))
        throw new V1Error('INTEGRITY_MISMATCH');
      whole.add(revision.id);
    } else {
      valid(selection.kind === 'commit' && Object.keys(selection).length === 8);
      valid(
        selection.source_repo_id === revision.repo_id &&
          selection.target_repo_id === binding.repo_id,
      );
      gitOid(selection.commit_oid, revision.commit_oid.length);
      gitOid(selection.tree_oid, revision.tree_oid.length);
      if (selection.parent_commit_oid !== null)
        gitOid(selection.parent_commit_oid, revision.commit_oid.length);
    }
    represented.add(revision.id);
  }
  // Exact implementation sharing may retain several origins for one selection.
  for (const id of selected) {
    const revision = byId.get(id);
    valid(revision);
    if (represented.has(id)) continue;
    const binding = bindings[id];
    const equivalent = [...whole].some((otherId) => {
      const other = byId.get(otherId),
        otherBinding = bindings[otherId];
      return (
        other.tree_oid === revision.tree_oid &&
        otherBinding.repo_id === binding.repo_id &&
        otherBinding.base_commit_oid === binding.base_commit_oid &&
        otherBinding.base_tree_oid === binding.base_tree_oid
      );
    });
    valid(equivalent);
    whole.add(id);
  }
  // A cherry-picked piece cannot claim to have satisfied a whole revision dependency.
  if (spec.required_dependencies.some((id) => !whole.has(id)))
    throw new V1Error('INCOMPLETE_ANALYSIS');
  return freeze({ spec, base_revision: base, revisions, bindings, commit_identity: identity });
}

export async function materializedCandidate(
  candidate_spec_id,
  repo_tree_oids,
  materialization_record,
) {
  const body = copyJsonData({
    schema_version: 1,
    candidate_spec_id,
    repo_tree_oids,
    materialization_record,
  });
  const digest = await digestCanonical('object-candidate', body);
  return Candidate({ ...body, id: objectId('candidate', digest), digest });
}
