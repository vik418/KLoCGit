use super::Language;
use crate::{Error, Result};
use std::collections::BTreeMap;

type Dependencies = BTreeMap<String, String>;

pub fn matches(language: Language, path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    match language {
        Language::Typescript => name == "package.json",
        Language::Python => name == "pyproject.toml",
        Language::Go => name == "go.mod",
    }
}

pub fn delta(language: Language, before: Option<&str>, after: Option<&str>) -> Result<(Dependencies, bool)> {
    let (old, a) = parse(language, before.unwrap_or(""))?;
    let (new, b) = parse(language, after.unwrap_or(""))?;
    // The schema can represent additions/version changes, but not removals.
    // Keep the result PARTIAL rather than claiming complete manifest coverage.
    let removed = old.keys().any(|name| !new.contains_key(name));
    let changed = new.into_iter().filter(|(name, value)| old.get(name) != Some(value)).collect();
    Ok((changed, a || b || removed))
}

fn parse(language: Language, source: &str) -> Result<(Dependencies, bool)> {
    if source.trim().is_empty() { return Ok((BTreeMap::new(), false)); }
    match language {
        Language::Typescript => javascript(source),
        Language::Python => python(source),
        Language::Go => go(source),
    }
}

fn put(values: &mut Dependencies, name: String, version: String) -> Result<()> {
    if name.is_empty() || version.is_empty() {
        return Err(Error::InvalidInput("empty dependency declaration".into()));
    }
    if values.insert(name.clone(), version.clone()).is_some_and(|previous| previous != version) {
        return Err(Error::InvalidInput(format!("conflicting dependency declaration: {name}")));
    }
    Ok(())
}

fn javascript(source: &str) -> Result<(Dependencies, bool)> {
    let document: serde_json::Value = serde_json::from_str(source)?;
    let object = document.as_object().ok_or_else(|| Error::InvalidInput("package manifest must be an object".into()))?;
    let mut result = BTreeMap::new();
    for section in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
        if let Some(value) = object.get(section) {
            let declarations = value.as_object().ok_or_else(|| Error::InvalidInput("dependency section must be an object".into()))?;
            for (name, version) in declarations {
                let version = version.as_str().ok_or_else(|| Error::InvalidInput("dependency version must be a string".into()))?;
                put(&mut result, name.clone(), version.into())?;
            }
        }
    }
    Ok((result, object.contains_key("overrides") || object.contains_key("resolutions")))
}

fn python(source: &str) -> Result<(Dependencies, bool)> {
    let document: toml::Value = source.parse().map_err(|error: toml::de::Error| Error::InvalidInput(error.to_string()))?;
    let mut result = BTreeMap::new();
    let mut partial = document.get("tool").and_then(|tool| tool.get("poetry")).is_some();
    if let Some(project) = document.get("project") {
        let table = project.as_table().ok_or_else(|| Error::InvalidInput("project must be a table".into()))?;
        if let Some(dynamic) = table.get("dynamic") {
            partial |= dynamic.as_array().is_none_or(|values| !values.is_empty());
        }
        if let Some(declarations) = table.get("dependencies") {
            requirement_list(declarations, &mut result, &mut partial)?;
        }
        if let Some(groups) = table.get("optional-dependencies") {
            let groups = groups.as_table().ok_or_else(|| Error::InvalidInput("optional dependencies must be a table".into()))?;
            for declarations in groups.values() { requirement_list(declarations, &mut result, &mut partial)?; }
        }
    }
    if let Some(groups) = document.get("dependency-groups") {
        let groups = groups.as_table().ok_or_else(|| Error::InvalidInput("dependency groups must be a table".into()))?;
        for declarations in groups.values() { requirement_list(declarations, &mut result, &mut partial)?; }
    }
    Ok((result, partial))
}

fn requirement_list(value: &toml::Value, result: &mut Dependencies, partial: &mut bool) -> Result<()> {
    let values = value.as_array().ok_or_else(|| Error::InvalidInput("requirements must be an array".into()))?;
    for value in values {
        let Some(requirement) = value.as_str() else { *partial = true; continue; };
        let requirement = requirement.trim();
        let length = requirement.bytes().take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')).count();
        if length == 0 { return Err(Error::InvalidInput("invalid Python requirement".into())); }
        let name = requirement[..length].to_ascii_lowercase().replace(['_', '.'], "-");
        put(result, name, requirement.into())?;
    }
    Ok(())
}

fn go(source: &str) -> Result<(Dependencies, bool)> {
    let mut result = BTreeMap::new();
    let mut block: Option<&str> = None;
    let mut partial = false;
    for raw in source.lines() {
        let line = raw.split("//").next().unwrap_or("").trim();
        if line.is_empty() { continue; }
        if line == ")" {
            if block.take().is_none() { return Err(Error::InvalidInput("unmatched go.mod block".into())); }
            continue;
        }
        let words: Vec<_> = line.split_whitespace().collect();
        if let Some(kind) = block {
            if words.contains(&"(") || words.contains(&")") { return Err(Error::InvalidInput("invalid go.mod block".into())); }
            if kind == "require" { go_requirement(&words, &mut result)?; }
            continue;
        }
        let directive = words[0];
        match directive {
            "require" | "replace" | "exclude" | "retract" => {
                partial |= directive != "require";
                if words.get(1) == Some(&"(") {
                    if words.len() != 2 { return Err(Error::InvalidInput("invalid go.mod block header".into())); }
                    block = Some(directive);
                } else if directive == "require" {
                    go_requirement(&words[1..], &mut result)?;
                }
            }
            "module" | "go" | "toolchain" => {
                if words.len() != 2 { return Err(Error::InvalidInput("invalid go.mod declaration".into())); }
            }
            // Unknown directives cannot silently become COMPLETE on new Go versions.
            _ => partial = true,
        }
    }
    if block.is_some() { return Err(Error::InvalidInput("unterminated go.mod block".into())); }
    Ok((result, partial))
}

fn go_requirement(words: &[&str], result: &mut Dependencies) -> Result<()> {
    if words.len() != 2 || !words[1].starts_with('v') {
        return Err(Error::InvalidInput("invalid Go requirement".into()));
    }
    put(result, words[0].into(), words[1].into())
}
