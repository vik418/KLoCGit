use super::{analyze, Limits, SourceChange};
use crate::contracts::{AnalysisStatus, CanonicalEffectSet, Capability, EffectSet, Language};
use crate::git::{self, objects::ObjectSource};
use crate::{Error, Result};
use git2::Oid;
use std::collections::{BTreeMap, BTreeSet};

pub struct RepositoryAnalysis {
    pub effects: EffectSet,
    pub changed_paths: Vec<String>,
}

fn language(path: &str) -> Option<Language> {
    let file = path.rsplit('/').next().unwrap_or(path);
    if path.ends_with(".ts") || path.ends_with(".tsx") || file == "package.json" { Some(Language::Typescript) }
    else if path.ends_with(".py") || file == "pyproject.toml" { Some(Language::Python) }
    else if path.ends_with(".go") || file == "go.mod" { Some(Language::Go) }
    else { None }
}

/// The caller supplies exact observed commit IDs. Neither producer summaries
/// nor patch text determine what the extractor considers changed.
pub fn analyze_repository(source: &dyn ObjectSource, base_oid: Oid, head_oid: Oid, revision_id: &str) -> Result<RepositoryAnalysis> {
    let base = git::snapshot(source, base_oid, git::Limits::default())?;
    let head = git::snapshot(source, head_oid, git::Limits::default())?;
    let paths: BTreeSet<_> = base.entries.keys().chain(head.entries.keys()).cloned().collect();
    let mut groups = BTreeMap::<String, (Language, Vec<SourceChange>)>::new();
    let mut changed = Vec::new();
    let mut bytes_read = 0usize;
    let mut incomplete = false;
    let mut sensitive = BTreeSet::new();
    let mut migrations = false;
    for path in paths {
        if base.entries.get(&path) == head.entries.get(&path) { continue; }
        changed.push(path.clone());
        if changed.len() > Limits::default().max_files { return Err(Error::LimitExceeded("analysis changed files")); }
        let lower = path.to_ascii_lowercase();
        migrations |= lower.split('/').any(|part| matches!(part, "migrations" | "migration" | "alembic"));
        if lower.split('/').any(|part| matches!(part, ".github" | "auth" | "iam" | "schema" | "migrations" | "migration" | "secrets")) ||
            ["package.json", "pyproject.toml", "go.mod", "dockerfile"].contains(&lower.rsplit('/').next().unwrap_or("")) {
            sensitive.insert(format!("sensitive-path:{path}"));
        }
        let Some(language) = language(&path) else {
            // Documentation is path-observed. Executable or configuration changes
            // outside declared parser coverage require a wider analysis policy.
            if !(lower.ends_with(".md") || lower.ends_with(".txt") || lower.ends_with(".rst")) { incomplete = true; }
            continue;
        };
        let key = match language { Language::Typescript => "typescript", Language::Python => "python", Language::Go => "go" };
        let mut contents = Vec::new();
        for entry in [base.entries.get(&path), head.entries.get(&path)] {
            let value = match entry {
                None => None,
                Some(entry) if matches!(entry.mode, 0o100644 | 0o100755) => {
                    let maximum = Limits::default().max_source_bytes.saturating_sub(bytes_read);
                    let bytes = git::objects::verified_blob(source, entry.oid, maximum)?;
                    bytes_read += bytes.len();
                    Some(String::from_utf8(bytes).map_err(|_| Error::InvalidInput("non-UTF8 source".into()))?)
                }
                Some(_) => { incomplete = true; None }
            };
            contents.push(value);
        }
        if contents.iter().all(Option::is_none) { continue; }
        groups.entry(key.into()).or_insert_with(|| (language, vec![])).1.push(SourceChange {
            path, before: contents[0].take(), after: contents[1].take(),
        });
    }
    let mut status = if incomplete { AnalysisStatus::Partial } else { AnalysisStatus::Complete };
    let mut exports = BTreeSet::new();
    let mut dependencies = BTreeMap::new();
    for (_, (language, changes)) in groups {
        let effects = analyze(revision_id, language, &changes, Limits::default());
        if effects.status == AnalysisStatus::Failed { status = AnalysisStatus::Failed; }
        else if effects.status != AnalysisStatus::Complete && status != AnalysisStatus::Failed { status = AnalysisStatus::Partial; }
        exports.extend(effects.modified_exports.iter().cloned());
        sensitive.extend(effects.security_effects.iter().cloned());
        migrations |= effects.db_migrations_detected;
        for (name, version) in &effects.added_dependencies {
            if dependencies.insert(name.clone(), version.clone()).is_some_and(|old| old != *version) {
                status = AnalysisStatus::Partial;
            }
        }
    }
    let mut effects = EffectSet {
        canonical: CanonicalEffectSet {
            future_revision_id: revision_id.into(), extractor_id: "tree-sitter.repository".into(),
            extractor_version: env!("CARGO_PKG_VERSION").into(), capability: Capability::Structural,
            status, modified_exports: exports.into_iter().collect(), added_dependencies: dependencies,
            db_migrations_detected: migrations, security_effects: sensitive.into_iter().collect(),
        }, effect_digest: String::new(),
    };
    effects.seal()?;
    Ok(RepositoryAnalysis { effects, changed_paths: changed })
}
