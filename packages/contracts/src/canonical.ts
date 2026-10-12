import { encodeCBOR, sortKeyedRecord, sortStrings } from './cbor.ts';
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
  ProvenanceSlice,
  OrderingConstraint,
  CompatibilityRequirement,
  StateCondition,
  ForwardOnlyOperation,
} from './types.ts';

// Composite structure sorting
export function sortProvenanceSlices(slices: ProvenanceSlice[]): ProvenanceSlice[] {
  return [...slices].sort((a, b) => {
    const keyA = `${a.repo_id}:${a.path}:${a.selector.type}:${a.selector.value}:${a.source_future_id}:${a.source_commit_oid}`;
    const keyB = `${b.repo_id}:${b.path}:${b.selector.type}:${b.selector.value}:${b.source_future_id}:${b.source_commit_oid}`;
    return keyA.localeCompare(keyB);
  });
}

export function sortOrderingConstraints(constraints: OrderingConstraint[]): OrderingConstraint[] {
  return [...constraints].sort((a, b) => {
    const keyA = `${a.before.system_id || ''}:${a.before.repo_id}:${a.before.resource_type}:${a.before.resource_id}#${a.after.system_id || ''}:${a.after.repo_id}:${a.after.resource_type}:${a.after.resource_id}`;
    const keyB = `${b.before.system_id || ''}:${b.before.repo_id}:${b.before.resource_type}:${b.before.resource_id}#${b.after.system_id || ''}:${b.after.repo_id}:${b.after.resource_type}:${b.after.resource_id}`;
    return keyA.localeCompare(keyB);
  });
}

export function sortCompatibilityRequirements(reqs: CompatibilityRequirement[]): CompatibilityRequirement[] {
  return [...reqs].sort((a, b) => {
    const keyA = `${a.subject.repo_id}:${a.subject.resource_id}#${a.target.repo_id}:${a.target.resource_id}#${a.relation}`;
    const keyB = `${b.subject.repo_id}:${b.subject.resource_id}#${b.target.repo_id}:${b.target.resource_id}#${b.relation}`;
    return keyA.localeCompare(keyB);
  });
}

export function sortStateConditions(conditions: StateCondition[]): StateCondition[] {
  return [...conditions].sort((a, b) => {
    const keyA = `${a.target.repo_id}:${a.target.resource_id}:${a.assertion}`;
    const keyB = `${b.target.repo_id}:${b.target.resource_id}:${b.assertion}`;
    return keyA.localeCompare(keyB);
  });
}

export function sortForwardOnlyOperations(ops: ForwardOnlyOperation[]): ForwardOnlyOperation[] {
  return [...ops].sort((a, b) => {
    const keyA = `${a.resource.repo_id}:${a.resource.resource_id}:${a.operation}`;
    const keyB = `${b.resource.repo_id}:${b.resource.resource_id}:${b.operation}`;
    return keyA.localeCompare(keyB);
  });
}

// ============================================================================
// CANONICAL PROJECTIONS
// ============================================================================

export function projectFutureRevisionState(input: {
  repo_id: string;
  commit_oid: string;
  tree_oid: string;
  parent_oids: string[];
}): CanonicalFutureRevisionState {
  return {
    commit_oid: input.commit_oid,
    parent_oids: [...input.parent_oids], // PRESERVE EXACT GIT PARENT ORDER
    repo_id: input.repo_id,
    tree_oid: input.tree_oid,
  };
}

export function projectFutureRevisionRecord(
  input: CanonicalFutureRevisionRecord | FutureRevision
): CanonicalFutureRevisionRecord {
  return {
    producer: {
      actor_id: input.producer.actor_id,
      ...(input.producer.agent_version ? { agent_version: input.producer.agent_version } : {}),
      ...(input.producer.prompt_digest ? { prompt_digest: input.producer.prompt_digest } : {}),
      ...(input.producer.task_id ? { task_id: input.producer.task_id } : {}),
    },
    ref: input.ref,
    state_digest: input.state_digest,
    system_id: input.system_id,
  };
}

export function projectEffectSet(input: CanonicalEffectSet | EffectSet): CanonicalEffectSet {
  return {
    added_dependencies: sortKeyedRecord(input.added_dependencies),
    capability: input.capability,
    db_migrations_detected: Boolean(input.db_migrations_detected),
    extractor_id: input.extractor_id,
    extractor_version: input.extractor_version,
    future_revision_id: input.future_revision_id,
    modified_exports: sortStrings(input.modified_exports),
    security_effects: sortStrings(input.security_effects),
    status: input.status,
  };
}

export function projectCandidateSpec(
  input: CanonicalCandidateSpec | CandidateSpec
): CanonicalCandidateSpec {
  return {
    base_revisions: sortKeyedRecord(input.base_revisions),
    composition_manifest: sortProvenanceSlices(input.composition_manifest),
    creation_reason: input.creation_reason,
    selected_future_revisions: sortStrings(input.selected_future_revisions),
  };
}

export function projectCandidate(input: CanonicalCandidate | Candidate): CanonicalCandidate {
  return {
    candidate_spec_id: input.candidate_spec_id,
    repo_tree_oids: sortKeyedRecord(input.repo_tree_oids),
  };
}

export function projectEvidence(input: CanonicalEvidence | Evidence): CanonicalEvidence {
  return {
    config_digest: input.config_digest,
    environment_digest: input.environment_digest,
    evaluator_id: input.evaluator_id,
    evaluator_version: input.evaluator_version,
    payload_digest: input.payload_digest,
    result: input.result,
    subject_digest: input.subject_digest,
  };
}

export function projectDecisionBasis(
  input: CanonicalDecisionBasis | DecisionBasis
): CanonicalDecisionBasis {
  return {
    candidate_digests: sortStrings(input.candidate_digests),
    canonical_ref_oids: sortKeyedRecord(input.canonical_ref_oids),
    evidence_digests: sortStrings(input.evidence_digests),
    material_effect_digest: input.material_effect_digest,
    policy_digest: input.policy_digest,
    required_analysis_status: sortKeyedRecord(input.required_analysis_status),
  };
}

export function projectSystemRevisionState(
  input: CanonicalSystemRevisionState
): CanonicalSystemRevisionState {
  return {
    configuration_digests: sortKeyedRecord(input.configuration_digests),
    repositories: sortKeyedRecord(input.repositories),
  };
}

export function projectSystemRevisionRecord(
  input: CanonicalSystemRevisionRecord | SystemRevision
): CanonicalSystemRevisionRecord {
  return {
    accepted_decision_ids: sortStrings(input.accepted_decision_ids),
    composition_manifest: sortProvenanceSlices(input.composition_manifest),
    state_digest: input.state_digest,
  };
}

export function projectReleaseConstraints(
  input: CanonicalReleaseConstraints | ReleaseConstraints
): CanonicalReleaseConstraints {
  return {
    compatibility_requirements: sortCompatibilityRequirements(input.compatibility_requirements),
    forward_only_operations: sortForwardOnlyOperations(input.forward_only_operations),
    ordering_constraints: sortOrderingConstraints(input.ordering_constraints),
    postconditions: sortStateConditions(input.postconditions),
    preconditions: sortStateConditions(input.preconditions),
    system_revision_state_digest: input.system_revision_state_digest,
  };
}

export function projectDeploymentAttestation(
  input: CanonicalDeploymentAttestation | DeploymentAttestation
): CanonicalDeploymentAttestation {
  return {
    deployer_identity: input.deployer_identity,
    environment: input.environment,
    observed_configuration_digests: sortKeyedRecord(input.observed_configuration_digests),
    observed_repositories: sortKeyedRecord(input.observed_repositories),
    observed_state: input.observed_state,
    payload_digest: input.payload_digest,
    system_revision_state_digest: input.system_revision_state_digest,
  };
}
