use klocgit_engine::sandbox::toolchains::{select, SupportedToolchain, ToolchainMatrix};

fn matrix() -> ToolchainMatrix {
    ToolchainMatrix {
        schema_version: 1,
        entries: [
            ("typescript", "24.0.0"),
            ("python", "3.12.0"),
            ("go", "1.23.0"),
        ]
        .into_iter()
        .map(|(language, version)| SupportedToolchain {
            language: language.into(),
            version: version.into(),
            image_oid: format!("sha256:{}", "a".repeat(64)),
        })
        .collect(),
    }
}

#[test]
fn declared_node_python_and_go_versions_select_explicit_registry_entries() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("package.json"),
        r#"{"engines":{"node":">=24,<25"}}"#,
    )
    .unwrap();
    std::fs::write(
        directory.path().join("pyproject.toml"),
        "[project]\nrequires-python = '>=3.12,<3.13'\n",
    )
    .unwrap();
    std::fs::write(
        directory.path().join("go.mod"),
        "module example.org/fixture\ngo 1.23\n",
    )
    .unwrap();
    for language in ["typescript", "python", "go"] {
        assert_eq!(
            select(directory.path(), language, &matrix())
                .unwrap()
                .language,
            language
        );
    }
}

#[test]
fn missing_conflicting_and_unavailable_toolchains_do_not_fall_back() {
    let directory = tempfile::tempdir().unwrap();
    assert!(select(directory.path(), "typescript", &matrix()).is_err());
    std::fs::write(
        directory.path().join("package.json"),
        r#"{"engines":{"node":"24"}}"#,
    )
    .unwrap();
    std::fs::write(directory.path().join(".nvmrc"), "22").unwrap();
    assert!(select(directory.path(), "typescript", &matrix()).is_err());
    std::fs::remove_file(directory.path().join(".nvmrc")).unwrap();
    std::fs::write(
        directory.path().join("package.json"),
        r#"{"engines":{"node":"25"}}"#,
    )
    .unwrap();
    assert!(select(directory.path(), "typescript", &matrix()).is_err());
    std::fs::write(
        directory.path().join("go.mod"),
        "module example.org/fixture\ngo 1.23\ntoolchain go1.24.1\n",
    )
    .unwrap();
    assert!(select(directory.path(), "go", &matrix()).is_err());
}
