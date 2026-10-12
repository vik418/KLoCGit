//! KLoCGit v1 Engine Foundations
//! Phase 1 Implementation

pub mod cbor;
pub mod digest;
pub mod extractor;
pub mod git;
pub mod golden;
pub mod sha256;
pub mod types;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use types::*;
    use digest::*;
    use extractor::StructuralExtractor;
    use git::GitCompositor;

    #[test]
    fn test_golden_suite_in_rust() {
        let results = golden::run_golden_suite();
        assert_eq!(results.len(), 9);
        for res in results {
            assert_eq!(res.digest.len(), 64);
        }
    }

    #[test]
    fn test_three_tier_digest_invariants() {
        // State Digest
        let state = CanonicalFutureRevisionState {
            repo_id: "repo-core".to_string(),
            commit_oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string(),
            tree_oid: "0123456789abcdef0123456789abcdef01234567".to_string(),
            parent_oids: vec!["parent1".to_string(), "parent2".to_string()],
        };
        let state_digest = compute_future_revision_state_digest(&state);
        assert_eq!(state_digest.len(), 64);

        // Record Digest
        let record = CanonicalFutureRevisionRecord {
            state_digest: state_digest.clone(),
            system_id: "sys-01".to_string(),
            ref_name: "refs/heads/feature-x".to_string(),
            actor_id: "agent-kloc".to_string(),
            agent_version: Some("2.1.0".to_string()),
            task_id: Some("task-42".to_string()),
            prompt_digest: Some("abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234".to_string()),
        };
        let record_digest = compute_future_revision_record_digest(&record);
        assert_eq!(record_digest.len(), 64);

        // Payload Digest
        let raw_payload = b"test payload bytes for external storage";
        let payload_digest = compute_payload_digest(raw_payload);
        assert_eq!(payload_digest.len(), 64);

        // Identity Separation Invariant: state_digest != record_digest != payload_digest
        assert_ne!(state_digest, record_digest);
        assert_ne!(record_digest, payload_digest);
        assert_ne!(state_digest, payload_digest);
    }

    #[test]
    fn test_sorting_and_canonicalization_rules() {
        let mut deps = BTreeMap::new();
        deps.insert("zod".to_string(), "^3.22.0".to_string());
        deps.insert("express".to_string(), "^4.19.0".to_string());
        deps.insert("dotenv".to_string(), "^16.0.0".to_string());

        let effect_set = CanonicalEffectSet {
            future_revision_id: "fut-101".to_string(),
            extractor_id: "structural-ts".to_string(),
            extractor_version: "1.0.0".to_string(),
            capability: "STRUCTURAL".to_string(),
            status: "COMPLETE".to_string(),
            // Unsorted inputs
            modified_exports: vec!["zebra".to_string(), "alpha".to_string(), "beta".to_string()],
            added_dependencies: deps,
            db_migrations_detected: false,
            security_effects: vec!["NET:egress".to_string(), "CRYPTO:usage".to_string()],
        };

        let digest1 = compute_effect_digest(&effect_set);

        // Perturb the order of modified_exports and security_effects in input
        let mut perturbed = effect_set.clone();
        perturbed.modified_exports = vec!["beta".to_string(), "zebra".to_string(), "alpha".to_string()];
        perturbed.security_effects = vec!["CRYPTO:usage".to_string(), "NET:egress".to_string()];

        let digest2 = compute_effect_digest(&perturbed);

        // Must produce identical canonical effect_digest
        assert_eq!(digest1, digest2);
    }

    #[test]
    fn test_parent_oids_sequence_preservation() {
        let state1 = CanonicalFutureRevisionState {
            repo_id: "repo-core".to_string(),
            commit_oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string(),
            tree_oid: "0123456789abcdef0123456789abcdef01234567".to_string(),
            parent_oids: vec!["parent_A".to_string(), "parent_B".to_string()],
        };

        let state2 = CanonicalFutureRevisionState {
            repo_id: "repo-core".to_string(),
            commit_oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string(),
            tree_oid: "0123456789abcdef0123456789abcdef01234567".to_string(),
            parent_oids: vec!["parent_B".to_string(), "parent_A".to_string()],
        };

        // Semantic sequences MUST PRESERVE EXACT SEQUENCE -> different digests
        let d1 = compute_future_revision_state_digest(&state1);
        let d2 = compute_future_revision_state_digest(&state2);
        assert_ne!(d1, d2);
    }

    #[test]
    fn test_structural_extractors() {
        let extractor = StructuralExtractor::default();

        // TypeScript extraction
        let ts_code = r#"
            import express from 'express';
            import { z } from 'zod';
            export function processOrder(id: string) { return id; }
            export const orderVersion = 2;
            const helper = () => eval("danger");
        "#;
        let ts_effects = extractor.extract("fut-ts", "src/order.ts", ts_code);
        assert_eq!(ts_effects.capability, "STRUCTURAL");
        assert_eq!(ts_effects.status, "COMPLETE");
        assert!(ts_effects.modified_exports.contains(&"processOrder".to_string()));
        assert!(ts_effects.modified_exports.contains(&"orderVersion".to_string()));
        assert!(ts_effects.added_dependencies.contains_key("express"));
        assert!(ts_effects.added_dependencies.contains_key("zod"));
        assert!(ts_effects.security_effects.contains(&"EXEC:eval".to_string()));

        // Python extraction
        let py_code = r#"
            import requests
            import os
            def compute_hash(data):
                return data
            class SecurityManager:
                pass
            os.system("echo hello")
        "#;
        let py_effects = extractor.extract("fut-py", "backend/service.py", py_code);
        assert_eq!(py_effects.capability, "STRUCTURAL");
        assert_eq!(py_effects.status, "COMPLETE");
        assert!(py_effects.modified_exports.contains(&"compute_hash".to_string()));
        assert!(py_effects.modified_exports.contains(&"SecurityManager".to_string()));
        assert!(py_effects.added_dependencies.contains_key("requests"));
        assert!(py_effects.security_effects.contains(&"EXEC:subprocess".to_string()));

        // Go extraction
        let go_code = r#"
            package main
            import "net/http"
            func HandleRequest(w http.ResponseWriter, r *http.Request) {}
            type Config struct {}
        "#;
        let go_effects = extractor.extract("fut-go", "pkg/server.go", go_code);
        assert_eq!(go_effects.capability, "STRUCTURAL");
        assert_eq!(go_effects.status, "COMPLETE");
        assert!(go_effects.modified_exports.contains(&"HandleRequest".to_string()));
        assert!(go_effects.modified_exports.contains(&"Config".to_string()));
        assert!(go_effects.added_dependencies.contains_key("net/http"));
    }

    #[test]
    fn test_git_in_memory_scratch_composition() {
        let temp_dir = std::env::temp_dir().join("klocgit_test_scratch");
        let compositor = GitCompositor::new(&temp_dir);

        let mut base_revs = BTreeMap::new();
        base_revs.insert("repo-core".to_string(), "commit_base_1111".to_string());

        let slices = vec![
            ProvenanceSlice {
                repo_id: "repo-core".to_string(),
                path: "src/index.ts".to_string(),
                selector_type: "hunk".to_string(),
                selector_value: "@@ -1,5 +1,8 @@".to_string(),
                source_future_id: "fut-1".to_string(),
                source_commit_oid: "c11111".to_string(),
            },
        ];

        let result = compositor.compose_in_scratch("spec-test-01", &base_revs, &slices).unwrap();
        assert_eq!(result.conflicts.len(), 0);
        assert!(result.candidate.repo_tree_oids.contains_key("repo-core"));

        // CAS validation
        assert!(GitCompositor::assert_cas_match("oid-aaa", "oid-aaa").is_ok());
        assert!(GitCompositor::assert_cas_match("oid-aaa", "oid-bbb").is_err());
    }
}
