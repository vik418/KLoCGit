use git2::{Oid, Repository, Signature};
use klocgit_engine::contracts::{CanonicalFutureRevisionRecord, CanonicalFutureRevisionState, EffectSet, FutureRevision, Language, Producer};
use klocgit_engine::extractors::{analyze, Limits as ExtractorLimits};
use klocgit_engine::git::{compose, hydrate_blob, FutureSource, Limits};
use klocgit_engine::Error;
use std::collections::{BTreeMap, BTreeSet};

fn tree(repo: &Repository, files: &[(&str, &[u8], i32)]) -> Oid {
    let mut builder = repo.treebuilder(None).unwrap();
    let mut children: BTreeMap<&str, Vec<(&str, &[u8], i32)>> = BTreeMap::new();
    for &(path, contents, mode) in files {
        if let Some((directory, remainder)) = path.split_once('/') {
            children.entry(directory).or_default().push((remainder, contents, mode));
        } else { builder.insert(path, repo.blob(contents).unwrap(), mode).unwrap(); }
    }
    for (name, files) in children { builder.insert(name, tree(repo, &files), 0o40000).unwrap(); }
    builder.write().unwrap()
}
fn commit_modes(repo: &Repository, parent: Option<Oid>, files: &[(&str, &[u8], i32)]) -> Oid {
    let tree = repo.find_tree(tree(repo, files)).unwrap();
    let identity = Signature::new("Fixture", "fixture@example.org", &git2::Time::new(0, 0)).unwrap();
    let parents: Vec<_> = parent.map(|id| repo.find_commit(id).unwrap()).into_iter().collect();
    repo.commit(None, &identity, &identity, "fixture", &tree, &parents.iter().collect::<Vec<_>>()).unwrap()
}
fn commit(repo: &Repository, parent: Option<Oid>, files: &[(&str, &[u8])]) -> Oid {
    commit_modes(repo, parent, &files.iter().map(|&(path, bytes)| (path, bytes, 0o100644)).collect::<Vec<_>>())
}
struct Observed { state: CanonicalFutureRevisionState, record: FutureRevision, effects: EffectSet }
impl Observed {
    fn source<'a>(&'a self, repository: &'a Repository) -> FutureSource<'a> {
        FutureSource { revision: &self.record, state: &self.state, effects: &self.effects, repository }
    }
    fn reseal(&mut self) {
        self.record.seal(&self.state).unwrap();
        self.effects = analyze(&self.record.id, Language::Typescript, &[], ExtractorLimits::default());
    }
}
fn observation(repo: &Repository, oid: Oid, actor: &str) -> Observed {
    let commit = repo.find_commit(oid).unwrap();
    let state = CanonicalFutureRevisionState { repo_id: "repo".into(), commit_oid: oid.to_string(), tree_oid: commit.tree_id().to_string(), parent_oids: commit.parent_ids().map(|id| id.to_string()).collect() };
    let mut record = FutureRevision {
        canonical: CanonicalFutureRevisionRecord {
            state_digest: String::new(), system_id: "system".into(), r#ref: format!("refs/futures/{actor}/work"),
            producer: Producer { actor_id: actor.into(), agent_version: None, task_id: None, prompt_digest: None },
        }, id: String::new(), record_digest: String::new(), observed_at: "2026-01-01T00:00:00Z".into(),
    };
    record.seal(&state).unwrap();
    let effects = analyze(&record.id, Language::Typescript, &[], ExtractorLimits::default());
    Observed { state, record, effects }
}
fn objects(repo: &Repository) -> BTreeSet<Oid> {
    let mut result = BTreeSet::new();
    repo.odb().unwrap().foreach(|oid| { result.insert(*oid); true }).unwrap(); result
}

#[test]
fn disjoint_futures_compose_without_durable_object_or_ref_writes() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("a.ts", b"export const A = 1;"), ("b.py", b"B = 1\n")]);
    repo.reference("refs/heads/main", base, false, "fixture").unwrap();
    let a = observation(&repo, commit(&repo, Some(base), &[("a.ts", b"export const A = 2;"), ("b.py", b"B = 1\n")]), "a");
    let b = observation(&repo, commit(&repo, Some(base), &[("a.ts", b"export const A = 1;"), ("b.py", b"B = 2\n")]), "b");
    let before = objects(&repo);
    let result = compose(&repo, "repo", base, &[a.source(&repo), b.source(&repo)], Limits::default()).unwrap();
    assert_eq!(repo.find_reference("refs/heads/main").unwrap().target(), Some(base));
    assert_eq!(objects(&repo), before); assert!(!repo.odb().unwrap().exists(result.tree_oid));
    let mut expected = repo.treebuilder(None).unwrap();
    expected.insert("a.ts", result.entries["a.ts"].oid, 0o100644).unwrap();
    expected.insert("b.py", result.entries["b.py"].oid, 0o100644).unwrap();
    assert_eq!(result.tree_oid, expected.write().unwrap());
    assert_eq!(result.spec.composition_manifest[0].source_future_id, a.record.id);
    assert_eq!(result.spec.composition_manifest[1].source_future_id, b.record.id);
    assert_eq!(hydrate_blob(&repo, result.entries["b.py"].oid, 100).unwrap(), b"B = 2\n");
}
#[test]
fn future_order_does_not_change_tree_or_spec_identity() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("a", b"0"), ("b", b"0")]);
    let a = observation(&repo, commit(&repo, Some(base), &[("a", b"1"), ("b", b"0")]), "a");
    let b = observation(&repo, commit(&repo, Some(base), &[("a", b"0"), ("b", b"1")]), "b");
    let forward = compose(&repo, "repo", base, &[a.source(&repo), b.source(&repo)], Limits::default()).unwrap();
    let reverse = compose(&repo, "repo", base, &[b.source(&repo), a.source(&repo)], Limits::default()).unwrap();
    assert_eq!(forward.tree_oid, reverse.tree_oid); assert_eq!(forward.spec, reverse.spec);
}
#[test]
fn overlapping_paths_are_rejected() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("api.go", b"package api")]);
    let a = observation(&repo, commit(&repo, Some(base), &[("api.go", b"package a")]), "a");
    let b = observation(&repo, commit(&repo, Some(base), &[("api.go", b"package b")]), "b");
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo), b.source(&repo)], Limits::default()), Err(Error::Conflict(_))));
}
#[test]
fn authoritative_tree_and_parent_order_are_verified() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("a", b"0")]);
    let mut a = observation(&repo, commit(&repo, Some(base), &[("a", b"1")]), "a");
    a.state.tree_oid = repo.find_commit(base).unwrap().tree_id().to_string(); a.reseal();
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo)], Limits::default()), Err(Error::RevisionMismatch)));
    a = observation(&repo, Oid::from_str(&a.state.commit_oid).unwrap(), "a");
    a.state.parent_oids = vec![]; a.reseal();
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo)], Limits::default()), Err(Error::RevisionMismatch)));
}
#[test]
fn duplicate_selection_and_substituted_effect_records_are_rejected() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("a", b"0")]); let mut a = observation(&repo, base, "a");
    assert!(compose(&repo, "repo", base, &[a.source(&repo), a.source(&repo)], Limits::default()).is_err());
    a.effects.canonical.modified_exports.push("unbound".into());
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo)], Limits::default()), Err(Error::RevisionMismatch)));
}
#[test]
fn metadata_and_blob_hydration_limits_are_enforced() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("a", &[0; 1024])]); let a = observation(&repo, base, "a");
    assert!(matches!(hydrate_blob(&repo, repo.find_commit(base).unwrap().tree().unwrap().get_name("a").unwrap().id(), 100), Err(Error::LimitExceeded(_))));
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo)], Limits { max_entries: 0, ..Limits::default() }), Err(Error::LimitExceeded(_))));
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo)], Limits { max_metadata_bytes: 1, ..Limits::default() }), Err(Error::LimitExceeded(_))));
}
#[test]
fn deletion_provenance_and_tree_objects_remain_inspectable() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("a", b"0"), ("b", b"0")]);
    let a = observation(&repo, commit(&repo, Some(base), &[("b", b"0")]), "a");
    let result = compose(&repo, "repo", base, &[a.source(&repo)], Limits::default()).unwrap();
    assert!(!result.entries.contains_key("a"));
    assert_eq!(result.spec.composition_manifest[0].path, "a");
    assert_eq!(result.spec.composition_manifest[0].source_future_id, a.record.id);
    assert_eq!(Oid::hash_object(git2::ObjectType::Tree, &result.tree_objects[&result.tree_oid]).unwrap(), result.tree_oid);
}
#[test]
fn nested_paths_and_executable_and_symlink_modes_are_preserved() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit_modes(&repo, None, &[("src/api.ts", b"old", 0o100644), ("run", b"old", 0o100755), ("link", b"src/api.ts", 0o120000)]);
    let a = observation(&repo, commit_modes(&repo, Some(base), &[("src/api.ts", b"new", 0o100644), ("run", b"old", 0o100755), ("link", b"src/api.ts", 0o120000)]), "a");
    let result = compose(&repo, "repo", base, &[a.source(&repo)], Limits::default()).unwrap();
    assert_eq!(result.entries["run"].mode, 0o100755); assert_eq!(result.entries["link"].mode, 0o120000);
    assert_eq!(result.tree_oid, tree(&repo, &[("src/api.ts", b"new", 0o100644), ("run", b"old", 0o100755), ("link", b"src/api.ts", 0o120000)]));
}
#[test]
fn file_directory_interactions_fail_materialization() {
    let dir = tempfile::tempdir().unwrap(); let repo = Repository::init_bare(dir.path()).unwrap();
    let base = commit(&repo, None, &[("src/a", b"old")]);
    let a = observation(&repo, commit(&repo, Some(base), &[("src", b"file")]), "a");
    let b = observation(&repo, commit(&repo, Some(base), &[("src/a", b"old"), ("src/b", b"new")]), "b");
    assert!(matches!(compose(&repo, "repo", base, &[a.source(&repo), b.source(&repo)], Limits::default()), Err(Error::Conflict(_))));
}
