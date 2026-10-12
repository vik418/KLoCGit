//! Cross-Language Golden Vector Runner for Rust Engine

use crate::digest::*;
use crate::types::*;
use std::collections::BTreeMap;

pub struct GoldenResult {
    pub name: String,
    pub digest: String,
}

pub fn run_golden_suite() -> Vec<GoldenResult> {
    let mut results = Vec::new();

    // 1. future_revision_state_basic
    {
        let state = CanonicalFutureRevisionState {
            repo_id: "klocgit-core".to_string(),
            commit_oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string(),
            tree_oid: "0123456789abcdef0123456789abcdef01234567".to_string(),
            parent_oids: vec![
                "1111111111111111111111111111111111111111".to_string(),
                "2222222222222222222222222222222222222222".to_string(),
            ],
        };
        let digest = compute_future_revision_state_digest(&state);
        results.push(GoldenResult {
            name: "future_revision_state_basic".to_string(),
            digest,
        });
    }

    // 2. future_revision_record_basic
    {
        let record = CanonicalFutureRevisionRecord {
            state_digest: "4a187e5fd60ff5833446002ff2c3af1d798604d538e14619dcfaf05809aaef9f".to_string(),
            system_id: "sys-enterprise-prod".to_string(),
            ref_name: "refs/heads/candidate-omega".to_string(),
            actor_id: "agent-orchestrator-9".to_string(),
            agent_version: Some("2.4.0".to_string()),
            prompt_digest: Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string()),
            task_id: Some("task-convergence-102".to_string()),
        };
        let digest = compute_future_revision_record_digest(&record);
        results.push(GoldenResult {
            name: "future_revision_record_basic".to_string(),
            digest,
        });
    }

    // 3. effect_set_structural
    {
        let mut deps = BTreeMap::new();
        deps.insert("dotenv".to_string(), "^16.0.0".to_string());
        deps.insert("express".to_string(), "^4.19.0".to_string());
        deps.insert("jsonwebtoken".to_string(), "^9.0.0".to_string());

        let effect = CanonicalEffectSet {
            future_revision_id: "fut-rev-901".to_string(),
            extractor_id: "tree-sitter-structural-v1".to_string(),
            extractor_version: "1.0.0".to_string(),
            capability: "STRUCTURAL".to_string(),
            status: "COMPLETE".to_string(),
            modified_exports: vec![
                "authenticateUser".to_string(),
                "createSession".to_string(),
                "verifyToken".to_string(),
            ],
            added_dependencies: deps,
            db_migrations_detected: false,
            security_effects: vec![
                "AUTH:token_issue".to_string(),
                "CRYPTO:verify".to_string(),
                "NET:ingress".to_string(),
            ],
        };
        let digest = compute_effect_digest(&effect);
        results.push(GoldenResult {
            name: "effect_set_structural".to_string(),
            digest,
        });
    }

    // 4. candidate_spec_composite
    {
        let mut base_revs = BTreeMap::new();
        base_revs.insert("repo-auth".to_string(), "auth_base_oid_1234".to_string());
        base_revs.insert("repo-gateway".to_string(), "gateway_base_oid_5678".to_string());

        let slices = vec![
            ProvenanceSlice {
                repo_id: "repo-auth".to_string(),
                path: "src/token.ts".to_string(),
                selector_type: "hunk".to_string(),
                selector_value: "@@ -10,5 +10,8 @@".to_string(),
                source_future_id: "fut-01".to_string(),
                source_commit_oid: "commit_auth_1".to_string(),
            },
            ProvenanceSlice {
                repo_id: "repo-gateway".to_string(),
                path: "src/proxy.ts".to_string(),
                selector_type: "symbol".to_string(),
                selector_value: "ProxyHandler".to_string(),
                source_future_id: "fut-02".to_string(),
                source_commit_oid: "commit_gw_1".to_string(),
            },
        ];

        let spec = CanonicalCandidateSpec {
            base_revisions: base_revs,
            selected_future_revisions: vec!["fut-01".to_string(), "fut-02".to_string()],
            composition_manifest: slices,
            creation_reason: "Automated convergence of auth and gateway changes".to_string(),
        };
        let digest = compute_candidate_spec_digest(&spec);
        results.push(GoldenResult {
            name: "candidate_spec_composite".to_string(),
            digest,
        });
    }

    // 5. candidate_basic
    {
        let mut tree_map = BTreeMap::new();
        tree_map.insert("repo-auth".to_string(), "tree_oid_auth_4444".to_string());
        tree_map.insert("repo-gateway".to_string(), "tree_oid_gw_5555".to_string());

        let cand = CanonicalCandidate {
            candidate_spec_id: "spec-conv-887".to_string(),
            repo_tree_oids: tree_map,
        };
        let digest = compute_candidate_digest(&cand);
        results.push(GoldenResult {
            name: "candidate_basic".to_string(),
            digest,
        });
    }

    // 6. evidence_decision_record
    {
        let ev = CanonicalEvidence {
            subject_digest: "cand-digest-9999".to_string(),
            evaluator_id: "container-sandbox-hermetic".to_string(),
            evaluator_version: "1.2.0".to_string(),
            config_digest: "config-sha256-node24".to_string(),
            environment_digest: "env-sha256-linux-x86".to_string(),
            result: "PASSED".to_string(),
            payload_digest: "payload-hash-sandbox-run-42".to_string(),
        };
        let digest = compute_evidence_digest(&ev);
        results.push(GoldenResult {
            name: "evidence_decision_record".to_string(),
            digest,
        });
    }

    // 7. system_revision_state_multi_repo
    {
        let mut repos = BTreeMap::new();
        repos.insert("repo-billing".to_string(), "oid_billing_head".to_string());
        repos.insert("repo-core".to_string(), "oid_core_head".to_string());
        repos.insert("repo-ui".to_string(), "oid_ui_head".to_string());

        let mut cfgs = BTreeMap::new();
        cfgs.insert("env.production".to_string(), "cfg_digest_prod".to_string());
        cfgs.insert("helm-values".to_string(), "cfg_digest_helm".to_string());

        let sys_state = CanonicalSystemRevisionState {
            repositories: repos,
            configuration_digests: cfgs,
        };
        let digest = compute_system_revision_state_digest(&sys_state);
        results.push(GoldenResult {
            name: "system_revision_state_multi_repo".to_string(),
            digest,
        });
    }

    // 8. release_constraints_typed
    {
        let constraints = CanonicalReleaseConstraints {
            system_revision_state_digest: "sys-state-digest-1234".to_string(),
            ordering_constraints: vec![OrderingConstraint {
                before: ResourceRef {
                    system_id: None,
                    repo_id: "repo-db".to_string(),
                    resource_type: "migration".to_string(),
                    resource_id: "002_add_tenants".to_string(),
                },
                after: ResourceRef {
                    system_id: None,
                    repo_id: "repo-api".to_string(),
                    resource_type: "service".to_string(),
                    resource_id: "tenant_service".to_string(),
                },
            }],
            compatibility_requirements: vec![CompatibilityRequirement {
                subject: ResourceRef {
                    system_id: None,
                    repo_id: "repo-ui".to_string(),
                    resource_type: "service".to_string(),
                    resource_id: "frontend".to_string(),
                },
                target: ResourceRef {
                    system_id: None,
                    repo_id: "repo-api".to_string(),
                    resource_type: "service".to_string(),
                    resource_id: "backend".to_string(),
                },
                relation: "COMPATIBLE".to_string(),
                version_constraint: None,
            }],
            preconditions: vec![StateCondition {
                target: ResourceRef {
                    system_id: None,
                    repo_id: "repo-db".to_string(),
                    resource_type: "database".to_string(),
                    resource_id: "main".to_string(),
                },
                assertion: "HEALTHY".to_string(),
                parameters: None,
            }],
            postconditions: vec![StateCondition {
                target: ResourceRef {
                    system_id: None,
                    repo_id: "repo-api".to_string(),
                    resource_type: "service".to_string(),
                    resource_id: "tenant_service".to_string(),
                },
                assertion: "HEALTHY".to_string(),
                parameters: None,
            }],
            forward_only_operations: vec![ForwardOnlyOperation {
                resource: ResourceRef {
                    system_id: None,
                    repo_id: "repo-db".to_string(),
                    resource_type: "migration".to_string(),
                    resource_id: "002_add_tenants".to_string(),
                },
                operation: "RUN_MIGRATION".to_string(),
                failure_policy: "ABORT".to_string(),
            }],
        };
        let digest = compute_release_constraints_digest(&constraints);
        results.push(GoldenResult {
            name: "release_constraints_typed".to_string(),
            digest,
        });
    }

    // 9. deployment_attestation_verified
    {
        let mut repos = BTreeMap::new();
        repos.insert("repo-billing".to_string(), "oid_billing_head".to_string());
        repos.insert("repo-core".to_string(), "oid_core_head".to_string());
        repos.insert("repo-ui".to_string(), "oid_ui_head".to_string());

        let mut cfgs = BTreeMap::new();
        cfgs.insert("env.production".to_string(), "cfg_digest_prod".to_string());
        cfgs.insert("helm-values".to_string(), "cfg_digest_helm".to_string());

        let att = CanonicalDeploymentAttestation {
            system_revision_state_digest: "sys-state-digest-1234".to_string(),
            environment: "production".to_string(),
            deployer_identity: "external-cd-spinnaker".to_string(),
            observed_state: "SUCCEEDED".to_string(),
            observed_repositories: repos,
            observed_configuration_digests: cfgs,
            payload_digest: "attestation-signature-hash-99".to_string(),
        };
        let digest = compute_deployment_attestation_digest(&att);
        results.push(GoldenResult {
            name: "deployment_attestation_verified".to_string(),
            digest,
        });
    }

    results
}
