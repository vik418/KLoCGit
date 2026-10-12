use crate::contracts::Candidate;
use crate::{canonical, Error, Result};
use git2::{ObjectType, Oid, Repository};
use serde::{Deserialize, Serialize};
use std::path::Path;
use super::{Limits, workspace::HydrationBudget};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Author {
    pub name: String,
    pub email: String,
    pub unix_timestamp: i64,
}

pub struct PreparedCommit {
    pub target_oid: Oid,
    pub tree_oid: Oid,
    pub expected_oid: Oid,
    pub payload_digest: String,
    pub pack: Vec<u8>,
}

/// Prepare a transport pack in scratch storage. Publishing remains a separately
/// authorized receive-pack CAS operation.
pub fn prepare(
    source: &Path,
    candidate: &Candidate,
    repo_id: &str,
    expected_oid: Oid,
    decision_id: &str,
    basis_digest: &str,
    author: &Author,
    max_pack_bytes: usize,
) -> Result<PreparedCommit> {
    let mut sealed = candidate.clone(); sealed.seal()?;
    canonical::hash_projection("klocgit.commit-author", author)?;
    crate::contracts::validate_digest(basis_digest)?;
    if sealed.id != candidate.id || sealed.candidate_digest != candidate.candidate_digest ||
        candidate.repo_tree_oids.len() != 1 || !candidate.repo_tree_oids.contains_key(repo_id) ||
        decision_id.is_empty() || decision_id.len() > 256 || decision_id.chars().any(char::is_control) ||
        author.name.is_empty() || author.email.is_empty() || author.unix_timestamp < 0 ||
        [&author.name, &author.email].iter().any(|value| value.len() > 256 ||
            value.chars().any(|c| c.is_control() || c == '<' || c == '>')) ||
        max_pack_bytes == 0 {
        return Err(Error::InvalidInput("invalid commit preparation".into()));
    }
    let scratch = tempfile::tempdir().map_err(|error| Error::InvalidInput(error.to_string()))?;
    let repository = Repository::init_bare(scratch.path())?;
    let tree_oid = super::workspace::tree_oid_with_objects(source, Limits::default(),
        HydrationBudget { max_blob_bytes: 16 * 1024 * 1024, max_total_bytes: 64 * 1024 * 1024 }, Some(&repository))?;
    if candidate.repo_tree_oids[repo_id] != tree_oid.to_string() { return Err(Error::RevisionMismatch); }
    let signature = format!("{} <{}> {} +0000", author.name, author.email, author.unix_timestamp);
    let commit = format!("tree {tree_oid}\nparent {expected_oid}\nauthor {signature}\ncommitter {signature}\n\nKLoCGit decision {decision_id}\n\nBasis: {basis_digest}\n");
    let target_oid = repository.odb()?.write(ObjectType::Commit, commit.as_bytes())?;
    let mut builder = repository.packbuilder()?;
    builder.set_threads(1);
    builder.insert_commit(target_oid)?;
    let mut pack = Vec::new();
    let mut exceeded = false;
    let result = builder.foreach(|chunk| {
        if chunk.len() > max_pack_bytes.saturating_sub(pack.len()) { exceeded = true; return false; }
        pack.extend_from_slice(chunk); true
    });
    if exceeded { return Err(Error::LimitExceeded("promotion pack bytes")); }
    result?;
    Ok(PreparedCommit { target_oid, tree_oid, expected_oid, payload_digest: canonical::payload_digest(&pack)?, pack })
}
