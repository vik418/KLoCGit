use klocgit_engine::contracts::{AnalysisStatus, Language};
use klocgit_engine::extractors::{analyze, Limits, SourceChange};

fn change(path: &str, before: &str, after: &str) -> SourceChange {
    SourceChange {
        path: path.into(),
        before: Some(before.into()),
        after: Some(after.into()),
    }
}

#[test]
fn typescript_exports_and_dependencies_are_observed() {
    let effects = analyze(
        "future-ts",
        Language::Typescript,
        &[
            change(
                "api.ts",
                include_str!("../../../tests/fixtures/typescript/base/api.ts"),
                include_str!("../../../tests/fixtures/typescript/future/api.ts"),
            ),
            change(
                "package.json",
                include_str!("../../../tests/fixtures/typescript/base/package.json"),
                include_str!("../../../tests/fixtures/typescript/future/package.json"),
            ),
        ],
        Limits::default(),
    );
    assert_eq!(effects.status, AnalysisStatus::Complete);
    assert_eq!(
        effects.modified_exports,
        ["api.ts::RetryPolicy", "api.ts::retryLimit"]
    );
    assert_eq!(effects.added_dependencies.get("zod").unwrap(), "^3.24.0");
    assert!(!effects
        .modified_exports
        .iter()
        .any(|name| name.ends_with("internal")));
}

#[test]
fn python_pydantic_schema_and_dependencies_are_observed() {
    let effects = analyze(
        "future-py",
        Language::Python,
        &[
            change(
                "api.py",
                include_str!("../../../tests/fixtures/python/base/api.py"),
                include_str!("../../../tests/fixtures/python/future/api.py"),
            ),
            change(
                "pyproject.toml",
                include_str!("../../../tests/fixtures/python/base/pyproject.toml"),
                include_str!("../../../tests/fixtures/python/future/pyproject.toml"),
            ),
        ],
        Limits::default(),
    );
    assert_eq!(effects.status, AnalysisStatus::Complete);
    assert_eq!(
        effects.modified_exports,
        ["api.py::RetryPolicy", "api.py::retry_limit"]
    );
    assert_eq!(
        effects.added_dependencies.get("tenacity").unwrap(),
        "tenacity>=9.0"
    );
}

#[test]
fn go_exported_functions_structs_and_dependencies_are_observed() {
    let effects = analyze(
        "future-go",
        Language::Go,
        &[
            change(
                "api.go",
                include_str!("../../../tests/fixtures/go/base/api.go"),
                include_str!("../../../tests/fixtures/go/future/api.go"),
            ),
            change(
                "go.mod",
                include_str!("../../../tests/fixtures/go/base/go.mod"),
                include_str!("../../../tests/fixtures/go/future/go.mod"),
            ),
        ],
        Limits::default(),
    );
    assert_eq!(effects.status, AnalysisStatus::Complete);
    assert_eq!(
        effects.modified_exports,
        ["api.go::Policy", "api.go::RetryLimit"]
    );
    assert_eq!(
        effects.added_dependencies.get("golang.org/x/sync").unwrap(),
        "v0.10.0"
    );
}

#[test]
fn syntax_errors_fail_closed_in_every_language() {
    for (language, path, source) in [
        (Language::Typescript, "api.ts", "export function broken( {"),
        (Language::Python, "api.py", "def broken(:\n pass"),
        (Language::Go, "api.go", "package broken\nfunc Broken( {"),
    ] {
        let effects = analyze(
            "future",
            language,
            &[change(path, "", source)],
            Limits::default(),
        );
        assert_eq!(effects.status, AnalysisStatus::Failed);
        assert!(!effects.can_auto_resolve());
        assert!(effects.effect_digest.starts_with("sha256:"));
    }
}

#[test]
fn unsupported_export_and_manifest_closures_are_partial() {
    for (language, path, source) in [
        (Language::Typescript, "api.ts", "export * from './other';"),
        (Language::Python, "api.py", "__all__ = discover_exports()"),
        (
            Language::Go,
            "go.mod",
            "module example.org/a\nreplace example.org/x => ../x",
        ),
    ] {
        let effects = analyze(
            "future",
            language,
            &[change(path, "", source)],
            Limits::default(),
        );
        assert_eq!(effects.status, AnalysisStatus::Partial);
        assert!(!effects.can_auto_resolve());
    }
}

#[test]
fn changed_file_order_does_not_change_effect_identity() {
    let mut changes = vec![
        change("a.ts", "", "export function A() {}"),
        change("b.ts", "", "export type B = number;"),
    ];
    let a = analyze("future", Language::Typescript, &changes, Limits::default());
    changes.reverse();
    let b = analyze("future", Language::Typescript, &changes, Limits::default());
    assert_eq!(a, b);
}

#[test]
fn deletions_and_migrations_are_material() {
    let changes = vec![
        SourceChange {
            path: "api.py".into(),
            before: Some("def Public():\n    return 1\n".into()),
            after: None,
        },
        change(
            "migrations/001.sql",
            "",
            "ALTER TABLE orders ADD COLUMN attempt INT;",
        ),
    ];
    let effects = analyze("future", Language::Python, &changes, Limits::default());
    assert_eq!(effects.modified_exports, ["api.py::Public"]);
    assert!(effects.db_migrations_detected);
}

#[test]
fn budgets_and_invalid_paths_fail_closed() {
    for (path, limits) in [
        ("../api.ts", Limits::default()),
        (
            "api.ts",
            Limits {
                max_source_bytes: 4,
                ..Limits::default()
            },
        ),
        (
            "api.ts",
            Limits {
                max_nodes: 1,
                ..Limits::default()
            },
        ),
    ] {
        let effects = analyze(
            "future",
            Language::Typescript,
            &[change(path, "", "export function A() {}")],
            limits,
        );
        assert_eq!(effects.status, AnalysisStatus::Failed);
    }
}

#[test]
fn malformed_manifests_fail_in_every_language() {
    for (language, path, source) in [
        (Language::Typescript, "package.json", "{broken"),
        (Language::Python, "pyproject.toml", "[project"),
        (Language::Go, "go.mod", "require (\nexample.org/x v1.0.0"),
    ] {
        assert_eq!(
            analyze(
                "future",
                language,
                &[change(path, "", source)],
                Limits::default()
            )
            .status,
            AnalysisStatus::Failed
        );
    }
}

#[test]
fn dependency_removal_is_explicitly_incomplete() {
    let effects = analyze(
        "future",
        Language::Typescript,
        &[change(
            "package.json",
            "{\"dependencies\":{\"a\":\"1\"}}",
            "{}",
        )],
        Limits::default(),
    );
    assert_eq!(effects.status, AnalysisStatus::Partial);
}
