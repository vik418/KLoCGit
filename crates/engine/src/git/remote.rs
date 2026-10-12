use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cas {
    pub schema_version: u32,
    pub remote: String,
    pub artifact_token: String,
    pub ref_name: String,
    pub expected_oid: String,
    pub target_oid: String,
    pub idempotency_key: String,
    pub operation_digest: String,
    pub pack_hex: Option<String>,
    pub pack_payload_digest: Option<String>,
    pub candidate_tree_oid: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Receipt {
    pub schema_version: u32,
    pub status: String,
    pub expected_oid: String,
    pub target_oid: String,
    pub operation_digest: String,
}

pub struct Executor {
    receipts: BTreeMap<String, Receipt>,
}

impl Executor {
    pub fn new() -> Self { Self { receipts: BTreeMap::new() } }

    pub fn operation(&self, key: &str, operation_digest: &str) -> Result<Option<Receipt>> {
        let receipt = self.receipts.get(key);
        if receipt.is_some_and(|record| record.operation_digest != operation_digest) { return Err(Error::RevisionMismatch); }
        Ok(receipt.cloned())
    }

    pub fn compare_and_swap(&mut self, input: Cas) -> Result<Receipt> {
        if let Some(receipt) = self.operation(&input.idempotency_key, &input.operation_digest)? { return Ok(receipt); }
        crate::contracts::validate_digest(&input.operation_digest)?;
        if input.schema_version != 1 || !input.remote.starts_with("https://") || input.remote.contains('\n') || input.remote.contains('\r') ||
            input.artifact_token.is_empty() || !input.ref_name.starts_with("refs/heads/") || input.idempotency_key.is_empty() {
            return Err(Error::InvalidInput("invalid Git CAS command".into()));
        }
        git2::Oid::from_str(&input.expected_oid)?; git2::Oid::from_str(&input.target_oid)?;
        let scratch = tempfile::tempdir().map_err(|error| Error::InvalidInput(error.to_string()))?;
        let directory = scratch.path();
        let deadline = Instant::now() + Duration::from_secs(90);
        let transport = |args: &[&str]| -> Result<ProcessOutcome> {
            let mut command = Command::new("/usr/bin/git");
            command.env_clear().env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .env("GIT_TERMINAL_PROMPT", "0").env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_COUNT", "7")
                .env("GIT_CONFIG_KEY_0", format!("http.{}.extraHeader", input.remote))
                .env("GIT_CONFIG_VALUE_0", format!("Authorization: Bearer {}", input.artifact_token))
                .env("GIT_CONFIG_KEY_1", "http.followRedirects").env("GIT_CONFIG_VALUE_1", "false")
                .env("GIT_CONFIG_KEY_2", "core.hooksPath").env("GIT_CONFIG_VALUE_2", "/dev/null")
                .env("GIT_CONFIG_KEY_3", "protocol.file.allow").env("GIT_CONFIG_VALUE_3", "never")
                .env("GIT_CONFIG_KEY_4", "protocol.ext.allow").env("GIT_CONFIG_VALUE_4", "never")
                .env("GIT_CONFIG_KEY_5", "http.lowSpeedLimit").env("GIT_CONFIG_VALUE_5", "1")
                .env("GIT_CONFIG_KEY_6", "http.lowSpeedTime").env("GIT_CONFIG_VALUE_6", "15");
            if let Some(certificates) = std::env::var_os("SSL_CERT_FILE") { command.env("GIT_SSL_CAINFO", certificates); }
            command.current_dir(directory).args(args);
            let remaining = deadline.checked_duration_since(Instant::now())
                .ok_or_else(|| Error::InvalidInput("Git command outcome requires reconciliation".into()))?;
            bounded_command(&mut command, remaining)
        };
        let run = |args: &[&str]| -> Result<String> {
            let result = transport(args)?;
            if result.success { Ok(result.output) } else { Err(Error::InvalidInput("Git command outcome requires reconciliation".into())) }
        };
        run(&["check-ref-format", &input.ref_name])?;
        let observed = run(&["ls-remote", "--refs", "--exit-code", &input.remote, &input.ref_name])?;
        let current = observed.split_whitespace().next().ok_or(Error::RevisionMismatch)?;
        if current != input.expected_oid {
            let receipt = Receipt { schema_version: 1, status: "NO_EFFECT".into(), expected_oid: input.expected_oid,
                target_oid: input.target_oid, operation_digest: input.operation_digest };
            self.receipts.insert(input.idempotency_key, receipt.clone());
            return Ok(receipt);
        }
        run(&["init", "--bare", "."])?;
        run(&["remote", "add", "origin", &input.remote])?;
        if let Some(hex) = &input.pack_hex {
            if hex.len() > 16 * 1024 * 1024 || hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(Error::LimitExceeded("promotion pack"));
            }
            let bytes: Vec<u8> = hex.as_bytes().chunks_exact(2).map(|pair| {
                u8::from_str_radix(std::str::from_utf8(pair).map_err(|_| Error::RevisionMismatch)?, 16)
                    .map_err(|_| Error::RevisionMismatch)
            }).collect::<Result<_>>()?;
            if input.pack_payload_digest.as_ref() != Some(&crate::canonical::payload_digest(&bytes)?) {
                return Err(Error::RevisionMismatch);
            }
            let tree = input.candidate_tree_oid.as_ref().ok_or(Error::RevisionMismatch)?;
            crate::contracts::validate_oid(tree)?;
            run(&["fetch", "--no-tags", "--depth=1", "origin", &input.expected_oid])?;
            if bytes.len() < 20 { return Err(Error::RevisionMismatch); }
            let pack_oid = git2::Oid::from_bytes(&bytes[bytes.len() - 20..])?;
            let pack_path = format!("objects/pack/pack-{pack_oid}.pack");
            std::fs::write(directory.join(&pack_path), bytes).map_err(|_| Error::RevisionMismatch)?;
            run(&["index-pack", "--strict", &pack_path])?;
            if run(&["cat-file", "-t", &input.target_oid])? != "commit" { return Err(Error::RevisionMismatch); }
            let commit = run(&["cat-file", "-p", &input.target_oid])?;
            let headers: Vec<_> = commit.lines().take_while(|line| !line.is_empty()).collect();
            let parents: Vec<_> = headers.iter().filter_map(|line| line.strip_prefix("parent ")).collect();
            if headers.first().copied() != Some(format!("tree {tree}").as_str()) || parents != [input.expected_oid.as_str()] {
                return Err(Error::RevisionMismatch);
            }
        } else {
            if input.pack_payload_digest.is_some() || input.candidate_tree_oid.is_some() { return Err(Error::RevisionMismatch); }
            run(&["fetch", "--no-tags", "--depth=1", "origin", &input.target_oid])?;
        }
        // receive-pack atomically asserts the exact old ref. No independent
        // read followed by an unconditional push can provide this guarantee.
        let pushed = transport(&["push", "--porcelain", &format!("--force-with-lease={}:{}", input.ref_name, input.expected_oid),
            "origin", &format!("{}:{}", input.target_oid, input.ref_name)])?;
        let reference = format!("{}:{}", input.target_oid, input.ref_name);
        let statuses: Vec<_> = pushed.output.lines().filter_map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            (fields.len() == 3 && fields[1] == reference).then(|| (fields[0].to_string(), fields[2].to_string()))
        }).collect();
        if statuses.len() != 1 { return Err(Error::InvalidInput("Git push outcome requires reconciliation".into())); }
        let (flag, reason) = &statuses[0];
        let applied = pushed.success && matches!(flag.as_str(), " " | "+" | "*");
        let no_effect = (pushed.success && flag == "=") ||
            (!pushed.success && flag == "!" && (reason == "[rejected] (stale info)" || reason.starts_with("[remote rejected] ")));
        if !applied && !no_effect { return Err(Error::InvalidInput("Git push outcome requires reconciliation".into())); }
        let receipt = Receipt { schema_version: 1, status: if applied { "APPLIED" } else { "NO_EFFECT" }.into(), expected_oid: input.expected_oid,
            target_oid: input.target_oid, operation_digest: input.operation_digest };
        self.receipts.insert(input.idempotency_key, receipt.clone());
        Ok(receipt)
    }
}

struct ProcessOutcome { success: bool, output: String }

#[cfg(test)]
fn bounded_output(command: &mut Command, timeout: Duration) -> Result<String> {
    let result = bounded_command(command, timeout)?;
    if result.success { Ok(result.output) } else { Err(Error::InvalidInput("Git command outcome requires reconciliation".into())) }
}

fn bounded_command(command: &mut Command, timeout: Duration) -> Result<ProcessOutcome> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| Error::InvalidInput("Git executor process failed".into()))?;
    let stdout = child.stdout.take().ok_or(Error::RevisionMismatch)?;
    let stderr = child.stderr.take().ok_or(Error::RevisionMismatch)?;
    // Drain both pipes without retaining transport diagnostics or credentials.
    let stdout = thread::spawn(move || crate::sandbox::drain(stdout, 512 * 1024));
    let stderr = thread::spawn(move || crate::sandbox::drain(stderr, 0));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| Error::InvalidInput("Git wait failed".into()))? { break Some(status); }
        if started.elapsed() >= timeout {
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            let _ = child.kill(); let _ = child.wait(); break None;
        }
        thread::sleep(Duration::from_millis(10));
    };
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let (output, truncated) = stdout.join().map_err(|_| Error::RevisionMismatch)?;
    let _ = stderr.join().map_err(|_| Error::RevisionMismatch)?;
    if status.is_none() || truncated {
        return Err(Error::InvalidInput("Git command outcome requires reconciliation".into()));
    }
    Ok(ProcessOutcome { success: status.is_some_and(|status| status.success()),
        output: String::from_utf8(output).map(|value| value.trim().to_string()).map_err(|_| Error::RevisionMismatch)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_process_timeout_is_bounded_and_ambiguous() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let started = Instant::now();
        assert!(bounded_output(&mut command, Duration::from_millis(30)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn transport_output_is_bounded_and_diagnostics_are_not_returned() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf ok; printf private-diagnostic >&2"]);
        assert_eq!(bounded_output(&mut command, Duration::from_secs(2)).unwrap(), "ok");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "head -c 600000 /dev/zero"]);
        assert!(bounded_output(&mut command, Duration::from_secs(2)).is_err());
    }
}
