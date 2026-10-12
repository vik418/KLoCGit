use klocgit_engine::contracts::Language;
use klocgit_engine::extractors::{analyze, Limits, SourceChange};
use klocgit_engine::reduction::{self, Budget, InputFuture};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Analyze { future_revision_id: String, language: Language, changes: Vec<SourceChange> },
    Reduce { base_revisions: BTreeMap<String, String>, futures: Vec<InputFuture>, budget: Budget },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    let max_bytes = 32 * 1024 * 1024;
    io::stdin().take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes { return Err("engine input exceeds limit".into()); }
    let input: Request = serde_json::from_slice(&bytes)?;
    let output = match input {
        Request::Analyze { future_revision_id, language, changes } => serde_json::to_value(analyze(&future_revision_id, language, &changes, Limits::default()))?,
        Request::Reduce { base_revisions, futures, budget } => serde_json::to_value(reduction::reduce(&base_revisions, &futures, budget)?)?,
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
