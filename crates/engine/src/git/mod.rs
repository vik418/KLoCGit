//! Git composition returns ephemeral tree objects and never updates refs.

use crate::canonical;
use crate::contracts::{
    CandidateSpec, CanonicalCandidateSpec, CanonicalFutureRevisionState, EffectSet, FutureRevision,
    ProvenanceSlice, Selector, SelectorType,
};
use crate::{Error, Result};
use git2::{ObjectType, Oid, Repository};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_entries: usize,
    pub max_metadata_bytes: usize,
    pub max_depth: usize,
    pub max_blob_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_metadata_bytes: 32 * 1024 * 1024,
            max_depth: 64,
            max_blob_bytes: 16 * 1024 * 1024,
        }
    }
}

pub struct FutureSource<'a> {
    pub revision: &'a FutureRevision,
    pub state: &'a CanonicalFutureRevisionState,
    pub effects: &'a EffectSet,
    pub repository: &'a Repository,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub oid: Oid,
    pub mode: i32,
}

#[derive(Debug)]
pub struct Composition {
    pub spec: CandidateSpec,
    pub tree_oid: Oid,
    /// Only synthesized trees live here. Referenced blobs remain in the source
    /// object databases until an evaluator requests bounded hydration.
    pub tree_objects: BTreeMap<Oid, Vec<u8>>,
    pub entries: BTreeMap<String, Entry>,
    pub metadata_bytes_read: usize,
}

struct Budget {
    entries: usize,
    bytes: usize,
    limits: Limits,
}

impl Budget {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(Error::LimitExceeded("Git metadata bytes"))?;
        if self.bytes > self.limits.max_metadata_bytes {
            return Err(Error::LimitExceeded("Git metadata bytes"));
        }
        Ok(())
    }
}

/// Compose disjoint path deltas relative to the exact base commit. This only
/// establishes textual composition; the resulting state still needs evaluation.
pub fn compose(
    base_repo: &Repository,
    repo_id: &str,
    base_oid: Oid,
    futures: &[FutureSource<'_>],
    limits: Limits,
) -> Result<Composition> {
    if futures.is_empty() || repo_id.is_empty() {
        return Err(Error::InvalidInput(
            "missing repository or selected Futures".into(),
        ));
    }
    let mut budget = Budget {
        entries: 0,
        bytes: 0,
        limits,
    };
    let base_tree = verified_commit_tree(base_repo, base_oid, &mut budget)?;
    let baseline = read_entries(base_repo, base_tree, &mut budget)?;
    let mut entries = baseline.clone();
    let mut changes = BTreeMap::<String, (Option<Entry>, String, String)>::new();
    let mut selected = BTreeSet::new();
    let mut effect_digests = BTreeSet::new();
    for source in futures {
        source.revision.verify(source.state)?;
        if source.state.repo_id != repo_id {
            return Err(Error::RevisionMismatch);
        }
        let mut sealed = source.effects.clone();
        sealed.seal()?;
        if sealed.effect_digest != source.effects.effect_digest
            || source.effects.future_revision_id != source.revision.id
        {
            return Err(Error::RevisionMismatch);
        }
        effect_digests.insert(source.effects.effect_digest.clone());
        if !selected.insert(source.revision.id.clone()) {
            return Err(Error::InvalidInput("duplicate Future selection".into()));
        }
        let commit_oid = Oid::from_str(&source.state.commit_oid)?;
        let tree_oid = verified_commit_tree(source.repository, commit_oid, &mut budget)?;
        let parents: Vec<_> = source
            .repository
            .find_commit(commit_oid)?
            .parent_ids()
            .map(|id| id.to_string())
            .collect();
        if tree_oid.to_string() != source.state.tree_oid || parents != source.state.parent_oids {
            return Err(Error::RevisionMismatch);
        }
        if verified_commit_tree(source.repository, base_oid, &mut budget)? != base_tree {
            return Err(Error::RevisionMismatch);
        }
        let observed = read_entries(source.repository, tree_oid, &mut budget)?;
        for path in baseline
            .keys()
            .chain(observed.keys())
            .collect::<BTreeSet<_>>()
        {
            if baseline.get(path) == observed.get(path) {
                continue;
            }
            if changes.contains_key(path) {
                return Err(Error::Conflict(path.clone()));
            }
            changes.insert(
                path.clone(),
                (
                    observed.get(path).cloned(),
                    source.revision.id.clone(),
                    source.state.commit_oid.clone(),
                ),
            );
        }
    }
    let mut manifest = Vec::new();
    for (path, (entry, future, commit)) in changes {
        if let Some(entry) = entry {
            entries.insert(path.clone(), entry);
        } else {
            entries.remove(&path);
        }
        manifest.push(ProvenanceSlice {
            repo_id: repo_id.into(),
            selector: Selector {
                r#type: SelectorType::File,
                value: path.clone(),
            },
            path,
            source_future_id: future,
            source_commit_oid: commit,
        });
    }
    let mut objects = BTreeMap::new();
    let tree_oid = synthesize_tree(&entries, &mut objects, limits)?;
    let mut spec = CandidateSpec {
        canonical: CanonicalCandidateSpec {
            base_revisions: BTreeMap::from([(repo_id.into(), base_oid.to_string())]),
            selected_future_revisions: selected.into_iter().collect(),
            composition_manifest: manifest,
            creation_reason: "disjoint-path-composition".into(),
        },
        id: String::new(),
        spec_digest: String::new(),
        effect_summary_digest: canonical::hash_projection(
            "klocgit.effect-summary",
            &effect_digests,
        )?,
    };
    spec.seal()?;
    Ok(Composition {
        spec,
        tree_oid,
        tree_objects: objects,
        entries,
        metadata_bytes_read: budget.bytes,
    })
}

/// Hydrate one blob from its pinned source. Size is checked before allocation,
/// and content is checked against its Git OID before it reaches execution.
pub fn hydrate_blob(repository: &Repository, oid: Oid, max_bytes: usize) -> Result<Vec<u8>> {
    let odb = repository.odb()?;
    let (size, kind) = odb.read_header(oid)?;
    if kind != ObjectType::Blob {
        return Err(Error::InvalidInput("requested object is not a blob".into()));
    }
    if size > max_bytes {
        return Err(Error::LimitExceeded("blob bytes"));
    }
    let object = odb.read(oid)?;
    if Oid::hash_object(ObjectType::Blob, object.data())? != oid {
        return Err(Error::RevisionMismatch);
    }
    Ok(object.data().to_vec())
}

fn verify_object(
    repository: &Repository,
    oid: Oid,
    kind: ObjectType,
    budget: &mut Budget,
) -> Result<()> {
    let odb = repository.odb()?;
    let (size, observed_kind) = odb.read_header(oid)?;
    if observed_kind != kind {
        return Err(Error::RevisionMismatch);
    }
    budget.charge(size)?;
    let object = odb.read(oid)?;
    if Oid::hash_object(kind, object.data())? != oid {
        return Err(Error::RevisionMismatch);
    }
    Ok(())
}

fn verified_commit_tree(repository: &Repository, oid: Oid, budget: &mut Budget) -> Result<Oid> {
    verify_object(repository, oid, ObjectType::Commit, budget)?;
    Ok(repository.find_commit(oid)?.tree_id())
}

fn read_entries(
    repository: &Repository,
    tree: Oid,
    budget: &mut Budget,
) -> Result<BTreeMap<String, Entry>> {
    let mut entries = BTreeMap::new();
    visit_tree(repository, tree, "", 0, budget, &mut entries)?;
    Ok(entries)
}

fn visit_tree(
    repository: &Repository,
    oid: Oid,
    prefix: &str,
    depth: usize,
    budget: &mut Budget,
    entries: &mut BTreeMap<String, Entry>,
) -> Result<()> {
    if depth > budget.limits.max_depth {
        return Err(Error::LimitExceeded("Git tree depth"));
    }
    verify_object(repository, oid, ObjectType::Tree, budget)?;
    let tree = repository.find_tree(oid)?;
    for item in tree.iter() {
        budget.entries += 1;
        if budget.entries > budget.limits.max_entries {
            return Err(Error::LimitExceeded("Git tree entries"));
        }
        let name = item
            .name()
            .ok_or_else(|| Error::InvalidInput("non-UTF8 Git path".into()))?;
        if canonical::nfc(name) != name
            || name.is_empty()
            || matches!(name, "." | "..")
            || name.contains('/')
            || name.contains('\\')
        {
            return Err(Error::InvalidInput("unsafe Git tree entry".into()));
        }
        let path = if prefix.is_empty() {
            name.into()
        } else {
            format!("{prefix}/{name}")
        };
        budget.charge(path.len())?;
        if item.kind() == Some(ObjectType::Tree) {
            visit_tree(repository, item.id(), &path, depth + 1, budget, entries)?;
        } else if matches!(item.filemode(), 0o100644 | 0o100755 | 0o120000 | 0o160000) {
            if entries
                .insert(
                    path.clone(),
                    Entry {
                        oid: item.id(),
                        mode: item.filemode(),
                    },
                )
                .is_some()
            {
                return Err(Error::Conflict(path));
            }
        } else {
            return Err(Error::InvalidInput("unsupported Git tree mode".into()));
        }
    }
    Ok(())
}

#[derive(Default)]
struct Directory {
    children: BTreeMap<String, Directory>,
    entry: Option<Entry>,
}

fn synthesize_tree(
    entries: &BTreeMap<String, Entry>,
    objects: &mut BTreeMap<Oid, Vec<u8>>,
    limits: Limits,
) -> Result<Oid> {
    let mut root = Directory::default();
    for (path, entry) in entries {
        let mut directory = &mut root;
        for part in path.split('/') {
            if directory.entry.is_some() {
                return Err(Error::Conflict(path.clone()));
            }
            directory = directory.children.entry(part.into()).or_default();
        }
        if !directory.children.is_empty() {
            return Err(Error::Conflict(path.clone()));
        }
        directory.entry = Some(entry.clone());
    }
    let mut bytes = 0;
    encode_tree(&root, objects, &mut bytes, limits.max_metadata_bytes)
}

fn encode_tree(
    directory: &Directory,
    objects: &mut BTreeMap<Oid, Vec<u8>>,
    total: &mut usize,
    limit: usize,
) -> Result<Oid> {
    let mut ordered: Vec<_> = directory.children.iter().collect();
    ordered.sort_by_key(|(name, child)| {
        if child.entry.is_none() {
            format!("{name}/")
        } else {
            name.to_string()
        }
    });
    let mut output = Vec::new();
    for (name, child) in ordered {
        let (mode, oid) = match &child.entry {
            Some(entry) => (entry.mode, entry.oid),
            None => (0o40000, encode_tree(child, objects, total, limit)?),
        };
        let prefix = format!("{mode:o} {name}\0");
        *total = total
            .checked_add(prefix.len() + oid.as_bytes().len())
            .ok_or(Error::LimitExceeded("synthesized tree bytes"))?;
        if *total > limit {
            return Err(Error::LimitExceeded("synthesized tree bytes"));
        }
        output.extend(prefix.as_bytes());
        output.extend(oid.as_bytes());
    }
    let oid = Oid::hash_object(ObjectType::Tree, &output)?;
    objects.insert(oid, output);
    Ok(oid)
}
