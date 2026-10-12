use super::{CommitHeader, ObjectSource};
use crate::{Error, Result};
use git2::Oid;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Duration;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub tenant_id: String,
    pub organization_id: String,
    pub repo_id: String,
    pub objective_id: String,
}

/// A trusted host receives a short-lived read-only capability from the edge.
/// The token is never copied into the candidate workspace or execution process.
pub struct BrokerSource {
    endpoint: String,
    capability: String,
    scope: Scope,
    agent: ureq::Agent,
}

impl BrokerSource {
    pub fn new(endpoint: String, capability: String, scope: Scope) -> Result<Self> {
        if !endpoint.starts_with("https://")
            || capability.is_empty()
            || capability.len() > 16 * 1024
            || scope.repo_id.is_empty()
            || scope.tenant_id.is_empty()
            || scope.organization_id.is_empty()
            || scope.objective_id.is_empty()
        {
            return Err(Error::InvalidInput(
                "invalid Git object broker configuration".into(),
            ));
        }
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_secs(30))
            .build();
        Ok(Self {
            endpoint,
            capability,
            scope,
            agent,
        })
    }

    fn read(&self, kind: &str, oid: Oid, maximum: usize) -> Result<Vec<u8>> {
        if maximum == 0 {
            return Err(Error::LimitExceeded("Git object bytes"));
        }
        let command = serde_json::json!({
            "schema_version": 1, "scope": self.scope, "kind": kind,
            "oid": oid.to_string(), "max_bytes": maximum.min(16 * 1024 * 1024),
        });
        let response = self
            .agent
            .post(&self.endpoint)
            .set("content-type", "application/json")
            .set("x-klocgit-object-capability", &self.capability)
            .send_string(&serde_json::to_string(&command)?)
            .map_err(|error| match error {
                ureq::Error::Status(status, _) => Error::InvalidInput(format!(
                    "Git object broker rejected the read: HTTP {status}"
                )),
                ureq::Error::Transport(error) => Error::InvalidInput(format!(
                    "Git object broker transport failed: {:?}",
                    error.kind()
                )),
            })?;
        if response
            .header("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|size| size > maximum)
        {
            return Err(Error::LimitExceeded("Git object bytes"));
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::InvalidInput("Git object broker response failed".into()))?;
        if bytes.len() > maximum {
            return Err(Error::LimitExceeded("Git object bytes"));
        }
        Ok(bytes)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    schema_version: u32,
    commit_oid: String,
    tree_oid: String,
    parent_oids: Vec<String>,
}

impl ObjectSource for BrokerSource {
    fn commit(&self, oid: Oid) -> Result<CommitHeader> {
        let response: Observation =
            serde_json::from_slice(&self.read("commit", oid, 64 * 1024)?)?;
        if response.schema_version != 1
            || response.commit_oid != oid.to_string()
            || response.parent_oids.len() > 1024
        {
            return Err(Error::RevisionMismatch);
        }
        Ok(CommitHeader {
            commit_oid: oid,
            tree_oid: Oid::from_str(&response.tree_oid)?,
            parent_oids: response
                .parent_oids
                .iter()
                .map(|value| Oid::from_str(value))
                .collect::<std::result::Result<Vec<_>, _>>()?,
        })
    }
    fn tree(&self, oid: Oid, max_bytes: usize) -> Result<Vec<u8>> {
        self.read("tree", oid, max_bytes)
    }
    fn blob(&self, oid: Oid, max_bytes: usize) -> Result<Vec<u8>> {
        self.read("blob", oid, max_bytes)
    }
}
