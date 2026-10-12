/**
 * CODEX OPERATING CONTRACT: KLoCGit v1 Enterprise Convergence Platform
 * Domain Schemas & Canonical Contracts (Section 3)
 */

export interface ResourceRef {
  system_id?: string;
  repo_id: string;
  resource_type: 'service' | 'database' | 'migration' | 'infrastructure' | 'package';
  resource_id: string;
}

export interface OrderingConstraint {
  before: ResourceRef;
  after: ResourceRef;
}

export interface CompatibilityRequirement {
  subject: ResourceRef;
  target: ResourceRef;
  relation: 'COMPATIBLE' | 'REQUIRES' | 'CONFLICTS';
  version_constraint?: string;
}

export interface StateCondition {
  target: ResourceRef;
  assertion: 'EXISTS' | 'HEALTHY' | 'MIGRATED' | 'ABSENT';
  parameters?: Record<string, string>;
}

export interface ForwardOnlyOperation {
  resource: ResourceRef;
  operation: string;
  failure_policy: 'ABORT' | 'MANUAL_INTERVENTION';
}

export interface Predicate {
  kind: 'EVIDENCE_PASSED' | 'ANALYSIS_COMPLETE' | 'CANDIDATE_UNCHANGED' | 'EFFECTS_UNCHANGED';
  subject: string;
  expected?: string;
}

export interface ProvenanceSlice {
  repo_id: string;
  path: string;
  selector: {
    type: 'hunk' | 'symbol' | 'byte_range' | 'file';
    value: string;
  };
  source_future_id: string;
  source_commit_oid: string;
}

// ============================================================================
// CANONICAL IDENTITIES & DOMAIN RECORDS
// ============================================================================

// --- FUTURE REVISION ---
export interface CanonicalFutureRevisionState {
  repo_id: string;
  commit_oid: string;
  tree_oid: string;
  parent_oids: string[]; // PRESERVE EXACT GIT PARENT ORDER
}

export interface CanonicalFutureRevisionRecord {
  state_digest: string;  // Digest of CanonicalFutureRevisionState
  system_id: string;
  ref: string;
  producer: {
    actor_id: string;
    agent_version?: string;
    task_id?: string;
    prompt_digest?: string;
  };
}

export interface FutureRevision extends CanonicalFutureRevisionRecord {
  id: string;
  state_digest: string;
  record_digest: string; // Digest of CanonicalFutureRevisionRecord
  observed_at: string;   // Excluded from digest
}

// --- EFFECT SET ---
export interface CanonicalEffectSet {
  future_revision_id: string;
  extractor_id: string;
  extractor_version: string;
  capability: 'PATH' | 'STRUCTURAL' | 'SEMANTIC';
  status: 'COMPLETE' | 'PARTIAL' | 'UNSUPPORTED' | 'FAILED';
  modified_exports: string[];                 // SORTED
  added_dependencies: Record<string, string>; // SORTED KEYS
  db_migrations_detected: boolean;
  security_effects: string[];                 // SORTED
}

export interface EffectSet extends CanonicalEffectSet {
  effect_digest: string; // Digest of CanonicalEffectSet
}

// --- CANDIDATE SPEC ---
export interface CanonicalCandidateSpec {
  base_revisions: Record<string, string>;      // SORTED KEYS (repo_id)
  selected_future_revisions: string[];         // SORTED
  composition_manifest: ProvenanceSlice[];     // SORTED by composite key
  creation_reason: string;
}

export interface CandidateSpec extends CanonicalCandidateSpec {
  id: string;
  effect_summary_digest: string;
  spec_digest: string; // Digest of CanonicalCandidateSpec
}

// --- CANDIDATE ---
export interface CanonicalCandidate {
  candidate_spec_id: string;
  repo_tree_oids: Record<string, string>; // SORTED KEYS (repo_id)
}

export interface Candidate extends CanonicalCandidate {
  id: string;
  candidate_digest: string; // Digest of CanonicalCandidate
  materialization_record: {
    executor_id: string;
    materialized_at: string;
    conflicts_encountered: string[];
  };
}

// --- EVIDENCE ---
export interface CanonicalEvidence {
  subject_digest: string;
  evaluator_id: string;
  evaluator_version: string;
  config_digest: string;
  environment_digest: string;
  result: 'PASSED' | 'FAILED' | 'ERROR';
  payload_digest: string; // Digest of raw external payload (NOT payload_ref or retention_class)
}

export interface Evidence extends CanonicalEvidence {
  id: string;
  payload_ref: string;    // R2 storage key (excluded from digest)
  retention_class: 'EPHEMERAL' | 'REBUILDABLE' | 'DECISION_RECORD' | 'CANONICAL'; // Excluded
  created_at: string;     // Excluded from digest
  evidence_digest: string;// Digest of CanonicalEvidence
}

// --- DECISION BASIS & DECISION ---
export interface CanonicalDecisionBasis {
  candidate_digests: string[];                 // SORTED
  evidence_digests: string[];                  // SORTED
  material_effect_digest: string;
  policy_digest: string;
  canonical_ref_oids: Record<string, string>;  // SORTED KEYS (repo_id)
  required_analysis_status: Record<
    string,
    'COMPLETE' | 'PARTIAL' | 'UNSUPPORTED' | 'FAILED'
  >;                                           // SORTED KEYS
}

export interface DecisionBasis extends CanonicalDecisionBasis {
  basis_digest: string; // Digest of CanonicalDecisionBasis
}

export interface Decision {
  id: string;
  objective_id: string;
  basis: DecisionBasis;
  state: 'DISCOVERED' | 'REVIEWABLE' | 'RESOLVABLE' | 'RESOLVED' | 'STALE';
  conditional_predicates: Predicate[]; // Typed predicates (no string parsing)
  resolved_by?: string;
  resolved_at?: string;
}

// --- SYSTEM REVISION ---
export interface CanonicalSystemRevisionState {
  repositories: Record<string, string>;         // SORTED KEYS (repo_id -> exact OID)
  configuration_digests: Record<string, string>;// SORTED KEYS
}

export interface CanonicalSystemRevisionRecord {
  state_digest: string;                         // Digest of CanonicalSystemRevisionState
  accepted_decision_ids: string[];              // SORTED
  composition_manifest: ProvenanceSlice[];      // SORTED by composite key
}

export interface SystemRevision extends CanonicalSystemRevisionRecord {
  id: string;
  state_digest: string;
  record_digest: string;                        // Digest of CanonicalSystemRevisionRecord
}

// --- RELEASE CONSTRAINTS ---
export interface CanonicalReleaseConstraints {
  system_revision_state_digest: string;         // Explicitly bound to state_digest
  ordering_constraints: OrderingConstraint[];   // SORTED by before + after refs
  compatibility_requirements: CompatibilityRequirement[]; // SORTED by subject + target refs
  preconditions: StateCondition[];              // SORTED by target ref
  postconditions: StateCondition[];             // SORTED by target ref
  forward_only_operations: ForwardOnlyOperation[]; // SORTED by resource ref
}

export interface ReleaseConstraints extends CanonicalReleaseConstraints {
  constraints_digest: string; // Digest of CanonicalReleaseConstraints
}

// --- DEPLOYMENT ATTESTATION ---
export interface CanonicalDeploymentAttestation {
  system_revision_state_digest: string;         // Explicitly bound to state_digest
  environment: string;
  deployer_identity: string;
  observed_state: 'SUBMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
  observed_repositories: Record<string, string>; // SORTED KEYS (repo_id -> observed commit OID)
  observed_configuration_digests: Record<string, string>; // SORTED KEYS
  payload_digest: string;                       // Exact attestation payload hash
}

export interface DeploymentAttestation extends CanonicalDeploymentAttestation {
  attestation_payload_ref: string; // R2 storage location (excluded from digest)
  verified_at: string;             // Excluded from digest
  attestation_digest: string;      // Digest of CanonicalDeploymentAttestation
}
