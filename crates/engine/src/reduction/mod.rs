use crate::canonical;
use crate::contracts::{
    AnalysisStatus, CandidateSpec, CanonicalCandidateSpec, CanonicalFutureRevisionState, EffectSet,
    FutureRevision, ProvenanceSlice, Selector, SelectorType,
};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputFuture {
    pub state: CanonicalFutureRevisionState,
    pub revision: FutureRevision,
    pub effects: EffectSet,
    pub changed_paths: Vec<String>,
    pub required_future_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    pub max_candidates: usize,
    pub max_futures: usize,
    pub max_footprint_entries: usize,
    pub max_output_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    pub group_id: String,
    pub alternatives: Vec<String>,
    pub duplicate_members: BTreeMap<String, Vec<String>>,
    pub effect_clusters: BTreeMap<String, Vec<String>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReductionResult {
    pub schema_version: u32,
    pub groups: Vec<Group>,
    pub candidate_specs: Vec<CandidateSpec>,
    pub deferred_future_ids: Vec<String>,
    pub status: AnalysisStatus,
    pub reduction_digest: String,
}

struct Unit {
    index: usize,
    members: Vec<usize>,
    keys: BTreeSet<String>,
}

fn find(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        parents[index] = parents[parents[index]];
        index = parents[index];
    }
    index
}

fn union(parents: &mut [usize], a: usize, b: usize) {
    let a = find(parents, a);
    let b = find(parents, b);
    if a != b {
        parents[a.max(b)] = a.min(b);
    }
}

fn signature(effects: &EffectSet) -> Result<String> {
    // A structural signature is a search key, not behavioral equivalence.
    let mut normalized = effects.clone();
    normalized.seal()?;
    let effects = &normalized;
    canonical::hash_projection(
        "klocgit.effect-signature",
        &serde_json::json!({
            "extractor_id": effects.extractor_id,
            "extractor_version": effects.extractor_version,
            "capability": effects.capability,
            "status": effects.status,
            "modified_exports": effects.modified_exports,
            "added_dependencies": effects.added_dependencies,
            "db_migrations_detected": effects.db_migrations_detected,
            "security_effects": effects.security_effects,
        }),
    )
}

pub fn reduce(
    base_revisions: &BTreeMap<String, String>,
    inputs: &[InputFuture],
    budget: Budget,
) -> Result<ReductionResult> {
    if inputs.len() > budget.max_futures
        || budget.max_candidates == 0
        || budget.max_output_bytes == 0
        || base_revisions.is_empty()
    {
        return Err(Error::LimitExceeded("reduction budget"));
    }
    let mut ordered: Vec<_> = inputs.iter().collect();
    ordered.sort_by(|a, b| a.revision.id.cmp(&b.revision.id));
    let mut ids = BTreeMap::new();
    let mut exact = BTreeMap::<(String, String), usize>::new();
    let mut units: Vec<Unit> = Vec::new();
    let mut footprints = 0usize;
    let mut partial = false;
    for (index, input) in ordered.iter().enumerate() {
        input.revision.verify(&input.state)?;
        if !base_revisions.contains_key(&input.state.repo_id)
            || ids.insert(input.revision.id.clone(), index).is_some()
        {
            return Err(Error::InvalidInput(
                "duplicate or out-of-scope Future".into(),
            ));
        }
        let mut effects = input.effects.clone();
        effects.seal()?;
        if effects.effect_digest != input.effects.effect_digest
            || effects.future_revision_id != input.revision.id
        {
            return Err(Error::RevisionMismatch);
        }
        partial |= input.effects.status != AnalysisStatus::Complete;
        let mut keys = BTreeSet::new();
        for path in &input.changed_paths {
            if canonical::nfc(path) != *path
                || path.is_empty()
                || path.starts_with('/')
                || path.contains('\\')
                || path
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | ".."))
            {
                return Err(Error::InvalidInput("invalid changed path".into()));
            }
            keys.insert(format!("{}\0path\0{path}", input.state.repo_id));
        }
        for symbol in &input.effects.modified_exports {
            keys.insert(format!("{}\0symbol\0{symbol}", input.state.repo_id));
        }
        footprints = footprints
            .checked_add(keys.len())
            .ok_or(Error::LimitExceeded("footprint entries"))?;
        if footprints > budget.max_footprint_entries {
            return Err(Error::LimitExceeded("footprint entries"));
        }
        let key = (input.state.repo_id.clone(), input.state.tree_oid.clone());
        if let Some(&unit) = exact.get(&key) {
            units[unit].members.push(index);
            units[unit].keys.extend(keys);
        } else {
            exact.insert(key, units.len());
            units.push(Unit {
                index,
                members: vec![index],
                keys,
            });
        }
    }

    // Index each footprint once. Dense hubs do not create pairwise edges.
    let mut parents: Vec<_> = (0..units.len()).collect();
    let mut first_owner = BTreeMap::new();
    for (index, unit) in units.iter().enumerate() {
        for key in &unit.keys {
            if let Some(&owner) = first_owner.get(key) {
                union(&mut parents, index, owner);
            } else {
                first_owner.insert(key.clone(), index);
            }
        }
    }
    let mut components = BTreeMap::<usize, Vec<usize>>::new();
    for index in 0..units.len() {
        components
            .entry(find(&mut parents, index))
            .or_default()
            .push(index);
    }
    let mut groups = Vec::new();
    let mut choices = Vec::new();
    let mut member_unit = BTreeMap::new();
    for (unit_id, unit) in units.iter().enumerate() {
        for &member in &unit.members {
            member_unit.insert(ordered[member].revision.id.clone(), unit_id);
        }
    }
    for alternatives in components.values() {
        let mut duplicates = BTreeMap::new();
        let mut clusters = BTreeMap::<String, Vec<String>>::new();
        let mut revisions = Vec::new();
        for &unit in alternatives {
            let input = ordered[units[unit].index];
            revisions.push(input.revision.id.clone());
            duplicates.insert(
                input.revision.id.clone(),
                units[unit]
                    .members
                    .iter()
                    .map(|&i| ordered[i].revision.id.clone())
                    .collect(),
            );
            clusters
                .entry(signature(&input.effects)?)
                .or_default()
                .push(input.revision.id.clone());
        }
        let group_id = canonical::hash_projection("klocgit.reduction-group", &revisions)?;
        groups.push(Group {
            group_id,
            alternatives: revisions,
            duplicate_members: duplicates,
            effect_clusters: clusters,
        });
        choices.push(alternatives.clone());
    }

    let defaults: Vec<_> = choices.iter().map(|values| values[0]).collect();
    let mut plans = vec![defaults.clone()];
    for (group, values) in choices.iter().enumerate() {
        for &alternative in values.iter().skip(1) {
            if plans.len() >= budget.max_candidates {
                partial = true;
                break;
            }
            let mut plan = defaults.clone();
            plan[group] = alternative;
            plans.push(plan);
        }
    }

    let mut specs = Vec::new();
    let mut represented = BTreeSet::new();
    let mut output_bytes = 0usize;
    for plan in plans {
        let mut selected: BTreeSet<_> = plan.into_iter().collect();
        let mut pending: Vec<_> = selected.iter().copied().collect();
        let mut missing = false;
        while let Some(unit) = pending.pop() {
            // Preserve dependency requirements supplied for every duplicate history.
            for &member in &units[unit].members {
                for dependency in &ordered[member].required_future_ids {
                    if let Some(&required) = member_unit.get(dependency) {
                        if selected.insert(required) {
                            pending.push(required);
                        }
                    } else {
                        missing = true;
                    }
                }
            }
        }
        let mut used_keys = BTreeSet::new();
        for &unit in &selected {
            for key in &units[unit].keys {
                if !used_keys.insert(key.clone()) {
                    missing = true;
                }
            }
        }
        if missing {
            partial = true;
            continue;
        }
        let mut selected_revisions = Vec::new();
        let mut manifest = Vec::new();
        let mut effect_digests = BTreeSet::new();
        for &unit in &selected {
            let input = ordered[units[unit].index];
            selected_revisions.push(input.revision.id.clone());
            effect_digests.insert(input.effects.effect_digest.clone());
            for path in &input.changed_paths {
                manifest.push(ProvenanceSlice {
                    repo_id: input.state.repo_id.clone(),
                    path: path.clone(),
                    selector: Selector {
                        r#type: SelectorType::File,
                        value: path.clone(),
                    },
                    source_future_id: input.revision.id.clone(),
                    source_commit_oid: input.state.commit_oid.clone(),
                });
            }
        }
        if selected_revisions.is_empty() {
            continue;
        }
        let mut spec = CandidateSpec {
            canonical: CanonicalCandidateSpec {
                base_revisions: base_revisions.clone(),
                selected_future_revisions: selected_revisions,
                composition_manifest: manifest,
                creation_reason: "structural-composition".into(),
            },
            id: String::new(),
            spec_digest: String::new(),
            effect_summary_digest: canonical::hash_projection(
                "klocgit.effect-summary",
                &effect_digests,
            )?,
        };
        spec.seal()?;
        let bytes = serde_json::to_vec(&spec)?.len();
        if bytes > budget.max_output_bytes.saturating_sub(output_bytes) {
            partial = true;
            continue;
        }
        output_bytes += bytes;
        represented.extend(selected);
        specs.push(spec);
    }
    let deferred_future_ids: Vec<_> = units
        .iter()
        .enumerate()
        .filter(|(index, _)| !represented.contains(index))
        .flat_map(|(_, unit)| unit.members.iter().map(|&i| ordered[i].revision.id.clone()))
        .collect();
    partial |= !deferred_future_ids.is_empty();
    let status = if partial {
        AnalysisStatus::Partial
    } else {
        AnalysisStatus::Complete
    };
    let reduction_digest = canonical::hash_projection(
        "klocgit.reduction",
        &serde_json::json!({
            "schema_version": 1, "groups": groups, "spec_digests": specs.iter().map(|spec| &spec.spec_digest).collect::<Vec<_>>(),
            "deferred_future_ids": deferred_future_ids, "status": status,
        }),
    )?;
    Ok(ReductionResult {
        schema_version: 1,
        groups,
        candidate_specs: specs,
        deferred_future_ids,
        status,
        reduction_digest,
    })
}
