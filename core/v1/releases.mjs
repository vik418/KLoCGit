/** Deterministic accepted-state and external-CD contracts. No Git or deployment writes. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import { SystemRevision, ReleaseConstraints, copyJsonData } from './domain.mjs';
import { digestCanonical, normalizeDomain } from './encoding.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

/** Callers supply authoritative accepted OIDs, not branch names or cache contents. */
export async function buildSystemRevision(input) {
  const body = copyJsonData(input);
  assertSchemaVersion(body);
  valid(Object.keys(body).length === 4 && Array.isArray(body.accepted_decisions));
  valid(new Set(body.accepted_decisions).size === body.accepted_decisions.length);
  body.accepted_decisions.sort();
  const digest = await digestCanonical('object-system-revision', body);
  return normalizeDomain('SystemRevision', {
    ...body,
    digest,
    id: objectId('system-revision', digest),
  });
}

export async function verifySystemRevision(input) {
  const record = SystemRevision(input);
  const { id, digest, ...body } = record;
  if (
    (await digestCanonical('object-system-revision', body)) !== digest ||
    objectId('system-revision', digest) !== id
  )
    throw new V1Error('INTEGRITY_MISMATCH');
  return record;
}

/** Constraint sequences stay ordered; adapters must reject unsupported semantics. */
export async function buildReleaseConstraints(input) {
  const body = copyJsonData(input);
  assertSchemaVersion(body);
  valid(Object.keys(body).length === 7 && !Object.hasOwn(body, 'digest'));
  const digest = await digestCanonical('release-constraints', body);
  return ReleaseConstraints({ ...body, digest });
}

export async function verifyReleaseConstraints(input, revisionInput) {
  const record = ReleaseConstraints(input);
  const { digest, ...body } = record;
  if ((await digestCanonical('release-constraints', body)) !== digest)
    throw new V1Error('INTEGRITY_MISMATCH');
  const revision = await verifySystemRevision(revisionInput);
  if (record.system_revision_digest !== revision.digest) throw new V1Error('INTEGRITY_MISMATCH');
  return record;
}
