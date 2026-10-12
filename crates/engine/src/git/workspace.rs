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
    pub fn path(&self) -> &Path {
        self.directory.path()
    }
}

#[derive(Clone, Copy)]
pub struct HydrationBudget {
    pub max_blob_bytes: usize,
    pub max_total_bytes: usize,
}

/// Materialize an exact whole-Future plan locally. A spec with unsupported
/// selectors or omitted changes is rejected instead of silently adding code.
pub fn materialize(
    specification: &CandidateSpec,
    base: &Repository,
    repo_id: &str,
    sources: &[FutureSource<'_>],
    limits: Limits,
    hydration: HydrationBudget,
    metadata: MaterializationRecord,
) -> Result<Workspace> {
    let mut verified = specification.clone();
    verified.seal()?;
    if verified.spec_digest != specification.spec_digest || verified.id != specification.id {
        return Err(Error::RevisionMismatch);
    }
    if specification.base_revisions.len() != 1
        || !specification.base_revisions.contains_key(repo_id)
    {
        return Err(Error::InvalidInput(
            "single-repository materializer requires one explicit base".into(),
        ));
    }
    let base_oid = Oid::from_str(&specification.base_revisions[repo_id])?;
    let composition = compose(base, repo_id, base_oid, sources, limits)?;
    if composition.spec.selected_future_revisions != specification.selected_future_revisions
        || composition.spec.composition_manifest != specification.composition_manifest
        || composition.spec.effect_summary_digest != specification.effect_summary_digest
    {
        return Err(Error::RevisionMismatch);
    }
    checkout(
        specification,
        repo_id,
        composition,
        |_path, oid, max| {
            let source = sources
                .iter()
                .map(|source| source.repository)
                .chain(std::iter::once(base))
                .find(|repository| repository.odb().is_ok_and(|odb| odb.exists(oid)))
                .ok_or(Error::RevisionMismatch)?;
            hydrate_blob(source, oid, max)
        },
        hydration,
        metadata,
    )
}

/// Fetch tree metadata first, then only blobs present in the composed tree.
/// This path never clones a repository or publishes candidate Git objects.
pub fn materialize_from_objects(
    specification: &CandidateSpec,
    base: &dyn super::objects::ObjectSource,
    repo_id: &str,
    sources: &[super::objects::ObjectFuture<'_>],
    limits: Limits,
    hydration: HydrationBudget,
    metadata: MaterializationRecord,
) -> Result<Workspace> {
    let mut verified = specification.clone();
    verified.seal()?;
    if verified.spec_digest != specification.spec_digest
        || verified.id != specification.id
        || specification.base_revisions.len() != 1
        || !specification.base_revisions.contains_key(repo_id)
    {
        return Err(Error::RevisionMismatch);
    }
    let composition = super::compose_from_objects(
        base,
        repo_id,
        Oid::from_str(&specification.base_revisions[repo_id])?,
        sources,
        limits,
    )?;
    if composition.spec.selected_future_revisions != specification.selected_future_revisions
        || composition.spec.composition_manifest != specification.composition_manifest
        || composition.spec.effect_summary_digest != specification.effect_summary_digest
    {
        return Err(Error::RevisionMismatch);
    }
    checkout(
        specification,
        repo_id,
        composition,
        |path, oid, max| {
            let owner = specification
                .composition_manifest
                .iter()
                .find(|slice| slice.path == path);
            let source = match owner {
                Some(owner) => sources
                    .iter()
                    .find(|source| source.revision.id == owner.source_future_id)
                    .map(|source| source.objects)
                    .ok_or(Error::RevisionMismatch)?,
                None => base,
            };
            super::objects::verified_blob(source, oid, max)
        },
        hydration,
        metadata,
    )
}

fn checkout(
    specification: &CandidateSpec,
    repo_id: &str,
    composition: Composition,
    mut read_blob: impl FnMut(&str, Oid, usize) -> Result<Vec<u8>>,
    budget: HydrationBudget,
    metadata: MaterializationRecord,
) -> Result<Workspace> {
    let directory = tempfile::Builder::new()
        .prefix("klocgit-candidate-")
        .tempdir()
        .map_err(|error| Error::InvalidInput(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755))
            .map_err(|error| Error::InvalidInput(error.to_string()))?;
    }
    let mut bytes_hydrated = 0usize;
    let mut files_hydrated = 0usize;
    for (path, entry) in &composition.entries {
        if path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            return Err(Error::InvalidInput(
                "reserved Git administration path".into(),
            ));
        }
        if entry.mode == 0o160000 {
            return Err(Error::InvalidInput(
                "submodule hydration requires an explicit pinned workspace source".into(),
            ));
        }
        let remaining = budget.max_total_bytes.saturating_sub(bytes_hydrated);
        let blob = read_blob(path, entry.oid, budget.max_blob_bytes.min(remaining))?;
        bytes_hydrated = bytes_hydrated
            .checked_add(blob.len())
            .ok_or(Error::LimitExceeded("hydrated bytes"))?;
        if bytes_hydrated > budget.max_total_bytes {
            return Err(Error::LimitExceeded("hydrated bytes"));
        }
        let destination = directory.path().join(path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| Error::InvalidInput(error.to_string()))?;
        }
        match entry.mode {
            0o100644 | 0o100755 => {
                fs::write(&destination, blob)
                    .map_err(|error| Error::InvalidInput(error.to_string()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mode = if entry.mode == 0o100755 { 0o755 } else { 0o644 };
                    fs::set_permissions(&destination, fs::Permissions::from_mode(mode))
                        .map_err(|error| Error::InvalidInput(error.to_string()))?;
                }
            }
            0o120000 => {
                let target = std::str::from_utf8(&blob)
                    .map_err(|_| Error::InvalidInput("non-UTF8 symlink".into()))?;
                let relative = Path::new(path).parent().unwrap_or(Path::new(""));
                validate_symlink(relative, Path::new(target))?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, &destination)
                    .map_err(|error| Error::InvalidInput(error.to_string()))?;
                #[cfg(not(unix))]
                return Err(Error::InvalidInput(
                    "symlink materialization is unsupported on this host".into(),
                ));
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
        id: String::new(),
        candidate_digest: String::new(),
        materialization_record: metadata,
    };
    candidate.seal()?;
    Ok(Workspace {
        directory,
        candidate,
        bytes_hydrated,
        files_hydrated,
    })
}

fn validate_symlink(parent: &Path, target: &Path) -> Result<()> {
    if target.as_os_str().is_empty() {
        return Err(Error::InvalidInput("empty symlink".into()));
    }
    let mut depth = parent.components().count();
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => depth -= 1,
            _ => {
                return Err(Error::InvalidInput(
                    "symlink escapes candidate workspace".into(),
                ))
            }
        }
    }
    Ok(())
}

/// Hash the actual files presented to a checker. No Git index or producer
/// metadata is used to assert that an execution workspace matches its subject.
pub fn tree_oid(directory: &Path, limits: Limits, hydration: HydrationBudget) -> Result<Oid> {
    tree_oid_with_objects(directory, limits, hydration, None)
}

pub(super) fn tree_oid_with_objects(
    directory: &Path,
    limits: Limits,
    hydration: HydrationBudget,
    repository: Option<&Repository>,
) -> Result<Oid> {
    fn visit(
        root: &Path,
        current: &Path,
        depth: usize,
        limits: Limits,
        hydration: HydrationBudget,
        entries: &mut BTreeMap<String, super::Entry>,
        total: &mut usize,
        odb: Option<&git2::Odb<'_>>,
    ) -> Result<()> {
        use std::io::Read;
        if depth > limits.max_depth {
            return Err(Error::LimitExceeded("workspace depth"));
        }
        let children =
            fs::read_dir(current).map_err(|error| Error::InvalidInput(error.to_string()))?;
        for child in children {
            let child = child.map_err(|error| Error::InvalidInput(error.to_string()))?;
            let path = child.path();
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| Error::InvalidInput("non-UTF8 workspace path".into()))?;
            if name.eq_ignore_ascii_case(".git")
                || crate::canonical::nfc(&name) != name
                || name.contains('\\')
            {
                return Err(Error::InvalidInput(
                    "unsafe execution workspace path".into(),
                ));
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| Error::InvalidInput(error.to_string()))?;
            if metadata.is_dir() {
                visit(
                    root,
                    &path,
                    depth + 1,
                    limits,
                    hydration,
                    entries,
                    total,
                    odb,
                )?;
                continue;
            }
            if entries.len() >= limits.max_entries {
                return Err(Error::LimitExceeded("workspace entries"));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error::RevisionMismatch)?;
            let key = relative
                .to_str()
                .ok_or_else(|| Error::InvalidInput("non-UTF8 workspace path".into()))?
                .to_string();
            let (contents, mode) = if metadata.file_type().is_symlink() {
                let target =
                    fs::read_link(&path).map_err(|error| Error::InvalidInput(error.to_string()))?;
                validate_symlink(relative.parent().unwrap_or(Path::new("")), &target)?;
                (
                    target
                        .to_str()
                        .ok_or_else(|| Error::InvalidInput("non-UTF8 symlink".into()))?
                        .as_bytes()
                        .to_vec(),
                    0o120000,
                )
            } else if metadata.is_file() {
                let maximum = hydration
                    .max_blob_bytes
                    .min(hydration.max_total_bytes.saturating_sub(*total));
                if metadata.len() > maximum as u64 {
                    return Err(Error::LimitExceeded("workspace blob bytes"));
                }
                let mut bytes = Vec::new();
                fs::File::open(&path)
                    .map_err(|error| Error::InvalidInput(error.to_string()))?
                    .take(maximum as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| Error::InvalidInput(error.to_string()))?;
                if bytes.len() > maximum {
                    return Err(Error::LimitExceeded("workspace blob bytes"));
                }
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o111 != 0 {
                        0o100755
                    } else {
                        0o100644
                    }
                };
                #[cfg(not(unix))]
                let mode = 0o100644;
                (bytes, mode)
            } else {
                return Err(Error::InvalidInput(
                    "unsupported execution file type".into(),
                ));
            };
            *total = total
                .checked_add(contents.len())
                .ok_or(Error::LimitExceeded("workspace bytes"))?;
            if *total > hydration.max_total_bytes {
                return Err(Error::LimitExceeded("workspace bytes"));
            }
            let oid = Oid::hash_object(git2::ObjectType::Blob, &contents)?;
            if let Some(odb) = odb {
                if odb.write(git2::ObjectType::Blob, &contents)? != oid {
                    return Err(Error::RevisionMismatch);
                }
            }
            entries.insert(key, super::Entry { oid, mode });
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    let odb = repository.map(Repository::odb).transpose()?;
    visit(
        directory,
        directory,
        0,
        limits,
        hydration,
        &mut entries,
        &mut 0,
        odb.as_ref(),
    )?;
    let mut trees = BTreeMap::new();
    let tree_oid = super::synthesize_tree(&entries, &mut trees, limits)?;
    if let Some(odb) = odb {
        for (oid, bytes) in trees {
            if odb.write(git2::ObjectType::Tree, &bytes)? != oid {
                return Err(Error::RevisionMismatch);
            }
        }
    }
    Ok(tree_oid)
}
