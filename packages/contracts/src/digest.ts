import { sha256Hex } from './sha256.ts';
import { encodeCBOR } from './cbor.ts';
import {
  projectFutureRevisionState,
  projectFutureRevisionRecord,
  projectEffectSet,
  projectCandidateSpec,
  projectCandidate,
  projectEvidence,
  projectDecisionBasis,
  projectSystemRevisionState,
  projectSystemRevisionRecord,
  projectReleaseConstraints,
  projectDeploymentAttestation,
} from './canonical.ts';
import {
  CanonicalFutureRevisionState,
  CanonicalFutureRevisionRecord,
  CanonicalEffectSet,
  CanonicalCandidateSpec,
  CanonicalCandidate,
  CanonicalEvidence,
  CanonicalDecisionBasis,
  CanonicalSystemRevisionState,
  CanonicalSystemRevisionRecord,
  CanonicalReleaseConstraints,
  CanonicalDeploymentAttestation,
  FutureRevision,
  EffectSet,
  CandidateSpec,
  Candidate,
  Evidence,
  DecisionBasis,
  SystemRevision,
  ReleaseConstraints,
  DeploymentAttestation,
} from './types.ts';

export const SCHEMA_VERSION = 'v1';

export const DOMAIN_SEPARATORS = {
  FUTURE_REVISION_STATE: 'klocgit/future_revision_state',
  FUTURE_REVISION_RECORD: 'klocgit/future_revision_record',
  EFFECT_SET: 'klocgit/effect_set',
  CANDIDATE_SPEC: 'klocgit/candidate_spec',
  CANDIDATE: 'klocgit/candidate',
  EVIDENCE: 'klocgit/evidence',
  DECISION_BASIS: 'klocgit/decision_basis',
  SYSTEM_REVISION_STATE: 'klocgit/system_revision_state',
  SYSTEM_REVISION_RECORD: 'klocgit/system_revision_record',
  RELEASE_CONSTRAINTS: 'klocgit/release_constraints',
  DEPLOYMENT_ATTESTATION: 'klocgit/deployment_attestation',
  PAYLOAD: 'klocgit/payload',
} as const;

export function calculateDigest(
  domainSeparator: string,
  schemaVersion: string,
  canonicalProjection: unknown
): string {
  const cborBytes = encodeCBOR(canonicalProjection);
  const header = new TextEncoder().encode(`${domainSeparator}::${schemaVersion}::`);
  const combined = new Uint8Array(header.length + cborBytes.length);
  combined.set(header, 0);
  combined.set(cborBytes, header.length);
  return sha256Hex(combined);
}

export function computePayloadDigest(payload: Uint8Array | string): string {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const header = new TextEncoder().encode(`${DOMAIN_SEPARATORS.PAYLOAD}::${SCHEMA_VERSION}::`);
  const combined = new Uint8Array(header.length + bytes.length);
  combined.set(header, 0);
  combined.set(bytes, header.length);
  return sha256Hex(combined);
}

export function computeFutureRevisionStateDigest(
  input: CanonicalFutureRevisionState
): string {
  const proj = projectFutureRevisionState(input);
  return calculateDigest(DOMAIN_SEPARATORS.FUTURE_REVISION_STATE, SCHEMA_VERSION, proj);
}

export function computeFutureRevisionRecordDigest(
  input: CanonicalFutureRevisionRecord | FutureRevision
): string {
  const proj = projectFutureRevisionRecord(input);
  return calculateDigest(DOMAIN_SEPARATORS.FUTURE_REVISION_RECORD, SCHEMA_VERSION, proj);
}

export function computeEffectDigest(input: CanonicalEffectSet | EffectSet): string {
  const proj = projectEffectSet(input);
  return calculateDigest(DOMAIN_SEPARATORS.EFFECT_SET, SCHEMA_VERSION, proj);
}

export function computeCandidateSpecDigest(
  input: CanonicalCandidateSpec | CandidateSpec
): string {
  const proj = projectCandidateSpec(input);
  return calculateDigest(DOMAIN_SEPARATORS.CANDIDATE_SPEC, SCHEMA_VERSION, proj);
}

export function computeCandidateDigest(input: CanonicalCandidate | Candidate): string {
  const proj = projectCandidate(input);
  return calculateDigest(DOMAIN_SEPARATORS.CANDIDATE, SCHEMA_VERSION, proj);
}

export function computeEvidenceDigest(input: CanonicalEvidence | Evidence): string {
  const proj = projectEvidence(input);
  return calculateDigest(DOMAIN_SEPARATORS.EVIDENCE, SCHEMA_VERSION, proj);
}

export function computeDecisionBasisDigest(
  input: CanonicalDecisionBasis | DecisionBasis
): string {
  const proj = projectDecisionBasis(input);
  return calculateDigest(DOMAIN_SEPARATORS.DECISION_BASIS, SCHEMA_VERSION, proj);
}

export function computeSystemRevisionStateDigest(
  input: CanonicalSystemRevisionState
): string {
  const proj = projectSystemRevisionState(input);
  return calculateDigest(DOMAIN_SEPARATORS.SYSTEM_REVISION_STATE, SCHEMA_VERSION, proj);
}

export function computeSystemRevisionRecordDigest(
  input: CanonicalSystemRevisionRecord | SystemRevision
): string {
  const proj = projectSystemRevisionRecord(input);
  return calculateDigest(DOMAIN_SEPARATORS.SYSTEM_REVISION_RECORD, SCHEMA_VERSION, proj);
}

export function computeReleaseConstraintsDigest(
  input: CanonicalReleaseConstraints | ReleaseConstraints
): string {
  const proj = projectReleaseConstraints(input);
  return calculateDigest(DOMAIN_SEPARATORS.RELEASE_CONSTRAINTS, SCHEMA_VERSION, proj);
}

export function computeDeploymentAttestationDigest(
  input: CanonicalDeploymentAttestation | DeploymentAttestation
): string {
  const proj = projectDeploymentAttestation(input);
  return calculateDigest(DOMAIN_SEPARATORS.DEPLOYMENT_ATTESTATION, SCHEMA_VERSION, proj);
}
