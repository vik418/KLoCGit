use super::{compose, hydrate_blob, Composition, FutureSource, Limits};
use crate::contracts::{Candidate, CandidateSpec, CanonicalCandidate, MaterializationRecord};
use crate::{Error, Result};
use git2::{Oid, Repository};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};
use tempfile::TempDir;

pub struct Workspace {
    directory: TempDir,
    pub candidate: Candidate,
    pub bytes_hydrated: usize,
    pub files_hydrated: usize,
}

impl Workspace {
    pub fn path(&self) -> &Path { self.directory.path() }
}

#[derive(Clone, Copy)]
pub struct HydrationBudget {
    pub max_blob_bytes: usize,
    pub max_total_bytes: usize,
}

/// Materialize an exact whole-Future plan locally. A spec with unsupported
/// selectors or omitted changes is rejected instead of silently adding code.
pub fn materialize(
    specification: &CandidateSpec, base: &Repository, repo_id: &str,
    sources: &[FutureSource<'_>], limits: Limits, hydration: HydrationBudget,
    metadata: MaterializationRecord,
) -> Result<Workspace> {
    let mut verified = specification.clone();
    verified.seal()?;
    if verified.spec_digest != specification.spec_digest || verified.id != specification.id {
        return Err(Error::RevisionMismatch);
    }
    if specification.base_revisions.len() != 1 || !specification.base_revisions.contains_key(repo_id) {
        return Err(Error::InvalidInput("single-repository materializer requires one explicit base".into()));
    }
    let base_oid = Oid::from_str(&specification.base_revisions[repo_id])?;
    let composition = compose(base, repo_id, base_oid, sources, limits)?;
    if composition.spec.selected_future_revisions != specification.selected_future_revisions
        || composition.spec.composition_manifest != specification.composition_manifest
        || composition.spec.effect_summary_digest != specification.effect_summary_digest {
        return Err(Error::RevisionMismatch);
    }
    checkout(specification, repo_id, composition, base, sources, hydration, metadata)
}

fn checkout(
    specification: &CandidateSpec, repo_id: &str, composition: Composition,
    base: &Repository, sources: &[FutureSource<'_>], budget: HydrationBudget,
    metadata: MaterializationRecord,
) -> Result<Workspace> {
    let directory = tempfile::Builder::new().prefix("klocgit-candidate-").tempdir()
        .map_err(|error| Error::InvalidInput(error.to_string()))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755))
            .map_err(|error| Error::InvalidInput(error.to_string()))?;
    }
    let mut bytes_hydrated = 0usize;
    let mut files_hydrated = 0usize;
    for (path, entry) in &composition.entries {
        if path.split('/').any(|part| part.eq_ignore_ascii_case(".git")) {
            return Err(Error::InvalidInput("reserved Git administration path".into()));
        }
        if entry.mode == 0o160000 {
            return Err(Error::InvalidInput("submodule hydration requires an explicit pinned workspace source".into()));
        }
        let source = sources.iter().map(|source| source.repository).chain(std::iter::once(base))
            .find(|repository| repository.odb().is_ok_and(|odb| odb.exists(entry.oid)))
            .ok_or(Error::RevisionMismatch)?;
        let blob = hydrate_blob(source, entry.oid, budget.max_blob_bytes)?;
        bytes_hydrated = bytes_hydrated.checked_add(blob.len()).ok_or(Error::LimitExceeded("hydrated bytes"))?;
        if bytes_hydrated > budget.max_total_bytes { return Err(Error::LimitExceeded("hydrated bytes")); }
        let destination = directory.path().join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| Error::InvalidInput(error.to_string()))?;
        }
        match entry.mode {
            0o100644 | 0o100755 => {
                fs::write(&destination, blob).map_err(|error| Error::InvalidInput(error.to_string()))?;
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = if entry.mode == 0o100755 { 0o755 } else { 0o644 };
                    fs::set_permissions(&destination, fs::Permissions::from_mode(mode)).map_err(|error| Error::InvalidInput(error.to_string()))?;
                }
            }
            0o120000 => {
                let target = std::str::from_utf8(&blob).map_err(|_| Error::InvalidInput("non-UTF8 symlink".into()))?;
                let relative = Path::new(path).parent().unwrap_or(Path::new(""));
                validate_symlink(relative, Path::new(target))?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, &destination).map_err(|error| Error::InvalidInput(error.to_string()))?;
                #[cfg(not(unix))]
                return Err(Error::InvalidInput("symlink materialization is unsupported on this host".into()));
            }
            _ => return Err(Error::InvalidInput("unsupported file mode".into())),
        }
        files_hydrated += 1;
    }
    let mut candidate = Candidate {
        canonical: CanonicalCandidate {
            candidate_spec_id: specification.id.clone(),
            repo_tree_oids: BTreeMap::from([(repo_id.into(), composition.tree_oid.to_string())]),
        },
        id: String::new(), candidate_digest: String::new(), materialization_record: metadata,
    };
    candidate.seal()?;
    Ok(Workspace { directory, candidate, bytes_hydrated, files_hydrated })
}

fn validate_symlink(parent: &Path, target: &Path) -> Result<()> {
    if target.as_os_str().is_empty() { return Err(Error::InvalidInput("empty symlink".into())); }
    let mut depth = parent.components().count();
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            _ => return Err(Error::InvalidInput("symlink escapes candidate workspace".into())),
        }
    }
    Ok(())
}
