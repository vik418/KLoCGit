import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDemo, produceWork} from '../scripts/demo.mjs';
import {Engine, emptyState} from '../core/engine.mjs';
import {git} from '../server/git.mjs';
import {record, DomainError} from '../core/hash.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'converge-test-v2-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return {...await createDemo(root, async () => {}, {...options, actor: 'explicit-acceptance-test-actor'}), root};
}
const architecture = state => state.decisionComponents.find(component => component.edges?.some(edge => edge.type === 'alternative') && component.status === 'open');
const interaction = state => state.decisionComponents.find(component => component.edges?.some(edge => edge.type === 'conflicts_with') && component.status === 'open');
function selection(engine, component) {
  return component.alternatives.find(option => option.validation === 'passed' && option.revision_ids.some(id => engine.revision(id).context_binding_state === 'bound'))
    ?? component.alternatives.find(option => option.validation === 'passed');
}
function input(engine, component, option = selection(engine, component)) {
  assert.ok(option, 'The reviewed decision must have an applicable, passing alternative');
  return {alternative_id: option.id, basis_hash: component.basis_hash, expected_canonical_head: component.canonical_head_seen,
    rationale: 'Follow the retrieved exactly-once policy and retain the selected retry behavior.'};
}
const resolve = (engine, component) => engine.serial(() => engine.resolve(component.id, input(engine, component), 'acceptance-owner'));

function abstractWork({textualConflict = false} = {}) {
  const state = emptyState();
  state.repositories.push({id: 'arbitrary-service', head: 'base-head', baseline: 'base-head', canonical_ref: 'refs/heads/main'});
  state.contexts.push({id: 'context', items: []});
  for (const name of ['one', 'two']) {
    state.proposals.push({id: `proposal-${name}`, repo: 'arbitrary-service', ref: `refs/heads/${name}`, title: `${name} unrelated intent`});
    state.revisions.push({id: `revision-${name}`, proposal_id: `proposal-${name}`, repo: 'arbitrary-service', head_commit: `head-${name}`,
      base_commit: 'base-head', tree_hash: `tree-${name}`, context_version: 'context', affected_scope: [`${name}.mjs`], provenance_state: 'declared', context_binding_state: 'unknown'});
    state.refVersions[`arbitrary-service:refs/heads/${name}`] = `head-${name}`;
  }
  const adapter = {configHash: 'platform-config', ref: async () => state.repositories[0].head,
    facts: async (_repo, head) => ({head, base: head, tree: `tree-${head}`, scope: []}),
    suitesForScope: () => ['trusted-suite'],
    validate: async () => ({passed: true, checks: [{name: 'Finite trusted case', passed: true, detail: 'Only this finite case passed.'}]}),
    compose: async (_repo, head, revisions) => {
      if (textualConflict && revisions.length > 1) throw new DomainError('COMPOSITION_CONFLICT', 'A real Git conflict requires review', 422);
      return {baseTree: `tree-${head}`, tree: `composed-tree-${head}-${revisions.map(revision => revision.id).sort().join('-')}`,
        commit: `candidate-${head}-${revisions.map(revision => revision.id).sort().join('-')}`};
    }};
  return {engine: new Engine(state, adapter), state, adapter};
}

test('five concurrent producers derive two decisions from eight ordinary Git proposals without predefined groups', async t => {
  const {engine, state} = await fixture(t); const view = await engine.view();
  assert.equal(state.workspace.producers.length, 5); assert.equal(state.proposals.length, 8);
  assert.equal(view.summary.decisionsRequired, 2); assert.equal(view.summary.compressionRatio, .25);
  assert.equal(view.summary.conventionalReview, 0);
  assert.ok(state.decisionComponents.every(component => component.derived && component.graph_hash));
  assert.equal(architecture(state).revision_ids.length, 2); assert.equal(interaction(state).revision_ids.length, 2);
  assert.ok(state.decisionComponents.every(component => component.edges.length === 1));
  const identical = state.relationships.filter(relationship => relationship.type === 'implementation_equivalent');
  assert.equal(identical.length, 1);
  assert.notEqual(engine.revision(identical[0].from_revision).proposal_id, engine.revision(identical[0].to_revision).proposal_id);
  assert.ok(view.summary.comparisonsAvoided > 0); assert.equal(view.summary.traceableRationale, .875);
});

test('A and B pass independently; their textually merged real HTTP application produces duplicate confirmations', async t => {
  const {engine, state} = await fixture(t); const component = interaction(state);
  const proof = state.evidence.find(evidence => evidence.type === 'composed-interaction');
  assert.ok(proof); assert.equal(proof.result.passed, false); assert.equal(proof.subject_versions.length, 2);
  assert.deepEqual(proof.subject_revision_ids, [...component.revision_ids].sort());
  const composition = state.compositions.find(candidate => candidate.id === proof.composition_ref);
  assert.ok(composition); assert.equal(composition.resulting_tree, proof.tree_hash);
  for (const evidenceId of proof.individual_evidence_ids) {
    const individual = state.evidence.find(evidence => evidence.id === evidenceId);
    assert.equal(individual.result.passed, true); assert.equal(engine.evidenceValidity(individual).status, 'current');
  }
  assert.equal(proof.result.observations.lostResponse.charges, 1);
  assert.equal(proof.result.observations.lostResponse.confirmations, 2);
  assert.equal(proof.result.observations.lostResponse.suppressedResponses, 1);
  assert.equal(proof.result.observations.lostResponse.attempts, 2);
  assert.equal(proof.result.isolation.producerTestsExecuted, false);
  assert.ok(proof.result.limitations.length > 0);
});

test('unknown provenance stays outside blocking components and is included only in explicit reviewed compositions', async t => {
  const {state} = await fixture(t); const unknown = state.revisions.filter(revision => revision.provenance_state === 'unknown');
  assert.equal(unknown.length, 1); assert.ok(unknown[0].affected_scope.every(filename => filename.endsWith('.md')));
  assert.ok(state.discovery.ungrouped_revision_ids.includes(unknown[0].id));
  for (const component of state.decisionComponents) {
    assert.ok(!component.revision_ids.includes(unknown[0].id));
    assert.ok(component.supplemental_revision_ids.includes(unknown[0].id));
    assert.ok(component.included.some(description => description.includes('unknown provenance')));
    assert.ok(component.alternatives.every(option => option.composed_revision_ids.includes(unknown[0].id)));
  }
});

test('context question precedes producer work and its one answer survives proposal, decision and exact code provenance', async t => {
  const {engine, state, root} = await fixture(t, {pending: true});
  assert.equal(state.proposals.length, 0); const preparation = state.tasks[0];
  assert.ok(preparation.question); assert.equal(preparation.source.repo, 'payment-policy');
  assert.equal(preparation.source.commit, engine.repo('payment-policy').head);
  await assert.rejects(() => produceWork(engine, root), error => error.code === 'CONTEXT_REQUIRED');
  const answered = await engine.resolveTask(preparation.task.id, {value: true}, 'explicit-context-answer-actor');
  await produceWork(engine, root);
  const bound = state.revisions.find(revision => revision.context_binding_state === 'bound');
  assert.ok(bound); assert.equal(bound.context_answer_ref, answered.snapshot.answer_ref);
  assert.equal(bound.context_version, answered.snapshot.id);
  const component = interaction(state); await resolve(engine, component);
  const decision = state.decisions.at(-1);
  assert.ok(decision.proposal_revision_ids.includes(bound.id));
  assert.ok(decision.context_refs.includes(answered.snapshot.id)); assert.ok(decision.context_answer_refs.includes(answered.snapshot.answer_ref));
  const repo = engine.repo(bound.repo), artifact = JSON.parse(await engine.git.file(repo, repo.head, '.converge/context.json'));
  assert.equal(artifact.context_snapshot_id ?? artifact.context_version, answered.snapshot.id);
});

test('both derived decisions resolve after renewed review; ordinary clones run the bounded HTTP application', async t => {
  const {engine, state, adapter, root} = await fixture(t); const first = architecture(state), second = interaction(state);
  await resolve(engine, first); assert.equal((await engine.view()).decisionComponents.find(component => component.id === second.id).stale, true);
  await assert.rejects(() => resolve(engine, second), error => error.code === 'DECISION_STALE');
  const refreshed = await engine.serial(() => engine.refreshDecision(second.id)); await resolve(engine, refreshed);
  assert.equal((await engine.view()).summary.decisionsRequired, 0);
  for (const repo of state.repositories) {
    const destination = path.join(root, 'verify', repo.id); await mkdir(path.dirname(destination), {recursive: true});
    await git(root, ['clone', '--quiet', adapter.dir(repo), destination]); assert.equal(await git(destination, ['rev-parse', 'HEAD']), repo.head); await git(destination, ['fsck', '--full']);
    if (repo.id === 'checkout-api') {
      const result = await adapter.validate(repo, repo.head, state.constraints, Object.fromEntries(state.repositories.map(item => [item.id, item.head])));
      assert.equal(result.passed, true); assert.equal(result.observations.lostResponse.charges, 1); assert.equal(result.observations.lostResponse.confirmations, 1);
    }
  }
  assert.equal(state.metrics.staleEvidenceAccepted, 0); assert.equal(state.operations.filter(operation => operation.status === 'applied').length, 2);
  assert.equal(new Set(state.dispositions.map(disposition => disposition.revision_id)).size, 8);
});

test('renamed branches and reversed arrival order derive the same decision structure and independent histories', async t => {
  const first = await fixture(t); const second = await fixture(t, {renameBranches: true, ingestionOrder: [7, 6, 5, 4, 3, 2, 1, 0]});
  const signature = state => state.decisionComponents.map(component => ({
    kinds: component.edges.map(edge => edge.type).sort(),
    titles: component.revision_ids.map(id => state.proposals.find(proposal => proposal.id === state.revisions.find(revision => revision.id === id).proposal_id).title).sort(),
    options: component.alternatives.map(option => option.title).sort(), supplemental: component.supplemental_revision_ids.length
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(signature(first.state), signature(second.state));
  assert.equal(second.state.proposals.length, 8); assert.equal((await second.engine.view()).summary.compressionRatio, .25);
});

test('canonical movement makes previous evidence stale and rejects an obsolete decision with 409', async t => {
  const {engine, state, adapter} = await fixture(t); const before = structuredClone(architecture(state));
  await adapter.externalAdvance(engine.repo('checkout-api')); const head = await adapter.ref(engine.repo('checkout-api'), 'refs/heads/main');
  await assert.rejects(() => resolve(engine, before), error => error.code === 'DECISION_STALE' && error.status === 409);
  assert.equal(await adapter.ref(engine.repo('checkout-api'), 'refs/heads/main'), head);
  assert.ok((await engine.view()).summary.staleEvidence > 0); assert.equal(state.metrics.casFailures, 1);
});

test('constraint version change invalidates evidence eligibility and the reviewed decision basis', async t => {
  const {engine, state} = await fixture(t); const before = structuredClone(architecture(state));
  const constraint = await record('constraint', {statement: 'A changed finite constraint', kind: 'checkable', version: 2, scope: ['checkout-api'], check_ref: 'trusted-new'});
  state.constraints.push({...constraint, active: true}); assert.equal(engine.evidenceValidity(state.evidence[0]).status, 'stale');
  await assert.rejects(() => resolve(engine, before), error => error.code === 'DECISION_STALE');
});

test('duplicate and out-of-order Git events cannot replace the authoritative producer head', async t => {
  const {engine, state, specs} = await fixture(t); const spec = specs[0], event = {repo: spec.repo, ref: `refs/heads/${spec.key}`, after: spec.head};
  const count = state.revisions.length; assert.equal((await engine.ingest(event)).duplicate, true); assert.equal(state.revisions.length, count);
  const other = specs.find(candidate => candidate.head !== spec.head);
  assert.equal((await engine.ingest({...event, after: other.head})).reason, 'OUT_OF_ORDER_EVENT');
  assert.equal(state.refVersions[`${spec.repo}:${event.ref}`], spec.head);
});

test('force push produces a new immutable revision; ABA restores the old pointer without deleting history', async t => {
  const {engine, state, specs, adapter} = await fixture(t); const spec = specs[0], repo = engine.repo(spec.repo), ref = `refs/heads/${spec.key}`;
  const tree = await git(adapter.dir(repo), ['rev-parse', `${spec.head}^{tree}`]);
  const newHead = await git(adapter.dir(repo), ['commit-tree', tree, '-p', repo.baseline, '-m', 'A producer rebase with the same tree']);
  await git(adapter.dir(repo), ['update-ref', ref, newHead, spec.head]);
  const result = await engine.ingest({repo: repo.id, ref, after: newHead}); assert.ok(result.revision_id); assert.notEqual(result.revision_id, spec.revision); assert.equal(state.revisions.length, 9);
  await git(adapter.dir(repo), ['update-ref', ref, spec.head, newHead]); assert.equal((await engine.ingest({repo: repo.id, ref, after: spec.head})).duplicate, true);
  assert.equal(state.refVersions[`${repo.id}:${ref}`], spec.head); assert.equal(state.revisions.length, 9);
});

test('new active proposal invalidates a reviewed basis even when changed paths are disjoint', async t => {
  const {engine, state} = await fixture(t); const component = architecture(state), before = await engine.basis(component);
  const revision = await record('rev', {proposal_id: 'new-proposal', repo: 'checkout-api', head_commit: 'new-head', context_version: 'new-context', affected_scope: ['different.txt']});
  state.proposals.push({id: 'new-proposal', ref: 'refs/heads/new'}); state.revisions.push(revision); state.refVersions['checkout-api:refs/heads/new'] = 'new-head';
  assert.notEqual(await engine.basis(component), before);
});

test('external Git push during write-ahead persistence defeats canonical CAS against the captured OID', async t => {
  const {engine, state, adapter} = await fixture(t); const component = architecture(state); let external;
  engine.save = async () => {if (!external && state.operations.some(operation => operation.status === 'prepared')) {external = await adapter.externalAdvance(engine.repo('checkout-api')); await engine.syncHeads();}};
  await assert.rejects(() => resolve(engine, component), error => error.code === 'DECISION_STALE');
  assert.equal(await adapter.ref(engine.repo('checkout-api'), 'refs/heads/main'), external); assert.equal(state.operations[0].status, 'cas-failed');
  assert.equal(state.dispositions.length, 0);
});

test('serialized concurrent resolution requests advance Git at most once', async t => {
  const {engine, state} = await fixture(t); const component = structuredClone(architecture(state));
  const results = await Promise.allSettled([resolve(engine, component), resolve(engine, component)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(state.operations.filter(operation => operation.status === 'applied').length, 1);
});

test('crash after Git CAS restores exact dispositions idempotently and never reopens applied work', async t => {
  const {engine, state, adapter} = await fixture(t); const component = architecture(state); let durable;
  engine.save = async current => {
    if (current.operations.some(operation => operation.status === 'prepared')) durable = structuredClone(current);
    if (current.operations.some(operation => operation.status === 'applied')) throw new Error('Simulated crash before final persistence receipt');
  };
  await assert.rejects(() => resolve(engine, component)); assert.ok(durable);
  const recovery = new Engine(durable, adapter); await recovery.recover();
  const operation = durable.operations[0], decision = durable.decisions.find(record => record.id === operation.decision_id);
  assert.equal(operation.status, 'applied'); assert.equal(recovery.component(component.id).status, 'resolved');
  for (const id of decision.proposal_revision_ids) assert.ok(durable.dispositions.some(disposition => disposition.revision_id === id && disposition.status === 'applied'));
  for (const id of decision.deferred_revision_ids) assert.ok(durable.dispositions.some(disposition => disposition.revision_id === id && disposition.status === 'deferred'));
  const count = durable.dispositions.length; await recovery.recover(); assert.equal(durable.dispositions.length, count);
  await recovery.analyzeWork(); assert.equal(recovery.component(component.id).status, 'resolved');
  assert.equal(durable.operations.filter(candidate => candidate.status === 'applied').length, 1);
});

test('unauthenticated actors or forged producer evidence cannot advance the canonical ref', async t => {
  const {engine, state} = await fixture(t); const component = architecture(state);
  await assert.rejects(() => engine.resolve(component.id, input(engine, component), null), error => error.status === 401);
  const option = selection(engine, component), evidenceId = option.evidence_ids[0];
  state.evidence = state.evidence.map(evidence => evidence.id === evidenceId ? {...evidence, source: 'producer-supplied tests'} : evidence);
  component.basis_hash = await engine.basis(component);
  await assert.rejects(() => resolve(engine, component), error => error.code === 'VALIDATION_REQUIRED');
});

test('a merge failure cannot become passing composition evidence', async t => {
  const {engine} = await fixture(t); engine.git.compose = async () => ({conflict: true, commit: 'unsafe-fallback', tree: 'baseline'});
  await assert.rejects(() => engine.compose('checkout-api', [engine.state.revisions[0].id]), error => error.code === 'COMPOSITION_CONFLICT');
});

test('all audit records remain content addressed and chained through concurrent work', async t => {
  const {state} = await fixture(t);
  for (let index = 1; index < state.audit.length; index++) assert.equal(state.audit[index].previous, state.audit[index - 1].id);
  for (const entry of state.audit) {const {id, ...data} = entry; assert.equal((await record('audit', data)).id, id);}
});

test('canonical Git events refresh observations rather than manufacture a producer proposal', async t => {
  const {engine, state, adapter} = await fixture(t); const count = state.proposals.length;
  const head = await adapter.externalAdvance(engine.repo('checkout-api'));
  const result = await engine.ingest({repo: 'checkout-api', ref: 'refs/heads/main', after: head});
  assert.equal(result.canonical, true); assert.equal(state.proposals.length, count); assert.equal(engine.repo('checkout-api').head, head);
});

test('passing independent-only work remains explicit pending review when no decision composition includes it', async () => {
  const {engine, state} = abstractWork(); const view = await engine.analyzeWork();
  assert.equal(state.repositories[0].head, 'base-head');
  assert.ok(view.summary.decisionsRequired > 0 || view.summary.conventionalReview > 0, 'Pending independent code cannot be described as zero total review');
  assert.ok(view.summary.compressionRatio > 0, 'Unreviewed work cannot silently achieve zero decision compression');
});

test('a textually conflicting pair stays visible and cannot be labeled independent supplemental work', async () => {
  const {engine, state} = abstractWork({textualConflict: true}); const view = await engine.analyzeWork();
  const blockers = state.decisionComponents.flatMap(component => component.revision_ids);
  const conventional = state.discovery.conventional_review_ids ?? [];
  assert.ok(state.revisions.every(revision => blockers.includes(revision.id) || conventional.includes(revision.id)));
  assert.ok(view.summary.decisionsRequired > 0 || view.summary.conventionalReview > 0);
  assert.ok(!(state.discovery.supplemental_revision_ids ?? []).includes('revision-one'));
  assert.ok(!(state.discovery.supplemental_revision_ids ?? []).includes('revision-two'));
});

test('unknown executable work adds conventional review and is never hidden by a passing decision group', async () => {
  const {engine, state} = abstractWork();
  state.relationships.push({id: 'declared-alternative', from_revision: 'revision-one', to_revision: 'revision-two', type: 'alternative', basis: 'declared', evidence_refs: []});
  state.proposals.push({id: 'unknown-proposal', repo: 'arbitrary-service', ref: 'refs/heads/unknown', title: 'Unattributed behavior'});
  state.revisions.push({id: 'unknown-revision', proposal_id: 'unknown-proposal', repo: 'arbitrary-service', head_commit: 'unknown-head', base_commit: 'base-head',
    tree_hash: 'unknown-tree', context_version: 'context', affected_scope: ['behavior.mjs'], provenance_state: 'unknown', context_binding_state: 'unknown'});
  state.refVersions['arbitrary-service:refs/heads/unknown'] = 'unknown-head';
  const view = await engine.analyzeWork();
  assert.ok(state.discovery.conventional_review_ids.includes('unknown-revision'));
  assert.ok(!state.discovery.supplemental_revision_ids.includes('unknown-revision'));
  assert.ok(state.decisionComponents.every(component => !component.revision_ids.includes('unknown-revision') && !component.supplemental_revision_ids.includes('unknown-revision')));
  assert.equal(view.summary.graphDecisions, 1); assert.equal(view.summary.decisionsRequired, 2); assert.equal(view.summary.conventionalReview, 1);
  assert.equal(view.summary.compressionRatio, 2 / 3);
});

test('new pair-failure proofs use isolated candidates on the same canonical base', async t => {
  const {engine, state, specs, adapter} = await fixture(t); const repo = engine.repo('checkout-api');
  const confirmation = specs.find(spec => spec.change === 'confirmation-before-dedupe');
  const externallyApplied = await adapter.compose(repo, repo.head, [engine.revision(confirmation.revision)]);
  assert.equal(await adapter.cas(repo, repo.head, externallyApplied.commit), true); await engine.syncHeads();
  const installedHead = repo.head; await engine.analyzeWork({refresh: true});
  const newProofs = state.evidence.filter(evidence => evidence.type === 'composed-interaction' && evidence.validity_heads?.['checkout-api'] === installedHead);
  assert.equal(newProofs.length, 0, 'Retry alone already interacts with the external canonical confirmation change; it is not evidence that two individually safe candidates conflict');
});

test('fresh failing pair evidence supersedes stale proof applicability without deleting historical evidence', async t => {
  const {engine, state, adapter} = await fixture(t); const component = interaction(state);
  const originalProof = state.evidence.find(evidence => evidence.type === 'composed-interaction');
  await adapter.externalAdvance(engine.repo('checkout-api'));
  const refreshed = await engine.refreshDecision(component.id);
  assert.ok(state.evidence.some(evidence => evidence.id === originalProof.id)); assert.equal(engine.evidenceValidity(originalProof).status, 'stale');
  assert.ok(refreshed.edges.some(edge => edge.classification === 'observed-interaction'));
  assert.equal(refreshed.basis_stale, false, 'A current exact replacement proof must not be obscured by stale historical versions');
});
