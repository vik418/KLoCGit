//! Native, bounded AST extraction. COMPLETE describes this extractor's declared
//! syntax coverage; it does not certify behavioral compatibility.

mod manifests;

use crate::contracts::{AnalysisStatus, CanonicalEffectSet, Capability, EffectSet, Language};
use crate::{Error, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tree_sitter::{Node, Parser};

#[derive(Clone, Debug)]
pub struct SourceChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_files: usize,
    pub max_source_bytes: usize,
    pub max_nodes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_files: 4096,
            max_source_bytes: 4 * 1024 * 1024,
            max_nodes: 100_000,
        }
    }
}

/// Parse only the selected language and its manifest. A parser error, panic or
/// exceeded budget produces FAILED; dynamic/unresolved exports produce PARTIAL.
pub fn analyze(
    revision_id: &str,
    language: Language,
    changes: &[SourceChange],
    limits: Limits,
) -> EffectSet {
    let result = catch_unwind(AssertUnwindSafe(|| extract(language, changes, limits)));
    let (status, modified_exports, added_dependencies, migrations) = match result {
        Ok(Ok(value)) => value,
        _ => (AnalysisStatus::Failed, Vec::new(), BTreeMap::new(), false),
    };
    let extractor_id = match language {
        Language::Typescript => "tree-sitter.typescript",
        Language::Python => "tree-sitter.python",
        Language::Go => "tree-sitter.go",
    };
    let security_effects = changes
        .iter()
        .filter(|change| change.before != change.after)
        .filter(|change| {
            manifests::matches(language, &change.path)
                || change.path.split('/').any(|part| {
                    matches!(
                        part.to_ascii_lowercase().as_str(),
                        "auth" | "iam" | "migrations" | "migration" | "secrets" | ".github"
                    )
                })
        })
        .map(|change| format!("sensitive-path:{}", change.path))
        .collect();
    let mut effects = EffectSet {
        canonical: CanonicalEffectSet {
            future_revision_id: revision_id.to_owned(),
            extractor_id: extractor_id.into(),
            extractor_version: env!("CARGO_PKG_VERSION").into(),
            capability: Capability::Structural,
            status,
            modified_exports,
            added_dependencies,
            db_migrations_detected: migrations,
            security_effects,
        },
        effect_digest: String::new(),
    };
    // An invalid caller identity must never leave an apparently usable result.
    if effects.seal().is_err() {
        effects.status = AnalysisStatus::Failed;
        effects.effect_digest.clear();
    }
    effects
}

type Extracted = (AnalysisStatus, Vec<String>, BTreeMap<String, String>, bool);

fn extract(language: Language, changes: &[SourceChange], limits: Limits) -> Result<Extracted> {
    if changes.len() > limits.max_files {
        return Err(Error::LimitExceeded("extractor files"));
    }
    let mut bytes = 0usize;
    let mut nodes = 0usize;
    let mut names = BTreeSet::new();
    let mut dependencies = BTreeMap::new();
    let mut partial = false;
    let mut migrations = false;
    let mut paths = BTreeSet::new();
    for change in changes {
        if !valid_path(&change.path)
            || !paths.insert(&change.path)
            || (change.before.is_none() && change.after.is_none())
        {
            return Err(Error::InvalidInput(
                "invalid or duplicate changed path".into(),
            ));
        }
        for source in [&change.before, &change.after].into_iter().flatten() {
            bytes = bytes
                .checked_add(source.len())
                .ok_or(Error::LimitExceeded("source bytes"))?;
            if bytes > limits.max_source_bytes {
                return Err(Error::LimitExceeded("source bytes"));
            }
        }
        if change.before == change.after {
            continue;
        }
        migrations |= change.path.split('/').any(|part| {
            matches!(
                part.to_ascii_lowercase().as_str(),
                "migration" | "migrations" | "alembic"
            )
        });
        if manifests::matches(language, &change.path) {
            let (added, incomplete) =
                manifests::delta(language, change.before.as_deref(), change.after.as_deref())?;
            partial |= incomplete;
            for (name, version) in added {
                if dependencies
                    .insert(name.clone(), version.clone())
                    .is_some_and(|old| old != version)
                {
                    return Err(Error::InvalidInput(format!(
                        "conflicting dependency declaration: {name}"
                    )));
                }
            }
            continue;
        }
        let matches = match language {
            Language::Typescript => change.path.ends_with(".ts") || change.path.ends_with(".tsx"),
            Language::Python => change.path.ends_with(".py"),
            Language::Go => change.path.ends_with(".go"),
        };
        if !matches {
            continue;
        }
        let (before, a) = exports(
            language,
            &change.path,
            change.before.as_deref(),
            &mut nodes,
            limits.max_nodes,
        )?;
        let (after, b) = exports(
            language,
            &change.path,
            change.after.as_deref(),
            &mut nodes,
            limits.max_nodes,
        )?;
        partial |= a || b;
        for name in before.keys().chain(after.keys()) {
            if before.get(name) != after.get(name) {
                names.insert(format!("{}::{name}", change.path));
            }
        }
    }
    Ok((
        if partial {
            AnalysisStatus::Partial
        } else {
            AnalysisStatus::Complete
        },
        names.into_iter().collect(),
        dependencies,
        migrations,
    ))
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}

fn exports(
    language: Language,
    path: &str,
    source: Option<&str>,
    visited: &mut usize,
    max_nodes: usize,
) -> Result<(BTreeMap<String, String>, bool)> {
    let Some(source) = source else {
        return Ok((BTreeMap::new(), false));
    };
    let mut parser = Parser::new();
    let grammar = match language {
        Language::Typescript if path.ends_with(".tsx") => tree_sitter_typescript::LANGUAGE_TSX,
        Language::Typescript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
        Language::Python => tree_sitter_python::LANGUAGE,
        Language::Go => tree_sitter_go::LANGUAGE,
    };
    parser
        .set_language(&grammar.into())
        .map_err(|err| Error::InvalidInput(err.to_string()))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| Error::InvalidInput("parser cancelled".into()))?;
    if tree.root_node().has_error() {
        return Err(Error::InvalidInput("source syntax error".into()));
    }
    let mut cursor = tree.walk();
    loop {
        *visited += 1;
        if *visited > max_nodes {
            return Err(Error::LimitExceeded("AST nodes"));
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return collect_exports(language, tree.root_node(), source);
            }
        }
    }
}

fn insert_named(result: &mut BTreeMap<String, String>, node: Node<'_>, source: &str) -> bool {
    if let Some(name) = node.child_by_field_name("name") {
        result.insert(text(name, source).to_owned(), text(node, source).to_owned());
        true
    } else {
        false
    }
}

fn collect_exports(
    language: Language,
    root: Node<'_>,
    source: &str,
) -> Result<(BTreeMap<String, String>, bool)> {
    let mut result = BTreeMap::new();
    let mut partial = false;
    let mut cursor = root.walk();
    for node in root.named_children(&mut cursor) {
        match language {
            Language::Typescript => {
                if node.kind() != "export_statement" {
                    continue;
                }
                if node.child_by_field_name("source").is_some() {
                    partial = true;
                    continue;
                }
                if let Some(declaration) = node.child_by_field_name("declaration") {
                    if matches!(
                        declaration.kind(),
                        "lexical_declaration" | "variable_declaration"
                    ) {
                        let mut cursor = declaration.walk();
                        for item in declaration.named_children(&mut cursor) {
                            if item.kind() == "variable_declarator"
                                && !insert_named(&mut result, item, source)
                            {
                                partial = true;
                            }
                        }
                    } else if !insert_named(&mut result, declaration, source) {
                        if text(node, source).starts_with("export default") {
                            result.insert("default".into(), text(node, source).into());
                        } else {
                            partial = true;
                        }
                    }
                } else if text(node, source).starts_with("export default") {
                    result.insert("default".into(), text(node, source).into());
                } else {
                    // Local export clauses can expose bindings not defined in this
                    // node; resolving their full dependency closure is a later tier.
                    partial = true;
                }
            }
            Language::Python => {
                let declaration = if node.kind() == "decorated_definition" {
                    node.child_by_field_name("definition").unwrap_or(node)
                } else {
                    node
                };
                if matches!(
                    declaration.kind(),
                    "function_definition" | "class_definition"
                ) {
                    if let Some(name) = declaration.child_by_field_name("name") {
                        let name = text(name, source);
                        if !name.starts_with('_') {
                            result.insert(name.into(), text(node, source).into());
                        }
                    }
                } else if node.kind() == "expression_statement" {
                    let child = node.named_child(0).unwrap_or(node);
                    if child.kind() == "assignment" {
                        if let Some(left) = child.child_by_field_name("left") {
                            let name = text(left, source);
                            if name == "__all__" {
                                partial = true;
                            } else if left.kind() == "identifier" && !name.starts_with('_') {
                                result.insert(name.into(), text(node, source).into());
                            } else if left.kind() != "identifier" {
                                partial = true;
                            }
                        }
                    }
                } else if node.kind() == "import_from_statement" && text(node, source).contains('*')
                {
                    partial = true;
                }
            }
            Language::Go => {
                if matches!(node.kind(), "function_declaration" | "method_declaration") {
                    if let Some(name) = node.child_by_field_name("name") {
                        let name = text(name, source);
                        if name.chars().next().is_some_and(char::is_uppercase) {
                            let qualified = node
                                .child_by_field_name("receiver")
                                .map(|receiver| format!("{}.{name}", text(receiver, source)))
                                .unwrap_or_else(|| name.into());
                            result.insert(qualified, text(node, source).into());
                        }
                    }
                } else if node.kind() == "type_declaration" {
                    let mut cursor = node.walk();
                    for item in node.named_children(&mut cursor) {
                        if let Some(name) = item.child_by_field_name("name") {
                            let name = text(name, source);
                            if name.chars().next().is_some_and(char::is_uppercase) {
                                result.insert(name.into(), text(item, source).into());
                            }
                        }
                    }
                }
            }
        }
    }
    Ok((result, partial))
}
