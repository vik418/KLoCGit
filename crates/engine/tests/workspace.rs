use git2::{ObjectType, Oid, Repository, Signature, Time};
use klocgit_engine::contracts::*;
use klocgit_engine::extractors::{analyze, Limits as ExtractorLimits};
use klocgit_engine::git::workspace::{materialize, HydrationBudget};
use klocgit_engine::git::{compose, FutureSource, Limits};
use std::collections::BTreeSet;

fn commit(repo: &Repository, parent: Option<Oid>, files: &[(&str, &[u8], i32)]) -> Oid {
    let mut builder = repo.treebuilder(None).unwrap();
    for &(path, contents, mode) in files {
        builder
            .insert(path, repo.blob(contents).unwrap(), mode)
            .unwrap();
    }
    let tree = repo.find_tree(builder.write().unwrap()).unwrap();
    let identity = Signature::new("Fixture", "fixture@example.org", &Time::new(0, 0)).unwrap();
    let parents: Vec<_> = parent
        .map(|oid| repo.find_commit(oid).unwrap())
        .into_iter()
        .collect();
    repo.commit(
        None,
        &identity,
        &identity,
        "fixture",
        &tree,
        &parents.iter().collect::<Vec<_>>(),
    )
    .unwrap()
}

fn revision(
    repo: &Repository,
    oid: Oid,
) -> (CanonicalFutureRevisionState, FutureRevision, EffectSet) {
    let commit = repo.find_commit(oid).unwrap();
    let state = CanonicalFutureRevisionState {
        repo_id: "repo".into(),
        commit_oid: oid.to_string(),
        tree_oid: commit.tree_id().to_string(),
        parent_oids: commit.parent_ids().map(|oid| oid.to_string()).collect(),
    };
    let mut revision = FutureRevision {
        canonical: CanonicalFutureRevisionRecord {
            state_digest: String::new(),
            system_id: "product".into(),
            r#ref: "refs/futures/fixture/task".into(),
            producer: Producer {
                actor_id: "fixture".into(),
                agent_version: None,
                task_id: None,
                prompt_digest: None,
            },
        },
        id: String::new(),
        record_digest: String::new(),
        observed_at: "2026-01-01T00:00:00Z".into(),
    };
    revision.seal(&state).unwrap();
    let effects = analyze(
        &revision.id,
        Language::Typescript,
        &[],
        ExtractorLimits::default(),
    );
    (state, revision, effects)
}

fn metadata() -> MaterializationRecord {
    MaterializationRecord {
        executor_id: "fixture".into(),
        materialized_at: "2026-01-01T00:00:00Z".into(),
        conflicts_encountered: vec![],
    }
}

fn objects(repo: &Repository) -> BTreeSet<Oid> {
    let mut result = BTreeSet::new();
    repo.odb()
        .unwrap()
        .foreach(|oid| {
            result.insert(*oid);
            true
        })
        .unwrap();
    result
}

#[test]
fn materialized_files_match_git_state_without_durable_candidate_writes() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(
        &repository,
        None,
        &[("api.ts", b"export const A = 1;", 0o100644)],
    );
    let head = commit(
        &repository,
        Some(base),
        &[
            ("api.ts", b"export const A = 2;", 0o100644),
            ("run", b"#!/bin/sh\nexit 0\n", 0o100755),
        ],
    );
    let (state, revision, effects) = revision(&repository, head);
    let sources = [FutureSource {
        state: &state,
        revision: &revision,
        effects: &effects,
        repository: &repository,
    }];
    let composition = compose(&repository, "repo", base, &sources, Limits::default()).unwrap();
    let before = objects(&repository);
    let workspace = materialize(
        &composition.spec,
        &repository,
        "repo",
        &sources,
        Limits::default(),
        HydrationBudget {
            max_blob_bytes: 1024,
            max_total_bytes: 4096,
        },
        metadata(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read(workspace.path().join("api.ts")).unwrap(),
        b"export const A = 2;"
    );
    assert_eq!(
        workspace.candidate.repo_tree_oids["repo"],
        composition.tree_oid.to_string()
    );
    assert_eq!(workspace.files_hydrated, 2);
    assert_eq!(objects(&repository), before);
    let location = workspace.path().to_path_buf();
    drop(workspace);
    assert!(!location.exists());
}

#[test]
fn a_manifest_cannot_omit_selected_changes_or_escape_the_workspace() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(&repository, None, &[("api.ts", b"old", 0o100644)]);
    let head = commit(
        &repository,
        Some(base),
        &[
            ("api.ts", b"new", 0o100644),
            ("escape", b"/etc/passwd", 0o120000),
        ],
    );
    let (state, revision, effects) = revision(&repository, head);
    let sources = [FutureSource {
        state: &state,
        revision: &revision,
        effects: &effects,
        repository: &repository,
    }];
    let composition = compose(&repository, "repo", base, &sources, Limits::default()).unwrap();
    assert!(materialize(
        &composition.spec,
        &repository,
        "repo",
        &sources,
        Limits::default(),
        HydrationBudget {
            max_blob_bytes: 1024,
            max_total_bytes: 4096
        },
        metadata()
    )
    .is_err());
    let mut spec = composition.spec.clone();
    spec.canonical.composition_manifest.clear();
    spec.seal().unwrap();
    assert!(materialize(
        &spec,
        &repository,
        "repo",
        &sources,
        Limits::default(),
        HydrationBudget {
            max_blob_bytes: 1024,
            max_total_bytes: 4096
        },
        metadata()
    )
    .is_err());
}

#[test]
fn hydration_is_bounded_before_the_blob_reaches_execution() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(&repository, None, &[]);
    let head = commit(&repository, Some(base), &[("large", &[0; 2048], 0o100644)]);
    let (state, revision, effects) = revision(&repository, head);
    let sources = [FutureSource {
        state: &state,
        revision: &revision,
        effects: &effects,
        repository: &repository,
    }];
    let composition = compose(&repository, "repo", base, &sources, Limits::default()).unwrap();
    assert!(materialize(
        &composition.spec,
        &repository,
        "repo",
        &sources,
        Limits::default(),
        HydrationBudget {
            max_blob_bytes: 100,
            max_total_bytes: 4096
        },
        metadata()
    )
    .is_err());
    assert!(materialize(
        &composition.spec,
        &repository,
        "repo",
        &sources,
        Limits::default(),
        HydrationBudget {
            max_blob_bytes: 4096,
            max_total_bytes: 100
        },
        metadata()
    )
    .is_err());
    assert_eq!(
        Oid::hash_object(ObjectType::Blob, &[0; 2048]).unwrap(),
        repository
            .find_commit(head)
            .unwrap()
            .tree()
            .unwrap()
            .get_name("large")
            .unwrap()
            .id()
    );
}

#[test]
fn object_source_reads_only_selected_candidate_blobs_and_detects_substitution() {
    use klocgit_engine::git::objects::{ObjectSource, ObjectFuture, CommitHeader};
    use klocgit_engine::git::workspace::materialize_from_objects;
    use std::cell::RefCell;
    struct Metered<'a> {
        repository: &'a Repository,
        blobs: RefCell<Vec<Oid>>,
        substitute: bool,
    }
    impl ObjectSource for Metered<'_> {
        fn commit(&self, oid: Oid) -> klocgit_engine::Result<CommitHeader> { ObjectSource::commit(self.repository, oid) }
        fn tree(&self, oid: Oid, max: usize) -> klocgit_engine::Result<Vec<u8>> { ObjectSource::tree(self.repository, oid, max) }
        fn blob(&self, oid: Oid, max: usize) -> klocgit_engine::Result<Vec<u8>> {
            self.blobs.borrow_mut().push(oid);
            if self.substitute { Ok(b"substituted".to_vec()) } else { ObjectSource::blob(self.repository, oid, max) }
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(&repository, None, &[("removed", &[0; 65536], 0o100644), ("keep", b"same", 0o100644)]);
    let head = commit(&repository, Some(base), &[("keep", b"same", 0o100644), ("api.ts", b"export const A = 2;", 0o100644)]);
    let (state, revision, effects) = revision(&repository, head);
    let source = Metered { repository: &repository, blobs: RefCell::new(vec![]), substitute: false };
    let futures = [ObjectFuture { state: &state, revision: &revision, effects: &effects, objects: &source }];
    let composition = klocgit_engine::git::compose_from_objects(&source, "repo", base, &futures, Limits::default()).unwrap();
    assert!(source.blobs.borrow().is_empty());
    let original = objects(&repository);
    let workspace = materialize_from_objects(&composition.spec, &source, "repo", &futures, Limits::default(),
        HydrationBudget { max_blob_bytes: 100, max_total_bytes: 100 }, metadata()).unwrap();
    assert_eq!(workspace.files_hydrated, 2);
    assert_eq!(source.blobs.borrow().len(), 2);
    assert!(!source.blobs.borrow().contains(&repository.blob(&[0; 65536]).unwrap()));
    assert_eq!(objects(&repository), original);
    let bad = Metered { repository: &repository, blobs: RefCell::new(vec![]), substitute: true };
    let bad_futures = [ObjectFuture { state: &state, revision: &revision, effects: &effects, objects: &bad }];
    assert!(materialize_from_objects(&composition.spec, &bad, "repo", &bad_futures, Limits::default(),
        HydrationBudget { max_blob_bytes: 100, max_total_bytes: 100 }, metadata()).is_err());
}
