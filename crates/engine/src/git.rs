//! In-Memory and Scratch-Worktree Git Composition.
//! Strictly conforms to Invariant 6: Never write speculative durable Git refs.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use crate::sha256::Sha256;
use crate::types::{CanonicalCandidate, ProvenanceSlice};

pub struct GitCompositor {
    scratch_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CompositionResult {
    pub candidate: CanonicalCandidate,
    pub conflicts: Vec<String>,
    pub scratch_path: PathBuf,
}

impl GitCompositor {
    pub fn new<P: AsRef<Path>>(scratch_root: P) -> Self {
        let path = scratch_root.as_ref().to_path_buf();
        fs::create_dir_all(&path).ok();
        Self { scratch_root: path }
    }

    /// Compose slices into an isolated scratch worktree without writing ANY durable refs.
    pub fn compose_in_scratch(
        &self,
        candidate_spec_id: &str,
        base_revisions: &BTreeMap<String, String>,
        slices: &[ProvenanceSlice],
    ) -> Result<CompositionResult, String> {
        let scratch_id = format!("candidate_{}", &candidate_spec_id[..12.min(candidate_spec_id.len())]);
        let worktree_dir = self.scratch_root.join(scratch_id);
        fs::create_dir_all(&worktree_dir).map_err(|e| e.to_string())?;

        let mut repo_tree_oids = BTreeMap::new();
        let mut conflicts = Vec::new();

        // For each repo referenced in base_revisions or slices
        let mut repos: Vec<String> = base_revisions.keys().cloned().collect();
        for s in slices {
            if !repos.contains(&s.repo_id) {
                repos.push(s.repo_id.clone());
            }
        }
        repos.sort();

        for repo_id in repos {
            let repo_scratch = worktree_dir.join(&repo_id);
            fs::create_dir_all(&repo_scratch).map_err(|e| e.to_string())?;

            // Track materialized files for conflict detection
            let mut file_touch_count: BTreeMap<String, Vec<String>> = BTreeMap::new();

            // Materialize slices for this repo
            for s in slices {
                if s.repo_id == repo_id {
                    let file_path = repo_scratch.join(&s.path);
                    if let Some(parent) = file_path.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }

                    file_touch_count.entry(s.path.clone())
                        .or_default()
                        .push(s.source_future_id.clone());

                    // Materialize content in scratch space
                    let content = format!("// Synthesized slice from future {} commit {}\n// Selector: {}:{}\n",
                        s.source_future_id, s.source_commit_oid, s.selector_type, s.selector_value);
                    fs::write(&file_path, content).map_err(|e| e.to_string())?;
                }
            }

            // Conflict detection: overlapping touches with conflicting selectors
            for (path, futures) in file_touch_count {
                if futures.len() > 1 {
                    conflicts.push(format!("Conflict on {}: competing slices from futures {:?}", path, futures));
                }
            }

            // Compute deterministic synthetic tree OID for this scratch tree
            let mut tree_hasher = Sha256::new();
            tree_hasher.update(b"tree ");
            tree_hasher.update(repo_id.as_bytes());
            if let Some(base_oid) = base_revisions.get(&repo_id) {
                tree_hasher.update(base_oid.as_bytes());
            }
            for s in slices {
                if s.repo_id == repo_id {
                    tree_hasher.update(s.path.as_bytes());
                    tree_hasher.update(s.source_commit_oid.as_bytes());
                }
            }
            let tree_hash = tree_hasher.finalize();
            let mut tree_oid = String::with_capacity(40);
            for b in &tree_hash[..20] {
                tree_oid.push_str(&format!("{:02x}", b));
            }
            repo_tree_oids.insert(repo_id, tree_oid);
        }

        let candidate = CanonicalCandidate {
            candidate_spec_id: candidate_spec_id.to_string(),
            repo_tree_oids,
        };

        Ok(CompositionResult {
            candidate,
            conflicts,
            scratch_path: worktree_dir,
        })
    }

    /// Compare-and-Swap (CAS) ref check: asserts remote ref equals expected_oid
    pub fn assert_cas_match(expected_oid: &str, current_remote_oid: &str) -> Result<(), String> {
        if expected_oid != current_remote_oid {
            Err(format!(
                "CAS violation: expected OID {}, but current ref is {}",
                expected_oid, current_remote_oid
            ))
        } else {
            Ok(())
        }
    }
}
