//! Tree-sitter and Structural Extractors for TypeScript, Python, and Go.
//! Emits normalized `CanonicalEffectSet` with `capability: "STRUCTURAL"`.

use crate::types::CanonicalEffectSet;
use std::collections::{BTreeMap, BTreeSet};

pub struct StructuralExtractor {
    extractor_id: String,
    extractor_version: String,
}

impl Default for StructuralExtractor {
    fn default() -> Self {
        Self::new("klocgit-structural-extractor", "1.0.0")
    }
}

impl StructuralExtractor {
    pub fn new(extractor_id: &str, extractor_version: &str) -> Self {
        Self {
            extractor_id: extractor_id.to_string(),
            extractor_version: extractor_version.to_string(),
        }
    }

    pub fn extract(
        &self,
        future_revision_id: &str,
        file_path: &str,
        file_content: &str,
    ) -> CanonicalEffectSet {
        let mut modified_exports = BTreeSet::new();
        let mut added_dependencies = BTreeMap::new();
        let mut db_migrations_detected = false;
        let mut security_effects = BTreeSet::new();

        // Check file path for migration or security
        let lower_path = file_path.to_lowercase();
        if lower_path.contains("migration") || lower_path.ends_with(".sql") || lower_path.contains("drizzle") || lower_path.contains("prisma") {
            db_migrations_detected = true;
        }

        let status = if file_path.ends_with(".ts") || file_path.ends_with(".tsx") || file_path.ends_with(".js") || file_path.ends_with(".jsx") {
            self.extract_typescript(
                file_content,
                &mut modified_exports,
                &mut added_dependencies,
                &mut security_effects,
            );
            "COMPLETE"
        } else if file_path.ends_with(".py") {
            self.extract_python(
                file_content,
                &mut modified_exports,
                &mut added_dependencies,
                &mut security_effects,
            );
            "COMPLETE"
        } else if file_path.ends_with(".go") {
            self.extract_go(
                file_content,
                &mut modified_exports,
                &mut added_dependencies,
                &mut security_effects,
            );
            "COMPLETE"
        } else if file_path.ends_with("package.json") || file_path.ends_with("requirements.txt") || file_path.ends_with("go.mod") {
            self.extract_manifest(
                file_path,
                file_content,
                &mut added_dependencies,
                &mut security_effects,
            );
            "COMPLETE"
        } else {
            "UNSUPPORTED"
        };

        CanonicalEffectSet {
            future_revision_id: future_revision_id.to_string(),
            extractor_id: self.extractor_id.clone(),
            extractor_version: self.extractor_version.clone(),
            capability: "STRUCTURAL".to_string(),
            status: status.to_string(),
            modified_exports: modified_exports.into_iter().collect(),
            added_dependencies,
            db_migrations_detected,
            security_effects: security_effects.into_iter().collect(),
        }
    }

    fn extract_typescript(
        &self,
        content: &str,
        exports: &mut BTreeSet<String>,
        dependencies: &mut BTreeMap<String, String>,
        security: &mut BTreeSet<String>,
    ) {
        for line in content.lines() {
            let trimmed = line.trim();
            // Export detection
            if trimmed.starts_with("export function ") {
                let rest = &trimmed["export function ".len()..];
                if let Some(name) = rest.split('(').next() {
                    exports.insert(name.trim().to_string());
                }
            } else if trimmed.starts_with("export const ") || trimmed.starts_with("export let ") || trimmed.starts_with("export var ") {
                let rest = trimmed.split_whitespace().nth(2).unwrap_or("");
                if let Some(name) = rest.split(':').next().and_then(|s| s.split('=').next()) {
                    exports.insert(name.trim().to_string());
                }
            } else if trimmed.starts_with("export class ") || trimmed.starts_with("export interface ") || trimmed.starts_with("export type ") {
                if let Some(name) = trimmed.split_whitespace().nth(2) {
                    exports.insert(name.trim().to_string());
                }
            } else if trimmed.starts_with("export default ") {
                exports.insert("default".to_string());
            }

            // Import / dependency detection
            if trimmed.starts_with("import ") && trimmed.contains(" from ") {
                if let Some(pkg_part) = trimmed.split(" from ").nth(1) {
                    let pkg = pkg_part.trim_matches(|c| c == ';' || c == '\'' || c == '"' || c == ' ');
                    if !pkg.starts_with('.') && !pkg.starts_with('/') {
                        dependencies.insert(pkg.to_string(), "*".to_string());
                    }
                }
            } else if trimmed.contains("require(") {
                if let Some(start) = trimmed.find("require(") {
                    let rest = &trimmed[start + 8..];
                    if let Some(end) = rest.find(')') {
                        let pkg = rest[..end].trim_matches(|c| c == '\'' || c == '"' || c == ' ');
                        if !pkg.starts_with('.') && !pkg.starts_with('/') {
                            dependencies.insert(pkg.to_string(), "*".to_string());
                        }
                    }
                }
            }

            // Security effects detection
            if trimmed.contains("eval(") {
                security.insert("EXEC:eval".to_string());
            }
            if trimmed.contains("child_process") || trimmed.contains("spawn(") || trimmed.contains("exec(") {
                security.insert("EXEC:child_process".to_string());
            }
            if trimmed.contains("crypto") {
                security.insert("CRYPTO:usage".to_string());
            }
            if trimmed.contains("fetch(") || trimmed.contains("axios") || trimmed.contains("http.") {
                security.insert("NET:egress".to_string());
            }
            if trimmed.contains("process.env.") {
                security.insert("ENV:read".to_string());
            }
        }
    }

    fn extract_python(
        &self,
        content: &str,
        exports: &mut BTreeSet<String>,
        dependencies: &mut BTreeMap<String, String>,
        security: &mut BTreeSet<String>,
    ) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("def ") {
                let rest = &trimmed[4..];
                if let Some(name) = rest.split('(').next() {
                    let n = name.trim();
                    if !n.starts_with('_') {
                        exports.insert(n.to_string());
                    }
                }
            } else if trimmed.starts_with("class ") {
                let rest = &trimmed[6..];
                if let Some(name) = rest.split('(').next().and_then(|s| s.split(':').next()) {
                    let n = name.trim();
                    if !n.starts_with('_') {
                        exports.insert(n.to_string());
                    }
                }
            }

            if trimmed.starts_with("import ") {
                let pkg = trimmed[7..].split(',').next().unwrap_or("").trim().split('.').next().unwrap_or("");
                if !pkg.is_empty() {
                    dependencies.insert(pkg.to_string(), "*".to_string());
                }
            } else if trimmed.starts_with("from ") {
                if let Some(pkg) = trimmed.split_whitespace().nth(1) {
                    let root_pkg = pkg.split('.').next().unwrap_or("");
                    if !root_pkg.is_empty() && !root_pkg.starts_with('.') {
                        dependencies.insert(root_pkg.to_string(), "*".to_string());
                    }
                }
            }

            if trimmed.contains("eval(") || trimmed.contains("exec(") {
                security.insert("EXEC:eval".to_string());
            }
            if trimmed.contains("subprocess") || trimmed.contains("os.system") {
                security.insert("EXEC:subprocess".to_string());
            }
            if trimmed.contains("requests.") || trimmed.contains("urllib.") || trimmed.contains("httpx.") {
                security.insert("NET:egress".to_string());
            }
            if trimmed.contains("os.environ") {
                security.insert("ENV:read".to_string());
            }
        }
    }

    fn extract_go(
        &self,
        content: &str,
        exports: &mut BTreeSet<String>,
        dependencies: &mut BTreeMap<String, String>,
        security: &mut BTreeSet<String>,
    ) {
        let mut in_import_block = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("import (") {
                in_import_block = true;
                continue;
            }
            if in_import_block {
                if trimmed == ")" {
                    in_import_block = false;
                    continue;
                }
                if let Some(pkg) = trimmed.split('"').nth(1) {
                    dependencies.insert(pkg.to_string(), "*".to_string());
                }
            } else if trimmed.starts_with("import ") {
                if let Some(pkg) = trimmed.split('"').nth(1) {
                    dependencies.insert(pkg.to_string(), "*".to_string());
                }
            }

            if trimmed.starts_with("func ") {
                let rest = &trimmed[5..];
                // Check if method receiver func (r *Receiver) Name()
                let func_name_part = if rest.starts_with('(') {
                    rest.split(')').nth(1).unwrap_or("").trim()
                } else {
                    rest
                };
                if let Some(name) = func_name_part.split('(').next() {
                    let n = name.trim();
                    if n.chars().next().map_or(false, |c| c.is_uppercase()) {
                        exports.insert(n.to_string());
                    }
                }
            } else if trimmed.starts_with("type ") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 2 {
                    let n = parts[1];
                    if n.chars().next().map_or(false, |c| c.is_uppercase()) {
                        exports.insert(n.to_string());
                    }
                }
            }

            if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.contains('/') {
                let pkg = trimmed.trim_matches('"');
                dependencies.insert(pkg.to_string(), "*".to_string());
            }

            if trimmed.contains("exec.Command") {
                security.insert("EXEC:command".to_string());
            }
            if trimmed.contains("unsafe.") {
                security.insert("SAFETY:unsafe".to_string());
            }
            if trimmed.contains("http.Get") || trimmed.contains("http.Post") || trimmed.contains("http.Client") {
                security.insert("NET:egress".to_string());
            }
        }
    }

    fn extract_manifest(
        &self,
        _file_path: &str,
        content: &str,
        dependencies: &mut BTreeMap<String, String>,
        _security: &mut BTreeSet<String>,
    ) {
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.contains("==") {
                let parts: Vec<&str> = trimmed.split("==").collect();
                if parts.len() == 2 {
                    dependencies.insert(parts[0].trim().to_string(), parts[1].trim().to_string());
                }
            } else if trimmed.starts_with("require ") {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    dependencies.insert(parts[1].trim().to_string(), parts[2].trim().to_string());
                }
            }
        }
    }
}
