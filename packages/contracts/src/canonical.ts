import type {
  CanonicalFutureRevisionState, CanonicalFutureRevisionRecord, FutureRevision,
  CanonicalEffectSet, EffectSet, CanonicalCandidateSpec, CandidateSpec,
  CanonicalCandidate, Candidate, CanonicalEvidence, Evidence, CanonicalDecisionBasis,
  DecisionBasis, CanonicalSystemRevisionState, CanonicalSystemRevisionRecord, SystemRevision,
  CanonicalReleaseConstraints, ReleaseConstraints, CanonicalDeploymentAttestation,
  DeploymentAttestation, ProvenanceSlice, ResourceRef,
} from './index.ts';

export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue };
export const schemaVersion = 1;
const encoder = new TextEncoder();
const maxBytes = 8 * 1024 * 1024;

function nfc(value: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) throw new Error('Invalid UTF-8 string');
  return value.normalize('NFC');
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function compareStrings(a: string, b: string): number { return compareBytes(encoder.encode(a), encoder.encode(b)); }
function sortedSet(values: readonly string[]): string[] { return [...new Set(values.map(nfc))].sort(compareStrings); }
function requireOid(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error('Invalid Git OID');
}
function requireDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('Invalid digest');
}
function keyed(values: Record<string, string>): Record<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    const normalized = nfc(key);
    if (result.has(normalized)) throw new Error('NFC key collision');
    result.set(normalized, nfc(value));
  }
  return Object.fromEntries([...result].sort(([a], [b]) => compareStrings(a, b)));
}

function header(major: number, number: number): Uint8Array {
  const prefix = major << 5;
  if (number < 24) return Uint8Array.of(prefix | number);
  if (number <= 0xff) return Uint8Array.of(prefix | 24, number);
  if (number <= 0xffff) return Uint8Array.of(prefix | 25, number >>> 8, number & 0xff);
  if (number <= 0xffffffff) return Uint8Array.of(prefix | 26, number >>> 24, (number >>> 16) & 0xff, (number >>> 8) & 0xff, number & 0xff);
  const bytes = new Uint8Array(9); bytes[0] = prefix | 27;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(number)); return bytes;
}

/** RFC 8949 core deterministic ordering, with NFC collision checks. */
export function canonicalEncode(value: unknown): Uint8Array {
  const output: number[] = [];
  const ancestors = new Set<object>();
  function append(bytes: Uint8Array): void {
    if (output.length + bytes.length > maxBytes) throw new Error('CBOR byte limit exceeded');
    for (const byte of bytes) output.push(byte);
  }
  function write(value: unknown, depth: number): void {
    if (depth > 64) throw new Error('CBOR nesting limit exceeded');
    if (value === null) append(Uint8Array.of(0xf6));
    else if (typeof value === 'boolean') append(Uint8Array.of(value ? 0xf5 : 0xf4));
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('Schema requires safe integers');
      append(header(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value));
    } else if (typeof value === 'string') {
      if (value.length > maxBytes) throw new Error('CBOR string limit exceeded');
      const bytes = encoder.encode(nfc(value)); append(header(3, bytes.length)); append(bytes);
    } else if (typeof value === 'object') {
      if (ancestors.has(value)) throw new Error('Cyclic CBOR value');
      ancestors.add(value);
      if (Array.isArray(value)) {
        append(header(4, value.length)); for (const item of value) write(item, depth + 1);
      } else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('Schema requires plain objects');
        if (Object.getOwnPropertySymbols(value).length) throw new Error('Symbol keys are unsupported');
        if (Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !('value' in entry))) throw new Error('Accessor properties are unsupported');
        const keys = new Set<string>();
        const entries = Object.entries(value).map(([key, item]) => {
          const normalized = nfc(key);
          if (keys.has(normalized)) throw new Error('NFC key collision');
          keys.add(normalized); return { item, encoded: canonicalEncode(normalized) };
        });
        entries.sort((a, b) => compareBytes(a.encoded, b.encoded));
        append(header(5, entries.length));
        for (const { encoded, item } of entries) { append(encoded); write(item, depth + 1); }
      }
      ancestors.delete(value);
    } else throw new Error('Unsupported CBOR value');
  }
  write(value, 0); return Uint8Array.from(output);
}

async function hashWire(domain: string, body: Uint8Array): Promise<string> {
  if (!domain || domain.length > 128 || !/^[A-Za-z0-9.-]+$/.test(domain)) throw new Error('Invalid hash domain');
  const prefix = encoder.encode(domain);
  const wire = new Uint8Array(prefix.length + 5 + body.length);
  wire.set(prefix); wire[prefix.length] = 0;
  new DataView(wire.buffer).setUint32(prefix.length + 1, schemaVersion);
  wire.set(body, prefix.length + 5);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', wire.buffer));
  return 'sha256:' + [...hash].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export function hashProjection(domain: string, projection: unknown): Promise<string> {
  return hashWire(domain, canonicalEncode(projection));
}
export function payloadDigest(bytes: Uint8Array): Promise<string> {
  const prefix = header(2, bytes.length); const body = new Uint8Array(prefix.length + bytes.length);
  body.set(prefix); body.set(bytes, prefix.length); return hashWire('klocgit.payload', body);
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareStrings(a[i], b[i]); if (order) return order;
  }
  return a.length - b.length;
}
function sortedComposite<T>(values: readonly T[], key: (value: T) => string[]): T[] {
  return values.map((value) => ({ value, key: key(value), bytes: canonicalEncode(value) }))
    .sort((a, b) => compareKeys(a.key, b.key) || compareBytes(a.bytes, b.bytes))
    .map(({ value }) => value);
}
function resource(value: ResourceRef): ResourceRef {
  if (!['service', 'database', 'migration', 'infrastructure', 'package'].includes(value.resource_type)) throw new Error('Invalid resource type');
  return {
    ...(value.system_id === undefined ? {} : { system_id: nfc(value.system_id) }),
    repo_id: nfc(value.repo_id), resource_type: value.resource_type, resource_id: nfc(value.resource_id),
  };
}
function resourceKey(value: ResourceRef): string[] {
  return [nfc(value.system_id ?? ''), nfc(value.repo_id), value.resource_type, nfc(value.resource_id)];
}
function manifest(values: readonly ProvenanceSlice[]): ProvenanceSlice[] {
  const normalized = values.map((slice) => {
    requireOid(slice.source_commit_oid);
    if (!['hunk', 'symbol', 'byte_range', 'file'].includes(slice.selector.type)) throw new Error('Invalid selector type');
    return {
      repo_id: nfc(slice.repo_id), path: nfc(slice.path),
      selector: { type: slice.selector.type, value: nfc(slice.selector.value) },
      source_future_id: nfc(slice.source_future_id), source_commit_oid: slice.source_commit_oid,
    };
  });
  return sortedComposite(normalized, (slice) => [slice.repo_id, slice.path, slice.selector.type, slice.selector.value]);
}

export function futureStateProjection(value: CanonicalFutureRevisionState): CanonicalFutureRevisionState {
  requireOid(value.commit_oid); requireOid(value.tree_oid); for (const oid of value.parent_oids) requireOid(oid);
  if (!value.repo_id) throw new Error('Missing repository');
  return { repo_id: nfc(value.repo_id), commit_oid: value.commit_oid, tree_oid: value.tree_oid, parent_oids: [...value.parent_oids] };
}
export function futureRecordProjection(value: CanonicalFutureRevisionRecord): CanonicalFutureRevisionRecord {
  requireDigest(value.state_digest);
  if (!value.system_id || !value.producer.actor_id || !value.ref.startsWith('refs/futures/') || value.ref.split('/').length < 4 || nfc(value.ref) !== value.ref || /[\x00-\x20\x7f~^:?*\[\\]/.test(value.ref) || value.ref.includes('..') || value.ref.includes('@{') || value.ref.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid FutureRevision');
  if (value.producer.prompt_digest !== undefined) requireDigest(value.producer.prompt_digest);
  return {
    state_digest: value.state_digest, system_id: nfc(value.system_id), ref: nfc(value.ref),
    producer: {
      actor_id: nfc(value.producer.actor_id),
      ...(value.producer.agent_version === undefined ? {} : { agent_version: nfc(value.producer.agent_version) }),
      ...(value.producer.task_id === undefined ? {} : { task_id: nfc(value.producer.task_id) }),
      ...(value.producer.prompt_digest === undefined ? {} : { prompt_digest: value.producer.prompt_digest }),
    },
  };
}
export async function sealFutureRevision(state: CanonicalFutureRevisionState, metadata: Omit<FutureRevision, 'state_digest' | 'record_digest' | 'id'>): Promise<FutureRevision> {
  const state_digest = await hashProjection('klocgit.future-revision.state', futureStateProjection(state));
  const projection = futureRecordProjection({ ...metadata, state_digest });
  const record_digest = await hashProjection('klocgit.future-revision.record', projection);
  return { ...projection, observed_at: metadata.observed_at, id: record_digest, record_digest };
}

export function effectProjection(value: CanonicalEffectSet): CanonicalEffectSet {
  if (typeof value.db_migrations_detected !== 'boolean') throw new Error('Invalid migration flag');
  if (!value.future_revision_id || !value.extractor_id || !value.extractor_version || !['PATH', 'STRUCTURAL', 'SEMANTIC'].includes(value.capability) || !['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED'].includes(value.status)) throw new Error('Invalid EffectSet');
  return {
    future_revision_id: nfc(value.future_revision_id), extractor_id: nfc(value.extractor_id),
    extractor_version: nfc(value.extractor_version), capability: value.capability, status: value.status,
    modified_exports: sortedSet(value.modified_exports), added_dependencies: keyed(value.added_dependencies),
    db_migrations_detected: value.db_migrations_detected, security_effects: sortedSet(value.security_effects),
  };
}
export async function sealEffectSet(value: CanonicalEffectSet): Promise<EffectSet> {
  const projection = effectProjection(value);
  return { ...projection, effect_digest: await hashProjection('klocgit.effect-set', projection) };
}
export function specProjection(value: CanonicalCandidateSpec): CanonicalCandidateSpec {
  const base_revisions = keyed(value.base_revisions); for (const oid of Object.values(base_revisions)) requireOid(oid);
  const selected_future_revisions = sortedSet(value.selected_future_revisions);
  const composition_manifest = manifest(value.composition_manifest);
  if (!Object.keys(base_revisions).length || !selected_future_revisions.length || !value.creation_reason || composition_manifest.some((slice) => (!selected_future_revisions.includes(slice.source_future_id) || !Object.hasOwn(base_revisions, slice.repo_id)))) throw new Error('Invalid candidate selection');
  return { base_revisions, selected_future_revisions, composition_manifest, creation_reason: nfc(value.creation_reason) };
}
export async function sealCandidateSpec(value: CanonicalCandidateSpec & { effect_summary_digest: string }): Promise<CandidateSpec> {
  requireDigest(value.effect_summary_digest); const projection = specProjection(value);
  const spec_digest = await hashProjection('klocgit.candidate-spec', projection);
  return { ...projection, id: spec_digest, effect_summary_digest: value.effect_summary_digest, spec_digest };
}
export function candidateProjection(value: CanonicalCandidate): CanonicalCandidate {
  const repo_tree_oids = keyed(value.repo_tree_oids); for (const oid of Object.values(repo_tree_oids)) requireOid(oid);
  if (!value.candidate_spec_id || !Object.keys(repo_tree_oids).length) throw new Error('Empty candidate state');
  return { candidate_spec_id: nfc(value.candidate_spec_id), repo_tree_oids };
}
export async function sealCandidate(value: Omit<Candidate, 'id' | 'candidate_digest'>): Promise<Candidate> {
  const projection = candidateProjection(value); const candidate_digest = await hashProjection('klocgit.candidate', projection);
  return { ...projection, id: candidate_digest, candidate_digest, materialization_record: value.materialization_record };
}
export function evidenceProjection(value: CanonicalEvidence): CanonicalEvidence {
  for (const digest of [value.subject_digest, value.config_digest, value.environment_digest, value.payload_digest]) requireDigest(digest);
  if (!value.evaluator_id || !value.evaluator_version || !['PASSED', 'FAILED', 'ERROR'].includes(value.result)) throw new Error('Invalid Evidence');
  return {
    subject_digest: value.subject_digest, evaluator_id: nfc(value.evaluator_id), evaluator_version: nfc(value.evaluator_version),
    config_digest: value.config_digest, environment_digest: value.environment_digest, result: value.result, payload_digest: value.payload_digest,
  };
}
export async function sealEvidence(value: Omit<Evidence, 'id' | 'evidence_digest'>): Promise<Evidence> {
  const projection = evidenceProjection(value); const evidence_digest = await hashProjection('klocgit.evidence', projection);
  return { ...projection, id: evidence_digest, evidence_digest, payload_ref: value.payload_ref, retention_class: value.retention_class, created_at: value.created_at };
}
export function basisProjection(value: CanonicalDecisionBasis): CanonicalDecisionBasis {
  const candidate_digests = sortedSet(value.candidate_digests), evidence_digests = sortedSet(value.evidence_digests);
  for (const digest of [...candidate_digests, ...evidence_digests, value.material_effect_digest, value.policy_digest]) requireDigest(digest);
  const canonical_ref_oids = keyed(value.canonical_ref_oids); for (const oid of Object.values(canonical_ref_oids)) requireOid(oid);
  const required_analysis_status = keyed(value.required_analysis_status) as CanonicalDecisionBasis['required_analysis_status'];
  for (const status of Object.values(required_analysis_status)) if (!['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED'].includes(status)) throw new Error('Invalid analysis status');
  return { candidate_digests, evidence_digests, material_effect_digest: value.material_effect_digest, policy_digest: value.policy_digest, canonical_ref_oids, required_analysis_status };
}
export async function sealDecisionBasis(value: CanonicalDecisionBasis): Promise<DecisionBasis> {
  const projection = basisProjection(value); return { ...projection, basis_digest: await hashProjection('klocgit.decision-basis', projection) };
}
export function systemStateProjection(value: CanonicalSystemRevisionState): CanonicalSystemRevisionState {
  const repositories = keyed(value.repositories), configuration_digests = keyed(value.configuration_digests);
  if (!Object.keys(repositories).length) throw new Error('Empty system state');
  for (const oid of Object.values(repositories)) requireOid(oid); for (const digest of Object.values(configuration_digests)) requireDigest(digest);
  return { repositories, configuration_digests };
}
export function systemRecordProjection(value: CanonicalSystemRevisionRecord): CanonicalSystemRevisionRecord {
  requireDigest(value.state_digest);
  return { state_digest: value.state_digest, accepted_decision_ids: sortedSet(value.accepted_decision_ids), composition_manifest: manifest(value.composition_manifest) };
}
export async function sealSystemRevision(state: CanonicalSystemRevisionState, metadata: Omit<CanonicalSystemRevisionRecord, 'state_digest'>): Promise<SystemRevision> {
  const state_digest = await hashProjection('klocgit.system-revision.state', systemStateProjection(state));
  const projection = systemRecordProjection({ ...metadata, state_digest });
  const record_digest = await hashProjection('klocgit.system-revision.record', projection);
  return { ...projection, id: record_digest, record_digest };
}
export function constraintsProjection(value: CanonicalReleaseConstraints): CanonicalReleaseConstraints {
  requireDigest(value.system_revision_state_digest);
  for (const v of value.compatibility_requirements) if (!['COMPATIBLE', 'REQUIRES', 'CONFLICTS'].includes(v.relation)) throw new Error('Invalid compatibility relation');
  for (const v of [...value.preconditions, ...value.postconditions]) if (!['EXISTS', 'HEALTHY', 'MIGRATED', 'ABSENT'].includes(v.assertion)) throw new Error('Invalid condition');
  for (const v of value.forward_only_operations) if (!['ABORT', 'MANUAL_INTERVENTION'].includes(v.failure_policy)) throw new Error('Invalid failure policy');
  const ordering_constraints = value.ordering_constraints.map((v) => ({ before: resource(v.before), after: resource(v.after) }));
  const compatibility_requirements = value.compatibility_requirements.map((v) => ({
    subject: resource(v.subject), target: resource(v.target), relation: v.relation,
    ...(v.version_constraint === undefined ? {} : { version_constraint: nfc(v.version_constraint) }),
  }));
  const conditions = (values: CanonicalReleaseConstraints['preconditions']) => sortedComposite(values.map((v) => ({
    target: resource(v.target), assertion: v.assertion, ...(v.parameters === undefined ? {} : { parameters: keyed(v.parameters) }),
  })), (v) => resourceKey(v.target));
  const forward_only_operations = value.forward_only_operations.map((v) => ({ resource: resource(v.resource), operation: nfc(v.operation), failure_policy: v.failure_policy }));
  return {
    system_revision_state_digest: value.system_revision_state_digest,
    ordering_constraints: sortedComposite(ordering_constraints, (v) => [...resourceKey(v.before), ...resourceKey(v.after)]),
    compatibility_requirements: sortedComposite(compatibility_requirements, (v) => [...resourceKey(v.subject), ...resourceKey(v.target)]),
    preconditions: conditions(value.preconditions), postconditions: conditions(value.postconditions),
    forward_only_operations: sortedComposite(forward_only_operations, (v) => resourceKey(v.resource)),
  };
}
export async function sealReleaseConstraints(value: CanonicalReleaseConstraints): Promise<ReleaseConstraints> {
  const projection = constraintsProjection(value); return { ...projection, constraints_digest: await hashProjection('klocgit.release-constraints', projection) };
}
export function attestationProjection(value: CanonicalDeploymentAttestation): CanonicalDeploymentAttestation {
  requireDigest(value.system_revision_state_digest); requireDigest(value.payload_digest);
  if (!['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(value.observed_state)) throw new Error('Invalid deployment state');
  const observed_repositories = keyed(value.observed_repositories), observed_configuration_digests = keyed(value.observed_configuration_digests);
  for (const oid of Object.values(observed_repositories)) requireOid(oid); for (const digest of Object.values(observed_configuration_digests)) requireDigest(digest);
  return { system_revision_state_digest: value.system_revision_state_digest, environment: nfc(value.environment), deployer_identity: nfc(value.deployer_identity), observed_state: value.observed_state, observed_repositories, observed_configuration_digests, payload_digest: value.payload_digest };
}
export async function sealDeploymentAttestation(value: Omit<DeploymentAttestation, 'attestation_digest'>): Promise<DeploymentAttestation> {
  const projection = attestationProjection(value);
  return { ...projection, attestation_payload_ref: value.attestation_payload_ref, verified_at: value.verified_at, attestation_digest: await hashProjection('klocgit.deployment-attestation', projection) };
}
