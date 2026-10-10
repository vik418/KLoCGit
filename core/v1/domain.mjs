/**
 * Persisted v1 domain records. These constructors validate representation and
 * snapshot consistency; they do not authenticate claims or authorize actions.
 */
import { V1Error, assertSchemaVersion, parseDigest, parseObjectId } from './conventions.mjs';

export const ANALYSIS_CAPABILITIES = Object.freeze(['PATH', 'STRUCTURAL', 'SEMANTIC']);
export const ANALYSIS_STATUSES = Object.freeze(['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED']);
export const DECISION_STATES = Object.freeze([
  'DISCOVERED',
  'REVIEWABLE',
  'RESOLVABLE',
  'RESOLVED',
  'STALE',
]);
export const RETENTION_CLASSES = Object.freeze([
  'EPHEMERAL',
  'REBUILDABLE',
  'DECISION_RECORD',
  'CANONICAL',
]);
export const DEPLOYMENT_STATUSES = Object.freeze([
  'SUBMITTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
]);

function assertValid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function text(value) {
  assertValid(typeof value === 'string' && value.trim().length > 0);
  return value;
}

function member(value, choices) {
  assertValid(choices.includes(value));
  return value;
}

function array(value) {
  assertValid(Array.isArray(value));
  return value;
}

function plain(value) {
  assertValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      assertValid(next >= 0xdc00 && next <= 0xdfff);
      index += 1;
    } else {
      assertValid(unit < 0xdc00 || unit > 0xdfff);
    }
  }
  return value;
}

/**
 * Read data descriptors rather than invoking getters. Copy every value so a
 * producer cannot change an accepted snapshot by retaining a mutable reference.
 */
export function copyJsonData(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return wellFormed(value);
  if (typeof value === 'number') {
    assertValid(Number.isFinite(value) && !Object.is(value, -0));
    assertValid(!Number.isInteger(value) || Number.isSafeInteger(value));
    return value;
  }
  assertValid(value !== undefined && typeof value === 'object');
  assertValid(!ancestors.has(value));
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  assertValid(
    isArray ? prototype === Array.prototype : prototype === Object.prototype || prototype === null,
  );
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  assertValid(keys.every((key) => typeof key === 'string'));
  let result;
  if (isArray) {
    assertValid(keys.length === value.length + 1 && Object.hasOwn(descriptors, 'length'));
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      assertValid(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      result.push(copyJsonData(descriptor.value, ancestors));
    }
  } else {
    result = {};
    for (const key of keys) {
      wellFormed(key);
      const descriptor = descriptors[key];
      assertValid(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      // defineProperty treats "__proto__" as an ordinary data key.
      Object.defineProperty(result, key, {
        value: copyJsonData(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  ancestors.delete(value);
  return result;
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function record(input, fields) {
  const result = copyJsonData(input);
  plain(result);
  assertSchemaVersion(result);
  const expected = ['schema_version', ...fields];
  assertValid(Object.keys(result).length === expected.length);
  assertValid(expected.every((field) => Object.hasOwn(result, field)));
  return result;
}

function objectId(value, kind) {
  parseObjectId(value, kind);
  return value;
}

function digest(value, domain) {
  parseDigest(value, domain);
  return value;
}

function matchingIdentity(id, value, kind) {
  const parsed = parseObjectId(id, kind);
  digest(value, 'object-' + kind);
  if (parsed.digest !== value) throw new V1Error('INTEGRITY_MISMATCH');
}

function unique(values) {
  assertValid(new Set(values).size === values.length);
  return values;
}

function references(value, kind) {
  return unique(array(value).map((entry) => objectId(entry, kind)));
}

function digests(value, domain) {
  return unique(array(value).map((entry) => digest(entry, domain)));
}

function oid(value, length) {
  assertValid(typeof value === 'string');
  assertValid(
    (value.length === 40 || value.length === 64) && !/[^a-f0-9]/.test(value) && !/^0+$/.test(value),
  );
  assertValid(length === undefined || value.length === length);
  return value;
}

/** Full Git refs only; branch aliases and abbreviated OIDs are not exact state. */
function ref(value) {
  text(value);
  assertValid(value.startsWith('refs/') && !value.endsWith('/') && !value.endsWith('.'));
  assertValid(!/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value));
  assertValid(!value.includes('..') && !value.includes('@{') && !value.includes('//'));
  assertValid(
    value
      .split('/')
      .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')),
  );
  return value;
}

function timestamp(value) {
  assertValid(typeof value === 'string');
  assertValid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value));
  const date = new Date(value);
  assertValid(Number.isFinite(date.getTime()));
  assertValid(date.toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')));
  return value;
}

export { oid as gitOid, ref as gitRef };

function oidMap(value) {
  plain(value);
  assertValid(Object.keys(value).length > 0);
  for (const [key, exactOid] of Object.entries(value)) {
    text(key);
    oid(exactOid);
  }
}

function payloadRecords(value) {
  for (const entry of array(value)) plain(entry);
}

export function FutureRevision(input) {
  const value = record(input, [
    'id',
    'system_id',
    'repo_id',
    'ref',
    'commit_oid',
    'tree_oid',
    'parent_oids',
    'producer',
    'observed_at',
  ]);
  objectId(value.id, 'future-revision');
  text(value.system_id);
  text(value.repo_id);
  ref(value.ref);
  oid(value.commit_oid);
  oid(value.tree_oid, value.commit_oid.length);
  for (const parent of array(value.parent_oids)) oid(parent, value.commit_oid.length);
  // Missing provenance is valid. A producer record remains a claim, not trust.
  if (value.producer !== null) plain(value.producer);
  timestamp(value.observed_at);
  return freeze(value);
}

export function EffectSet(input) {
  const value = record(input, [
    'future_revision_id',
    'extractor_id',
    'extractor_version',
    'capability',
    'status',
    'effects',
    'security_effects',
    'digest',
  ]);
  objectId(value.future_revision_id, 'future-revision');
  text(value.extractor_id);
  text(value.extractor_version);
  member(value.capability, ANALYSIS_CAPABILITIES);
  member(value.status, ANALYSIS_STATUSES);
  payloadRecords(value.effects);
  payloadRecords(value.security_effects);
  digest(value.digest, 'effect-set');
  return freeze(value);
}

export function CandidateSpec(input) {
  const value = record(input, [
    'id',
    'base_revision',
    'selected_future_revisions',
    'selections',
    'required_dependencies',
    'effect_summary_digest',
    'creation_reason',
  ]);
  objectId(value.id, 'candidate-spec');
  objectId(value.base_revision, 'system-revision');
  references(value.selected_future_revisions, 'future-revision');
  payloadRecords(value.selections);
  references(value.required_dependencies, 'future-revision');
  digest(value.effect_summary_digest);
  text(value.creation_reason);
  return freeze(value);
}

export function Candidate(input) {
  const value = record(input, [
    'id',
    'candidate_spec_id',
    'repo_tree_oids',
    'digest',
    'materialization_record',
  ]);
  matchingIdentity(value.id, value.digest, 'candidate');
  objectId(value.candidate_spec_id, 'candidate-spec');
  oidMap(value.repo_tree_oids);
  plain(value.materialization_record);
  return freeze(value);
}

export function Evidence(input) {
  const value = record(input, [
    'id',
    'subject_digest',
    'type',
    'producer_identity',
    'producer_version',
    'config_digest',
    'environment_digest',
    'result',
    'payload_ref',
    'created_at',
    'retention_class',
  ]);
  objectId(value.id, 'evidence');
  digest(value.subject_digest);
  text(value.type);
  text(value.producer_identity);
  text(value.producer_version);
  digest(value.config_digest);
  digest(value.environment_digest);
  text(value.payload_ref);
  timestamp(value.created_at);
  member(value.retention_class, RETENTION_CLASSES);
  return freeze(value);
}

export function DecisionBasis(input) {
  const value = record(input, [
    'candidate_digests',
    'evidence_digests',
    'material_effect_digest',
    'policy_digest',
    'canonical_ref_oids',
    'required_analysis_status',
    'digest',
  ]);
  digests(value.candidate_digests, 'object-candidate');
  digests(value.evidence_digests, 'object-evidence');
  digest(value.material_effect_digest, 'material-effect');
  digest(value.policy_digest);
  plain(value.canonical_ref_oids);
  for (const [repoId, refs] of Object.entries(value.canonical_ref_oids)) {
    text(repoId);
    plain(refs);
    assertValid(Object.keys(refs).length > 0);
    let oidLength;
    for (const [fullRef, exactOid] of Object.entries(refs)) {
      ref(fullRef);
      oid(exactOid, oidLength);
      oidLength = exactOid.length;
    }
  }
  plain(value.required_analysis_status);
  for (const [requirement, status] of Object.entries(value.required_analysis_status)) {
    text(requirement);
    member(status, ANALYSIS_STATUSES);
  }
  digest(value.digest, 'decision-basis');
  return freeze(value);
}

export function Decision(input) {
  const value = record(input, ['id', 'state', 'basis', 'resolution']);
  objectId(value.id, 'decision');
  member(value.state, DECISION_STATES);
  if (value.basis === null) {
    assertValid(value.state === 'DISCOVERED');
  } else {
    value.basis = DecisionBasis(value.basis);
  }
  if (value.state === 'RESOLVABLE' || value.state === 'RESOLVED') {
    assertValid(value.basis.candidate_digests.length > 0);
    // This checks only listed requirements. Policy must establish completeness.
    assertValid(
      Object.values(value.basis.required_analysis_status).every((status) => status === 'COMPLETE'),
    );
  }
  if (value.state === 'RESOLVED') {
    plain(value.resolution);
    assertValid(Object.hasOwn(value.resolution, 'candidate_digest'));
    digest(value.resolution.candidate_digest, 'object-candidate');
    assertValid(value.basis.candidate_digests.includes(value.resolution.candidate_digest));
  } else {
    assertValid(value.resolution === null);
  }
  return freeze(value);
}

export function SystemRevision(input) {
  const value = record(input, [
    'id',
    'repositories',
    'configuration_digests',
    'accepted_decisions',
    'digest',
  ]);
  matchingIdentity(value.id, value.digest, 'system-revision');
  oidMap(value.repositories);
  plain(value.configuration_digests);
  for (const [key, exactDigest] of Object.entries(value.configuration_digests)) {
    text(key);
    digest(exactDigest);
  }
  references(value.accepted_decisions, 'decision');
  return freeze(value);
}

export function ReleaseConstraints(input) {
  const value = record(input, [
    'system_revision_digest',
    'ordering_constraints',
    'compatibility_requirements',
    'preconditions',
    'postconditions',
    'forward_only_operations',
    'digest',
  ]);
  digest(value.system_revision_digest, 'object-system-revision');
  for (const field of [
    'ordering_constraints',
    'compatibility_requirements',
    'preconditions',
    'postconditions',
    'forward_only_operations',
  ]) {
    payloadRecords(value[field]);
  }
  digest(value.digest, 'release-constraints');
  return freeze(value);
}

export function DeploymentObservation(input) {
  const value = record(input, [
    'id',
    'digest',
    'system_revision_digest',
    'external_run_id',
    'status',
    'observed_at',
    'method',
  ]);
  matchingIdentity(value.id, value.digest, 'deployment-observation');
  digest(value.system_revision_digest, 'object-system-revision');
  text(value.external_run_id);
  member(value.status, DEPLOYMENT_STATUSES);
  timestamp(value.observed_at);
  text(value.method);
  return freeze(value);
}

export function DeploymentAttestation(input) {
  const value = record(input, [
    'id',
    'digest',
    'system_revision_digest',
    'observation_digest',
    'producer_identity',
    'created_at',
    'proof_ref',
  ]);
  matchingIdentity(value.id, value.digest, 'deployment-attestation');
  digest(value.system_revision_digest, 'object-system-revision');
  digest(value.observation_digest, 'object-deployment-observation');
  text(value.producer_identity);
  timestamp(value.created_at);
  text(value.proof_ref);
  return freeze(value);
}

const constructors = Object.freeze({
  FutureRevision,
  EffectSet,
  CandidateSpec,
  Candidate,
  Evidence,
  DecisionBasis,
  Decision,
  SystemRevision,
  ReleaseConstraints,
  DeploymentObservation,
  DeploymentAttestation,
});

function constructor(type) {
  assertValid(typeof type === 'string' && Object.hasOwn(constructors, type));
  return constructors[type];
}

export function validateDomain(type, input) {
  return constructor(type)(input);
}

/** JSON persistence preserves input order; canonical CBOR has its own encoder. */
export function serializeDomain(type, input) {
  return JSON.stringify(validateDomain(type, input));
}

export function deserializeDomain(type, encoded) {
  assertValid(typeof encoded === 'string');
  let input;
  try {
    input = JSON.parse(encoded);
  } catch {
    throw new V1Error('INVALID_ARGUMENT');
  }
  return validateDomain(type, input);
}
