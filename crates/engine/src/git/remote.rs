use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::process::{Command, Stdio};

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
        let run = |args: &[&str]| -> Result<String> {
            let mut command = Command::new("/usr/bin/git");
            command.env_clear().env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .env("GIT_TERMINAL_PROMPT", "0").env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_COUNT", "5")
                .env("GIT_CONFIG_KEY_0", format!("http.{}.extraHeader", input.remote))
                .env("GIT_CONFIG_VALUE_0", format!("Authorization: Bearer {}", input.artifact_token))
                .env("GIT_CONFIG_KEY_1", "http.followRedirects").env("GIT_CONFIG_VALUE_1", "false")
                .env("GIT_CONFIG_KEY_2", "core.hooksPath").env("GIT_CONFIG_VALUE_2", "/dev/null")
                .env("GIT_CONFIG_KEY_3", "protocol.file.allow").env("GIT_CONFIG_VALUE_3", "never")
                .env("GIT_CONFIG_KEY_4", "protocol.ext.allow").env("GIT_CONFIG_VALUE_4", "never");
            if let Some(certificates) = std::env::var_os("SSL_CERT_FILE") { command.env("GIT_SSL_CAINFO", certificates); }
            let output = command.current_dir(directory).args(args).stdin(Stdio::null()).output()
                .map_err(|_| Error::InvalidInput("Git executor process failed".into()))?;
            if !output.status.success() { return Err(Error::InvalidInput("Git command outcome requires reconciliation".into())); }
            String::from_utf8(output.stdout).map(|value| value.trim().to_string()).map_err(|_| Error::RevisionMismatch)
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
        run(&["fetch", "--no-tags", "--depth=1", "origin", &input.target_oid])?;
        // receive-pack atomically asserts the exact old ref. No independent
        // read followed by an unconditional push can provide this guarantee.
        run(&["push", "--porcelain", &format!("--force-with-lease={}:{}", input.ref_name, input.expected_oid),
            "origin", &format!("{}:{}", input.target_oid, input.ref_name)])?;
        let receipt = Receipt { schema_version: 1, status: "APPLIED".into(), expected_oid: input.expected_oid,
            target_oid: input.target_oid, operation_digest: input.operation_digest };
        self.receipts.insert(input.idempotency_key, receipt.clone());
        Ok(receipt)
    }
}
