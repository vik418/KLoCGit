//! Digest architecture for KLoCGit v1 Enterprise Convergence Platform

use crate::cbor::{CborEncoder, CborValue};
use crate::sha256::Sha256;
use crate::types::*;

pub const SCHEMA_VERSION: &str = "v1";

pub mod domains {
    pub const FUTURE_REVISION_STATE: &str = "klocgit/future_revision_state";
    pub const FUTURE_REVISION_RECORD: &str = "klocgit/future_revision_record";
    pub const EFFECT_SET: &str = "klocgit/effect_set";
    pub const CANDIDATE_SPEC: &str = "klocgit/candidate_spec";
    pub const CANDIDATE: &str = "klocgit/candidate";
    pub const EVIDENCE: &str = "klocgit/evidence";
    pub const DECISION_BASIS: &str = "klocgit/decision_basis";
    pub const SYSTEM_REVISION_STATE: &str = "klocgit/system_revision_state";
    pub const SYSTEM_REVISION_RECORD: &str = "klocgit/system_revision_record";
    pub const RELEASE_CONSTRAINTS: &str = "klocgit/release_constraints";
    pub const DEPLOYMENT_ATTESTATION: &str = "klocgit/deployment_attestation";
    pub const PAYLOAD: &str = "klocgit/payload";
}

pub fn calculate_digest(domain: &str, schema_version: &str, value: &CborValue) -> String {
    let cbor_bytes = CborEncoder::encode(value);
    let header = format!("{}::{}::", domain, schema_version);
    let mut hasher = Sha256::new();
    hasher.update(header.as_bytes());
    hasher.update(&cbor_bytes);
    let hash = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in hash {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

pub fn compute_payload_digest(data: &[u8]) -> String {
    let header = format!("{}::{}::", domains::PAYLOAD, SCHEMA_VERSION);
    let mut hasher = Sha256::new();
    hasher.update(header.as_bytes());
    hasher.update(data);
    let hash = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in hash {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

pub fn compute_future_revision_state_digest(state: &CanonicalFutureRevisionState) -> String {
    calculate_digest(domains::FUTURE_REVISION_STATE, SCHEMA_VERSION, &state.to_cbor())
}

pub fn compute_future_revision_record_digest(rec: &CanonicalFutureRevisionRecord) -> String {
    calculate_digest(domains::FUTURE_REVISION_RECORD, SCHEMA_VERSION, &rec.to_cbor())
}

pub fn compute_effect_digest(effects: &CanonicalEffectSet) -> String {
    calculate_digest(domains::EFFECT_SET, SCHEMA_VERSION, &effects.to_cbor())
}

pub fn compute_candidate_spec_digest(spec: &CanonicalCandidateSpec) -> String {
    calculate_digest(domains::CANDIDATE_SPEC, SCHEMA_VERSION, &spec.to_cbor())
}

pub fn compute_candidate_digest(cand: &CanonicalCandidate) -> String {
    calculate_digest(domains::CANDIDATE, SCHEMA_VERSION, &cand.to_cbor())
}

pub fn compute_evidence_digest(ev: &CanonicalEvidence) -> String {
    calculate_digest(domains::EVIDENCE, SCHEMA_VERSION, &ev.to_cbor())
}

pub fn compute_decision_basis_digest(basis: &CanonicalDecisionBasis) -> String {
    calculate_digest(domains::DECISION_BASIS, SCHEMA_VERSION, &basis.to_cbor())
}

pub fn compute_system_revision_state_digest(state: &CanonicalSystemRevisionState) -> String {
    calculate_digest(domains::SYSTEM_REVISION_STATE, SCHEMA_VERSION, &state.to_cbor())
}

pub fn compute_system_revision_record_digest(rec: &CanonicalSystemRevisionRecord) -> String {
    calculate_digest(domains::SYSTEM_REVISION_RECORD, SCHEMA_VERSION, &rec.to_cbor())
}

pub fn compute_release_constraints_digest(constraints: &CanonicalReleaseConstraints) -> String {
    calculate_digest(domains::RELEASE_CONSTRAINTS, SCHEMA_VERSION, &constraints.to_cbor())
}

pub fn compute_deployment_attestation_digest(att: &CanonicalDeploymentAttestation) -> String {
    calculate_digest(domains::DEPLOYMENT_ATTESTATION, SCHEMA_VERSION, &att.to_cbor())
}
