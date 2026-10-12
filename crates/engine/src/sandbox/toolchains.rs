use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::str::FromStr;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupportedToolchain {
    pub language: String,
    pub version: String,
    pub image_oid: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolchainMatrix {
    pub schema_version: u32,
    pub entries: Vec<SupportedToolchain>,
}

fn read(path: &Path, limit: usize) -> Result<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::InvalidInput(error.to_string())),
    };
    if !metadata.file_type().is_file() || metadata.len() as usize > limit {
        return Err(Error::InvalidInput(
            "invalid or oversized toolchain manifest".into(),
        ));
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| Error::InvalidInput(error.to_string()))
}

/// Registry support is explicit. Missing manifests and unsupported requirement
/// syntax return an error instead of selecting a universal default toolchain.
pub fn select(
    workspace: &Path,
    language: &str,
    matrix: &ToolchainMatrix,
) -> Result<SupportedToolchain> {
    if matrix.schema_version != 1 {
        return Err(Error::InvalidInput("unsupported toolchain schema".into()));
    }
    let mut supported: Vec<_> = matrix
        .entries
        .iter()
        .filter(|entry| entry.language == language)
        .collect();
    if supported.is_empty() {
        return Err(Error::InvalidInput(
            "UNSUPPORTED: language toolchain".into(),
        ));
    }
    for entry in &supported {
        crate::contracts::validate_digest(&entry.image_oid)?;
    }
    let selected = match language {
        "typescript" => {
            let package = read(&workspace.join("package.json"), 1024 * 1024)?
                .ok_or_else(|| Error::InvalidInput("UNSUPPORTED: missing Node manifest".into()))?;
            let package: serde_json::Value = serde_json::from_str(&package)?;
            let engine = package
                .get("engines")
                .and_then(|engines| engines.get("node"))
                .and_then(|value| value.as_str());
            let nvm = read(&workspace.join(".nvmrc"), 1024)?;
            let requirements: Vec<_> = engine
                .into_iter()
                .chain(nvm.as_deref().map(str::trim))
                .map(|value| {
                    semver::VersionReq::parse(value.strip_prefix('v').unwrap_or(value)).map_err(
                        |_| Error::InvalidInput("UNSUPPORTED: Node requirement syntax".into()),
                    )
                })
                .collect::<Result<_>>()?;
            if requirements.is_empty() {
                return Err(Error::InvalidInput(
                    "UNSUPPORTED: undeclared Node version".into(),
                ));
            }
            supported.sort_by_key(|entry| semver::Version::parse(&entry.version).ok());
            supported.into_iter().find(|entry| {
                semver::Version::parse(&entry.version).is_ok_and(|version| {
                    requirements
                        .iter()
                        .all(|required| required.matches(&version))
                })
            })
        }
        "python" => {
            let source =
                read(&workspace.join("pyproject.toml"), 1024 * 1024)?.ok_or_else(|| {
                    Error::InvalidInput("UNSUPPORTED: missing Python manifest".into())
                })?;
            let document: toml::Value = source
                .parse()
                .map_err(|error: toml::de::Error| Error::InvalidInput(error.to_string()))?;
            let requirement = document
                .get("project")
                .and_then(|project| project.get("requires-python"))
                .and_then(|value| value.as_str())
                .ok_or_else(|| {
                    Error::InvalidInput("UNSUPPORTED: undeclared Python version".into())
                })?;
            let requirement =
                pep440_rs::VersionSpecifiers::from_str(requirement).map_err(|_| {
                    Error::InvalidInput("UNSUPPORTED: Python requirement syntax".into())
                })?;
            supported.sort_by_key(|entry| pep440_rs::Version::from_str(&entry.version).ok());
            supported.into_iter().find(|entry| {
                pep440_rs::Version::from_str(&entry.version)
                    .is_ok_and(|version| requirement.contains(&version))
            })
        }
        "go" => {
            let source = read(&workspace.join("go.mod"), 1024 * 1024)?
                .ok_or_else(|| Error::InvalidInput("UNSUPPORTED: missing Go manifest".into()))?;
            let mut required = None;
            for raw in source.lines() {
                let words: Vec<_> = raw
                    .split("//")
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect();
                if matches!(words.first(), Some(&"go") | Some(&"toolchain")) && words.len() == 2 {
                    let value = words[1].strip_prefix("go").unwrap_or(words[1]);
                    let version = go_version(value)?;
                    required = Some(
                        required.map_or(version.clone(), |old: semver::Version| old.max(version)),
                    );
                }
            }
            let required = required
                .ok_or_else(|| Error::InvalidInput("UNSUPPORTED: undeclared Go version".into()))?;
            supported.sort_by_key(|entry| go_version(&entry.version).ok());
            supported
                .into_iter()
                .find(|entry| go_version(&entry.version).is_ok_and(|version| version >= required))
        }
        _ => None,
    };
    selected.cloned().ok_or_else(|| {
        Error::InvalidInput("UNSUPPORTED: requested toolchain is not in the registry".into())
    })
}

fn go_version(value: &str) -> Result<semver::Version> {
    let normalized = if value.split('.').count() == 2 {
        format!("{value}.0")
    } else {
        value.into()
    };
    semver::Version::parse(&normalized)
        .map_err(|_| Error::InvalidInput("UNSUPPORTED: Go version syntax".into()))
}
