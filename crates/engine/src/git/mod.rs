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

/// Compose local Git inputs without modifying their object databases or refs.
pub fn compose(
    base_repo: &Repository,
    repo_id: &str,
    base_oid: Oid,
    futures: &[FutureSource<'_>],
    limits: Limits,
) -> Result<Composition> {
    let sources: Vec<_> = futures
        .iter()
        .map(|source| objects::ObjectFuture {
            revision: source.revision,
            state: source.state,
            effects: source.effects,
            objects: source.repository,
        })
        .collect();
    compose_from_objects(base_repo, repo_id, base_oid, &sources, limits)
}

/// Compose disjoint path deltas relative to the exact base commit. This only
/// establishes textual composition; the resulting state still needs evaluation.
pub fn compose_from_objects(
    base_repo: &dyn objects::ObjectSource,
    repo_id: &str,
    base_oid: Oid,
    futures: &[objects::ObjectFuture<'_>],
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
    let base_tree = objects::verified_commit(base_repo, base_oid)?.tree_oid;
    let baseline = objects::read_entries(base_repo, base_tree, &mut budget)?;
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
        let commit = objects::verified_commit(source.objects, commit_oid)?;
        let tree_oid = commit.tree_oid;
        let parents: Vec<_> = commit.parent_oids.iter().map(ToString::to_string).collect();
        if tree_oid.to_string() != source.state.tree_oid || parents != source.state.parent_oids {
            return Err(Error::RevisionMismatch);
        }
        if objects::verified_commit(source.objects, base_oid)?.tree_oid != base_tree {
            return Err(Error::RevisionMismatch);
        }
        let observed = objects::read_entries(source.objects, tree_oid, &mut budget)?;
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

pub mod objects;
pub mod workspace;

pub struct Snapshot {
    pub tree_oid: Oid,
    pub parent_oids: Vec<Oid>,
    pub entries: BTreeMap<String, Entry>,
}

/// Read pinned tree metadata without hydrating blobs or changing any refs.
pub fn snapshot(source: &dyn objects::ObjectSource, commit_oid: Oid, limits: Limits) -> Result<Snapshot> {
    let commit = objects::verified_commit(source, commit_oid)?;
    let mut budget = Budget { entries: 0, bytes: 0, limits };
    let entries = objects::read_entries(source, commit.tree_oid, &mut budget)?;
    Ok(Snapshot { tree_oid: commit.tree_oid, parent_oids: commit.parent_oids, entries })
}

pub mod remote;
