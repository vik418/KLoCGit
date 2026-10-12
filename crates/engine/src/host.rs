use crate::canonical;
use crate::contracts::{CandidateSpec, CanonicalFutureRevisionState, FutureRevision, EffectSet, MaterializationRecord};
use crate::git::{objects::{ObjectFuture, broker::{BrokerSource, Scope}}, workspace::{Workspace, HydrationBudget}, Limits};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisInput {
    pub schema_version: u32,
    pub scope: Scope,
    pub base_oid: String,
    pub state: CanonicalFutureRevisionState,
    pub revision: FutureRevision,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisJob {
    pub schema_version: u32,
    pub original_payload: String,
    pub input_payload_digest: String,
    pub broker_endpoint: String,
    pub read_capability: String,
}

pub fn analyze(job: AnalysisJob) -> Result<serde_json::Value> {
    if job.schema_version != 1 || canonical::payload_digest(job.original_payload.as_bytes())? != job.input_payload_digest {
        return Err(Error::RevisionMismatch);
    }
    let input: AnalysisInput = serde_json::from_str(&job.original_payload)?;
    input.revision.verify(&input.state)?;
    if input.schema_version != 1 || input.scope.repo_id != input.state.repo_id { return Err(Error::RevisionMismatch); }
    let source = BrokerSource::new(job.broker_endpoint, job.read_capability, input.scope)?;
    let head = crate::git::objects::verified_commit(&source, git2::Oid::from_str(&input.state.commit_oid)?)?;
    if head.tree_oid.to_string() != input.state.tree_oid ||
        head.parent_oids.iter().map(ToString::to_string).collect::<Vec<_>>() != input.state.parent_oids {
        return Err(Error::RevisionMismatch);
    }
    let result = crate::extractors::repository::analyze_repository(
        &source, git2::Oid::from_str(&input.base_oid)?, head.commit_oid, &input.revision.id,
    )?;
    Ok(serde_json::json!({ "schema_version": 1, "input_payload_digest": job.input_payload_digest,
        "effects": result.effects, "changed_paths": result.changed_paths }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectRevision {
    pub state: CanonicalFutureRevisionState,
    pub revision: FutureRevision,
    pub effects: EffectSet,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializeJob {
    pub schema_version: u32,
    pub scope: Scope,
    pub broker_endpoint: String,
    pub read_capability: String,
    pub candidate_spec: CandidateSpec,
    pub sources: Vec<ObjectRevision>,
}

pub fn materialize(job: MaterializeJob) -> Result<Workspace> {
    if job.schema_version != 1 { return Err(Error::InvalidInput("unsupported materialization schema".into())); }
    let source = BrokerSource::new(job.broker_endpoint, job.read_capability, job.scope.clone())?;
    let revisions: Vec<_> = job.sources.iter().map(|record| ObjectFuture {
        state: &record.state, revision: &record.revision, effects: &record.effects, objects: &source,
    }).collect();
    crate::git::workspace::materialize_from_objects(&job.candidate_spec, &source, &job.scope.repo_id,
        &revisions, Limits::default(), HydrationBudget { max_blob_bytes: 16 * 1024 * 1024, max_total_bytes: 64 * 1024 * 1024 },
        MaterializationRecord { executor_id: "native-host".into(), materialized_at: String::new(), conflicts_encountered: vec![] })
}

#[derive(Serialize)]
pub struct ExportFile {
    pub path: String,
    pub mode: u32,
    pub blob_oid: String,
    pub bytes: usize,
}

pub fn export_manifest(root: &Path) -> Result<Vec<ExportFile>> {
    fn visit(root: &Path, directory: &Path, output: &mut Vec<ExportFile>, depth: usize) -> Result<()> {
        if depth > 64 || output.len() > 100_000 { return Err(Error::LimitExceeded("export manifest")); }
        for entry in std::fs::read_dir(directory).map_err(|error| Error::InvalidInput(error.to_string()))? {
            let entry = entry.map_err(|error| Error::InvalidInput(error.to_string()))?;
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| Error::InvalidInput(error.to_string()))?;
            if metadata.is_dir() { visit(root, &entry.path(), output, depth + 1)?; continue; }
            let (contents, mode) = if metadata.file_type().is_symlink() {
                let target = std::fs::read_link(entry.path()).map_err(|error| Error::InvalidInput(error.to_string()))?;
                (target.to_str().ok_or_else(|| Error::InvalidInput("non-UTF8 link".into()))?.as_bytes().to_vec(), 0o120000)
            } else {
                if metadata.len() > 16 * 1024 * 1024 { return Err(Error::LimitExceeded("export blob")); }
                let mut bytes = Vec::new();
                std::fs::File::open(entry.path()).map_err(|error| Error::InvalidInput(error.to_string()))?
                    .take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| Error::InvalidInput(error.to_string()))?;
                #[cfg(unix)]
                let mode = { use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o111 != 0 { 0o100755 } else { 0o100644 } };
                #[cfg(not(unix))]
                let mode = 0o100644;
                (bytes, mode)
            };
            let path = entry.path().strip_prefix(root).map_err(|_| Error::RevisionMismatch)?
                .to_str().ok_or_else(|| Error::InvalidInput("non-UTF8 export path".into()))?.to_string();
            output.push(ExportFile { path, mode, blob_oid: git2::Oid::hash_object(git2::ObjectType::Blob, &contents)?.to_string(), bytes: contents.len() });
        }
        Ok(())
    }
    let mut files = Vec::new(); visit(root, root, &mut files, 0)?;
    files.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Ok(files)
}

pub fn export_blob(root: &Path, manifest: &[ExportFile], path: &str) -> Result<Vec<u8>> {
    let entry = manifest.iter().find(|file| file.path == path).ok_or(Error::RevisionMismatch)?;
    let bytes = if entry.mode == 0o120000 {
        std::fs::read_link(root.join(path)).map_err(|error| Error::InvalidInput(error.to_string()))?
            .to_str().ok_or_else(|| Error::InvalidInput("non-UTF8 link".into()))?.as_bytes().to_vec()
    } else {
        let mut bytes = Vec::new();
        std::fs::File::open(root.join(path)).map_err(|error| Error::InvalidInput(error.to_string()))?
            .take(entry.bytes as u64 + 1).read_to_end(&mut bytes).map_err(|error| Error::InvalidInput(error.to_string()))?;
        bytes
    };
    if bytes.len() != entry.bytes || git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)?.to_string() != entry.blob_oid {
        return Err(Error::RevisionMismatch);
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReductionJob {
    pub schema_version: u32,
    pub input_payload_digest: String,
    pub base_revisions: BTreeMap<String, String>,
    pub futures: Vec<crate::reduction::InputFuture>,
    pub budget: crate::reduction::Budget,
}

pub fn reduce(job: ReductionJob) -> Result<serde_json::Value> {
    if job.schema_version != 1 { return Err(Error::InvalidInput("unsupported reduction schema".into())); }
    crate::contracts::validate_digest(&job.input_payload_digest)?;
    let result = crate::reduction::reduce(&job.base_revisions, &job.futures, job.budget)?;
    Ok(serde_json::json!({ "schema_version": 1, "input_payload_digest": job.input_payload_digest, "result": result }))
}
