import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createDemo} from './demo.mjs';
import {git} from '../server/git.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'converge-report-v2-'));
try {
  const {engine, state, adapter} = await createDemo(root, async () => {}, {actor: 'explicit-verification-context-actor'});
  const before = await engine.view();
  const first = state.decisionComponents.find(component => component.edges.some(edge => edge.type === 'alternative'));
  const second = state.decisionComponents.find(component => component.edges.some(edge => edge.type === 'conflicts_with'));
  assert.ok(first && second); assert.equal(state.decisionComponents.length, 2);
  const interaction = state.evidence.find(evidence => evidence.type === 'composed-interaction');
  assert.equal(interaction.result.passed, false);
  assert.equal(interaction.result.observations.lostResponse.charges, 1);
  assert.equal(interaction.result.observations.lostResponse.confirmations, 2);
  assert.ok(interaction.individual_evidence_ids.every(id => state.evidence.find(evidence => evidence.id === id).result.passed));
  async function resolve(component) {
    const option = component.alternatives.find(candidate => candidate.validation === 'passed' && candidate.revision_ids.some(id => engine.revision(id).context_binding_state === 'bound'))
      ?? component.alternatives.find(candidate => candidate.validation === 'passed');
    assert.ok(option);
    return engine.serial(() => engine.resolve(component.id, {alternative_id: option.id, basis_hash: component.basis_hash,
      expected_canonical_head: component.canonical_head_seen, rationale: 'Keep one charge and one confirmation while applying the explicitly answered retry policy.'}, 'verified-demo-owner'));
  }
  await resolve(first); await assert.rejects(() => resolve(second), error => error.code === 'DECISION_STALE');
  const stale = (await engine.view()).summary.staleEvidence;
  const refreshed = await engine.serial(() => engine.refreshDecision(second.id)); await resolve(refreshed);
  let finalValidation;const canonicalVersions=[];
  for (const repo of state.repositories) {
    const destination = path.join(root, 'clones', repo.id); await mkdir(path.dirname(destination), {recursive: true});
    await git(root, ['clone', '--quiet', adapter.dir(repo), destination]);
    assert.equal(await git(destination, ['rev-parse', 'HEAD']), repo.head); await git(destination, ['fsck', '--full']);canonicalVersions.push({repo:repo.id,head_commit:repo.head,tree_hash:await git(destination,['rev-parse','HEAD^{tree}'])});
    if (repo.validation_profile === 'checkout-effects-v2') {
      finalValidation = await adapter.validate(repo, repo.head, state.constraints, Object.fromEntries(state.repositories.map(item => [item.id, item.head])));
      assert.equal(finalValidation.passed, true);
    }
  }
  const report = {generated_at: new Date().toISOString(), scope: 'Local ordinary Git repositories and sandboxed real HTTP application; live Cloudflare behavior is separate and unverified.',
    candidate_proposals: state.proposals.length, concurrent_producers: state.workspace.producers.length, repositories: state.repositories.length,
    human_decisions_required: before.summary.decisionsRequired, decision_compression_ratio: before.summary.compressionRatio, metric_scope: 'Downstream review decisions; the preceding clarification is reported separately.', context_clarifications: state.tasks.filter(t=>t.question&&t.authorization).length, total_human_inputs: before.summary.decisionsRequired+state.tasks.filter(t=>t.question&&t.authorization).length,
    grouping: 'Derived from declared competing choices and an observed exact composed-pair failure; no authored decision components.',
    automatic_actions_later_reversed: state.metrics.automaticReversals,
    incorrect_duplicate_classifications: state.relationships.filter(relationship => relationship.type === 'implementation_equivalent').length === 1 ? 0 : 1,
    stale_evidence_accepted: state.metrics.staleEvidenceAccepted, canonical_CAS_failures_handled: state.metrics.casFailures,
    previously_valid_evidence_now_stale: stale, producer_intent_traceability: before.summary.traceableRationale,
    analysis_latency_ms: state.metrics.analysisLatencyMs, relationship_comparisons: state.metrics.comparisons,
    relationship_comparisons_avoided: before.summary.comparisonsAvoided, resolved_decisions: state.operations.filter(operation => operation.status === 'applied').length,
    settled_revision_histories: new Set(state.dispositions.map(disposition => disposition.revision_id)).size,
    ordinary_git_clone_and_fsck: 'passed',
    semantic_interaction: {isolated_candidates: 'both pass', git_composition: 'textually clean',
      rejected_pair: interaction.result.observations.lostResponse, resolved_canonical: finalValidation.observations.lostResponse},
    context_before_code: {questions: 1, retrieved_repository: state.tasks[0].source.repo, answered_by: 'explicit-verification-context-actor',
      selected_context_answer_refs: state.decisions.flatMap(decision => decision.context_answer_refs)},
    immutable_inputs:{canonical_repositories:canonicalVersions,interaction:{evidence_id:interaction.id,subject_versions:interaction.subject_versions,composition_ref:interaction.composition_ref,resulting_tree:interaction.tree_hash,config_hash:interaction.config_hash,validity_heads:interaction.validity_heads,baseline_evidence_id:interaction.baseline_evidence_id,individual_evidence_ids:interaction.individual_evidence_ids},context_source:state.tasks[0].source,context_snapshot_id:state.tasks[0].snapshot.id,decision_ids:state.operations.filter(o=>o.status==='applied').map(o=>o.decision_id)},limits: finalValidation.limitations};
  assert.equal(report.settled_revision_histories, 8);
  await writeFile(new URL('../docs/demo-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {await rm(root, {recursive: true, force: true});}
