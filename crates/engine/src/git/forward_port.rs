use super::objects::{ObjectFuture, ObjectSource};
use super::workspace::{checkout, HydrationBudget, Workspace};
use super::{compose_from_objects, snapshot, Limits};
use crate::canonical;
use crate::contracts::{Candidate, CandidateSpec, MaterializationRecord};
use crate::{Error, Result};
use git2::Oid;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForwardPortProof {
    pub schema_version: u32,
    pub repo_id: String,
    pub previous_spec_digest: String,
    pub spec_digest: String,
    pub previous_candidate_digest: String,
    pub candidate_digest: String,
    pub previous_base_oid: String,
    pub base_oid: String,
    pub base_tree_oid: String,
    pub reviewed_delta_digest: String,
    pub effect_summary_digest: String,
    pub proof_digest: String,
}

impl ForwardPortProof {
    pub fn seal(&mut self) -> Result<()> {
        if self.schema_version != 1 { return Err(Error::RevisionMismatch); }
        self.proof_digest = canonical::hash_projection(
            "klocgit.forward-port-proof",
            &serde_json::json!({
                "repo_id": self.repo_id,
                "previous_spec_digest": self.previous_spec_digest,
                "spec_digest": self.spec_digest,
                "previous_candidate_digest": self.previous_candidate_digest,
                "candidate_digest": self.candidate_digest,
                "previous_base_oid": self.previous_base_oid,
                "base_oid": self.base_oid,
                "base_tree_oid": self.base_tree_oid,
                "reviewed_delta_digest": self.reviewed_delta_digest,
                "effect_summary_digest": self.effect_summary_digest,
            }),
        )?;
        Ok(())
    }
}

pub struct ForwardPort {
    pub specification: CandidateSpec,
    pub workspace: Workspace,
    pub proof: ForwardPortProof,
}

/// A changed base tree requires dependency analysis that path disjointness alone
/// cannot establish. Until such a proof exists, preserve reviews only when the
/// authoritative base tree is byte-identical and rerun exact-state checks.
pub fn rematerialize(
    previous_spec: &CandidateSpec,
    previous_candidate: &Candidate,
    base: &dyn ObjectSource,
    repo_id: &str,
    new_base_oid: Oid,
    sources: &[ObjectFuture<'_>],
    limits: Limits,
    hydration: HydrationBudget,
    metadata: MaterializationRecord,
) -> Result<ForwardPort> {
    let mut sealed = previous_spec.clone();
    sealed.seal()?;
    let mut candidate = previous_candidate.clone();
    candidate.seal()?;
    if sealed.spec_digest != previous_spec.spec_digest
        || sealed.id != previous_spec.id
        || candidate.candidate_digest != previous_candidate.candidate_digest
        || candidate.id != previous_candidate.id
        || candidate.candidate_spec_id != sealed.id
        || sealed.base_revisions.len() != 1
    {
        return Err(Error::RevisionMismatch);
    }
    let old_base_oid = Oid::from_str(
        sealed.base_revisions.get(repo_id).ok_or(Error::RevisionMismatch)?,
    )?;
    let old_base = snapshot(base, old_base_oid, limits)?;
    let new_base = snapshot(base, new_base_oid, limits)?;
    if old_base.tree_oid != new_base.tree_oid {
        return Err(Error::Conflict(
            "canonical tree changed; interaction remains uncertain".into(),
        ));
    }
    let composition = compose_from_objects(base, repo_id, old_base_oid, sources, limits)?;
    if composition.spec.selected_future_revisions != sealed.selected_future_revisions
        || composition.spec.composition_manifest != sealed.composition_manifest
        || composition.spec.effect_summary_digest != sealed.effect_summary_digest
        || candidate.repo_tree_oids.len() != 1
        || candidate.repo_tree_oids.get(repo_id) != Some(&composition.tree_oid.to_string())
    {
        return Err(Error::RevisionMismatch);
    }
    let delta: Vec<_> = sealed.composition_manifest.iter().map(|slice| {
        let before = old_base.entries.get(&slice.path);
        let after = composition.entries.get(&slice.path);
        serde_json::json!({
            "path": slice.path,
            "before": before.map(|entry| serde_json::json!({ "oid": entry.oid.to_string(), "mode": entry.mode })),
            "after": after.map(|entry| serde_json::json!({ "oid": entry.oid.to_string(), "mode": entry.mode })),
        })
    }).collect();
    let reviewed_delta_digest = canonical::hash_projection("klocgit.reviewed-delta", &delta)?;
    let mut specification = sealed.clone();
    specification.canonical.base_revisions.insert(repo_id.into(), new_base_oid.to_string());
    specification.seal()?;
    let workspace = checkout(
        &specification, repo_id, composition,
        |path, oid, max| {
            let owner = specification.composition_manifest.iter().find(|slice| slice.path == path);
            let source = match owner {
                Some(owner) => sources.iter()
                    .find(|source| source.revision.id == owner.source_future_id)
                    .map(|source| source.objects).ok_or(Error::RevisionMismatch)?,
                None => base,
            };
            super::objects::verified_blob(source, oid, max)
        }, hydration, metadata,
    )?;
    let mut proof = ForwardPortProof {
        schema_version: 1, repo_id: repo_id.into(),
        previous_spec_digest: previous_spec.spec_digest.clone(),
        spec_digest: specification.spec_digest.clone(),
        previous_candidate_digest: previous_candidate.candidate_digest.clone(),
        candidate_digest: workspace.candidate.candidate_digest.clone(),
        previous_base_oid: old_base_oid.to_string(),
        base_oid: new_base_oid.to_string(), base_tree_oid: new_base.tree_oid.to_string(),
        reviewed_delta_digest,
        effect_summary_digest: specification.effect_summary_digest.clone(),
        proof_digest: String::new(),
    };
    proof.seal()?;
    Ok(ForwardPort { specification, workspace, proof })
}
