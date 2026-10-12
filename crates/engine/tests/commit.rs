use git2::{Oid, Repository};
use klocgit_engine::{
    canonical,
    contracts::*,
    git::{
        commit,
        workspace::{tree_oid, HydrationBudget},
        Limits,
    },
};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

fn candidate(path: &std::path::Path) -> Candidate {
    let tree = tree_oid(
        path,
        Limits::default(),
        HydrationBudget {
            max_blob_bytes: 1024,
            max_total_bytes: 4096,
        },
    )
    .unwrap();
    let mut candidate = Candidate {
        canonical: CanonicalCandidate {
            candidate_spec_id: canonical::hash_projection("test.spec", &()).unwrap(),
            repo_tree_oids: BTreeMap::from([("repo".into(), tree.to_string())]),
        },
        id: String::new(),
        candidate_digest: String::new(),
        materialization_record: MaterializationRecord {
            executor_id: "test".into(),
            materialized_at: String::new(),
            conflicts_encountered: vec![],
        },
    };
    candidate.seal().unwrap();
    candidate
}

#[test]
fn scratch_transport_pack_contains_the_exact_candidate_and_writes_no_refs() {
    let source = tempfile::tempdir().unwrap();
    fs::create_dir(source.path().join("nested")).unwrap();
    fs::write(
        source.path().join("nested/api.ts"),
        "export const value = 7;",
    )
    .unwrap();
    fs::write(source.path().join("asset.bin"), [0, 255, 7]).unwrap();
    let candidate = candidate(source.path());
    let parent = Oid::from_str(&"1".repeat(40)).unwrap();
    let basis = canonical::hash_projection("test.basis", &()).unwrap();
    let author = commit::Author {
        name: "Engineer".into(),
        email: "engineer@example.test".into(),
        unix_timestamp: 1_700_000_000,
    };
    let prepared = commit::prepare(
        source.path(),
        &candidate,
        "repo",
        parent,
        "decision",
        &basis,
        &author,
        1024 * 1024,
    )
    .unwrap();
    let repeat = commit::prepare(
        source.path(),
        &candidate,
        "repo",
        parent,
        "decision",
        &basis,
        &author,
        1024 * 1024,
    )
    .unwrap();
    assert_eq!(prepared.target_oid, repeat.target_oid);
    assert_eq!(prepared.pack, repeat.pack);
    assert_eq!(
        prepared.payload_digest,
        canonical::payload_digest(&prepared.pack).unwrap()
    );
    let receiver = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(receiver.path()).unwrap();
    let mut child = Command::new("git")
        .arg("--git-dir")
        .arg(receiver.path())
        .args(["index-pack", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&prepared.pack)
        .unwrap();
    assert!(child.wait_with_output().unwrap().status.success());
    let observed = repository.find_commit(prepared.target_oid).unwrap();
    assert_eq!(observed.tree_id(), prepared.tree_oid);
    assert_eq!(observed.parent_id(0).unwrap(), parent);
    assert_eq!(observed.author().email(), Some(author.email.as_str()));
    assert_eq!(repository.references().unwrap().count(), 0);
    assert_eq!(
        repository
            .find_blob(
                observed
                    .tree()
                    .unwrap()
                    .get_path(std::path::Path::new("asset.bin"))
                    .unwrap()
                    .id()
            )
            .unwrap()
            .content(),
        [0, 255, 7]
    );
}

#[test]
fn preparation_rejects_substitution_and_pack_overflow() {
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("file"), "original").unwrap();
    let candidate = candidate(source.path());
    let parent = Oid::from_str(&"1".repeat(40)).unwrap();
    let basis = canonical::hash_projection("test.basis", &()).unwrap();
    let author = commit::Author {
        name: "Engineer".into(),
        email: "engineer@example.test".into(),
        unix_timestamp: 0,
    };
    assert!(commit::prepare(
        source.path(),
        &candidate,
        "repo",
        parent,
        "decision",
        &basis,
        &author,
        1
    )
    .is_err());
    fs::write(source.path().join("file"), "substituted").unwrap();
    assert!(commit::prepare(
        source.path(),
        &candidate,
        "repo",
        parent,
        "decision",
        &basis,
        &author,
        1024
    )
    .is_err());
}
