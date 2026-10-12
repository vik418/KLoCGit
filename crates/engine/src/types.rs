//! Domain structures and Canonical Projections for KLoCGit v1 Enterprise Convergence Platform

use crate::cbor::{CborValue, sort_strings};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct ResourceRef {
    pub system_id: Option<String>,
    pub repo_id: String,
    pub resource_type: String,
    pub resource_id: String,
}

impl ResourceRef {
    pub fn to_cbor(&self) -> CborValue {
        let mut map = Vec::new();
        map.push(("repo_id".to_string(), CborValue::Text(self.repo_id.clone())));
        map.push(("resource_id".to_string(), CborValue::Text(self.resource_id.clone())));
        map.push(("resource_type".to_string(), CborValue::Text(self.resource_type.clone())));
        if let Some(ref sys) = self.system_id {
            map.push(("system_id".to_string(), CborValue::Text(sys.clone())));
        }
        CborValue::Map(map)
    }

    pub fn canonical_key(&self) -> String {
        format!("{}:{}:{}:{}", self.system_id.as_deref().unwrap_or(""), self.repo_id, self.resource_type, self.resource_id)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderingConstraint {
    pub before: ResourceRef,
    pub after: ResourceRef,
}

impl OrderingConstraint {
    pub fn to_cbor(&self) -> CborValue {
        CborValue::Map(vec![
            ("after".to_string(), self.after.to_cbor()),
            ("before".to_string(), self.before.to_cbor()),
        ])
    }

    pub fn canonical_key(&self) -> String {
        format!("{}#{}", self.before.canonical_key(), self.after.canonical_key())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompatibilityRequirement {
    pub subject: ResourceRef,
    pub target: ResourceRef,
    pub relation: String,
    pub version_constraint: Option<String>,
}

impl CompatibilityRequirement {
    pub fn to_cbor(&self) -> CborValue {
        let mut map = vec![
            ("relation".to_string(), CborValue::Text(self.relation.clone())),
            ("subject".to_string(), self.subject.to_cbor()),
            ("target".to_string(), self.target.to_cbor()),
        ];
        if let Some(ref vc) = self.version_constraint {
            map.push(("version_constraint".to_string(), CborValue::Text(vc.clone())));
        }
        CborValue::Map(map)
    }

    pub fn canonical_key(&self) -> String {
        format!("{}:{}#{}:{}#{}", self.subject.repo_id, self.subject.resource_id, self.target.repo_id, self.target.resource_id, self.relation)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StateCondition {
    pub target: ResourceRef,
    pub assertion: String,
    pub parameters: Option<BTreeMap<String, String>>,
}

impl StateCondition {
    pub fn to_cbor(&self) -> CborValue {
        let mut map = vec![
            ("assertion".to_string(), CborValue::Text(self.assertion.clone())),
            ("target".to_string(), self.target.to_cbor()),
        ];
        if let Some(ref params) = self.parameters {
            let p_map = params.iter().map(|(k, v)| (k.clone(), CborValue::Text(v.clone()))).collect();
            map.push(("parameters".to_string(), CborValue::Map(p_map)));
        }
        CborValue::Map(map)
    }

    pub fn canonical_key(&self) -> String {
        format!("{}:{}:{}", self.target.repo_id, self.target.resource_id, self.assertion)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ForwardOnlyOperation {
    pub resource: ResourceRef,
    pub operation: String,
    pub failure_policy: String,
}

impl ForwardOnlyOperation {
    pub fn to_cbor(&self) -> CborValue {
        CborValue::Map(vec![
            ("failure_policy".to_string(), CborValue::Text(self.failure_policy.clone())),
            ("operation".to_string(), CborValue::Text(self.operation.clone())),
            ("resource".to_string(), self.resource.to_cbor()),
        ])
    }

    pub fn canonical_key(&self) -> String {
        format!("{}:{}:{}", self.resource.repo_id, self.resource.resource_id, self.operation)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProvenanceSlice {
    pub repo_id: String,
    pub path: String,
    pub selector_type: String,
    pub selector_value: String,
    pub source_future_id: String,
    pub source_commit_oid: String,
}

impl ProvenanceSlice {
    pub fn to_cbor(&self) -> CborValue {
        CborValue::Map(vec![
            ("path".to_string(), CborValue::Text(self.path.clone())),
            ("repo_id".to_string(), CborValue::Text(self.repo_id.clone())),
            ("selector".to_string(), CborValue::Map(vec![
                ("type".to_string(), CborValue::Text(self.selector_type.clone())),
                ("value".to_string(), CborValue::Text(self.selector_value.clone())),
            ])),
            ("source_commit_oid".to_string(), CborValue::Text(self.source_commit_oid.clone())),
            ("source_future_id".to_string(), CborValue::Text(self.source_future_id.clone())),
        ])
    }

    pub fn canonical_key(&self) -> String {
        format!("{}:{}:{}:{}:{}:{}", self.repo_id, self.path, self.selector_type, self.selector_value, self.source_future_id, self.source_commit_oid)
    }
}

// ============================================================================
// CANONICAL DOMAIN TYPES
// ============================================================================

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalFutureRevisionState {
    pub repo_id: String,
    pub commit_oid: String,
    pub tree_oid: String,
    pub parent_oids: Vec<String>, // PRESERVE EXACT SEQUENCE
}

impl CanonicalFutureRevisionState {
    pub fn to_cbor(&self) -> CborValue {
        let parents = self.parent_oids.iter().map(|p| CborValue::Text(p.clone())).collect();
        CborValue::Map(vec![
            ("commit_oid".to_string(), CborValue::Text(self.commit_oid.clone())),
            ("parent_oids".to_string(), CborValue::Array(parents)),
            ("repo_id".to_string(), CborValue::Text(self.repo_id.clone())),
            ("tree_oid".to_string(), CborValue::Text(self.tree_oid.clone())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalFutureRevisionRecord {
    pub state_digest: String,
    pub system_id: String,
    pub ref_name: String,
    pub actor_id: String,
    pub agent_version: Option<String>,
    pub task_id: Option<String>,
    pub prompt_digest: Option<String>,
}

impl CanonicalFutureRevisionRecord {
    pub fn to_cbor(&self) -> CborValue {
        let mut producer = vec![
            ("actor_id".to_string(), CborValue::Text(self.actor_id.clone())),
        ];
        if let Some(ref av) = self.agent_version {
            producer.push(("agent_version".to_string(), CborValue::Text(av.clone())));
        }
        if let Some(ref pd) = self.prompt_digest {
            producer.push(("prompt_digest".to_string(), CborValue::Text(pd.clone())));
        }
        if let Some(ref tid) = self.task_id {
            producer.push(("task_id".to_string(), CborValue::Text(tid.clone())));
        }

        CborValue::Map(vec![
            ("producer".to_string(), CborValue::Map(producer)),
            ("ref".to_string(), CborValue::Text(self.ref_name.clone())),
            ("state_digest".to_string(), CborValue::Text(self.state_digest.clone())),
            ("system_id".to_string(), CborValue::Text(self.system_id.clone())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalEffectSet {
    pub future_revision_id: String,
    pub extractor_id: String,
    pub extractor_version: String,
    pub capability: String,
    pub status: String,
    pub modified_exports: Vec<String>,                 // MUST SORT
    pub added_dependencies: BTreeMap<String, String>,  // SORTED KEYS
    pub db_migrations_detected: bool,
    pub security_effects: Vec<String>,                 // MUST SORT
}

impl CanonicalEffectSet {
    pub fn to_cbor(&self) -> CborValue {
        let sorted_exports = sort_strings(self.modified_exports.clone());
        let sorted_security = sort_strings(self.security_effects.clone());

        let deps = self.added_dependencies.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();

        CborValue::Map(vec![
            ("added_dependencies".to_string(), CborValue::Map(deps)),
            ("capability".to_string(), CborValue::Text(self.capability.clone())),
            ("db_migrations_detected".to_string(), CborValue::Bool(self.db_migrations_detected)),
            ("extractor_id".to_string(), CborValue::Text(self.extractor_id.clone())),
            ("extractor_version".to_string(), CborValue::Text(self.extractor_version.clone())),
            ("future_revision_id".to_string(), CborValue::Text(self.future_revision_id.clone())),
            ("modified_exports".to_string(), CborValue::Array(sorted_exports.into_iter().map(CborValue::Text).collect())),
            ("security_effects".to_string(), CborValue::Array(sorted_security.into_iter().map(CborValue::Text).collect())),
            ("status".to_string(), CborValue::Text(self.status.clone())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalCandidateSpec {
    pub base_revisions: BTreeMap<String, String>,      // SORTED KEYS
    pub selected_future_revisions: Vec<String>,        // MUST SORT
    pub composition_manifest: Vec<ProvenanceSlice>,   // MUST SORT by composite key
    pub creation_reason: String,
}

impl CanonicalCandidateSpec {
    pub fn to_cbor(&self) -> CborValue {
        let base_map = self.base_revisions.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();
        let sorted_futures = sort_strings(self.selected_future_revisions.clone());
        
        let mut sorted_slices = self.composition_manifest.clone();
        sorted_slices.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        CborValue::Map(vec![
            ("base_revisions".to_string(), CborValue::Map(base_map)),
            ("composition_manifest".to_string(), CborValue::Array(sorted_slices.into_iter().map(|s| s.to_cbor()).collect())),
            ("creation_reason".to_string(), CborValue::Text(self.creation_reason.clone())),
            ("selected_future_revisions".to_string(), CborValue::Array(sorted_futures.into_iter().map(CborValue::Text).collect())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalCandidate {
    pub candidate_spec_id: String,
    pub repo_tree_oids: BTreeMap<String, String>, // SORTED KEYS
}

impl CanonicalCandidate {
    pub fn to_cbor(&self) -> CborValue {
        let tree_map = self.repo_tree_oids.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();
        CborValue::Map(vec![
            ("candidate_spec_id".to_string(), CborValue::Text(self.candidate_spec_id.clone())),
            ("repo_tree_oids".to_string(), CborValue::Map(tree_map)),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalEvidence {
    pub subject_digest: String,
    pub evaluator_id: String,
    pub evaluator_version: String,
    pub config_digest: String,
    pub environment_digest: String,
    pub result: String,
    pub payload_digest: String,
}

impl CanonicalEvidence {
    pub fn to_cbor(&self) -> CborValue {
        CborValue::Map(vec![
            ("config_digest".to_string(), CborValue::Text(self.config_digest.clone())),
            ("environment_digest".to_string(), CborValue::Text(self.environment_digest.clone())),
            ("evaluator_id".to_string(), CborValue::Text(self.evaluator_id.clone())),
            ("evaluator_version".to_string(), CborValue::Text(self.evaluator_version.clone())),
            ("payload_digest".to_string(), CborValue::Text(self.payload_digest.clone())),
            ("result".to_string(), CborValue::Text(self.result.clone())),
            ("subject_digest".to_string(), CborValue::Text(self.subject_digest.clone())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalDecisionBasis {
    pub candidate_digests: Vec<String>,                // MUST SORT
    pub evidence_digests: Vec<String>,                 // MUST SORT
    pub material_effect_digest: String,
    pub policy_digest: String,
    pub canonical_ref_oids: BTreeMap<String, String>,  // SORTED KEYS
    pub required_analysis_status: BTreeMap<String, String>, // SORTED KEYS
}

impl CanonicalDecisionBasis {
    pub fn to_cbor(&self) -> CborValue {
        let sorted_cands = sort_strings(self.candidate_digests.clone());
        let sorted_evs = sort_strings(self.evidence_digests.clone());
        let ref_map = self.canonical_ref_oids.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();
        let status_map = self.required_analysis_status.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();

        CborValue::Map(vec![
            ("candidate_digests".to_string(), CborValue::Array(sorted_cands.into_iter().map(CborValue::Text).collect())),
            ("canonical_ref_oids".to_string(), CborValue::Map(ref_map)),
            ("evidence_digests".to_string(), CborValue::Array(sorted_evs.into_iter().map(CborValue::Text).collect())),
            ("material_effect_digest".to_string(), CborValue::Text(self.material_effect_digest.clone())),
            ("policy_digest".to_string(), CborValue::Text(self.policy_digest.clone())),
            ("required_analysis_status".to_string(), CborValue::Map(status_map)),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalSystemRevisionState {
    pub repositories: BTreeMap<String, String>,         // SORTED KEYS
    pub configuration_digests: BTreeMap<String, String>,// SORTED KEYS
}

impl CanonicalSystemRevisionState {
    pub fn to_cbor(&self) -> CborValue {
        let repo_map = self.repositories.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();
        let cfg_map = self.configuration_digests.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();

        CborValue::Map(vec![
            ("configuration_digests".to_string(), CborValue::Map(cfg_map)),
            ("repositories".to_string(), CborValue::Map(repo_map)),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalSystemRevisionRecord {
    pub state_digest: String,
    pub accepted_decision_ids: Vec<String>,             // MUST SORT
    pub composition_manifest: Vec<ProvenanceSlice>,     // MUST SORT by composite key
}

impl CanonicalSystemRevisionRecord {
    pub fn to_cbor(&self) -> CborValue {
        let sorted_decisions = sort_strings(self.accepted_decision_ids.clone());
        let mut sorted_slices = self.composition_manifest.clone();
        sorted_slices.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        CborValue::Map(vec![
            ("accepted_decision_ids".to_string(), CborValue::Array(sorted_decisions.into_iter().map(CborValue::Text).collect())),
            ("composition_manifest".to_string(), CborValue::Array(sorted_slices.into_iter().map(|s| s.to_cbor()).collect())),
            ("state_digest".to_string(), CborValue::Text(self.state_digest.clone())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalReleaseConstraints {
    pub system_revision_state_digest: String,
    pub ordering_constraints: Vec<OrderingConstraint>,
    pub compatibility_requirements: Vec<CompatibilityRequirement>,
    pub preconditions: Vec<StateCondition>,
    pub postconditions: Vec<StateCondition>,
    pub forward_only_operations: Vec<ForwardOnlyOperation>,
}

impl CanonicalReleaseConstraints {
    pub fn to_cbor(&self) -> CborValue {
        let mut orderings = self.ordering_constraints.clone();
        orderings.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        let mut compat = self.compatibility_requirements.clone();
        compat.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        let mut pre = self.preconditions.clone();
        pre.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        let mut post = self.postconditions.clone();
        post.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        let mut ops = self.forward_only_operations.clone();
        ops.sort_by(|a, b| a.canonical_key().cmp(&b.canonical_key()));

        CborValue::Map(vec![
            ("compatibility_requirements".to_string(), CborValue::Array(compat.into_iter().map(|c| c.to_cbor()).collect())),
            ("forward_only_operations".to_string(), CborValue::Array(ops.into_iter().map(|o| o.to_cbor()).collect())),
            ("ordering_constraints".to_string(), CborValue::Array(orderings.into_iter().map(|o| o.to_cbor()).collect())),
            ("postconditions".to_string(), CborValue::Array(post.into_iter().map(|p| p.to_cbor()).collect())),
            ("preconditions".to_string(), CborValue::Array(pre.into_iter().map(|p| p.to_cbor()).collect())),
            ("system_revision_state_digest".to_string(), CborValue::Text(self.system_revision_state_digest.clone())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalDeploymentAttestation {
    pub system_revision_state_digest: String,
    pub environment: String,
    pub deployer_identity: String,
    pub observed_state: String,
    pub observed_repositories: BTreeMap<String, String>,
    pub observed_configuration_digests: BTreeMap<String, String>,
    pub payload_digest: String,
}

impl CanonicalDeploymentAttestation {
    pub fn to_cbor(&self) -> CborValue {
        let repo_map = self.observed_repositories.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();
        let cfg_map = self.observed_configuration_digests.iter()
            .map(|(k, v)| (k.clone(), CborValue::Text(v.clone())))
            .collect();

        CborValue::Map(vec![
            ("deployer_identity".to_string(), CborValue::Text(self.deployer_identity.clone())),
            ("environment".to_string(), CborValue::Text(self.environment.clone())),
            ("observed_configuration_digests".to_string(), CborValue::Map(cfg_map)),
            ("observed_repositories".to_string(), CborValue::Map(repo_map)),
            ("observed_state".to_string(), CborValue::Text(self.observed_state.clone())),
            ("payload_digest".to_string(), CborValue::Text(self.payload_digest.clone())),
            ("system_revision_state_digest".to_string(), CborValue::Text(self.system_revision_state_digest.clone())),
        ])
    }
}
