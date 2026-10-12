pub mod toolchains;

use crate::canonical;
use crate::contracts::{CanonicalEvidence, Evidence, EvidenceResult, RetentionClass};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub id: String,
    pub command: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationPolicy {
    pub schema_version: u32,
    pub evaluator_id: String,
    pub evaluator_version: String,
    pub image_oid: String,
    pub language: String,
    pub supported_toolchains: toolchains::ToolchainMatrix,
    pub trusted_suite_state_digest: String,
    pub checks: Vec<Check>,
    pub timeout_ms: u64,
    pub memory_bytes: u64,
    pub pids_limit: u32,
    pub max_log_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckReceipt {
    pub check_id: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_hex: String,
    pub stderr_hex: String,
    pub log_truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvaluationReceipt {
    pub schema_version: u32,
    pub subject_digest: String,
    pub config_digest: String,
    pub environment_digest: String,
    pub checks: Vec<CheckReceipt>,
}

pub struct Evaluation {
    pub receipt: EvaluationReceipt,
    pub evidence: Evidence,
    pub payload: Vec<u8>,
}

fn docker() -> Command {
    let mut command = Command::new("docker");
    let path = std::env::var_os("PATH").unwrap_or_default();
    command
        .env_clear()
        .env("PATH", path)
        .arg("--host=unix:///var/run/docker.sock");
    if let Some(config) = std::env::var_os("DOCKER_CONFIG") {
        command.env("DOCKER_CONFIG", config);
    }
    command
}

struct Container(String);
impl Drop for Container {
    fn drop(&mut self) {
        let _ = docker()
            .args(["rm", "--force", &self.0])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub(crate) fn drain(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut captured = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 4096];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let accepted = count.min(limit.saturating_sub(captured.len()));
        captured.extend_from_slice(&buffer[..accepted]);
        truncated |= accepted < count;
    }
    (captured, truncated)
}

fn run_check(
    source: &Path,
    suite: &Path,
    policy: &EvaluationPolicy,
    check: &Check,
) -> Result<CheckReceipt> {
    if check.id.is_empty()
        || check.command.is_empty()
        || check.command.iter().any(|value| value.contains('\0'))
    {
        return Err(Error::InvalidInput("invalid evaluator command".into()));
    }
    let source =
        fs::canonicalize(source).map_err(|error| Error::InvalidInput(error.to_string()))?;
    let suite = fs::canonicalize(suite).map_err(|error| Error::InvalidInput(error.to_string()))?;
    let source_mount = format!("type=bind,src={},dst=/workspace,readonly", source.display());
    let suite_mount = format!("type=bind,src={},dst=/checks,readonly", suite.display());
    let created = docker()
        .args([
            "create",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--user=10001:10001",
            "--pids-limit",
            &policy.pids_limit.to_string(),
            "--memory",
            &policy.memory_bytes.to_string(),
            "--memory-swap",
            &policy.memory_bytes.to_string(),
            "--cpus=1",
            "--tmpfs=/tmp:rw,exec,nosuid,nodev,size=268435456",
            "--mount",
            &source_mount,
            "--mount",
            &suite_mount,
            "--workdir=/checks",
            "--env=HTTP_PROXY=",
            "--env=HTTPS_PROXY=",
            "--env=ALL_PROXY=",
            "--env=NO_PROXY=",
            "--env=http_proxy=",
            "--env=https_proxy=",
            "--env=all_proxy=",
            "--env=no_proxy=",
            "--env=HOME=/tmp",
            "--env=GOCACHE=/tmp/go-build",
            "--env=GOPATH=/tmp/go",
            "--env=PYTHONDONTWRITEBYTECODE=1",
            &policy.image_oid,
        ])
        .args(&check.command)
        .output()
        .map_err(|error| Error::InvalidInput(error.to_string()))?;
    if !created.status.success() {
        return Err(Error::InvalidInput(
            "isolated container could not be created".into(),
        ));
    }
    let id = String::from_utf8(created.stdout)
        .map_err(|_| Error::InvalidInput("invalid container receipt".into()))?;
    let id = id.trim().to_string();
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::InvalidInput("invalid container identity".into()));
    }
    let container = Container(id);
    let started = Instant::now();
    let mut process = docker()
        .args(["start", "--attach", &container.0])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Error::InvalidInput(error.to_string()))?;
    let stdout = process
        .stdout
        .take()
        .ok_or_else(|| Error::InvalidInput("missing stdout".into()))?;
    let stderr = process
        .stderr
        .take()
        .ok_or_else(|| Error::InvalidInput("missing stderr".into()))?;
    let max_log_bytes = policy.max_log_bytes;
    let stdout = thread::spawn(move || drain(stdout, max_log_bytes));
    let stderr = thread::spawn(move || drain(stderr, max_log_bytes));
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = process
            .try_wait()
            .map_err(|error| Error::InvalidInput(error.to_string()))?
        {
            break status;
        }
        if started.elapsed() > Duration::from_millis(policy.timeout_ms) {
            timed_out = true;
            // Killing the Docker client alone leaves its container running.
            let _ = docker()
                .args(["kill", &container.0])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = process.kill();
            break process
                .wait()
                .map_err(|error| Error::InvalidInput(error.to_string()))?;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let (out, a) = stdout
        .join()
        .map_err(|_| Error::InvalidInput("stdout reader failed".into()))?;
    let (err, b) = stderr
        .join()
        .map_err(|_| Error::InvalidInput("stderr reader failed".into()))?;
    Ok(CheckReceipt {
        check_id: check.id.clone(),
        exit_code: status.code(),
        timed_out,
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        stdout_hex: out.iter().map(|byte| format!("{byte:02x}")).collect(),
        stderr_hex: err.iter().map(|byte| format!("{byte:02x}")).collect(),
        log_truncated: a || b,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// A trusted evaluator supplies the suite, image and commands. Repository
/// scripts cannot select a weaker evaluator or turn networking back on.
pub fn evaluate(
    source: &Path,
    suite: &Path,
    candidate: &crate::contracts::Candidate,
    repo_id: &str,
    policy: &EvaluationPolicy,
) -> Result<Evaluation> {
    let toolchain = validate(source, suite, candidate, repo_id, policy)?;
    let subject_digest = &candidate.candidate_digest;
    // Environment and policy are separate from execution timing and payload location.
    let config_digest = canonical::hash_projection("klocgit.evaluator.config", policy)?;
    let environment_digest = canonical::hash_projection(
        "klocgit.evaluator.environment",
        &serde_json::json!({
            "image_oid": policy.image_oid, "network": "NONE", "uid": 10001,
            "source_read_only": true, "suite_read_only": true, "memory_bytes": policy.memory_bytes,
            "pids_limit": policy.pids_limit, "toolchain": toolchain,
            "scratch_mount": { "writable": true, "executable": true, "bytes": 268435456 },
        }),
    )?;
    let mut checks = Vec::new();
    for check in &policy.checks {
        checks.push(run_check(source, suite, policy, check)?);
    }
    evidence(subject_digest, policy, config_digest, environment_digest, checks)
}

pub(crate) fn evidence(subject_digest: &str, policy: &EvaluationPolicy, config_digest: String, environment_digest: String, checks: Vec<CheckReceipt>) -> Result<Evaluation> {
    let result = if checks
        .iter()
        .any(|check| check.timed_out || check.exit_code.is_none())
    {
        EvidenceResult::Error
    } else if checks.iter().all(|check| check.exit_code == Some(0)) {
        EvidenceResult::Passed
    } else {
        EvidenceResult::Failed
    };
    let receipt = EvaluationReceipt {
        schema_version: 1,
        subject_digest: subject_digest.into(),
        config_digest: config_digest.clone(),
        environment_digest: environment_digest.clone(),
        checks,
    };
    let payload = serde_json::to_vec(&receipt)?;
    let mut evidence = Evidence {
        canonical: CanonicalEvidence {
            subject_digest: subject_digest.into(),
            evaluator_id: policy.evaluator_id.clone(),
            evaluator_version: policy.evaluator_version.clone(),
            config_digest,
            environment_digest,
            result,
            payload_digest: canonical::payload_digest(&payload)?,
        },
        id: String::new(),
        evidence_digest: String::new(),
        payload_ref: String::new(),
        retention_class: RetentionClass::DecisionRecord,
        created_at: String::new(),
    };
    evidence.seal()?;
    Ok(Evaluation {
        receipt,
        evidence,
        payload,
    })
}

pub(crate) fn validate(
    source: &Path, suite: &Path, candidate: &crate::contracts::Candidate, repo_id: &str, policy: &EvaluationPolicy,
) -> Result<toolchains::SupportedToolchain> {
    let mut sealed = candidate.clone();
    sealed.seal()?;
    if sealed.id != candidate.id
        || sealed.candidate_digest != candidate.candidate_digest
        || candidate.repo_tree_oids.len() != 1
    {
        return Err(Error::RevisionMismatch);
    }
    let actual_tree = crate::git::workspace::tree_oid(
        source,
        crate::git::Limits::default(),
        crate::git::workspace::HydrationBudget {
            max_blob_bytes: 16 * 1024 * 1024,
            max_total_bytes: 64 * 1024 * 1024,
        },
    )?;
    if candidate.repo_tree_oids.get(repo_id) != Some(&actual_tree.to_string()) {
        return Err(Error::RevisionMismatch);
    }
    let suite_tree = crate::git::workspace::tree_oid(
        suite,
        crate::git::Limits::default(),
        crate::git::workspace::HydrationBudget {
            max_blob_bytes: 16 * 1024 * 1024,
            max_total_bytes: 64 * 1024 * 1024,
        },
    )?;
    if canonical::hash_projection(
        "klocgit.trusted-suite",
        &serde_json::json!({ "tree_oid": suite_tree.to_string() }),
    )? != policy.trusted_suite_state_digest
    {
        return Err(Error::RevisionMismatch);
    }
    crate::contracts::validate_digest(&policy.trusted_suite_state_digest)?;
    crate::contracts::validate_digest(&policy.image_oid)?;
    if policy.schema_version != 1
        || !policy.image_oid.starts_with("sha256:")
        || policy.image_oid.len() != 71
        || policy.evaluator_id.is_empty()
        || policy.evaluator_version.is_empty()
        || policy.checks.is_empty()
        || policy.timeout_ms == 0
        || policy.memory_bytes == 0
        || policy.pids_limit == 0
        || policy.max_log_bytes == 0
        || policy.max_log_bytes > 1024 * 1024
    {
        return Err(Error::InvalidInput("invalid evaluation policy".into()));
    }
    let toolchain = toolchains::select(source, &policy.language, &policy.supported_toolchains)?;
    if toolchain.image_oid != policy.image_oid {
        return Err(Error::InvalidInput(
            "UNSUPPORTED: evaluator image differs from the selected toolchain".into(),
        ));
    }

    Ok(toolchain)
}

pub mod vm;
