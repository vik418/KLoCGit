import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, emptyState } from '../core/engine.mjs';
import { DomainError, hash, record } from '../core/hash.mjs';
import { LocalGit, git } from '../server/git.mjs';

const ref = 'refs/heads/main';
const actor = 'owner';
const sorted = (values) => [...new Set(values)].sort();
const equalIds = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const oid = async (value) => (await hash(value)).slice(0, 40);

const appSource = [
  'export function checkout(client, server) {',
  '  const orders = new Set();',
  '  let attempts = 0;',
  '  let confirmations = 0;',
  '  let acknowledged = false;',
  '  for (;;) {',
  '    attempts++;',
  '    const seen = orders.has("order-1");',
  '    orders.add("order-1");',
  '    if (!seen || !server.deduplicateConfirmations) confirmations++;',
  '    if (attempts > 1) { acknowledged = true; break; }',
  '    // The first response is lost after the server committed its effects.',
  '    if (!client.retryFailedResponse || attempts >= 2) break;',
  '  }',
  '  return { attempts, confirmations, acknowledged };',
  '}',
  '',
].join('\n');

const baseFiles = () => ({
  'app.mjs': appSource,
  'client.json': JSON.stringify({ retryFailedResponse: false }),
  'server.json': JSON.stringify({ deduplicateConfirmations: true }),
  'trace.json': JSON.stringify({ enabled: false }),
  'metrics.json': JSON.stringify({ enabled: false }),
  'retention.json': JSON.stringify({ days: 7 }),
  'README.md': 'Ordinary checkout application.\n',
});

const specs = () => [
  { name: 'a', objective: 'checkout', files: { 'client.json': JSON.stringify({ retryFailedResponse: true }) } },
  { name: 'b', objective: 'checkout', files: { 'server.json': JSON.stringify({ deduplicateConfirmations: false }) } },
  { name: 'c', objective: 'tracing', files: { 'trace.json': JSON.stringify({ enabled: true }) } },
  { name: 'd', objective: 'tracing', files: { 'trace.json': JSON.stringify({ enabled: true }) } },
  { name: 'e', objective: 'retention', files: { 'retention.json': JSON.stringify({ days: 1 }) }, declaration: { decision_key: 'retention', choice: 'short' } },
  { name: 'f', objective: 'retention', files: { 'retention.json': JSON.stringify({ days: 30 }) }, declaration: { decision_key: 'retention', choice: 'long' } },
  { name: 'g', objective: 'metrics', files: { 'metrics.json': JSON.stringify({ enabled: true }) } },
  { name: 'h', objective: 'unknown', provenance: 'unknown', files: { 'README.md': 'Documentation from an arbitrary Git client.\n' } },
];

async function finiteValidation(files) {
  // Execute only the exact test-owned application; producers modify configuration.
  assert.equal(files['app.mjs'], appSource);
  const client = JSON.parse(files['client.json']);
  const server = JSON.parse(files['server.json']);
  assert.equal(typeof client.retryFailedResponse, 'boolean');
  assert.equal(typeof server.deduplicateConfirmations, 'boolean');
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(appSource).toString('base64')
  );
  const observation = module.checkout(client, server);
  const passed = observation.confirmations <= 1;
  return {
    passed,
    checks: [{ name: 'One confirmation after a lost response', passed }],
    observations: { lostResponse: observation },
    limitations: ['Only this finite lost-response scenario is established.'],
  };
}

async function fixture(inputSpecs = specs()) {
  const objects = new Map();
  const refs = new Map();
  const calls = { compositions: [], validations: [], cas: [] };
  const saved = [];
  const state = emptyState();
  state.workspace.owner_id = actor;
  const repoIds = sorted(inputSpecs.map((spec) => spec.repo ?? 'app'));
  const baselines = new Map();
  for (const repoId of repoIds) {
    const files = baseFiles();
    const commit = await oid({ repoId, baseline: true });
    const tree = await oid(files);
    objects.set(commit, { commit, tree, files });
    refs.set(repoId + ':' + ref, commit);
    baselines.set(repoId, { commit, tree });
    state.repositories.push({ id: repoId, canonical_ref: ref, head: commit, tree, baseline: commit });
  }
  const systemIds = sorted(inputSpecs.map((spec) => spec.system ?? 'checkout-system'));
  state.systems = systemIds.map((id) => ({
    id, name: id, version: 1,
    repository_refs: repoIds.map((repo_id) => ({ repo_id, ref })),
  }));
  state.objectives = [];
  state.futures = [];
  state.futureRevisions = [];
  const revisions = new Map();
  for (const spec of inputSpecs) {
    const repoId = spec.repo ?? 'app';
    const systemId = spec.system ?? 'checkout-system';
    const objectiveId = systemId + ':objective:' + (spec.objective ?? spec.name);
    if (!state.objectives.some((objective) => objective.id === objectiveId))
      state.objectives.push({
        id: objectiveId, system_id: systemId, statement: spec.objective ?? spec.name,
        source: { basis: 'declared', actor }, status: 'open', scope: [repoId],
      });
    const baseline = baselines.get(repoId);
    const files = { ...baseFiles(), ...spec.files };
    if (spec.declaration) files['.klocgit/proposal.json'] = JSON.stringify(spec.declaration);
    const sourceRepo = 'source-' + spec.name;
    const commit = await oid({ producer: spec.name, files });
    const tree = await oid(files);
    objects.set(commit, { commit, tree, files });
    refs.set(sourceRepo + ':' + ref, commit);
    const baselineRefs = [{ repo_id: repoId, ref, ...baseline }];
    const producer = { kind: spec.provenance === 'unknown' ? 'unknown' : 'git-client', id: spec.name };
    const revision = await record('future_revision', {
      future_id: 'future-' + spec.name,
      previous_revision_id: null,
      repository_heads: [{ repo_id: repoId, source_repo_id: sourceRepo, ref, commit }],
      tree_hashes: [{ repo_id: repoId, tree }],
      baseline_refs: baselineRefs,
      affected_scope: [{ repo_id: repoId, paths: sorted(Object.keys(files).filter((name) => files[name] !== baseFiles()[name])) }],
      producer,
      context_snapshot: null,
      provenance_state: spec.provenance ?? 'declared',
    });
    state.futureRevisions.push(revision);
    state.futures.push({
      id: revision.future_id, system_id: systemId, objective_id: objectiveId,
      name: spec.name, producer, provenance_state: revision.provenance_state,
      status: 'active', version: 1, current_revision_id: revision.id,
      baseline_refs: baselineRefs,
      repositories: [{ canonical_repo_id: repoId, repo_id: sourceRepo, ref, status: 'ready' }],
    });
    revisions.set(spec.name, revision);
  }
  const adapter = {
    configHash: 'native-discovery-fixture-v0',
    async ref(repo, name) {
      const value = refs.get(repo.id + ':' + name);
      if (!value) throw new DomainError('REF_NOT_FOUND', 'Git ref missing', 404);
      return value;
    },
    async facts(_repo, head, base) {
      const current = objects.get(head), previous = objects.get(base);
      if (!current || !previous) throw new DomainError('MISSING_COMMIT', 'Git object missing', 404);
      return {
        head, base, tree: current.tree,
        scope: sorted(Object.keys(current.files).filter((name) => current.files[name] !== previous.files[name])),
      };
    },
    async file(_repo, head, name) {
      return objects.get(head)?.files[name] ?? null;
    },
    async isAncestor(_repo, ancestor, descendant) {
      return ancestor === descendant || [...baselines.values()].some((base) => base.commit === ancestor);
    },
    async composeSelections(repo, head, selections) {
      calls.compositions.push({ repo: repo.id, head, selections: structuredClone(selections) });
      const baseline = objects.get(head), files = { ...baseline.files }, changed = new Map();
      for (const selection of selections) {
        const previous = objects.get(selection.base_commit), current = objects.get(selection.head_commit);
        for (const [name, content] of Object.entries(current.files)) {
          if (content === previous.files[name]) continue;
          if (changed.has(name) && changed.get(name) !== content)
            throw new DomainError('COMPOSITION_CONFLICT', 'Git merge conflict', 422);
          changed.set(name, content); files[name] = content;
        }
      }
      const tree = await oid(files);
      const commit = await oid({ repo: repo.id, head, tree, parents: sorted(selections.map((item) => item.head_commit)) });
      objects.set(commit, { commit, tree, files });
      return { commit, tree, baseTree: baseline.tree, canonical_parent: head };
    },
    async validate(repo, commit) {
      calls.validations.push({ repo: repo.id, commit });
      const files = objects.get(commit)?.files;
      let result = await finiteValidation(files);
      if (adapter.validationOverride) result = await adapter.validationOverride({ repo, commit, files, result });
      return result;
    },
    async cas(repo, expected, target) {
      calls.cas.push({ repo: repo.id, expected, target });
      if (refs.get(repo.id + ':' + ref) !== expected) return false;
      refs.set(repo.id + ':' + ref, target); return true;
    },
  };
  const engine = new Engine(state, adapter, async (value) => saved.push(structuredClone(value)));
  return {
    engine, state, adapter, objects, refs, revisions, calls, saved, baselines,
    graph: engine.futuresGraph,
    run: (fn) => engine.serial(fn),
    analyze: (input = {}) => engine.serial(() => engine.futuresGraph.analyze({ request_id: 'analyze', ...input }, actor)),
  };
}

async function groupFor(f, names) {
  const wanted = names.map((name) => f.revisions.get(name).id);
  const view = await f.graph.view();
  const group = view.decisionGroups.find((entry) => equalIds(entry.revision_ids, wanted));
  assert.ok(group, 'Discovery must derive the exact blocking component ' + names.join(', '));
  return group;
}

async function resolutionInput(f, group, dispositions, extra = {}) {
  const review = await f.graph.review(group.id);
  return {
    request_id: 'resolve-' + group.id,
    decision_basis_hash: review.decision_basis_hash,
    expected_heads: review.expected_heads,
    rationale: 'Reviewed the exact revisions, constraints and finite composed evidence.',
    dispositions,
    ...extra,
  };
}

async function candidateFor(f, names) {
  const selections = [];
  for (const name of names) {
    const revision = f.revisions.get(name);
    const result = await f.run(() => f.engine.pipeline.createSelection({
      future_revision_id: revision.id, request_id: 'selection-' + name,
    }, actor));
    selections.push(result.selection.id);
  }
  const { candidate } = await f.run(() => f.engine.pipeline.createCandidate({
    selection_ids: selections, request_id: 'candidate-' + names.join('-'),
  }, actor));
  await f.run(() => f.engine.pipeline.validateCandidate(
    candidate.id, { request_id: 'validate-' + names.join('-') }, actor,
  ));
  return candidate;
}

test('native discovery derives two decisions without scripted groups or compatibility history', async () => {
  const f = await fixture();
  f.state.relationships.push({ id: 'legacy-inference', from_revision: f.revisions.get('c').id, to_revision: f.revisions.get('g').id, type: 'conflicts_with', basis: 'inferred', confidence: 1 });
  await f.analyze();
  const view = await f.graph.view();
  assert.equal(view.decisionGroups.length, 2);
  await groupFor(f, ['a', 'b']);
  await groupFor(f, ['e', 'f']);
  assert.deepEqual(sorted(view.discovery.ungrouped_revision_ids), sorted(['c', 'd', 'g', 'h'].map((name) => f.revisions.get(name).id)));
  assert.ok(view.discovery.unknown_revision_ids.includes(f.revisions.get('h').id));
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.state.decisionComponents.length, 0);
  assert.equal(f.calls.cas.length, 0);
  assert.ok(view.discovery.validation_runs >= 4);
  assert.ok(view.discovery.compositions >= 3);
  assert.ok(view.discovery.comparisons_avoided > 0);
});

test('identical complete trees share implementation identity while preserving Future histories', async () => {
  const f = await fixture();
  await f.analyze();
  const view = await f.graph.view();
  const c = f.revisions.get('c'), d = f.revisions.get('d');
  assert.notEqual(c.id, d.id);
  assert.notEqual(c.future_id, d.future_id);
  assert.notEqual(c.repository_heads[0].commit, d.repository_heads[0].commit);
  assert.deepEqual(c.tree_hashes, d.tree_hashes);
  const implementation = view.implementations.find((entry) => entry.revision_ids.includes(c.id));
  assert.ok(implementation);
  assert.deepEqual(sorted(implementation.revision_ids), sorted([c.id, d.id]));
  assert.equal(f.state.futureRevisions.length, 8);
  assert.equal(f.engine.native.future(c.future_id).producer.id, 'c');
  assert.equal(f.engine.native.future(d.future_id).producer.id, 'd');
  const snapshot = await f.graph.view();
  snapshot.implementations[0].revision_ids.push('untrusted-local-edit');
  assert.equal((await f.graph.view()).implementations.some((entry) => entry.revision_ids.includes('untrusted-local-edit')), false);
});

test('producer-declared conflict, unknown and inferred confidence never become observed interaction facts', async () => {
  const f = await fixture();
  for (const type of ['unknown', 'conflicts_with', 'compatible_candidate', 'depends_on']) {
    await f.run(() => f.graph.addRelationship({
      request_id: 'declare-' + type,
      from_revision: f.revisions.get('c').id,
      to_revision: f.revisions.get('g').id,
      type, statement: 'Producer assertion requiring review.',
      basis: 'observed', confidence: 1, evidence_refs: ['producer-reported-passing-tests'],
    }, actor));
  }
  await f.analyze();
  assert.equal((await f.graph.view()).decisionGroups.length, 2);
  const declarations = f.state.nativeRelationships.filter((entry) =>
    entry.from_revision === f.revisions.get('c').id && entry.to_revision === f.revisions.get('g').id);
  assert.ok(declarations.length >= 4);
  assert.ok(declarations.every((entry) => entry.basis === 'declared'));
  assert.ok(declarations.every((entry) => !(entry.evidence_refs ?? []).includes('producer-reported-passing-tests')));
});

test('declared alternatives can connect separate objectives, but cannot connect separate Systems', async () => {
  const input = specs().filter((spec) => ['e', 'f'].includes(spec.name));
  const same = await fixture(input.map((spec) => ({ ...spec, objective: spec.name })));
  await same.analyze();
  assert.equal((await same.graph.view()).decisionGroups.length, 1);
  await groupFor(same, ['e', 'f']);
  const separate = await fixture(input.map((spec) => ({ ...spec, system: 'system-' + spec.name })));
  await separate.analyze();
  assert.equal((await separate.graph.view()).decisionGroups.length, 0);
  assert.deepEqual(sorted((await separate.graph.view()).discovery.ungrouped_revision_ids), sorted([...separate.revisions.values()].map((entry) => entry.id)));
});

test('a baseline or singleton failure prevents the claim of an emergent pair interaction', async () => {
  for (const control of ['baseline', 'singleton-a']) {
    const f = await fixture(specs().filter((spec) => ['a', 'b'].includes(spec.name)));
    f.adapter.validationOverride = ({ commit, files, result }) => {
      const baseline = commit === f.baselines.get('app').commit;
      const aOnly = JSON.parse(files['client.json']).retryFailedResponse &&
        JSON.parse(files['server.json']).deduplicateConfirmations;
      return (control === 'baseline' && baseline) || (control === 'singleton-a' && aOnly)
        ? { ...result, passed: false, checks: [{ name: 'Control fails independently', passed: false }] }
        : result;
    };
    await f.analyze();
    assert.equal((await f.graph.view()).decisionGroups.length, 0);
    assert.equal(f.state.nativeRelationships.some((entry) => entry.type === 'conflicts_with' && entry.basis === 'observed'), false);
    assert.deepEqual(sorted((await f.graph.view()).discovery.ungrouped_revision_ids), sorted([...f.revisions.values()].map((entry) => entry.id)));
    assert.equal(f.calls.cas.length, 0);
  }
});

test('unfinished or cancelled composed evaluations establish neither compatibility nor semantic conflict', async () => {
  for (const outcome of [
    { state: 'pending' },
    { state: 'cancelled' },
    { state: 'skipped' },
    { state: 'unknown' },
    { state: 'failed', status: 'pending' },
    { state: 'failed', check_status: 'pending' },
  ]) {
    const f = await fixture(specs().filter((spec) => ['a', 'b'].includes(spec.name)));
    f.adapter.validationOverride = ({ files, result }) => {
      const pair = JSON.parse(files['client.json']).retryFailedResponse &&
        !JSON.parse(files['server.json']).deduplicateConfirmations;
      return pair ? {
        passed: false, state: outcome.state,
        ...(outcome.status ? { status: outcome.status } : {}),
        checks: [{
          name: 'Lost-response scenario is not completed',
          passed: false,
          state: outcome.state,
          ...(outcome.check_status ? { status: outcome.check_status } : {}),
        }],
      } : result;
    };
    await f.analyze();
    const view = await f.graph.view();
    assert.equal(view.decisionGroups.length, 0);
    assert.deepEqual(sorted(view.discovery.ungrouped_revision_ids), sorted([...f.revisions.values()].map((entry) => entry.id)));
    assert.equal(view.relationships.some((entry) => entry.basis === 'observed' &&
      ['conflicts_with', 'compatible_candidate'].includes(entry.type)), false);
    assert.ok(view.discovery.diagnostics.some((entry) => entry.code === 'COMPOSITION_OUTCOME_UNKNOWN'));
    assert.equal(f.calls.cas.length, 0);
  }
});

test('a pending rerun retains a stale proven interaction until completed same-base evidence supersedes it', async () => {
  const f = await fixture(specs().filter((spec) => ['a', 'b'].includes(spec.name)));
  await f.analyze();
  const original = await groupFor(f, ['a', 'b']);
  const originalReview = await f.graph.review(original.id);
  const proof = originalReview.relationships.find((entry) => entry.type === 'conflicts_with' && entry.basis === 'observed');
  assert.ok(proof);
  const immutableHistory = structuredClone(proof);
  f.adapter.configHash = 'native-discovery-fixture-v1';
  f.adapter.validationOverride = ({ files, result }) => {
    const pair = JSON.parse(files['client.json']).retryFailedResponse &&
      !JSON.parse(files['server.json']).deduplicateConfirmations;
    return pair ? {
      passed: false, state: 'pending',
      checks: [{ name: 'New composed run has not completed', passed: false, state: 'pending' }],
    } : result;
  };
  await f.analyze({ request_id: 'reanalyse-with-pending-result' });
  const retained = await groupFor(f, ['a', 'b']);
  assert.equal(retained.id, original.id);
  assert.equal(retained.status, 'open');
  assert.equal(retained.stale, true);
  const review = await f.graph.review(retained.id);
  assert.ok(review.relationships.some((entry) => entry.id === proof.id));
  assert.deepEqual(f.state.nativeRelationships.find((entry) => entry.id === proof.id), immutableHistory);
  assert.ok(review.stale_reasons.some((reason) => /stale|repeat analysis/i.test(reason)));
  assert.ok(review.evidence.some((entry) => proof.evidence_refs.includes(entry.id) &&
    entry.validity.status === 'stale'));
  assert.equal(review.relationships.some((entry) => entry.type === 'compatible_candidate' &&
    equalIds([entry.from_revision, entry.to_revision], original.revision_ids)), false);
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.calls.cas.length, 0);
});

test('indexing avoids global comparisons for unrelated repository paths and objectives', async () => {
  const input = Array.from({ length: 24 }, (_, index) => ({
    name: 'independent-' + index,
    objective: 'objective-' + index,
    files: { ['isolated-' + index + '/entry.txt']: 'Independent material ' + index },
  }));
  const f = await fixture(input);
  await f.analyze();
  const view = await f.graph.view();
  assert.equal(view.decisionGroups.length, 0);
  assert.equal(view.discovery.ungrouped_revision_ids.length, 24);
  assert.equal(view.discovery.comparisons, 0);
  assert.ok(view.discovery.comparisons_avoided > 0);
  assert.equal(view.discovery.diagnostics.some((entry) => /budget/i.test(entry.code)), false);
  assert.equal(f.calls.cas.length, 0);
});

test('a comparison budget keeps all work accounted for and exposes incomplete analysis', async () => {
  const f = await fixture();
  await f.analyze({ max_comparisons: 1 });
  const view = await f.graph.view();
  assert.ok(view.discovery.comparisons <= 1);
  assert.ok(JSON.stringify(view.discovery.diagnostics).match(/budget|limit/i));
  const accounted = sorted([
    ...view.decisionGroups.flatMap((entry) => entry.revision_ids),
    ...view.discovery.ungrouped_revision_ids,
  ]);
  assert.deepEqual(accounted, sorted([...f.revisions.values()].map((entry) => entry.id)));
  assert.equal(f.calls.cas.length, 0);
});

test('exact analyze request replay does not repeat compositions, checks or graph history', async () => {
  const f = await fixture();
  const input = { request_id: 'analysis-once', max_comparisons: 100 };
  const first = await f.analyze(input);
  const counts = {
    compositions: f.calls.compositions.length,
    validations: f.calls.validations.length,
    relationships: f.state.nativeRelationships.length,
  };
  assert.deepEqual(await f.analyze(input), first);
  assert.deepEqual({
    compositions: f.calls.compositions.length,
    validations: f.calls.validations.length,
    relationships: f.state.nativeRelationships.length,
  }, counts);
  await assert.rejects(() => f.analyze({ ...input, max_comparisons: 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.calls.cas.length, 0);
});

test('an unprocessed source push invalidates a reviewed native decision before any canonical write', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['a', 'b']);
  const input = await resolutionInput(f, group, group.revision_ids.map((future_revision_id) => ({ future_revision_id, outcome: 'defer' })));
  const revision = f.revisions.get('a');
  f.refs.set(revision.repository_heads[0].source_repo_id + ':' + ref, await oid('new-unprocessed-source-head'));
  await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)), { code: 'DECISION_STALE' });
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.calls.cas.length, 0);
});

test('changed constraints, evaluator configuration and canonical heads each reject an obsolete review', async () => {
  for (const change of ['constraint', 'configuration', 'canonical']) {
    const f = await fixture();
    await f.analyze();
    const group = await groupFor(f, ['e', 'f']);
    const input = await resolutionInput(f, group, group.revision_ids.map((future_revision_id) => ({ future_revision_id, outcome: 'defer' })));
    if (change === 'constraint') f.state.constraints.push({ id: 'policy-v2', active: true, kind: 'advisory', statement: 'Changed retention policy.' });
    if (change === 'configuration') f.adapter.configHash = 'trusted-fixture-v2';
    if (change === 'canonical') {
      const head = await oid('external-canonical-change');
      f.objects.set(head, { commit: head, tree: await oid('external-tree'), files: baseFiles() });
      f.refs.set('app:' + ref, head);
    }
    await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)), { code: 'DECISION_STALE' });
    assert.equal(f.state.operations.length, 0);
    assert.equal(f.calls.cas.length, 0);
  }
});

test('metadata-only resolution records each immutable revision and rationale without modifying Git', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['e', 'f']);
  const before = await f.adapter.ref({ id: 'app' }, ref);
  const input = await resolutionInput(f, group, [
    { future_revision_id: f.revisions.get('e').id, outcome: 'defer' },
    { future_revision_id: f.revisions.get('f').id, outcome: 'reject' },
  ]);
  const result = await f.run(() => f.graph.resolve(group.id, input, actor));
  assert.equal(result.group.status, 'resolved');
  assert.equal(result.decision.actor, actor);
  assert.equal(result.decision.rationale, input.rationale);
  assert.equal(Object.isFrozen(f.state.nativeGroupDecisions[0]), true);
  assert.deepEqual(sorted(f.state.nativeGroupDispositions.map((entry) => entry.future_revision_id)), sorted(group.revision_ids));
  assert.ok(f.state.nativeGroupDispositions.every((entry) => entry.scope === 'whole_future'));
  assert.deepEqual(sorted(f.state.nativeGroupDispositions.map((entry) => entry.status)), ['deferred', 'rejected']);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), before);
  assert.equal(f.calls.cas.length, 0);
  assert.equal(f.state.futureRevisions.length, 8);
  assert.deepEqual(await f.run(() => f.graph.resolve(group.id, input, actor)), result);
  assert.equal(f.state.nativeGroupDecisions.length, 1);
});

test('incomplete dispositions and unrelated unknown additions cannot silently settle a component', async () => {
  for (const extra of [false, true]) {
    const f = await fixture();
    await f.analyze();
    const group = await groupFor(f, ['e', 'f']);
    const dispositions = extra
      ? [...group.revision_ids, f.revisions.get('h').id].map((future_revision_id) => ({ future_revision_id, outcome: 'defer' }))
      : [{ future_revision_id: group.revision_ids[0], outcome: 'defer' }];
    const input = await resolutionInput(f, group, dispositions);
    await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)), (error) => error instanceof DomainError);
    assert.equal(f.state.nativeGroupDecisions.length, 0);
    assert.equal(f.state.operations.length, 0);
    assert.equal(f.calls.cas.length, 0);
  }
});

test('acceptance requires exactly the reviewed accepted whole-Future candidate, with no extra work', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['e', 'f']);
  const candidate = await candidateFor(f, ['e', 'h']);
  const candidateReview = await f.engine.pipeline.review(candidate.id);
  const input = await resolutionInput(f, group, [
    { future_revision_id: f.revisions.get('e').id, outcome: 'accept' },
    { future_revision_id: f.revisions.get('f').id, outcome: 'defer' },
  ], { candidate_id: candidate.id, candidate_basis_hash: candidateReview.decision_basis_hash });
  await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)), (error) => error instanceof DomainError);
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.calls.cas.length, 0);
});

test('accepted graph resolution delegates one trusted exact candidate promotion and replays without another CAS', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['e', 'f']);
  const candidate = await candidateFor(f, ['e']);
  const candidateReview = await f.engine.pipeline.review(candidate.id);
  const input = await resolutionInput(f, group, [
    { future_revision_id: f.revisions.get('e').id, outcome: 'accept' },
    { future_revision_id: f.revisions.get('f').id, outcome: 'defer' },
  ], { candidate_id: candidate.id, candidate_basis_hash: candidateReview.decision_basis_hash });
  const result = await f.run(() => f.graph.resolve(group.id, input, actor));
  assert.equal(result.group.status, 'resolved');
  assert.equal(f.calls.cas.length, 1);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), candidate.repositories[0].commit);
  assert.equal(f.state.nativeGroupDispositions.find((entry) => entry.future_revision_id === f.revisions.get('e').id).status, 'applied');
  assert.equal(f.state.nativeGroupDispositions.find((entry) => entry.future_revision_id === f.revisions.get('f').id).status, 'deferred');
  assert.deepEqual(await f.run(() => f.graph.resolve(group.id, input, actor)), result);
  assert.equal(f.calls.cas.length, 1);
  assert.equal(f.state.operations.length, 1);
});

test('a newly declared relevant relationship invalidates the decision basis the human reviewed', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['e', 'f']);
  const input = await resolutionInput(f, group, group.revision_ids.map((future_revision_id) => ({ future_revision_id, outcome: 'defer' })));
  await f.run(() => f.graph.addRelationship({
    request_id: 'new-relevant-rationale',
    from_revision: f.revisions.get('e').id,
    to_revision: f.revisions.get('f').id,
    type: 'unknown', statement: 'A previously unreviewed retention interaction remains unresolved.',
  }, actor));
  await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)), { code: 'DECISION_STALE' });
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.calls.cas.length, 0);
});

test('native discovery recovery settles only its linked applied promotion without another Git CAS', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['e', 'f']);
  const candidate = await candidateFor(f, ['e']);
  const candidateReview = await f.engine.pipeline.review(candidate.id);
  const input = await resolutionInput(f, group, [
    { future_revision_id: f.revisions.get('e').id, outcome: 'accept' },
    { future_revision_id: f.revisions.get('f').id, outcome: 'defer' },
  ], { candidate_id: candidate.id, candidate_basis_hash: candidateReview.decision_basis_hash });
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {
    await cas(...args);
    throw new Error('Git acknowledgement lost after the write');
  };
  await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)));
  assert.equal(f.calls.cas.length, 1);
  assert.equal(f.state.operations[0].status, 'recovery-required');
  await f.run(() => f.engine.recover());
  await f.run(() => f.graph.reconcile());
  assert.equal(f.calls.cas.length, 1);
  assert.equal(f.state.operations[0].status, 'applied');
  assert.equal((await f.graph.review(group.id)).group.status, 'resolved');
  assert.equal(f.state.nativeGroupDispositions.find((entry) => entry.future_revision_id === f.revisions.get('e').id).status, 'applied');
  assert.equal(f.state.nativeGroupDispositions.find((entry) => entry.future_revision_id === f.revisions.get('f').id).status, 'deferred');
  const count = f.state.nativeGroupDispositions.length;
  await f.run(() => f.graph.reconcile());
  assert.equal(f.state.nativeGroupDispositions.length, count);
  assert.equal(f.calls.cas.length, 1);
});

test('a later unrelated direct promotion cannot establish an interrupted discovery resolution outcome', async () => {
  const f = await fixture();
  await f.analyze();
  const group = await groupFor(f, ['e', 'f']);
  const selected = await candidateFor(f, ['e']);
  const unrelated = await candidateFor(f, ['c']);
  const selectedReview = await f.engine.pipeline.review(selected.id);
  const input = await resolutionInput(f, group, [
    { future_revision_id: f.revisions.get('e').id, outcome: 'accept' },
    { future_revision_id: f.revisions.get('f').id, outcome: 'defer' },
  ], {
    request_id: 'same-public-promotion-identity',
    candidate_id: selected.id,
    candidate_basis_hash: selectedReview.decision_basis_hash,
  });
  const promote = f.engine.pipeline.promote.bind(f.engine.pipeline);
  f.engine.pipeline.promote = async () => {
    throw new Error('Interrupted before preparing a canonical operation');
  };
  await assert.rejects(() => f.run(() => f.graph.resolve(group.id, input, actor)));
  assert.equal(f.state.operations.length, 0);
  f.engine.pipeline.promote = promote;
  const unrelatedReview = await f.engine.pipeline.review(unrelated.id);
  assert.equal(unrelatedReview.validation_passing, true);
  try {
    await f.run(() => f.engine.pipeline.promote(unrelated.id, {
      request_id: input.request_id,
      decision_basis_hash: unrelatedReview.decision_basis_hash,
      expected_heads: unrelatedReview.expected_heads,
      rationale: 'A separate direct request to promote tracing.',
    }, actor));
  } catch (error) {
    // A reserved identity may reject the direct request before any write.
    assert.ok(error instanceof DomainError);
    assert.ok(['IDEMPOTENCY_CONFLICT', 'RECOVERY_REQUIRED'].includes(error.code));
  }
  await f.run(() => f.graph.reconcile());
  assert.equal(f.state.nativeGroupDispositions.length, 0);
  assert.notEqual((await f.graph.review(group.id)).group.status, 'resolved');
  assert.ok(f.state.operations.every((operation) => operation.candidate_id !== selected.id));
  assert.ok(f.calls.cas.length <= 1);
});

async function actualGitFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-native-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'repositories'));
  const adapter = new LocalGit(root);
  adapter.configHash = 'finite-native-checkout-v0';
  const repositories = [];
  for (const repoId of ['app', 'policy']) {
    const work = path.join(root, repoId + '-baseline');
    await mkdir(work);
    await git(work, ['init', '--quiet', '-b', 'main']);
    const files = repoId === 'app' ? baseFiles() : { 'policy.json': JSON.stringify({ maxConfirmations: 1 }) };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(work, name)), { recursive: true });
      await writeFile(path.join(work, name), content);
    }
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'Ordinary application baseline']);
    const head = await git(work, ['rev-parse', 'HEAD']);
    const tree = await git(work, ['rev-parse', 'HEAD^{tree}']);
    await git(root, ['clone', '--bare', '--quiet', work, adapter.dir({ id: repoId })]);
    repositories.push({ id: repoId, canonical_ref: ref, head, tree, baseline: head });
  }
  adapter.validate = async (repo, commit) => {
    if (repo.id === 'policy') return { passed: true, checks: [{ name: 'Policy fixture', passed: true }] };
    const files = {};
    for (const name of ['app.mjs', 'client.json', 'server.json']) files[name] = await adapter.file(repo, commit, name);
    // Git.file trims content, so compare against the same trusted exact module text.
    files['app.mjs'] += '\n';
    return finiteValidation(files);
  };
  const state = { ...emptyState(), repositories };
  state.workspace.owner_id = actor;
  const engine = new Engine(state, adapter);
  const { system } = await engine.serial(() => engine.native.createSystem({
    name: 'Checkout', repository_ids: ['app', 'policy'], request_id: 'checkout-system',
  }, actor));
  const objectives = new Map();
  for (const name of ['checkout', 'tracing', 'retention', 'metrics', 'unknown']) {
    const { objective } = await engine.serial(() => engine.native.createObjective({
      system_id: system.id, statement: name, scope: ['app'], request_id: 'objective-' + name,
    }, actor));
    objectives.set(name, objective);
  }
  const entries = [];
  for (const spec of specs()) {
    const created = await engine.serial(() => engine.native.createFuture({
      system_id: system.id, objective_id: objectives.get(spec.objective).id,
      repository_ids: ['app'], name: spec.name,
      producer: spec.provenance === 'unknown' ? { kind: 'unknown' } : { kind: 'git-client', id: spec.name },
      request_id: 'future-' + spec.name,
    }, actor));
    entries.push({ spec, future: created.future });
  }
  const revisions = new Map();
  // Producers use ordinary clone/commit/push concurrently. Ingress is serialized.
  await Promise.all(entries.map(async ({ spec, future }) => {
    const source = future.repositories[0];
    const work = path.join(root, 'producer-' + spec.name);
    await git(root, ['clone', '--quiet', adapter.dir({ id: source.repo_id }), work]);
    const changes = { ...spec.files };
    if (spec.declaration) changes['.klocgit/proposal.json'] = JSON.stringify(spec.declaration);
    for (const [name, content] of Object.entries(changes)) {
      await mkdir(path.dirname(path.join(work, name)), { recursive: true });
      await writeFile(path.join(work, name), content);
    }
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'Independent producer ' + spec.name]);
    const head = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['push', '--quiet', 'origin', 'HEAD:' + ref]);
    await engine.serial(() => engine.native.observeRepositoryPush({
      repo: source.repo_id, ref, before: future.baseline_refs[0].commit, after: head,
    }, 'git-ingress'));
    const observed = engine.native.future(future.id);
    revisions.set(spec.name, engine.native.revision(observed.current_revision_id));
  }));
  return {
    root, engine, adapter, revisions, graph: engine.futuresGraph,
    state: engine.state, run: (fn) => engine.serial(fn),
  };
}

test('real concurrent Git work cleanly merges A+B, passes each singleton, discovers two actual decisions and stays cloneable', async (t) => {
  const f = await actualGitFixture(t);
  const original = structuredClone(f.state.futureRevisions);
  const baseline = f.engine.repo('app').head;
  assert.equal((await f.adapter.validate(f.engine.repo('app'), baseline)).passed, true);
  await f.run(() => f.graph.analyze({ request_id: 'real-git-discovery' }, actor));
  const view = await f.graph.view();
  assert.equal(view.decisionGroups.length, 2);
  const interaction = await groupFor(f, ['a', 'b']);
  await groupFor(f, ['e', 'f']);
  assert.deepEqual(sorted(view.discovery.ungrouped_revision_ids), sorted(['c', 'd', 'g', 'h'].map((name) => f.revisions.get(name).id)));
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.state.decisionComponents.length, 0);
  const review = await f.graph.review(interaction.id);
  const edge = review.relationships.find((entry) => entry.type === 'conflicts_with' && entry.basis === 'observed');
  assert.ok(edge, 'A finite trusted composed failure, with passing controls, must establish the interaction edge');
  assert.ok(edge.evidence_refs.length >= 4);
  assert.ok(edge.evidence_refs.every((id) => review.evidence.some((entry) => entry.id === id)));
  const proofEvidence = edge.evidence_refs.map((id) => review.evidence.find((entry) => entry.id === id));
  assert.ok(proofEvidence.every((entry) => entry.type === 'trusted-validation' && entry.source === 'platform-owned checks'));
  assert.ok(proofEvidence.filter((entry) => entry.result.passed === true).length >= 3);
  assert.ok(proofEvidence.some((entry) => entry.result.passed === false));
  assert.ok(proofEvidence.every((entry) => entry.validity_heads.app === baseline && entry.config_hash === f.adapter.configHash));
  const candidates = f.state.candidateStates;
  const candidateOf = (names) => candidates.find((candidate) => equalIds(
    candidate.selection_ids.map((id) => f.state.selections.find((selection) => selection.id === id).future_revision_id),
    names.map((name) => f.revisions.get(name).id),
  ));
  const a = candidateOf(['a']), b = candidateOf(['b']), pair = candidateOf(['a', 'b']);
  assert.ok(a && b && pair, 'Discovery must retain the exact same-base singleton and clean merged candidates');
  for (const candidate of [a, b, pair]) assert.equal(candidate.repositories[0].base_commit, baseline);
  assert.equal((await f.engine.pipeline.review(a.id)).validation_passing, true);
  assert.equal((await f.engine.pipeline.review(b.id)).validation_passing, true);
  assert.equal((await f.engine.pipeline.review(pair.id)).validation_passing, false);
  const pairedResult = await f.adapter.validate(f.engine.repo('app'), pair.repositories[0].commit);
  assert.equal(pairedResult.observations.lostResponse.attempts, 2);
  assert.equal(pairedResult.observations.lostResponse.confirmations, 2);
  assert.equal(JSON.parse(await f.adapter.file(f.engine.repo('app'), pair.repositories[0].commit, 'client.json')).retryFailedResponse, true);
  assert.equal(JSON.parse(await f.adapter.file(f.engine.repo('app'), pair.repositories[0].commit, 'server.json')).deduplicateConfirmations, false);
  assert.deepEqual(f.revisions.get('c').tree_hashes, f.revisions.get('d').tree_hashes);
  assert.notEqual(f.revisions.get('c').repository_heads[0].commit, f.revisions.get('d').repository_heads[0].commit);
  assert.equal(f.revisions.get('h').provenance_state, 'unknown');
  const candidateReview = await f.engine.pipeline.review(a.id);
  const input = await resolutionInput(f, interaction, [
    { future_revision_id: f.revisions.get('a').id, outcome: 'accept' },
    { future_revision_id: f.revisions.get('b').id, outcome: 'defer' },
  ], { candidate_id: a.id, candidate_basis_hash: candidateReview.decision_basis_hash });
  const result = await f.run(() => f.graph.resolve(interaction.id, input, actor));
  assert.equal(result.group.status, 'resolved');
  assert.equal((await f.adapter.validate(f.engine.repo('app'), f.engine.repo('app').head)).observations.lostResponse.confirmations, 1);
  assert.deepEqual(f.state.futureRevisions, original);
  const clone = path.join(f.root, 'ordinary-client-clone');
  await git(f.root, ['clone', '--quiet', f.adapter.dir({ id: 'app' }), clone]);
  assert.equal(await git(clone, ['rev-parse', 'HEAD']), a.repositories[0].commit);
  await git(clone, ['fsck', '--full']);
  assert.equal(JSON.parse(await git(clone, ['show', 'HEAD:client.json'])).retryFailedResponse, true);
  assert.equal(JSON.parse(await git(clone, ['show', 'HEAD:server.json'])).deduplicateConfirmations, true);
});
