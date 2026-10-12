use super::{Budget, Entry};
use crate::contracts::{CanonicalFutureRevisionState, EffectSet, FutureRevision};
use crate::{Error, Result};
use git2::{ObjectType, Oid, Repository};
use std::collections::BTreeMap;

/// A GitStore supplies authoritative commit metadata. Raw tree and blob reads
/// are independently checked against their Git object IDs before use.
pub trait ObjectSource {
    fn commit(&self, oid: Oid) -> Result<CommitHeader>;
    fn tree(&self, oid: Oid, max_bytes: usize) -> Result<Vec<u8>>;
    fn blob(&self, oid: Oid, max_bytes: usize) -> Result<Vec<u8>>;
}

pub struct CommitHeader {
    pub commit_oid: Oid,
    pub tree_oid: Oid,
    pub parent_oids: Vec<Oid>,
}

pub struct ObjectFuture<'a> {
    pub revision: &'a FutureRevision,
    pub state: &'a CanonicalFutureRevisionState,
    pub effects: &'a EffectSet,
    pub objects: &'a dyn ObjectSource,
}

fn read(repository: &Repository, oid: Oid, kind: ObjectType, max: usize) -> Result<Vec<u8>> {
    let odb = repository.odb()?;
    let (size, observed_kind) = odb.read_header(oid)?;
    if observed_kind != kind { return Err(Error::RevisionMismatch); }
    if size > max { return Err(Error::LimitExceeded("Git object bytes")); }
    let object = odb.read(oid)?;
    if Oid::hash_object(kind, object.data())? != oid { return Err(Error::RevisionMismatch); }
    Ok(object.data().to_vec())
}

impl ObjectSource for Repository {
    fn commit(&self, oid: Oid) -> Result<CommitHeader> {
        read(self, oid, ObjectType::Commit, 1024 * 1024)?;
        let commit = self.find_commit(oid)?;
        Ok(CommitHeader { commit_oid: oid, tree_oid: commit.tree_id(), parent_oids: commit.parent_ids().collect() })
    }
    fn tree(&self, oid: Oid, max_bytes: usize) -> Result<Vec<u8>> {
        read(self, oid, ObjectType::Tree, max_bytes)
    }
    fn blob(&self, oid: Oid, max_bytes: usize) -> Result<Vec<u8>> {
        read(self, oid, ObjectType::Blob, max_bytes)
    }
}

pub fn verified_commit(source: &dyn ObjectSource, oid: Oid) -> Result<CommitHeader> {
    let header = source.commit(oid)?;
    if header.commit_oid != oid || header.parent_oids.len() > 1024 { return Err(Error::RevisionMismatch); }
    Ok(header)
}

pub fn verified_blob(source: &dyn ObjectSource, oid: Oid, max_bytes: usize) -> Result<Vec<u8>> {
    let bytes = source.blob(oid, max_bytes)?;
    if bytes.len() > max_bytes { return Err(Error::LimitExceeded("blob bytes")); }
    if Oid::hash_object(ObjectType::Blob, &bytes)? != oid { return Err(Error::RevisionMismatch); }
    Ok(bytes)
}

pub(super) fn read_entries(source: &dyn ObjectSource, oid: Oid, budget: &mut Budget) -> Result<BTreeMap<String, Entry>> {
    let mut entries = BTreeMap::new();
    visit(source, oid, "", 0, budget, &mut entries)?;
    Ok(entries)
}

fn visit(source: &dyn ObjectSource, oid: Oid, prefix: &str, depth: usize, budget: &mut Budget, entries: &mut BTreeMap<String, Entry>) -> Result<()> {
    if depth > budget.limits.max_depth { return Err(Error::LimitExceeded("Git tree depth")); }
    let remaining = budget.limits.max_metadata_bytes.saturating_sub(budget.bytes);
    let bytes = source.tree(oid, remaining)?;
    budget.charge(bytes.len())?;
    if Oid::hash_object(ObjectType::Tree, &bytes)? != oid { return Err(Error::RevisionMismatch); }
    let mut offset = 0;
    let mut previous: Option<Vec<u8>> = None;
    while offset < bytes.len() {
        let separator = bytes[offset..].iter().position(|b| *b == b' ').ok_or(Error::RevisionMismatch)? + offset;
        let end = bytes[separator + 1..].iter().position(|b| *b == 0).ok_or(Error::RevisionMismatch)? + separator + 1;
        let mode = match &bytes[offset..separator] {
            b"40000" => 0o40000, b"100644" => 0o100644, b"100755" => 0o100755,
            b"120000" => 0o120000, b"160000" => 0o160000,
            _ => return Err(Error::InvalidInput("unsupported Git tree mode".into())),
        };
        let name = std::str::from_utf8(&bytes[separator + 1..end]).map_err(|_| Error::InvalidInput("non-UTF8 Git path".into()))?;
        if crate::canonical::nfc(name) != name || name.is_empty() || matches!(name, "." | "..") || name.contains('/') || name.contains('\\') {
            return Err(Error::InvalidInput("unsafe Git tree entry".into()));
        }
        let mut order = name.as_bytes().to_vec();
        if mode == 0o40000 { order.push(b'/'); }
        if previous.as_ref().is_some_and(|old| old >= &order) { return Err(Error::RevisionMismatch); }
        previous = Some(order);
        let raw_oid = bytes.get(end + 1..end + 21).ok_or(Error::RevisionMismatch)?;
        let child_oid = Oid::from_bytes(raw_oid)?;
        offset = end + 21;
        budget.entries += 1;
        if budget.entries > budget.limits.max_entries { return Err(Error::LimitExceeded("Git tree entries")); }
        let path = if prefix.is_empty() { name.into() } else { format!("{prefix}/{name}") };
        budget.charge(path.len())?;
        if mode == 0o40000 { visit(source, child_oid, &path, depth + 1, budget, entries)?; }
        else if entries.insert(path.clone(), Entry { oid: child_oid, mode }).is_some() { return Err(Error::Conflict(path)); }
    }
    Ok(())
}

pub mod broker;
