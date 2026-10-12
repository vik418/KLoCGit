//! Canonical projections separate software state from records and stored bytes.

use crate::{canonical, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

macro_rules! record {
    ($name:ident, $projection:ident, { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        pub struct $name {
            #[serde(flatten)]
            pub canonical: $projection,
            $(pub $field: $ty),*
        }
        impl std::ops::Deref for $name {
            type Target = $projection;
            fn deref(&self) -> &Self::Target { &self.canonical }
        }
        impl std::ops::DerefMut for $name {
            fn deref_mut(&mut self) -> &mut Self::Target { &mut self.canonical }
        }
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType { Service, Database, Migration, Infrastructure, Package }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_id: Option<String>,
    pub repo_id: String,
    pub resource_type: ResourceType,
    pub resource_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderingConstraint { pub before: ResourceRef, pub after: ResourceRef }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CompatibilityRelation { Compatible, Requires, Conflicts }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityRequirement {
    pub subject: ResourceRef, pub target: ResourceRef, pub relation: CompatibilityRelation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_constraint: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Assertion { Exists, Healthy, Migrated, Absent }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateCondition {
    pub target: ResourceRef, pub assertion: Assertion,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailurePolicy { Abort, ManualIntervention }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForwardOnlyOperation {
    pub resource: ResourceRef, pub operation: String, pub failure_policy: FailurePolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PredicateKind { EvidencePassed, AnalysisComplete, CandidateUnchanged, EffectsUnchanged }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Predicate {
    pub kind: PredicateKind, pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectorType { Hunk, Symbol, ByteRange, File }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Selector { pub r#type: SelectorType, pub value: String }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceSlice {
    pub repo_id: String, pub path: String, pub selector: Selector,
    pub source_future_id: String, pub source_commit_oid: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Producer {
    pub actor_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_digest: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalFutureRevisionState {
    pub repo_id: String, pub commit_oid: String, pub tree_oid: String, pub parent_oids: Vec<String>,
}

impl CanonicalFutureRevisionState {
    pub fn state_digest(&self) -> Result<String> {
        validate_oid(&self.commit_oid)?; validate_oid(&self.tree_oid)?;
        for oid in &self.parent_oids { validate_oid(oid)?; }
        if self.repo_id.is_empty() { return Err(Error::InvalidInput("missing repository".into())); }
        canonical::hash_projection("klocgit.future-revision.state", self)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalFutureRevisionRecord {
    pub state_digest: String, pub system_id: String, pub r#ref: String, pub producer: Producer,
}
record!(FutureRevision, CanonicalFutureRevisionRecord, {
    id: String, record_digest: String, observed_at: String,
});

impl FutureRevision {
    pub fn seal(&mut self, state: &CanonicalFutureRevisionState) -> Result<()> {
        self.canonical.state_digest = state.state_digest()?;
        validate_digest(&self.state_digest)?;
        if self.system_id.is_empty() || self.producer.actor_id.is_empty()
            || !self.r#ref.starts_with("refs/futures/") || self.r#ref.split('/').count() < 4
            || canonical::nfc(&self.r#ref) != self.r#ref
            || !git2::Reference::is_valid_name(&self.r#ref) {
            return Err(Error::InvalidInput("invalid FutureRevision".into()));
        }
        if let Some(value) = &self.producer.prompt_digest { validate_digest(value)?; }
        self.record_digest = canonical::hash_projection("klocgit.future-revision.record", &self.canonical)?;
        self.id = self.record_digest.clone();
        Ok(())
    }
    pub fn verify(&self, state: &CanonicalFutureRevisionState) -> Result<()> {
        let mut expected = self.clone(); expected.seal(state)?;
        if self.state_digest != expected.state_digest || self.record_digest != expected.record_digest || self.id != expected.id { return Err(Error::RevisionMismatch); }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Capability { Path, Structural, Semantic }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AnalysisStatus { Complete, Partial, Unsupported, Failed }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language { Typescript, Python, Go }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalEffectSet {
    pub future_revision_id: String, pub extractor_id: String, pub extractor_version: String,
    pub capability: Capability, pub status: AnalysisStatus, pub modified_exports: Vec<String>,
    pub added_dependencies: BTreeMap<String, String>, pub db_migrations_detected: bool, pub security_effects: Vec<String>,
}
record!(EffectSet, CanonicalEffectSet, { effect_digest: String });

impl EffectSet {
    pub fn seal(&mut self) -> Result<()> {
        if self.future_revision_id.is_empty() || self.extractor_id.is_empty() || self.extractor_version.is_empty() { return Err(Error::InvalidInput("missing effect input identity".into())); }
        normalize_set(&mut self.canonical.modified_exports); normalize_set(&mut self.canonical.security_effects);
        normalize_map(&mut self.canonical.added_dependencies)?;
        self.effect_digest = canonical::hash_projection("klocgit.effect-set", &self.canonical)?;
        Ok(())
    }
    pub fn can_auto_resolve(&self) -> bool {
        self.status == AnalysisStatus::Complete && canonical::hash_projection("klocgit.effect-set", &self.canonical).is_ok_and(|value| value == self.effect_digest)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalCandidateSpec {
    pub base_revisions: BTreeMap<String, String>, pub selected_future_revisions: Vec<String>,
    pub composition_manifest: Vec<ProvenanceSlice>, pub creation_reason: String,
}
record!(CandidateSpec, CanonicalCandidateSpec, { id: String, effect_summary_digest: String, spec_digest: String });

impl CandidateSpec {
    pub fn seal(&mut self) -> Result<()> {
        normalize_map(&mut self.canonical.base_revisions)?;
        for oid in self.base_revisions.values() { validate_oid(oid)?; }
        normalize_set(&mut self.canonical.selected_future_revisions);
        normalize_manifest(&mut self.canonical.composition_manifest)?;
        if self.base_revisions.is_empty() || self.selected_future_revisions.is_empty() || self.creation_reason.is_empty()
            || self.composition_manifest.iter().any(|slice| (!self.selected_future_revisions.contains(&slice.source_future_id) || !self.base_revisions.contains_key(&slice.repo_id))) {
            return Err(Error::InvalidInput("invalid candidate selection".into()));
        }
        validate_digest(&self.effect_summary_digest)?;
        self.spec_digest = canonical::hash_projection("klocgit.candidate-spec", &self.canonical)?;
        self.id = self.spec_digest.clone();
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalCandidate { pub candidate_spec_id: String, pub repo_tree_oids: BTreeMap<String, String> }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterializationRecord { pub executor_id: String, pub materialized_at: String, pub conflicts_encountered: Vec<String> }
record!(Candidate, CanonicalCandidate, { id: String, candidate_digest: String, materialization_record: MaterializationRecord });

impl Candidate {
    pub fn seal(&mut self) -> Result<()> {
        normalize_map(&mut self.canonical.repo_tree_oids)?;
        if self.repo_tree_oids.is_empty() || self.candidate_spec_id.is_empty() { return Err(Error::InvalidInput("empty candidate state".into())); }
        for oid in self.repo_tree_oids.values() { validate_oid(oid)?; }
        self.candidate_digest = canonical::hash_projection("klocgit.candidate", &self.canonical)?;
        self.id = self.candidate_digest.clone();
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EvidenceResult { Passed, Failed, Error }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RetentionClass { Ephemeral, Rebuildable, DecisionRecord, Canonical }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalEvidence {
    pub subject_digest: String, pub evaluator_id: String, pub evaluator_version: String,
    pub config_digest: String, pub environment_digest: String, pub result: EvidenceResult, pub payload_digest: String,
}
record!(Evidence, CanonicalEvidence, { id: String, payload_ref: String, retention_class: RetentionClass, created_at: String, evidence_digest: String });

impl Evidence {
    pub fn seal(&mut self) -> Result<()> {
        for value in [&self.subject_digest, &self.config_digest, &self.environment_digest, &self.payload_digest] { validate_digest(value)?; }
        if self.evaluator_id.is_empty() || self.evaluator_version.is_empty() { return Err(Error::InvalidInput("missing evaluator identity".into())); }
        self.evidence_digest = canonical::hash_projection("klocgit.evidence", &self.canonical)?;
        self.id = self.evidence_digest.clone();
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalDecisionBasis {
    pub candidate_digests: Vec<String>, pub evidence_digests: Vec<String>,
    pub material_effect_digest: String, pub policy_digest: String,
    pub canonical_ref_oids: BTreeMap<String, String>, pub required_analysis_status: BTreeMap<String, AnalysisStatus>,
}
record!(DecisionBasis, CanonicalDecisionBasis, { basis_digest: String });

impl DecisionBasis {
    pub fn seal(&mut self) -> Result<()> {
        normalize_set(&mut self.canonical.candidate_digests); normalize_set(&mut self.canonical.evidence_digests);
        normalize_map(&mut self.canonical.canonical_ref_oids)?; normalize_keyed(&mut self.canonical.required_analysis_status)?;
        for value in self.candidate_digests.iter().chain(&self.evidence_digests).chain([&self.material_effect_digest, &self.policy_digest]) { validate_digest(value)?; }
        for oid in self.canonical_ref_oids.values() { validate_oid(oid)?; }
        self.basis_digest = canonical::hash_projection("klocgit.decision-basis", &self.canonical)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DecisionState { Discovered, Reviewable, Resolvable, Resolved, Stale }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub id: String, pub objective_id: String, pub basis: DecisionBasis, pub state: DecisionState,
    pub conditional_predicates: Vec<Predicate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalSystemRevisionState { pub repositories: BTreeMap<String, String>, pub configuration_digests: BTreeMap<String, String> }
impl CanonicalSystemRevisionState {
    pub fn state_digest(&self) -> Result<String> {
        if self.repositories.is_empty() { return Err(Error::InvalidInput("empty system state".into())); }
        for oid in self.repositories.values() { validate_oid(oid)?; }
        for value in self.configuration_digests.values() { validate_digest(value)?; }
        canonical::hash_projection("klocgit.system-revision.state", self)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalSystemRevisionRecord {
    pub state_digest: String, pub accepted_decision_ids: Vec<String>, pub composition_manifest: Vec<ProvenanceSlice>,
}
record!(SystemRevision, CanonicalSystemRevisionRecord, { id: String, record_digest: String });
impl SystemRevision {
    pub fn seal(&mut self, state: &CanonicalSystemRevisionState) -> Result<()> {
        self.canonical.state_digest = state.state_digest()?;
        normalize_set(&mut self.canonical.accepted_decision_ids); normalize_manifest(&mut self.canonical.composition_manifest)?;
        self.record_digest = canonical::hash_projection("klocgit.system-revision.record", &self.canonical)?;
        self.id = self.record_digest.clone();
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalReleaseConstraints {
    pub system_revision_state_digest: String, pub ordering_constraints: Vec<OrderingConstraint>,
    pub compatibility_requirements: Vec<CompatibilityRequirement>, pub preconditions: Vec<StateCondition>,
    pub postconditions: Vec<StateCondition>, pub forward_only_operations: Vec<ForwardOnlyOperation>,
}
record!(ReleaseConstraints, CanonicalReleaseConstraints, { constraints_digest: String });
impl ReleaseConstraints {
    pub fn seal(&mut self) -> Result<()> {
        validate_digest(&self.system_revision_state_digest)?;
        sort_composite(&mut self.canonical.ordering_constraints, |v| [resource_key(&v.before), resource_key(&v.after)].concat())?;
        sort_composite(&mut self.canonical.compatibility_requirements, |v| [resource_key(&v.subject), resource_key(&v.target)].concat())?;
        sort_composite(&mut self.canonical.preconditions, |v| resource_key(&v.target))?;
        sort_composite(&mut self.canonical.postconditions, |v| resource_key(&v.target))?;
        sort_composite(&mut self.canonical.forward_only_operations, |v| resource_key(&v.resource))?;
        self.constraints_digest = canonical::hash_projection("klocgit.release-constraints", &self.canonical)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeploymentState { Submitted, Running, Succeeded, Failed, Cancelled, Unknown }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalDeploymentAttestation {
    pub system_revision_state_digest: String, pub environment: String, pub deployer_identity: String,
    pub observed_state: DeploymentState, pub observed_repositories: BTreeMap<String, String>,
    pub observed_configuration_digests: BTreeMap<String, String>, pub payload_digest: String,
}
record!(DeploymentAttestation, CanonicalDeploymentAttestation, { attestation_payload_ref: String, verified_at: String, attestation_digest: String });
impl DeploymentAttestation {
    pub fn seal(&mut self) -> Result<()> {
        validate_digest(&self.system_revision_state_digest)?; validate_digest(&self.payload_digest)?;
        normalize_map(&mut self.canonical.observed_repositories)?; normalize_map(&mut self.canonical.observed_configuration_digests)?;
        for oid in self.observed_repositories.values() { validate_oid(oid)?; }
        for value in self.observed_configuration_digests.values() { validate_digest(value)?; }
        self.attestation_digest = canonical::hash_projection("klocgit.deployment-attestation", &self.canonical)?;
        Ok(())
    }
}

pub fn normalize_set(values: &mut Vec<String>) {
    for value in values.iter_mut() { *value = canonical::nfc(value); }
    values.sort(); values.dedup();
}
fn normalize_keyed<T>(values: &mut BTreeMap<String, T>) -> Result<()> {
    let mut normalized = BTreeMap::new();
    for (key, value) in std::mem::take(values) {
        if normalized.insert(canonical::nfc(&key), value).is_some() { return Err(Error::InvalidInput("NFC key collision".into())); }
    }
    *values = normalized;
    Ok(())
}
fn normalize_map(values: &mut BTreeMap<String, String>) -> Result<()> {
    normalize_keyed(values)?;
    for value in values.values_mut() { *value = canonical::nfc(value); }
    Ok(())
}
fn normalize_manifest(values: &mut Vec<ProvenanceSlice>) -> Result<()> {
    for value in values.iter_mut() {
        validate_oid(&value.source_commit_oid)?;
        value.repo_id = canonical::nfc(&value.repo_id);
        value.path = canonical::nfc(&value.path);
        value.selector.value = canonical::nfc(&value.selector.value);
        value.source_future_id = canonical::nfc(&value.source_future_id);
    }
    sort_composite(values, |v| vec![
        canonical::nfc(&v.repo_id), canonical::nfc(&v.path),
        serde_json::to_value(v.selector.r#type).unwrap().as_str().unwrap().into(),
        canonical::nfc(&v.selector.value),
    ])
}
fn resource_key(value: &ResourceRef) -> Vec<String> {
    vec![canonical::nfc(value.system_id.as_deref().unwrap_or("")), canonical::nfc(&value.repo_id),
        serde_json::to_value(value.resource_type).unwrap().as_str().unwrap().into(), canonical::nfc(&value.resource_id)]
}
fn sort_composite<T: Serialize>(values: &mut Vec<T>, key: impl Fn(&T) -> Vec<String>) -> Result<()> {
    let mut decorated = Vec::with_capacity(values.len());
    for value in std::mem::take(values) {
        let stable_key = key(&value); let bytes = canonical::encode(&value)?;
        decorated.push((stable_key, bytes, value));
    }
    decorated.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    *values = decorated.into_iter().map(|(_, _, value)| value).collect();
    Ok(())
}
pub fn validate_oid(oid: &str) -> Result<()> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) { return Err(Error::InvalidInput("invalid Git OID".into())); }
    Ok(())
}
pub fn validate_digest(value: &str) -> Result<()> {
    if value.strip_prefix("sha256:").is_none_or(|hex| hex.len() != 64 || !hex.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))) { return Err(Error::InvalidInput("invalid digest".into())); }
    Ok(())
}
