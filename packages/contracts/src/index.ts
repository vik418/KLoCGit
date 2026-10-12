export type AnalysisStatus = 'COMPLETE' | 'PARTIAL' | 'UNSUPPORTED' | 'FAILED';

export interface ResourceRef {
  system_id?: string;
  repo_id: string;
  resource_type: 'service' | 'database' | 'migration' | 'infrastructure' | 'package';
  resource_id: string;
}
export interface OrderingConstraint { before: ResourceRef; after: ResourceRef }
export interface CompatibilityRequirement {
  subject: ResourceRef; target: ResourceRef;
  relation: 'COMPATIBLE' | 'REQUIRES' | 'CONFLICTS';
  version_constraint?: string;
}
export interface StateCondition {
  target: ResourceRef; assertion: 'EXISTS' | 'HEALTHY' | 'MIGRATED' | 'ABSENT';
  parameters?: Record<string, string>;
}
export interface ForwardOnlyOperation {
  resource: ResourceRef; operation: string;
  failure_policy: 'ABORT' | 'MANUAL_INTERVENTION';
}
export interface Predicate {
  kind: 'EVIDENCE_PASSED' | 'ANALYSIS_COMPLETE' | 'CANDIDATE_UNCHANGED' | 'EFFECTS_UNCHANGED';
  subject: string; expected?: string;
}
export interface ProvenanceSlice {
  repo_id: string; path: string;
  selector: { type: 'hunk' | 'symbol' | 'byte_range' | 'file'; value: string };
  source_future_id: string; source_commit_oid: string;
}
export interface Producer {
  actor_id: string; agent_version?: string; task_id?: string; prompt_digest?: string;
}
export interface CanonicalFutureRevisionState {
  repo_id: string; commit_oid: string; tree_oid: string; parent_oids: string[];
}
export interface CanonicalFutureRevisionRecord {
  state_digest: string; system_id: string; ref: string; producer: Producer;
}
export interface FutureRevision extends CanonicalFutureRevisionRecord {
  id: string; record_digest: string; observed_at: string;
}
export interface CanonicalEffectSet {
  future_revision_id: string; extractor_id: string; extractor_version: string;
  capability: 'PATH' | 'STRUCTURAL' | 'SEMANTIC'; status: AnalysisStatus;
  modified_exports: string[]; added_dependencies: Record<string, string>;
  db_migrations_detected: boolean; security_effects: string[];
}
export interface EffectSet extends CanonicalEffectSet { effect_digest: string }
export interface CanonicalCandidateSpec {
  base_revisions: Record<string, string>; selected_future_revisions: string[];
  composition_manifest: ProvenanceSlice[]; creation_reason: string;
}
export interface CandidateSpec extends CanonicalCandidateSpec {
  id: string; effect_summary_digest: string; spec_digest: string;
}
export interface CanonicalCandidate {
  candidate_spec_id: string; repo_tree_oids: Record<string, string>;
}
export interface Candidate extends CanonicalCandidate {
  id: string; candidate_digest: string;
  materialization_record: { executor_id: string; materialized_at: string; conflicts_encountered: string[] };
}
export interface CanonicalEvidence {
  subject_digest: string; evaluator_id: string; evaluator_version: string;
  config_digest: string; environment_digest: string;
  result: 'PASSED' | 'FAILED' | 'ERROR'; payload_digest: string;
}
export interface Evidence extends CanonicalEvidence {
  id: string; payload_ref: string;
  retention_class: 'EPHEMERAL' | 'REBUILDABLE' | 'DECISION_RECORD' | 'CANONICAL';
  created_at: string; evidence_digest: string;
}
export interface CanonicalDecisionBasis {
  candidate_digests: string[]; evidence_digests: string[];
  material_effect_digest: string; policy_digest: string;
  canonical_ref_oids: Record<string, string>;
  required_analysis_status: Record<string, AnalysisStatus>;
}
export interface DecisionBasis extends CanonicalDecisionBasis { basis_digest: string }
export interface Decision {
  id: string; objective_id: string; basis: DecisionBasis;
  state: 'DISCOVERED' | 'REVIEWABLE' | 'RESOLVABLE' | 'RESOLVED' | 'STALE';
  conditional_predicates: Predicate[]; resolved_by?: string; resolved_at?: string;
}
export interface CanonicalSystemRevisionState {
  repositories: Record<string, string>; configuration_digests: Record<string, string>;
}
export interface CanonicalSystemRevisionRecord {
  state_digest: string; accepted_decision_ids: string[]; composition_manifest: ProvenanceSlice[];
}
export interface SystemRevision extends CanonicalSystemRevisionRecord { id: string; record_digest: string }
export interface CanonicalReleaseConstraints {
  system_revision_state_digest: string; ordering_constraints: OrderingConstraint[];
  compatibility_requirements: CompatibilityRequirement[]; preconditions: StateCondition[];
  postconditions: StateCondition[]; forward_only_operations: ForwardOnlyOperation[];
}
export interface ReleaseConstraints extends CanonicalReleaseConstraints { constraints_digest: string }
export interface CanonicalDeploymentAttestation {
  system_revision_state_digest: string; environment: string; deployer_identity: string;
  observed_state: 'SUBMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
  observed_repositories: Record<string, string>; observed_configuration_digests: Record<string, string>;
  payload_digest: string;
}
export interface DeploymentAttestation extends CanonicalDeploymentAttestation {
  attestation_payload_ref: string; verified_at: string; attestation_digest: string;
}

export * from './canonical.ts';
