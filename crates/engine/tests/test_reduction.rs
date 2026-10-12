use std::collections::BTreeMap;
use klocgit_engine::reduction::{InputFutureRevision, ReductionEngine};
use klocgit_engine::types::{CanonicalEffectSet, ProvenanceSlice};

#[test]
fn test_ten_competing_revisions_reduction_and_synthesis() {
    let engine = ReductionEngine::new();

    let mut base_revs = BTreeMap::new();
    base_revs.insert("repo-core".to_string(), "commit_trunk_001".to_string());
    base_revs.insert("repo-billing".to_string(), "commit_trunk_002".to_string());

    // Construct 10 competing future revisions with overlapping diffs & version skews
    let mut revisions = Vec::new();
    for i in 0..10 {
        let mut deps = BTreeMap::new();
        // Futures 0..5 use express ^4, 6..9 use express ^5 (version skew!)
        if i < 6 {
            deps.insert("express".to_string(), "^4.19.0".to_string());
        } else {
            deps.insert("express".to_string(), "^5.0.0".to_string());
        }
        deps.insert("zod".to_string(), "^3.22.0".to_string());

        let effect_set = CanonicalEffectSet {
            future_revision_id: format!("fut-{:03}", i),
            extractor_id: "structural-v1".to_string(),
            extractor_version: "1.0.0".to_string(),
            capability: "STRUCTURAL".to_string(),
            status: "COMPLETE".to_string(),
            modified_exports: vec!["handleOrder".to_string()],
            added_dependencies: deps,
            db_migrations_detected: false,
            security_effects: vec![],
        };

        // All futures touch the same symbol (competing alternatives!)
        // Half share the EXACT same slice (syntactic duplicates)
        let selector_val = if i % 2 == 0 { "handleOrder_shared" } else { "handleOrder_alt" };

        let slices = vec![
            ProvenanceSlice {
                repo_id: "repo-core".to_string(),
                path: "src/order.ts".to_string(),
                selector_type: "symbol".to_string(),
                selector_value: selector_val.to_string(),
                source_future_id: format!("fut-{:03}", i),
                source_commit_oid: format!("commit_{:03}", i),
            },
        ];

        revisions.push(InputFutureRevision {
            id: format!("fut-{:03}", i),
            repo_id: "repo-core".to_string(),
            commit_oid: format!("commit_{:03}", i),
            slices,
            effect_set,
            evidence_score: 90.0 + (i as f64),
        });
    }

    assert_eq!(revisions.len(), 10);

    // Run Reduction Engine
    let clusters = engine.reduce_candidates(&base_revs, &revisions);

    assert_eq!(clusters.len(), 1);
    let cluster = &clusters[0];

    // Verification 1: Exact Deduplication (10 slices collapsed down to 2 distinct slices)
    assert_eq!(cluster.spec.composition_manifest.len(), 2);
    assert_eq!(cluster.collapsed_duplicates, 8); // 8 duplicate slices successfully collapsed!

    // Verification 2: Alternative Implementation Detection
    assert!(!cluster.alternative_implementations.is_empty());
    println!("Detected Alternatives: {:?}", cluster.alternative_implementations);

    // Verification 3: Dependency Version Skew Detection (express ^4 vs ^5)
    assert_eq!(cluster.dependency_conflicts.len(), 1);
    assert!(cluster.dependency_conflicts[0].contains("Dependency version skew on express"));

    // Verification 4: Canonical CandidateSpec Synthesis & Deterministic Digest
    assert_eq!(cluster.spec_digest.len(), 64);
    assert_eq!(cluster.spec.selected_future_revisions.len(), 10);
    assert_eq!(cluster.spec.base_revisions.len(), 2);

    println!("✓ Successfully reduced 10 competing future revisions with deduplication & conflict detection.");
}
