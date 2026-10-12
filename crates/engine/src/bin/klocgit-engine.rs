use klocgit_engine::contracts::Language;
use klocgit_engine::extractors::{analyze, Limits, SourceChange};
use klocgit_engine::reduction::{self, Budget, InputFuture};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    EvaluateVm {
        workspace: String, trusted_suite: String, candidate: klocgit_engine::contracts::Candidate,
        repo_id: String, policy: klocgit_engine::sandbox::EvaluationPolicy,
        environment: klocgit_engine::sandbox::vm::Environment,
    },
    EvaluateObjects {
        broker_endpoint: String,
        read_capability: String,
        scope: klocgit_engine::git::objects::broker::Scope,
        candidate_spec: klocgit_engine::contracts::CandidateSpec,
        sources: Vec<ObjectRevision>,
        trusted_suite: String,
        policy: klocgit_engine::sandbox::EvaluationPolicy,
    },
    EvaluateCandidate {
        base_repository: String,
        repo_id: String,
        candidate_spec: klocgit_engine::contracts::CandidateSpec,
        sources: Vec<SourceRepository>,
        trusted_suite: String,
        policy: klocgit_engine::sandbox::EvaluationPolicy,
    },
    Evaluate {
        workspace: String,
        trusted_suite: String,
        candidate: klocgit_engine::contracts::Candidate,
        repo_id: String,
        policy: klocgit_engine::sandbox::EvaluationPolicy,
    },
    Analyze {
        future_revision_id: String,
        language: Language,
        changes: Vec<SourceChange>,
    },
    Reduce {
        base_revisions: BTreeMap<String, String>,
        futures: Vec<InputFuture>,
        budget: Budget,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObjectRevision {
    state: klocgit_engine::contracts::CanonicalFutureRevisionState,
    revision: klocgit_engine::contracts::FutureRevision,
    effects: klocgit_engine::contracts::EffectSet,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceRepository {
    repository_path: String,
    state: klocgit_engine::contracts::CanonicalFutureRevisionState,
    revision: klocgit_engine::contracts::FutureRevision,
    effects: klocgit_engine::contracts::EffectSet,
}

fn evaluate_candidate(
    base_repository: String,
    repo_id: String,
    candidate_spec: klocgit_engine::contracts::CandidateSpec,
    sources: Vec<SourceRepository>,
    trusted_suite: String,
    policy: klocgit_engine::sandbox::EvaluationPolicy,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let base = git2::Repository::open(base_repository)?;
    let repositories: Result<Vec<_>, _> = sources
        .iter()
        .map(|source| git2::Repository::open(&source.repository_path))
        .collect();
    let repositories = repositories?;
    let observed: Vec<_> = sources
        .iter()
        .zip(&repositories)
        .map(|(source, repository)| klocgit_engine::git::FutureSource {
            repository,
            state: &source.state,
            revision: &source.revision,
            effects: &source.effects,
        })
        .collect();
    let workspace = klocgit_engine::git::workspace::materialize(
        &candidate_spec,
        &base,
        &repo_id,
        &observed,
        klocgit_engine::git::Limits::default(),
        klocgit_engine::git::workspace::HydrationBudget {
            max_blob_bytes: 16 * 1024 * 1024,
            max_total_bytes: 64 * 1024 * 1024,
        },
        klocgit_engine::contracts::MaterializationRecord {
            executor_id: "sandbox-host".into(),
            materialized_at: String::new(),
            conflicts_encountered: vec![],
        },
    )?;
    let result = klocgit_engine::sandbox::evaluate(
        workspace.path(),
        std::path::Path::new(&trusted_suite),
        &workspace.candidate,
        &repo_id,
        &policy,
    )?;
    Ok(serde_json::json!({
        "schema_version": 1, "candidate": workspace.candidate,
        "evidence": result.evidence, "payload": result.payload, "receipt": result.receipt,
        "hydrated_bytes": workspace.bytes_hydrated, "hydrated_files": workspace.files_hydrated,
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let max_bytes = 32 * 1024 * 1024;
    io::stdin().take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err("engine input exceeds limit".into());
    }
    let input: Request = serde_json::from_slice(&bytes)?;
    let output = match input {
        Request::EvaluateVm { workspace, trusted_suite, candidate, repo_id, policy, environment } => {
            let result = klocgit_engine::sandbox::vm::evaluate(
                std::path::Path::new(&workspace), std::path::Path::new(&trusted_suite),
                &candidate, &repo_id, &policy, &environment,
            )?;
            serde_json::json!({ "schema_version": 1, "evidence": result.evidence, "payload": result.payload, "receipt": result.receipt })
        }
        Request::EvaluateObjects {
            broker_endpoint,
            read_capability,
            scope,
            candidate_spec,
            sources,
            trusted_suite,
            policy,
        } => {
            let repo_id = scope.repo_id.clone();
            let broker = klocgit_engine::git::objects::broker::BrokerSource::new(
                broker_endpoint,
                read_capability,
                scope,
            )?;
            let observed: Vec<_> = sources
                .iter()
                .map(|source| klocgit_engine::git::objects::ObjectFuture {
                    state: &source.state,
                    revision: &source.revision,
                    effects: &source.effects,
                    objects: &broker,
                })
                .collect();
            let workspace = klocgit_engine::git::workspace::materialize_from_objects(
                &candidate_spec,
                &broker,
                &repo_id,
                &observed,
                klocgit_engine::git::Limits::default(),
                klocgit_engine::git::workspace::HydrationBudget {
                    max_blob_bytes: 16 * 1024 * 1024,
                    max_total_bytes: 64 * 1024 * 1024,
                },
                klocgit_engine::contracts::MaterializationRecord {
                    executor_id: "sandbox-host".into(),
                    materialized_at: String::new(),
                    conflicts_encountered: vec![],
                },
            )?;
            let result = klocgit_engine::sandbox::evaluate(
                workspace.path(),
                std::path::Path::new(&trusted_suite),
                &workspace.candidate,
                &repo_id,
                &policy,
            )?;
            serde_json::json!({
                "schema_version": 1, "candidate": workspace.candidate, "evidence": result.evidence,
                "payload": result.payload, "receipt": result.receipt,
                "hydrated_bytes": workspace.bytes_hydrated, "hydrated_files": workspace.files_hydrated,
            })
        }
        Request::EvaluateCandidate {
            base_repository,
            repo_id,
            candidate_spec,
            sources,
            trusted_suite,
            policy,
        } => evaluate_candidate(
            base_repository,
            repo_id,
            candidate_spec,
            sources,
            trusted_suite,
            policy,
        )?,
        Request::Evaluate {
            workspace,
            trusted_suite,
            candidate,
            repo_id,
            policy,
        } => {
            let result = klocgit_engine::sandbox::evaluate(
                std::path::Path::new(&workspace),
                std::path::Path::new(&trusted_suite),
                &candidate,
                &repo_id,
                &policy,
            )?;
            serde_json::json!({ "schema_version": 1, "evidence": result.evidence, "payload": result.payload, "receipt": result.receipt })
        }
        Request::Analyze {
            future_revision_id,
            language,
            changes,
        } => serde_json::to_value(analyze(
            &future_revision_id,
            language,
            &changes,
            Limits::default(),
        ))?,
        Request::Reduce {
            base_revisions,
            futures,
            budget,
        } => serde_json::to_value(reduction::reduce(&base_revisions, &futures, budget)?)?,
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
