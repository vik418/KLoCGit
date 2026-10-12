use klocgit_engine::{Error, Result, canonical, host, contracts::Candidate, sandbox};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tiny_http::{Header, Response, Server, StatusCode};
use sha2::{Digest, Sha256};

const MAX_REQUEST: usize = 32 * 1024 * 1024;

fn same_secret(a: &[u8], b: &[u8]) -> bool {
    let a = Sha256::digest(a); let b = Sha256::digest(b);
    a.iter().zip(b).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

fn decode(value: &str) -> Result<Vec<u8>> {
    if value.len() > 2 * 1024 * 1024 || value.len() % 2 != 0 ||
        !value.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err(Error::InvalidInput("invalid transfer bytes".into())); }
    value.as_bytes().chunks_exact(2).map(|pair| {
        let value = std::str::from_utf8(pair).map_err(|_| Error::RevisionMismatch)?;
        u8::from_str_radix(value, 16).map_err(|_| Error::RevisionMismatch)
    }).collect()
}

fn relative(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.len() > 4096 || value.contains('\\') || value.contains('\0') ||
        value.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")) ||
        canonical::nfc(value) != value {
        return Err(Error::InvalidInput("unsafe transfer path".into()));
    }
    Ok(PathBuf::from(value))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    schema_version: u32,
    root: String,
    path: String,
    mode: u32,
    blob_oid: String,
    chunk_index: usize,
    chunk_count: usize,
    payload_hex: String,
}

struct Partial {
    next: usize,
    chunks: usize,
    mode: u32,
    oid: String,
    bytes: Vec<u8>,
}

struct EvaluationWorkspace {
    sources: BTreeMap<String, Partial>,
    hydrated: usize,
    sealed: bool,
}

impl EvaluationWorkspace {
    fn new() -> Result<Self> {
        for root in ["/workspace", "/checks"] {
            if Path::new(root).exists() {
                if fs::read_dir(root).map_err(|error| Error::InvalidInput(error.to_string()))?.next().is_some() {
                    return Err(Error::InvalidInput("execution root must be empty at startup".into()));
                }
            } else { fs::create_dir(root).map_err(|error| Error::InvalidInput(error.to_string()))?; }
        }
        Ok(Self { sources: BTreeMap::new(), hydrated: 0, sealed: false })
    }

    fn transfer(&mut self, input: Transfer) -> Result<()> {
        if self.sealed || input.schema_version != 1 || !["workspace", "checks"].contains(&input.root.as_str()) ||
            !matches!(input.mode, 0o100644 | 0o100755 | 0o120000) || input.chunk_count == 0 || input.chunk_count > 16 ||
            input.chunk_index >= input.chunk_count { return Err(Error::RevisionMismatch); }
        let relative = relative(&input.path)?;
        let key = format!("{}/{}", input.root, input.path);
        let bytes = decode(&input.payload_hex)?;
        let destination = PathBuf::from(format!("/{}", input.root)).join(&relative);
        if destination.exists() || fs::symlink_metadata(&destination).is_ok() {
            if input.chunk_index != 0 { return Err(Error::RevisionMismatch); }
            let old = if input.mode == 0o120000 {
                fs::read_link(&destination).map_err(|_| Error::RevisionMismatch)?.to_str().ok_or(Error::RevisionMismatch)?.as_bytes().to_vec()
            } else { fs::read(&destination).map_err(|_| Error::RevisionMismatch)? };
            if git2::Oid::hash_object(git2::ObjectType::Blob, &old)?.to_string() == input.blob_oid { return Ok(()); }
            return Err(Error::RevisionMismatch);
        }
        if self.sources.len() >= 100_000 { return Err(Error::LimitExceeded("transfer files")); }
        let partial = self.sources.entry(key.clone()).or_insert_with(|| Partial {
            next: 0, chunks: input.chunk_count, mode: input.mode, oid: input.blob_oid.clone(), bytes: vec![],
        });
        if partial.next != input.chunk_index || partial.chunks != input.chunk_count || partial.mode != input.mode || partial.oid != input.blob_oid {
            return Err(Error::RevisionMismatch);
        }
        self.hydrated = self.hydrated.checked_add(bytes.len()).ok_or(Error::LimitExceeded("transfer bytes"))?;
        if self.hydrated > 64 * 1024 * 1024 || partial.bytes.len() + bytes.len() > 16 * 1024 * 1024 {
            return Err(Error::LimitExceeded("transfer bytes"));
        }
        partial.bytes.extend(bytes); partial.next += 1;
        if partial.next == partial.chunks {
            if git2::Oid::hash_object(git2::ObjectType::Blob, &partial.bytes)?.to_string() != partial.oid { return Err(Error::RevisionMismatch); }
            let root = PathBuf::from(format!("/{}", input.root));
            let mut parent = root.clone();
            for component in relative.parent().unwrap_or(Path::new("")).components() {
                parent.push(component);
                if fs::symlink_metadata(&parent).is_ok_and(|metadata| !metadata.is_dir() || metadata.file_type().is_symlink()) {
                    return Err(Error::InvalidInput("transfer parent is not a directory".into()));
                }
                fs::create_dir_all(&parent).map_err(|error| Error::InvalidInput(error.to_string()))?;
            }
            if input.mode == 0o120000 {
                let target = std::str::from_utf8(&partial.bytes).map_err(|_| Error::RevisionMismatch)?;
                let mut depth = relative.parent().unwrap_or(Path::new("")).components().count();
                for part in Path::new(target).components() {
                    match part {
                        std::path::Component::Normal(_) => depth += 1,
                        std::path::Component::CurDir => {},
                        std::path::Component::ParentDir if depth > 0 => depth -= 1,
                        _ => return Err(Error::InvalidInput("link escapes execution root".into())),
                    }
                }
                #[cfg(unix)] std::os::unix::fs::symlink(target, &destination).map_err(|error| Error::InvalidInput(error.to_string()))?;
            } else {
                fs::write(&destination, &partial.bytes).map_err(|error| Error::InvalidInput(error.to_string()))?;
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&destination, fs::Permissions::from_mode(if input.mode == 0o100755 { 0o755 } else { 0o644 }))
                        .map_err(|error| Error::InvalidInput(error.to_string()))?;
                }
            }
            self.sources.remove(&key);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvaluationJob {
    schema_version: u32,
    candidate: Candidate,
    repo_id: String,
    policy: sandbox::EvaluationPolicy,
    environment: sandbox::vm::Environment,
}

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let role = std::env::var("KLOCGIT_HOST_ROLE")?;
    if !["analysis", "evaluation", "git"].contains(&role.as_str()) { return Err("invalid host role".into()); }
    let session = std::env::var("KLOCGIT_SESSION")?;
    if session.len() < 32 { return Err("session key is required".into()); }
    let port: u16 = std::env::var("KLOCGIT_HOST_PORT")?.parse()?;
    let server = Server::http(("0.0.0.0", port)).map_err(|error| error.to_string())?;
    let mut materialized: Option<(klocgit_engine::git::workspace::Workspace, Vec<host::ExportFile>)> = None;
    let mut execution = if role == "evaluation" { Some(EvaluationWorkspace::new()?) } else { None };
    let mut git_executor = klocgit_engine::git::remote::Executor::new();
    for mut request in server.incoming_requests() {
        if request.url() == "/health" && request.method().as_str() == "GET" {
            let _ = request.respond(Response::from_string("ready")); continue;
        }
        let supplied = request.headers().iter().find(|header| header.field.equiv("x-klocgit-session"))
            .map(|header| header.value.as_str()).unwrap_or("");
        if !same_secret(supplied.as_bytes(), session.as_bytes()) {
            let _ = request.respond(Response::empty(StatusCode(403))); continue;
        }
        if request.method().as_str() != "POST" || request.body_length().is_some_and(|size| size > MAX_REQUEST) {
            let _ = request.respond(Response::empty(StatusCode(413))); continue;
        }
        let path = request.url().to_string();
        let mut bytes = Vec::new();
        let read = request.as_reader().take(MAX_REQUEST as u64 + 1).read_to_end(&mut bytes);
        let result: Result<(Vec<u8>, &'static str)> = (|| {
            if read.is_err() || bytes.len() > MAX_REQUEST { return Err(Error::LimitExceeded("host request")); }
            let json = |value: serde_json::Value| -> Result<(Vec<u8>, &'static str)> { Ok((serde_json::to_vec(&value)?, "application/json")) };
            match (role.as_str(), path.as_str()) {
                ("git", "/git/cas") => {
                    let receipt = git_executor.compare_and_swap(serde_json::from_slice(&bytes)?)?;
                    json(serde_json::to_value(receipt)?)
                }
                ("git", "/git/operation") => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Query { idempotency_key: String, operation_digest: String }
                    let query: Query = serde_json::from_slice(&bytes)?;
                    let receipt = git_executor.operation(&query.idempotency_key, &query.operation_digest)?;
                    json(serde_json::to_value(receipt)?.as_object().cloned().map(serde_json::Value::Object)
                        .unwrap_or_else(|| serde_json::json!({ "schema_version": 1, "status": "UNKNOWN" })))
                }
                ("analysis", "/analyze") => json(host::analyze(serde_json::from_slice(&bytes)?)?),
                ("analysis", "/reduce") => json(host::reduce(serde_json::from_slice(&bytes)?)?),
                ("analysis", "/materialize") => {
                    let workspace = host::materialize(serde_json::from_slice(&bytes)?)?;
                    let files = host::export_manifest(workspace.path())?;
                    let result = serde_json::json!({ "schema_version": 1, "candidate": workspace.candidate,
                        "files": files, "hydrated_bytes": workspace.bytes_hydrated });
                    materialized = Some((workspace, files)); json(result)
                }
                ("analysis", "/workspace/blob") => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Query { path: String }
                    let query: Query = serde_json::from_slice(&bytes)?;
                    let (workspace, files) = materialized.as_ref().ok_or(Error::RevisionMismatch)?;
                    Ok((host::export_blob(workspace.path(), files, &query.path)?, "application/octet-stream"))
                }
                ("evaluation", "/stage") => {
                    execution.as_mut().ok_or(Error::RevisionMismatch)?.transfer(serde_json::from_slice(&bytes)?)?;
                    json(serde_json::json!({ "schema_version": 1, "status": "STAGED" }))
                }
                ("evaluation", "/evaluate") => {
                    let job: EvaluationJob = serde_json::from_slice(&bytes)?;
                    let workspace = execution.as_mut().ok_or(Error::RevisionMismatch)?;
                    if job.schema_version != 1 || workspace.sealed || !workspace.sources.is_empty() { return Err(Error::RevisionMismatch); }
                    workspace.sealed = true;
                    let result = sandbox::vm::evaluate(Path::new("/workspace"), Path::new("/checks"),
                        &job.candidate, &job.repo_id, &job.policy, &job.environment)?;
                    json(serde_json::json!({ "schema_version": 1, "evidence": result.evidence, "payload": result.payload, "receipt": result.receipt }))
                }
                _ => Err(Error::InvalidInput("unsupported host action".into())),
            }
        })();
        match result {
            Ok((bytes, content_type)) => {
                let header = Header::from_bytes("content-type", content_type).map_err(|_| "invalid response header")?;
                let _ = request.respond(Response::from_data(bytes).with_header(header));
            }
            Err(error) => {
                let class = match error { Error::RevisionMismatch => "INPUT_MISMATCH", Error::LimitExceeded(_) => "RESOURCE_LIMIT",
                    Error::InvalidInput(ref message) if message.starts_with("UNSUPPORTED:") => "UNSUPPORTED", _ => "EXECUTION_ERROR" };
                // Diagnostics stay out of responses: they may contain source paths.
                let body = serde_json::json!({ "error": { "code": class } }).to_string();
                let _ = request.respond(Response::from_string(body).with_status_code(StatusCode(409)));
            }
        }
    }
    Ok(())
}
