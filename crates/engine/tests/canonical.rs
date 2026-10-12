use klocgit_engine::canonical::{encode, hash_projection, payload_digest};
use klocgit_engine::contracts::*;
use std::collections::BTreeMap;

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() }
fn sha(byte: &str) -> String { format!("sha256:{}", byte.repeat(64)) }
fn state() -> CanonicalFutureRevisionState {
    CanonicalFutureRevisionState { repo_id: "repo".into(), commit_oid: "a".repeat(40), tree_oid: "b".repeat(40), parent_oids: vec!["c".repeat(40), "d".repeat(40)] }
}
fn revision() -> FutureRevision {
    let mut value = FutureRevision {
        canonical: CanonicalFutureRevisionRecord {
            state_digest: String::new(), system_id: "system".into(), r#ref: "refs/futures/agent/work".into(),
            producer: Producer { actor_id: "agent".into(), agent_version: None, task_id: None, prompt_digest: None },
        },
        id: String::new(), record_digest: String::new(), observed_at: "2026-01-01T00:00:00Z".into(),
    };
    value.seal(&state()).unwrap(); value
}
fn slice(path: &str, future: &str) -> ProvenanceSlice {
    ProvenanceSlice { repo_id: "repo".into(), path: path.into(), selector: Selector { r#type: SelectorType::File, value: path.into() }, source_future_id: future.into(), source_commit_oid: "a".repeat(40) }
}
fn effects() -> EffectSet {
    let mut value = EffectSet {
        canonical: CanonicalEffectSet {
            future_revision_id: "future".into(), extractor_id: "tree-sitter.typescript".into(),
            extractor_version: "1".into(), capability: Capability::Structural, status: AnalysisStatus::Complete,
            modified_exports: vec!["b".into(), "a".into(), "b".into()],
            added_dependencies: BTreeMap::new(), db_migrations_detected: false, security_effects: vec![],
        }, effect_digest: String::new(),
    }; value.seal().unwrap(); value
}

#[test]
fn rfc_8949_integer_widths_and_core_map_order() {
    for (value, expected) in [
        (serde_json::json!(0), "00"), (serde_json::json!(23), "17"),
        (serde_json::json!(24), "1818"), (serde_json::json!(256), "190100"),
        (serde_json::json!(-1000), "3903e7"), (serde_json::json!(true), "f5"),
        (serde_json::json!(null), "f6"), (serde_json::json!({"b": 1, "a": 2}), "a2616102616201"),
    ] { assert_eq!(hex(&encode(&value).unwrap()), expected); }
}

#[test]
fn shared_vectors_match_bytes_and_projection_hashes() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/canonical.golden.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        if let Some(raw) = vector.get("payload_hex") {
            let raw = raw.as_str().unwrap();
            let bytes: Vec<u8> = (0..raw.len()).step_by(2).map(|i| u8::from_str_radix(&raw[i..i+2], 16).unwrap()).collect();
            assert_eq!(payload_digest(&bytes).unwrap(), vector["expected_digest"].as_str().unwrap());
        } else {
            assert_eq!(hex(&encode(&vector["projection"]).unwrap()), vector["cbor_hex"].as_str().unwrap(), "{}", vector["name"]);
            assert_eq!(hash_projection(vector["domain"].as_str().unwrap(), &vector["projection"]).unwrap(), vector["expected_digest"].as_str().unwrap(), "{}", vector["name"]);
        }
    }
}

#[test]
fn domains_nfc_and_semantic_sequences_have_explicit_identity() {
    assert_eq!(encode(&"cafe\u{301}").unwrap(), encode(&"café").unwrap());
    assert!(encode(&serde_json::json!({"café": 1, "cafe\u{301}": 2})).is_err());
    assert_ne!(hash_projection("klocgit.a", &1).unwrap(), hash_projection("klocgit.b", &1).unwrap());
    let a = state(); let mut b = a.clone(); b.parent_oids.reverse();
    assert_ne!(a.state_digest().unwrap(), b.state_digest().unwrap());
}

#[test]
fn observation_time_and_provenance_do_not_change_software_state() {
    let a = revision(); let mut b = a.clone(); b.observed_at = "/transient/executor".into(); b.seal(&state()).unwrap();
    assert_eq!(a.record_digest, b.record_digest);
    b.canonical.producer.agent_version = Some("2".into()); b.seal(&state()).unwrap();
    assert_eq!(a.state_digest, b.state_digest); assert_ne!(a.record_digest, b.record_digest);
    b.verify(&state()).unwrap();
}

#[test]
fn effect_sets_are_normalized_and_required_incomplete_analysis_blocks() {
    let a = effects(); assert_eq!(a.modified_exports, ["a", "b"]); assert!(a.can_auto_resolve());
    for status in [AnalysisStatus::Partial, AnalysisStatus::Unsupported, AnalysisStatus::Failed] {
        let mut b = a.clone(); b.canonical.status = status; b.seal().unwrap(); assert!(!b.can_auto_resolve());
    }
    let mut b = a.clone(); b.canonical.modified_exports.push("unreviewed".into()); assert!(!b.can_auto_resolve());
}

#[test]
fn candidate_spec_sorts_selections_and_provenance_slices() {
    let mut value = CandidateSpec {
        canonical: CanonicalCandidateSpec {
            base_revisions: BTreeMap::from([("repo".into(), "a".repeat(40))]),
            selected_future_revisions: vec!["b".into(), "a".into(), "a".into()],
            composition_manifest: vec![slice("z", "b"), slice("a", "a")], creation_reason: "composition".into(),
        }, id: String::new(), spec_digest: String::new(), effect_summary_digest: sha("c"),
    };
    value.seal().unwrap(); let expected = value.spec_digest.clone();
    value.canonical.selected_future_revisions.reverse(); value.canonical.composition_manifest.reverse(); value.seal().unwrap();
    assert_eq!(expected, value.spec_digest); assert_eq!(value.selected_future_revisions, ["a", "b"]);
    value.canonical.composition_manifest[0].source_future_id = "unselected".into(); assert!(value.seal().is_err());
}

#[test]
fn candidate_executor_metadata_is_not_state_identity() {
    let mut value = Candidate {
        canonical: CanonicalCandidate { candidate_spec_id: "spec".into(), repo_tree_oids: BTreeMap::from([("repo".into(), "a".repeat(40))]) },
        id: String::new(), candidate_digest: String::new(),
        materialization_record: MaterializationRecord { executor_id: "a".into(), materialized_at: "now".into(), conflicts_encountered: vec![] },
    };
    value.seal().unwrap(); let expected = value.candidate_digest.clone();
    value.materialization_record.executor_id = "b".into(); value.materialization_record.materialized_at = "later".into(); value.seal().unwrap();
    assert_eq!(expected, value.candidate_digest);
}

#[test]
fn evidence_storage_retention_and_creation_time_are_decoupled() {
    let mut value = Evidence {
        canonical: CanonicalEvidence { subject_digest: sha("a"), evaluator_id: "trusted-tests".into(), evaluator_version: "1".into(), config_digest: sha("b"), environment_digest: sha("c"), result: EvidenceResult::Passed, payload_digest: payload_digest(b"passing log").unwrap() },
        id: String::new(), evidence_digest: String::new(), payload_ref: "first/key".into(), retention_class: RetentionClass::Ephemeral, created_at: "now".into(),
    };
    value.seal().unwrap(); let expected = value.evidence_digest.clone();
    value.payload_ref = "other/key".into(); value.retention_class = RetentionClass::Canonical; value.created_at = "later".into(); value.seal().unwrap();
    assert_eq!(expected, value.evidence_digest);
    value.canonical.payload_digest = payload_digest(b"different log").unwrap(); value.seal().unwrap(); assert_ne!(expected, value.evidence_digest);
    assert_ne!(payload_digest("café".as_bytes()).unwrap(), payload_digest("cafe\u{301}".as_bytes()).unwrap());
}

#[test]
fn system_state_is_independent_of_provenance_and_decision_records() {
    let state = CanonicalSystemRevisionState { repositories: BTreeMap::from([("repo".into(), "a".repeat(40))]), configuration_digests: BTreeMap::from([("config".into(), sha("b"))]) };
    let mut value = SystemRevision {
        canonical: CanonicalSystemRevisionRecord { state_digest: String::new(), accepted_decision_ids: vec!["a".into()], composition_manifest: vec![slice("api.ts", "future")] },
        id: String::new(), record_digest: String::new(),
    };
    value.seal(&state).unwrap(); let prior = value.clone();
    value.canonical.accepted_decision_ids.push("b".into()); value.seal(&state).unwrap();
    assert_eq!(prior.state_digest, value.state_digest); assert_ne!(prior.record_digest, value.record_digest);
    let encoded = serde_json::to_vec(&value).unwrap(); assert_eq!(serde_json::from_slice::<SystemRevision>(&encoded).unwrap(), value);
}

#[test]
fn constraints_are_typed_and_stably_ordered() {
    let resource = |id: &str| ResourceRef { system_id: None, repo_id: "repo".into(), resource_type: ResourceType::Service, resource_id: id.into() };
    let mut value = ReleaseConstraints {
        canonical: CanonicalReleaseConstraints {
            system_revision_state_digest: sha("a"),
            ordering_constraints: vec![OrderingConstraint { before: resource("z"), after: resource("b") }, OrderingConstraint { before: resource("a"), after: resource("b") }],
            compatibility_requirements: vec![], preconditions: vec![], postconditions: vec![], forward_only_operations: vec![],
        }, constraints_digest: String::new(),
    };
    value.seal().unwrap(); let expected = value.constraints_digest.clone();
    value.canonical.ordering_constraints.reverse(); value.seal().unwrap(); assert_eq!(value.constraints_digest, expected);
    assert!(serde_json::from_value::<StateCondition>(serde_json::json!({"target":resource("a"),"assertion":"free form condition"})).is_err());
}

#[test]
fn attestation_location_and_verification_time_are_excluded() {
    let mut value = DeploymentAttestation {
        canonical: CanonicalDeploymentAttestation {
            system_revision_state_digest: sha("a"), environment: "staging".into(), deployer_identity: "cd".into(), observed_state: DeploymentState::Unknown,
            observed_repositories: BTreeMap::from([("repo".into(), "a".repeat(40))]), observed_configuration_digests: BTreeMap::new(), payload_digest: sha("b"),
        }, attestation_payload_ref: "first".into(), verified_at: "now".into(), attestation_digest: String::new(),
    };
    value.seal().unwrap(); let expected = value.attestation_digest.clone();
    value.attestation_payload_ref = "other".into(); value.verified_at = "later".into(); value.seal().unwrap(); assert_eq!(expected, value.attestation_digest);
}

#[test]
fn invalid_numbers_nesting_and_nfc_collisions_are_rejected() {
    assert!(encode(&serde_json::json!(1.5)).is_err());
    let mut value = serde_json::json!(null); for _ in 0..66 { value = serde_json::json!([value]); } assert!(encode(&value).is_err());
    let mut spec = CandidateSpec {
        canonical: CanonicalCandidateSpec { base_revisions: BTreeMap::from([("café".into(), "a".repeat(40)), ("cafe\u{301}".into(), "b".repeat(40))]), selected_future_revisions: vec!["a".into()], composition_manifest: vec![], creation_reason: "test".into() },
        id: String::new(), effect_summary_digest: sha("a"), spec_digest: String::new(),
    };
    assert!(spec.seal().is_err());
}
