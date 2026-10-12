use klocgit_engine::contracts::*;
use klocgit_engine::extractors::{analyze, Limits, SourceChange};
use klocgit_engine::reduction::{reduce, Budget, InputFuture};
use std::collections::BTreeMap;

fn budget() -> Budget {
    Budget { max_candidates: 16, max_futures: 100, max_footprint_entries: 1000, max_output_bytes: 1_000_000 }
}

fn future(actor: &str, tree: char, path: &str, value: u32) -> InputFuture {
    let state = CanonicalFutureRevisionState {
        repo_id: "repo".into(), commit_oid: format!("{value:040x}"),
        tree_oid: tree.to_string().repeat(40), parent_oids: vec!["a".repeat(40)],
    };
    let mut revision = FutureRevision {
        canonical: CanonicalFutureRevisionRecord {
            state_digest: String::new(), system_id: "product".into(), r#ref: format!("refs/futures/{actor}/task"),
            producer: Producer { actor_id: actor.into(), agent_version: None, task_id: None, prompt_digest: None },
        }, id: String::new(), record_digest: String::new(), observed_at: "2026-01-01T00:00:00Z".into(),
    };
    revision.seal(&state).unwrap();
    let effects = analyze(&revision.id, Language::Typescript, &[SourceChange {
        path: path.into(), before: Some(String::new()), after: Some(format!("export function Public() {{ return {value}; }}")),
    }], Limits::default());
    InputFuture { state, revision, effects, changed_paths: vec![path.into()], required_future_ids: vec![] }
}

#[test]
fn five_futures_reduce_to_two_compositions_without_losing_histories() {
    let inputs = [
        future("a", 'b', "retry.ts", 1), future("duplicate", 'b', "retry.ts", 1),
        future("alternative", 'c', "retry.ts", 3),
        future("telemetry", 'd', "telemetry.ts", 4), future("security", 'e', "auth.ts", 5),
    ];
    let bases = BTreeMap::from([("repo".into(), "a".repeat(40))]);
    let result = reduce(&bases, &inputs, budget()).unwrap();
    assert_eq!(result.status, AnalysisStatus::Complete);
    assert_eq!(result.candidate_specs.len(), 2);
    assert_eq!(result.groups.iter().map(|group| group.duplicate_members.values().map(Vec::len).sum::<usize>()).sum::<usize>(), inputs.len());
    for spec in result.candidate_specs {
        assert_eq!(spec.selected_future_revisions.len(), 3);
        assert!(spec.composition_manifest.iter().any(|slice| slice.path == "auth.ts"));
        assert!(spec.composition_manifest.iter().any(|slice| slice.path == "telemetry.ts"));
    }
}

#[test]
fn input_order_and_observation_time_do_not_change_reduction_identity() {
    let mut inputs = vec![future("a", 'b', "a.ts", 1), future("b", 'c', "b.ts", 2)];
    let bases = BTreeMap::from([("repo".into(), "a".repeat(40))]);
    let forward = reduce(&bases, &inputs, budget()).unwrap();
    inputs.reverse();
    inputs[0].revision.observed_at = "later".into();
    assert_eq!(forward.reduction_digest, reduce(&bases, &inputs, budget()).unwrap().reduction_digest);
}

#[test]
fn a_structural_signature_does_not_collapse_distinct_trees() {
    let mut a = future("a", 'b', "api.ts", 1);
    let mut b = future("b", 'c', "api.ts", 2);
    b.effects.canonical.modified_exports = a.effects.modified_exports.clone();
    b.effects.seal().unwrap();
    a.effects.seal().unwrap();
    let result = reduce(&BTreeMap::from([("repo".into(), "a".repeat(40))]), &[a, b], budget()).unwrap();
    assert_eq!(result.candidate_specs.len(), 2);
    assert_eq!(result.groups[0].effect_clusters.len(), 1);
    assert_eq!(result.groups[0].alternatives.len(), 2);
}

#[test]
fn missing_dependency_and_incomplete_analysis_remain_partial() {
    let mut a = future("a", 'b', "api.ts", 1);
    a.required_future_ids.push("unobserved".into());
    let bases = BTreeMap::from([("repo".into(), "a".repeat(40))]);
    let result = reduce(&bases, &[a.clone()], budget()).unwrap();
    assert_eq!(result.status, AnalysisStatus::Partial);
    assert!(result.candidate_specs.is_empty());
    a.required_future_ids.clear();
    a.effects.canonical.status = AnalysisStatus::Partial;
    a.effects.seal().unwrap();
    assert_eq!(reduce(&bases, &[a], budget()).unwrap().status, AnalysisStatus::Partial);
}

#[test]
fn candidate_budget_defers_work_without_deleting_its_alternative() {
    let a = future("a", 'b', "api.ts", 1);
    let b = future("b", 'c', "api.ts", 2);
    let result = reduce(&BTreeMap::from([("repo".into(), "a".repeat(40))]), &[a, b], Budget { max_candidates: 1, ..budget() }).unwrap();
    assert_eq!(result.status, AnalysisStatus::Partial);
    assert_eq!(result.candidate_specs.len(), 1);
    assert_eq!(result.groups[0].alternatives.len(), 2);
    assert_eq!(result.deferred_future_ids.len(), 1);
}

#[test]
fn substituted_effects_and_resource_budgets_are_rejected() {
    let mut a = future("a", 'b', "api.ts", 1);
    let bases = BTreeMap::from([("repo".into(), "a".repeat(40))]);
    assert!(reduce(&bases, &[a.clone()], Budget { max_footprint_entries: 0, ..budget() }).is_err());
    a.effects.canonical.modified_exports.push("unbound".into());
    assert!(reduce(&bases, &[a], budget()).is_err());
}
