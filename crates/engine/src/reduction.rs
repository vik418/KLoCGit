//! CODEX OPERATING CONTRACT: Phase 4 Candidate Reduction & Semantic Graph
//! Implements Deduplication, Effect Clustering, Alternative Implementation Resolution,
//! Dependency Closure Solving, and CandidateSpec Synthesis.

use std::collections::{BTreeMap, BTreeSet};
use crate::types::{CanonicalCandidateSpec, ProvenanceSlice, CanonicalEffectSet};
use crate::digest::compute_candidate_spec_digest;

#[derive(Debug, Clone)]
pub struct InputFutureRevision {
    pub id: String,
    pub repo_id: String,
    pub commit_oid: String,
    pub slices: Vec<ProvenanceSlice>,
    pub effect_set: CanonicalEffectSet,
    pub evidence_score: f64,
}

#[derive(Debug, Clone)]
pub struct SynthesizedCluster {
    pub cluster_id: String,
    pub spec: CanonicalCandidateSpec,
    pub spec_digest: String,
    pub collapsed_duplicates: usize,
    pub alternative_implementations: Vec<String>,
    pub dependency_conflicts: Vec<String>,
}

#[derive(Debug, Default)]
pub struct ReductionEngine;

impl ReductionEngine {
    pub fn new() -> Self {
        Self
    }

    /// Process a batch of competing future revisions into canonical candidate specs
    pub fn reduce_candidates(
        &self,
        base_revisions: &BTreeMap<String, String>,
        future_revisions: &[InputFutureRevision],
    ) -> Vec<SynthesizedCluster> {
        if future_revisions.is_empty() {
            return Vec::new();
        }

        // 1. Deduplication Engine: collapse exact syntactic matches across future revisions
        let mut deduplicated_slices: BTreeMap<String, ProvenanceSlice> = BTreeMap::new();
        let mut duplicate_count = 0;
        let mut touched_symbols: BTreeMap<String, Vec<String>> = BTreeMap::new();

        for rev in future_revisions {
            for slice in &rev.slices {
                let slice_key = format!("{}:{}:{}:{}", slice.repo_id, slice.path, slice.selector_type, slice.selector_value);
                if deduplicated_slices.contains_key(&slice_key) {
                    duplicate_count += 1;
                } else {
                    deduplicated_slices.insert(slice_key.clone(), slice.clone());
                }

                touched_symbols.entry(slice_key).or_default().push(rev.id.clone());
            }
        }

        // 2. Alternative Implementation Detection: competing futures on same symbol
        let mut alternative_conflicts = Vec::new();
        for (key, futures) in touched_symbols {
            if futures.len() > 1 {
                alternative_conflicts.push(format!("Alternative competing implementations on {}: {:?}", key, futures));
            }
        }

        // 3. Dependency Closure Solver & Version Skew Detection
        let mut unified_deps: BTreeMap<String, String> = BTreeMap::new();
        let mut dep_conflicts = BTreeSet::new();

        for rev in future_revisions {
            for (dep, ver) in &rev.effect_set.added_dependencies {
                if let Some(existing_ver) = unified_deps.get(dep) {
                    if existing_ver != ver && existing_ver != "*" && ver != "*" {
                        dep_conflicts.insert(format!("Dependency version skew on {}: {} vs {}", dep, existing_ver, ver));
                    }
                } else {
                    unified_deps.insert(dep.clone(), ver.clone());
                }
            }
        }

        // 4. CandidateSpec Synthesis
        let selected_futures: Vec<String> = future_revisions.iter().map(|f| f.id.clone()).collect();
        let composition_manifest: Vec<ProvenanceSlice> = deduplicated_slices.into_values().collect();

        let spec = CanonicalCandidateSpec {
            base_revisions: base_revisions.clone(),
            selected_future_revisions: selected_futures,
            composition_manifest,
            creation_reason: format!("Automated reduction across {} future revisions", future_revisions.len()),
        };

        let spec_digest = compute_candidate_spec_digest(&spec);

        vec![SynthesizedCluster {
            cluster_id: format!("cluster_{}", &spec_digest[..8]),
            spec,
            spec_digest,
            collapsed_duplicates: duplicate_count,
            alternative_implementations: alternative_conflicts,
            dependency_conflicts: dep_conflicts.into_iter().collect(),
        }]
    }
}
