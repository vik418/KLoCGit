use git2::{Oid, Repository, Signature, Time};
use klocgit_engine::contracts::AnalysisStatus;
use klocgit_engine::extractors::repository::analyze_repository;

fn commit(repository: &Repository, parent: Option<Oid>, files: &[(&str, &str)]) -> Oid {
    let mut builder = repository.treebuilder(None).unwrap();
    for (path, source) in files { builder.insert(path, repository.blob(source.as_bytes()).unwrap(), 0o100644).unwrap(); }
    let tree = repository.find_tree(builder.write().unwrap()).unwrap();
    let identity = Signature::new("Fixture", "fixture@example.org", &Time::new(0, 0)).unwrap();
    let parents: Vec<_> = parent.map(|oid| repository.find_commit(oid).unwrap()).into_iter().collect();
    repository.commit(None, &identity, &identity, "fixture", &tree, &parents.iter().collect::<Vec<_>>()).unwrap()
}

#[test]
fn native_analysis_observes_actual_git_deltas_across_supported_languages() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(&repository, None, &[
        ("api.ts", "export function value(): number { return 1; }"),
        ("api.py", "def value() -> int:\n    return 1\n"),
        ("api.go", "package app\nfunc Value() int { return 1 }"),
    ]);
    let head = commit(&repository, Some(base), &[
        ("api.ts", "export function value(): number { return 2; }"),
        ("api.py", "def value() -> int:\n    return 2\n"),
        ("api.go", "package app\nfunc Value() int { return 2 }"),
    ]);
    let result = analyze_repository(&repository, base, head, "future:test").unwrap();
    assert_eq!(result.effects.status, AnalysisStatus::Complete);
    assert_eq!(result.changed_paths, ["api.go", "api.py", "api.ts"]);
    for name in ["api.go::Value", "api.py::value", "api.ts::value"] {
        assert!(result.effects.modified_exports.contains(&name.to_string()));
    }
    assert_eq!(repository.references().unwrap().count(), 0);
}

#[test]
fn an_unknown_executable_change_is_not_silently_complete() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(&repository, None, &[]);
    let head = commit(&repository, Some(base), &[("runner.sh", "exec sensitive_operation")]);
    let result = analyze_repository(&repository, base, head, "future:test").unwrap();
    assert_eq!(result.effects.status, AnalysisStatus::Partial);
    assert_eq!(result.changed_paths, ["runner.sh"]);
}

#[test]
fn syntax_failure_in_one_language_fails_the_aggregate_analysis() {
    let directory = tempfile::tempdir().unwrap();
    let repository = Repository::init_bare(directory.path()).unwrap();
    let base = commit(&repository, None, &[("api.py", "def value():\n    return 1\n")]);
    let head = commit(&repository, Some(base), &[("api.py", "def (")]);
    let result = analyze_repository(&repository, base, head, "future:test").unwrap();
    assert_eq!(result.effects.status, AnalysisStatus::Failed);
}
