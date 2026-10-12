use super::{CheckReceipt, Evaluation, EvaluationPolicy};
use crate::{Error, Result, canonical};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Environment {
    pub schema_version: u32,
    pub provider: String,
    pub image_oid: String,
    pub network: String,
}

/// The provider adapter supplies this environment after creating a VM with
/// egress disabled. Repository code cannot select the provider or its settings.
pub fn evaluate(source: &Path, suite: &Path, candidate: &crate::contracts::Candidate,
    repo_id: &str, policy: &EvaluationPolicy, environment: &Environment) -> Result<Evaluation> {
    let toolchain = super::validate(source, suite, candidate, repo_id, policy)?;
    if environment.schema_version != 1 || environment.network != "DENIED" ||
        environment.image_oid != policy.image_oid || environment.provider.is_empty() {
        return Err(Error::InvalidInput("UNSUPPORTED: VM environment does not meet policy".into()));
    }
    #[cfg(not(target_os = "linux"))]
    return Err(Error::InvalidInput("UNSUPPORTED: evaluator requires Linux".into()));
    #[cfg(target_os = "linux")]
    if unsafe { libc::geteuid() } != 0 {
        return Err(Error::InvalidInput("UNSUPPORTED: evaluator cannot establish an isolated execution identity".into()));
    }
    let memory_cap = memory_limit()?;
    if memory_cap > policy.memory_bytes {
        return Err(Error::InvalidInput("UNSUPPORTED: VM memory capacity exceeds the evaluator policy".into()));
    }
    protect(source)?; protect(suite)?;
    let config_digest = canonical::hash_projection("klocgit.evaluator.config", policy)?;
    let environment_digest = canonical::hash_projection("klocgit.evaluator.vm-environment", &serde_json::json!({
        "provider": environment.provider, "image_oid": environment.image_oid, "network": environment.network,
        "memory_cap": memory_cap, "uid": 10001, "source_read_only": true, "suite_read_only": true,
        "toolchain": toolchain, "pids_limit": policy.pids_limit,
    }))?;
    let mut receipts = Vec::new();
    for check in &policy.checks {
        if check.command.is_empty() || check.id.is_empty() || check.command.iter().any(|arg| arg.contains('\0')) {
            return Err(Error::InvalidInput("invalid check command".into()));
        }
        let seconds = policy.timeout_ms.div_ceil(1000).max(1).to_string();
        let mut command = Command::new("/usr/bin/setpriv");
        command.env_clear().env("PATH", "/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin")
            .env("HOME", "/tmp").env("GOCACHE", "/tmp/go-build").env("GOPATH", "/tmp/go")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .args(["--reuid=10001", "--regid=10001", "--clear-groups", "--no-new-privs",
                "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
                "/usr/bin/prlimit", &format!("--cpu={seconds}"), &format!("--nproc={}", policy.pids_limit),
                "--nofile=1024", "--"])
            .args(&check.command).current_dir(suite).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)] {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let started = Instant::now();
        let mut child = command.spawn().map_err(|_| Error::InvalidInput("isolated checker launch failed".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| Error::InvalidInput("missing stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| Error::InvalidInput("missing stderr".into()))?;
        let limit = policy.max_log_bytes;
        let stdout = thread::spawn(move || super::drain(stdout, limit));
        let stderr = thread::spawn(move || super::drain(stderr, limit));
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|_| Error::InvalidInput("checker wait failed".into()))? { break status; }
            if started.elapsed() > Duration::from_millis(policy.timeout_ms) {
                timed_out = true;
                // Descendants must not outlive their evaluator process.
                #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                let _ = child.kill();
                break child.wait().map_err(|_| Error::InvalidInput("checker termination failed".into()))?;
            }
            thread::sleep(Duration::from_millis(10));
        };
        // A daemonized descendant can keep log pipes open after its parent exits.
        #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let (out, a) = stdout.join().map_err(|_| Error::InvalidInput("stdout collection failed".into()))?;
        let (err, b) = stderr.join().map_err(|_| Error::InvalidInput("stderr collection failed".into()))?;
        receipts.push(CheckReceipt {
            check_id: check.id.clone(), exit_code: status.code(), timed_out,
            stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&err).into_owned(),
            stdout_hex: out.iter().map(|byte| format!("{byte:02x}")).collect(),
            stderr_hex: err.iter().map(|byte| format!("{byte:02x}")).collect(),
            log_truncated: a || b, elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }
    super::evidence(&candidate.candidate_digest, policy, config_digest, environment_digest, receipts)
}

fn memory_limit() -> Result<u64> {
    let source = fs::read_to_string("/proc/meminfo").map_err(|_| Error::InvalidInput("UNSUPPORTED: VM memory limits unavailable".into()))?;
    let physical = source.lines().find_map(|line| line.strip_prefix("MemTotal:"))
        .and_then(|value| value.split_whitespace().next()).and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| value.checked_mul(1024))
        .ok_or_else(|| Error::InvalidInput("UNSUPPORTED: VM memory limits invalid".into()))?;
    let cgroup = fs::read_to_string("/sys/fs/cgroup/memory.max").ok()
        .and_then(|value| value.trim().parse::<u64>().ok());
    Ok(cgroup.map_or(physical, |limit| limit.min(physical)))
}

fn protect(directory: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    for entry in fs::read_dir(directory).map_err(|error| Error::InvalidInput(error.to_string()))? {
        let path = entry.map_err(|error| Error::InvalidInput(error.to_string()))?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| Error::InvalidInput(error.to_string()))?;
        if metadata.is_dir() { protect(&path)?; }
        else if metadata.is_file() {
            let mode = if metadata.permissions().mode() & 0o111 != 0 { 0o555 } else { 0o444 };
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).map_err(|error| Error::InvalidInput(error.to_string()))?;
        }
    }
    fs::set_permissions(directory, fs::Permissions::from_mode(0o555)).map_err(|error| Error::InvalidInput(error.to_string()))?;
    Ok(())
}
