import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {bootstrapWorkspace} from '../scripts/workspace.mjs';
import {Engine} from '../core/engine.mjs';
import {LocalGit, git} from '../server/git.mjs';
import {handleWorkflowRequest} from '../server/workflow-api.mjs';

const OWNER = 'workflow-integration-owner';
const selectedInput = component => ({alternative_id: component.alternatives[0].id,
  basis_hash: component.basis_hash, expected_canonical_head: component.canonical_head_seen,
  rationale: 'Review the exact policy documentation composition and its finite schema check.'});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-workflow-integration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  let persisted;
  const save = async state => {persisted = JSON.stringify(state);};
  const {engine, state, adapter} = await bootstrapWorkspace(root, save);
  state.workspace.owner_id = OWNER;
  const repo = engine.repo('payment-policy');
  repo.owner_id = OWNER;
  repo.merge_request_policy = {minApprovals: 1, allowSelfApproval: true, requiredChecks: ['trusted-validation']};
  const writes = [];
  const cas = adapter.cas.bind(adapter);
  adapter.cas = async (...args) => {writes.push({repo: args[0].id, expected: args[1], target: args[2]});return cas(...args);};
  const f = {root, engine, state, adapter, repo, writes, save, persisted: () => persisted,
    run: operation => engine.serial(operation)};
  assert.equal(state.tasks[0].authorization, null, 'A pending coding-task question must not disable ordinary Git.');
  return f;
}

async function branch(f, name, files, {parent = f.repo.baseline, force = false} = {}) {
  const work = path.join(f.root, 'clients', `${name}-${Math.random().toString(36).slice(2)}`);
  await mkdir(path.dirname(work), {recursive: true});
  await git(f.root, ['clone', '--quiet', f.adapter.dir(f.repo), work]);
  await git(work, ['checkout', '--quiet', '-b', name, parent]);
  for (const [filename, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, filename)), {recursive: true});
    await writeFile(path.join(work, filename), value);
  }
  await git(work, ['add', '.']);await git(work, ['commit', '--quiet', '-m', `Ordinary Git change: ${name}`]);
  const head = await git(work, ['rev-parse', 'HEAD']);
  await git(work, ['push', '--quiet', ...(force ? ['--force'] : []), 'origin', `HEAD:refs/heads/${name}`]);
  return {name, head, work, ref: `refs/heads/${name}`};
}
const open = (f, source, extra = {}) => f.run(() => f.engine.mr.open({repo: f.repo.id,
  source_ref: source.ref, title: `Review ${source.name}`, ...extra}, OWNER));
const analyze = f => f.run(() => f.engine.analyzeWork({actor: OWNER}));
async function approve(f, id) {
  const mr = f.engine.mr.get(id);
  return f.run(() => f.engine.mr.review(id, {action: 'approve', expected_version: mr.version,
    expected_revision_id: mr.revision_id}, OWNER));
}
const prepare = (f, ids, extra = {}) => f.run(() => f.engine.prepareReview({revision_ids: ids, ...extra}, OWNER));
const apply = (f, component) => f.run(() => f.engine.resolve(component.id, selectedInput(component), OWNER));
const canonical = f => f.adapter.ref(f.repo, f.repo.canonical_ref);
async function enqueue(f, component, requestId) {
  return f.run(() => f.engine.queue.enqueue({...selectedInput(component), component_id: component.id,
    request_id: requestId}, OWNER));
}

test('native MR lifecycle, reviews and line threads are immutable metadata over ordinary Git', async t => {
  const f = await fixture(t), source = await branch(f, 'lifecycle', {'review.md': 'First line.\nSecond line.\n'});
  let mr = await open(f, source, {draft: true});
  const revisionId = mr.revision_id;
  mr = await f.run(() => f.engine.mr.transition(mr.id, {action: 'ready', expected_version: mr.version}, OWNER));
  mr = await f.run(() => f.engine.mr.comment(mr.id, {file: 'review.md', line: 2, body: 'Review this exact line.',
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER));
  const thread = mr.threads[0];
  mr = await f.run(() => f.engine.mr.comment(mr.id, {action: 'resolve', thread_id: thread.id,
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER));
  assert.equal(mr.threads[0].resolved, true);
  const closeInput = {action: 'close', expected_version: mr.version, request_id: 'close-lifecycle-once'};
  mr = await f.run(() => f.engine.mr.transition(mr.id, closeInput, OWNER));
  const eventCount = f.state.mrEvents.length;
  assert.deepEqual(await f.run(() => f.engine.mr.transition(mr.id, closeInput, OWNER)), mr);
  assert.equal(f.state.mrEvents.length, eventCount);
  mr = await f.run(() => f.engine.mr.transition(mr.id, {action: 'reopen', expected_version: mr.version}, OWNER));
  await analyze(f);mr = await approve(f, mr.id);
  assert.equal(mr.review_state.approvals, 1);
  assert.equal(mr.revision_id, revisionId);
  assert.equal(mr.status, 'open');
  assert.equal(await canonical(f), f.repo.baseline);
  assert.equal(f.writes.length, 0);
  assert.equal(f.state.comments.length, 2);
  assert.ok(f.state.comments.every(comment => comment.revision_id === revisionId));
  assert.equal(f.state.tasks[0].authorization, null);
});

test('draft and closed requests are excluded from analysis until explicitly made ready or reopened', async t => {
  const f = await fixture(t);
  let draft = await open(f, await branch(f, 'draft', {'draft.md': 'Draft work.\n'}), {draft: true});
  let closed = await open(f, await branch(f, 'closed', {'closed.md': 'Closed work.\n'}));
  closed = await f.run(() => f.engine.mr.transition(closed.id, {action: 'close', expected_version: closed.version}, OWNER));
  const ready = await open(f, await branch(f, 'ready', {'ready.md': 'Ready work.\n'}));
  await analyze(f);
  for (const id of [draft.revision_id, closed.revision_id]) {
    assert.equal(f.state.evidence.some(evidence => evidence.subject_ref === id), false);
    assert.equal(f.state.discovery.conventional_review_ids.includes(id), false);
    assert.equal(f.state.discovery.ungrouped_revision_ids.includes(id), false);
  }
  assert.ok(f.state.evidence.some(evidence => evidence.subject_ref === ready.revision_id && evidence.result.passed));
  draft = await f.run(() => f.engine.mr.transition(draft.id, {action: 'ready', expected_version: draft.version}, OWNER));
  closed = await f.run(() => f.engine.mr.transition(closed.id, {action: 'reopen', expected_version: closed.version}, OWNER));
  await analyze(f);
  assert.ok(f.engine.mr.get(draft.id).checks_state.passed.includes('trusted-validation'));
  assert.ok(f.engine.mr.get(closed.id).checks_state.passed.includes('trusted-validation'));
  assert.equal(f.writes.length, 0);
});

test('an unnotified source push cannot consume old approval or a previously reviewed canonical composition', async t => {
  const f = await fixture(t), source = await branch(f, 'moving', {'moving.md': 'Reviewed source.\n'});
  let mr = await open(f, source);await analyze(f);mr = await approve(f, mr.id);
  const originalRevision = mr.revision_id, originalReview = mr.reviews[0].id;
  mr = await f.run(() => f.engine.mr.reportCheck(mr.id, {name: 'producer-unit-tests', status: 'passed',
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER));
  const originalCheck = mr.check_runs[0].id, originalEvidenceIds = [...mr.checks_state.evidence_ids];
  assert.ok(originalEvidenceIds.length > 0);
  const component = await prepare(f, [originalRevision]);
  await writeFile(path.join(source.work, 'moving.md'), 'New unreviewed source.\n');
  await git(source.work, ['add', '.']);await git(source.work, ['commit', '--quiet', '-m', 'Source changed without webhook delivery']);
  const changedHead = await git(source.work, ['rev-parse', 'HEAD']);await git(source.work, ['push', '--quiet', 'origin', source.name]);
  await assert.rejects(() => f.run(() => f.engine.mr.review(mr.id, {action: 'approve',
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER)), error => error.code === 'MR_STALE');
  assert.equal(f.state.reviews.length, 1, 'An unnotified push cannot create a new approval of the old source head.');
  await assert.rejects(() => apply(f, component), error => ['MR_STALE', 'DECISION_STALE'].includes(error.code));
  assert.equal(await canonical(f), f.repo.baseline);assert.equal(f.writes.length, 0);
  await f.run(() => f.engine.ingest({repo: f.repo.id, ref: source.ref, before: source.head, after: changedHead}));
  mr = f.engine.mr.get(mr.id);
  assert.notEqual(mr.revision_id, originalRevision);
  assert.equal(mr.review_state.approvals, 0);
  assert.ok(mr.reviews.find(review => review.id === originalReview).stale);
  assert.ok(mr.check_runs.find(check => check.id === originalCheck).stale);
  assert.deepEqual(mr.checks_state.evidence_ids, []);
  assert.deepEqual(mr.checks_state.missing, ['trusted-validation']);
  assert.ok(originalEvidenceIds.every(id => f.state.evidence.find(evidence => evidence.id === id).result.passed),
    'Old passing evidence remains historical rather than validating the new source revision.');
  assert.ok(f.state.revisions.some(revision => revision.id === originalRevision));
  await assert.rejects(() => apply(f, component), error => error.code === 'DECISION_STALE');
  await analyze(f);
  const fresh = await prepare(f, [mr.revision_id]);
  await assert.rejects(() => apply(f, fresh), error => error.code === 'MR_BLOCKED'
    && error.details.reasons.some(reason => reason.code === 'APPROVAL_REQUIRED'));
});

test('a declared passing CI report never satisfies platform-owned required validation', async t => {
  const f = await fixture(t), source = await branch(f, 'reported-ci', {'checks.md': 'A producer reports tests.\n'});
  let mr = await open(f, source);
  mr = await f.run(() => f.engine.mr.reportCheck(mr.id, {name: 'trusted-validation', status: 'passed',
    details: 'Producer claims all tests pass.', expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER));
  assert.equal(mr.check_runs[0].basis, 'declared');
  assert.deepEqual(mr.checks_state.missing, ['trusted-validation']);
  assert.equal(f.state.evidence.length, 0);
  mr = await approve(f, mr.id);
  await assert.rejects(() => f.run(() => f.engine.mr.guardRevisionIds([mr.revision_id], OWNER)),
    error => error.code === 'MR_BLOCKED' && error.details.reasons.some(reason => reason.code === 'REQUIRED_CHECKS'));
  await analyze(f);mr = f.engine.mr.get(mr.id);
  assert.deepEqual(mr.checks_state.missing, []);
  assert.ok(mr.checks_state.evidence_ids.every(id => f.state.evidence.find(evidence => evidence.id === id).source === 'platform-owned checks'));
  assert.equal(f.writes.length, 0);
});

test('a batch composition requires current review of every included MR before one Git CAS', async t => {
  const f = await fixture(t);
  const a = await open(f, await branch(f, 'batch-a', {'batch-a.md': 'Independent A.\n'}));
  const b = await open(f, await branch(f, 'batch-b', {'batch-b.md': 'Independent B.\n'}));
  await analyze(f);await approve(f, a.id);
  let component = await prepare(f, [a.revision_id, b.revision_id]);
  await assert.rejects(() => apply(f, component), error => error.code === 'MR_BLOCKED'
    && error.details.reasons.some(reason => reason.mr_id === b.id && reason.code === 'APPROVAL_REQUIRED'));
  assert.equal(f.writes.length, 0);
  await approve(f, b.id);
  await assert.rejects(() => apply(f, component), error => error.code === 'DECISION_STALE');
  component = await prepare(f, [a.revision_id, b.revision_id]);
  const receipt = await apply(f, component);
  assert.equal(f.writes.length, 1);
  const decision = f.state.decisions.find(item => item.id === receipt.decision_id);
  assert.deepEqual([...decision.proposal_revision_ids].sort(), [a.revision_id, b.revision_id].sort());
  assert.equal(f.state.decisions.length, 1);
  for (const mr of [a, b]) {
    assert.equal(f.engine.mr.get(mr.id).status, 'merged');
    assert.equal(f.engine.mr.get(mr.id).resolution_decision_id, receipt.decision_id);
    const dispositions = f.state.dispositions.filter(item => item.revision_id === mr.revision_id);
    assert.equal(dispositions.length, 1);assert.equal(dispositions[0].status, 'applied');
    assert.equal(dispositions[0].decision_id, receipt.decision_id);
    assert.equal(dispositions[0].commit, receipt.canonical_head);
    assert.equal(await f.adapter.isAncestor(f.repo, mr.head_commit, receipt.canonical_head), true);
  }
  assert.match(await f.adapter.file(f.repo, receipt.canonical_head, 'batch-a.md'), /Independent A/);
  assert.match(await f.adapter.file(f.repo, receipt.canonical_head, 'batch-b.md'), /Independent B/);
});

test('dependency guards produce topological queue progress and every canonical advance requires fresh remaining tickets', async t => {
  const f = await fixture(t);
  const a = await open(f, await branch(f, 'dependency-a', {'dependency-a.md': 'Required predecessor.\n'}));
  let b = await open(f, await branch(f, 'dependency-b', {'dependency-b.md': 'Dependent proposal.\n'}));
  b = await f.run(() => f.engine.mr.dependencies(b.id, {dependency_ids: [a.id], expected_version: b.version}, OWNER));
  await analyze(f);await approve(f, a.id);await approve(f, b.id);
  const aReview = await prepare(f, [a.revision_id]), bReview = await prepare(f, [b.revision_id]);
  const bEntry = await enqueue(f, bReview, 'dependency-b-ticket');
  assert.equal(bEntry.status, 'blocked');
  assert.ok(bEntry.blockers.some(reason => reason.code === 'DEPENDENCY_REQUIRED'));
  const aEntry = await enqueue(f, aReview, 'dependency-a-ticket');
  const first = await f.run(() => f.engine.queue.process({request_id: 'topological-first'}, OWNER));
  assert.equal(first.processed, true);assert.equal(first.entry.id, aEntry.id);
  assert.equal(f.engine.mr.get(a.id).status, 'merged');assert.equal(f.engine.mr.get(b.id).status, 'open');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(await f.run(() => f.engine.queue.process({request_id: 'topological-first'}, OWNER)), first);
  assert.equal(f.writes.length, 1, 'Replaying a queue request must not perform another CAS.');
  const stopped = await f.run(() => f.engine.queue.process({request_id: 'topological-stale'}, OWNER));
  assert.equal(stopped.processed, false);
  assert.equal(f.engine.queue.get(bEntry.id).status, 'needs_review');
  assert.equal(f.writes.length, 1, 'A queue must not silently rebuild the remaining reviewed candidate.');
  await analyze(f);
  const reviewedAgain = await prepare(f, [b.revision_id]);
  const replacement = await enqueue(f, reviewedAgain, 'dependency-b-reviewed-again');
  const second = await f.run(() => f.engine.queue.process({request_id: 'topological-second'}, OWNER));
  assert.equal(second.processed, true);assert.equal(second.entry.id, replacement.id);
  assert.equal(f.engine.mr.get(b.id).status, 'merged');assert.equal(f.writes.length, 2);
  assert.equal(await f.adapter.isAncestor(f.repo, first.entry.outcome.canonical_head, await canonical(f)), true);
});

test('standalone conventional work without an MR can be prepared and applied while task clarification stays unanswered', async t => {
  const f = await fixture(t), source = await branch(f, 'ordinary-only', {'ordinary.md': 'No agent protocol or merge request.\n'});
  const ingress = await f.run(() => f.engine.ingest({repo: f.repo.id, ref: source.ref, after: source.head}));
  const revision = f.engine.revision(ingress.revision_id);
  assert.equal(revision.provenance_state, 'unknown');
  assert.equal(f.state.mergeRequests.length, 0);
  await analyze(f);
  assert.ok(f.state.discovery.conventional_review_ids.includes(revision.id));
  const component = await prepare(f, [revision.id]);
  assert.equal(component.alternatives[0].validation, 'passed');
  assert.equal(await canonical(f), f.repo.baseline);
  const receipt = await apply(f, component);
  assert.equal(receipt.canonical_head, await canonical(f));
  assert.equal(await f.adapter.isAncestor(f.repo, source.head, receipt.canonical_head), true);
  assert.equal(f.state.tasks[0].authorization, null);
  const clone = path.join(f.root, 'ordinary-result');
  await git(f.root, ['clone', '--quiet', f.adapter.dir(f.repo), clone]);
  assert.equal(await git(clone, ['rev-parse', 'HEAD']), receipt.canonical_head);
  await git(clone, ['fsck', '--full']);
});

test('external true-ancestor merges, force pushes and source deletion preserve native MR and revision history', async t => {
  const f = await fixture(t), aSource = await branch(f, 'external-a', {'external-a.md': 'Merged by ordinary Git.\n'});
  const a = await open(f, aSource), bSource = await branch(f, 'external-b', {'external-b.md': 'Original source history.\n'});
  let b = await open(f, bSource);await analyze(f);b = await approve(f, b.id);
  const oldRevision = b.revision_id, oldApproval = b.reviews[0].id;
  const external = path.join(f.root, 'external-canonical');
  await git(f.root, ['clone', '--quiet', f.adapter.dir(f.repo), external]);
  await git(external, ['merge', '--quiet', '--no-ff', `origin/${aSource.name}`, '-m', 'External native Git merge']);
  const mergedHead = await git(external, ['rev-parse', 'HEAD']);await git(external, ['push', '--quiet', 'origin', 'main']);
  await f.run(() => f.engine.syncHeads());
  assert.equal(f.engine.mr.get(a.id).status, 'merged');
  assert.equal(f.engine.mr.get(a.id).resolution, 'external-ancestry');
  assert.equal(f.engine.mr.get(b.id).status, 'open');
  await git(external, ['push', '--quiet', '--force', 'origin', `${f.repo.baseline}:refs/heads/main`]);
  await f.run(() => f.engine.syncHeads());
  assert.equal(f.engine.mr.get(a.id).status, 'merged', 'A later force push must not erase the historical merge event.');
  assert.equal(f.engine.mr.get(a.id).merge_commit, mergedHead);
  const rewritten = await branch(f, bSource.name, {'replacement.md': 'Rebased replacement history.\n'}, {force: true});
  await f.run(() => f.engine.ingest({repo: f.repo.id, ref: bSource.ref, before: bSource.head, after: rewritten.head}));
  b = f.engine.mr.get(b.id);
  assert.notEqual(b.revision_id, oldRevision);
  assert.ok(b.reviews.find(review => review.id === oldApproval).stale);
  assert.ok(f.state.revisions.some(revision => revision.id === oldRevision));
  await git(rewritten.work, ['push', '--quiet', 'origin', '--delete', rewritten.name]);
  const deletion = await f.run(() => f.engine.ingest({repo: f.repo.id, ref: rewritten.ref,
    before: rewritten.head, after: '0'.repeat(40)}));
  assert.equal(deletion.deleted, true);
  assert.equal(f.engine.activeRevisions().some(revision => revision.id === b.revision_id), false);
  assert.ok(f.state.revisions.some(revision => revision.id === b.revision_id));
  assert.ok(f.state.refEvents.some(event => event.type === 'deleted' && event.ref === rewritten.ref));
  assert.equal(f.writes.length, 0, 'All canonical writes in this test came from ordinary Git clients.');
  await git(f.adapter.dir(f.repo), ['fsck', '--full']);
});

test('reviewed inverse code exists before CAS, preserves later work and rejects a raced canonical head', async t => {
  const f = await fixture(t), source = await branch(f, 'to-revert', {'reverted.md': 'Selected implementation.\n'});
  const ingress = await f.run(() => f.engine.ingest({repo: f.repo.id, ref: source.ref, after: source.head}));
  const original = await apply(f, await prepare(f, [ingress.revision_id]));
  const later = await branch(f, 'later-independent', {'later.md': 'Preserve this later independent work.\n'}, {parent: original.canonical_head});
  await git(later.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  await f.run(() => f.engine.syncHeads());
  let inverse = await f.run(() => f.engine.prepareRevert({decision_id: original.decision_id,
    rationale: 'Undo the selected implementation while preserving later work.'}, OWNER));
  let composition = f.state.compositions.find(candidate => candidate.id === inverse.alternatives[0].composition_id);
  assert.equal(inverse.review_kind, 'revert');
  assert.equal(inverse.alternatives[0].validation, 'passed');
  assert.equal(await f.adapter.file(f.repo, composition.commit, 'reverted.md'), null);
  assert.match(await f.adapter.file(f.repo, composition.commit, 'later.md'), /Preserve this later/);
  assert.equal(await canonical(f), later.head, 'Preparing an inverse must not move canonical Git.');
  assert.match(await f.adapter.diff(f.repo, later.head, composition.commit), /-Selected implementation/);
  const raced = await f.adapter.externalAdvance(f.repo), writeCount = f.writes.length;
  await assert.rejects(() => apply(f, inverse), error => error.code === 'DECISION_STALE');
  assert.equal(f.writes.length, writeCount);assert.equal(await canonical(f), raced);
  inverse = await f.run(() => f.engine.refreshDecision(inverse.id));
  composition = f.state.compositions.find(candidate => candidate.id === inverse.alternatives[0].composition_id);
  assert.equal(composition.base_commit, raced);
  const reverted = await apply(f, inverse);
  assert.equal(await f.adapter.file(f.repo, reverted.canonical_head, 'reverted.md'), null);
  assert.match(await f.adapter.file(f.repo, reverted.canonical_head, 'later.md'), /Preserve this later/);
  assert.equal(await f.adapter.isAncestor(f.repo, raced, reverted.canonical_head), true);
  const decision = f.state.decisions.find(item => item.id === reverted.decision_id);
  assert.equal(decision.operation_kind, 'revert');assert.equal(decision.reverts_decision_id, original.decision_id);
  assert.equal((await f.engine.view()).summary.humanReverts, 1);
});

test('lost CAS response recovers MR and queue exactly once after reload without repeating Git writes', async t => {
  const f = await fixture(t), source = await branch(f, 'recoverable', {'recoverable.md': 'Exactly one canonical advancement.\n'});
  const mr = await open(f, source);await analyze(f);await approve(f, mr.id);
  const component = await prepare(f, [mr.revision_id]), ticket = await enqueue(f, component, 'recovery-ticket');
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {const changed = await cas(...args);assert.equal(changed, true);throw new Error('Successful Git reply was lost.');};
  const processInput = {request_id: 'recovery-process-once'};
  const result = await f.run(() => f.engine.queue.process(processInput, OWNER));
  assert.equal(result.reason, 'recovery_required');
  assert.equal(f.engine.queue.get(ticket.id).status, 'recovery_required');
  assert.equal(f.state.operations.length, 1);assert.equal(f.state.operations[0].status, 'recovery-required');
  assert.equal(await canonical(f), ticket.ticket.composition_commit);assert.equal(f.writes.length, 1);
  const adapter = await new LocalGit(f.root).init();let recoveryWrites = 0;
  adapter.cas = async () => {recoveryWrites++;throw new Error('Recovery must never repeat canonical CAS.');};
  const restored = new Engine(JSON.parse(f.persisted()), adapter, f.save);
  await restored.serial(() => restored.recover());
  assert.equal(restored.state.operations[0].status, 'applied');
  assert.equal(restored.mr.get(mr.id).status, 'merged');
  assert.equal(restored.queue.get(ticket.id).status, 'merged');
  const mergedEvents = restored.state.mrEvents.filter(event => event.mr_id === mr.id && event.type === 'decision.selected').length;
  const dispositions = restored.state.dispositions.length;
  await restored.serial(() => restored.recover());
  await restored.serial(() => restored.queue.process(processInput, OWNER));
  assert.equal(restored.state.mrEvents.filter(event => event.mr_id === mr.id && event.type === 'decision.selected').length, mergedEvents);
  assert.equal(mergedEvents, 1);assert.equal(restored.state.dispositions.length, dispositions);
  assert.equal(restored.state.operations.length, 1);assert.equal(recoveryWrites, 0);
  assert.equal(await adapter.ref(restored.repo(f.repo.id), f.repo.canonical_ref), ticket.ticket.composition_commit);
});

test('shared API validates native revisions, pins batch reviews and prepares a real decision revert', async t => {
  const f = await fixture(t);
  const api = (url, input = {}, method = 'POST') => f.run(() => handleWorkflowRequest(f.engine,
    {method, url, input, actor: OWNER}));
  const requests = [];
  for (const name of ['api-a', 'api-b']) {
    const source = await branch(f, name, {[`${name}.md`]: `API-reviewed ${name}.\n`});
    let mr = await api('/api/merge-requests', {repo: f.repo.id, source_ref: source.ref, title: `API ${name}`});
    const checked = await api(`/api/merge-requests/${mr.id}/validate`,
      {expected_version: mr.version, expected_revision_id: mr.revision_id});
    assert.equal(checked.validation.result.passed, true);
    mr = checked.mergeRequest;requests.push(mr);
  }
  const items = requests.map(mr => ({mr_id: mr.id, action: 'approve', body: 'Review this exact API snapshot.',
    expected_version: mr.version, expected_revision_id: mr.revision_id, request_id: `approve-${mr.id}`}));
  const batch = await api('/api/merge-requests/reviews/batch', {items});
  assert.equal(batch.mergeRequests.length, 2);
  assert.ok(batch.mergeRequests.every(mr => mr.review_state.approvals === 1));
  const prepared = await api('/api/reviews/prepare', {revision_ids: requests.map(mr => mr.revision_id)});
  const applied = await apply(f, prepared), headBeforeRevert = await canonical(f);
  const inverse = await api('/api/reverts/prepare', {repo: f.repo.id, decision_id: applied.decision_id,
    target_commit: applied.canonical_head, mainline: 1, title: 'API inverse of reviewed batch'});
  assert.equal(inverse.review_kind, 'revert');assert.equal(inverse.revert.mainline, 1);
  assert.equal(await canonical(f), headBeforeRevert);
  const candidate = f.state.compositions.find(item => item.id === inverse.alternatives[0].composition_id);
  for (const name of ['api-a', 'api-b']) assert.equal(await f.adapter.file(f.repo, candidate.commit, `${name}.md`), null);
  const reverted = await apply(f, inverse);
  assert.equal(f.state.decisions.find(item => item.id === reverted.decision_id).reverts_decision_id, applied.decision_id);
  assert.equal(f.writes.length, 2);
});

async function appliedDependency(f) {
  const prerequisite = await open(f, await branch(f, 'prerequisite', {'prerequisite.md': 'Required implementation.\n'}));
  let dependent = await open(f, await branch(f, 'dependent', {'dependent.md': 'Requires the prerequisite implementation.\n'}));
  dependent = await f.run(() => f.engine.mr.dependencies(dependent.id,
    {dependency_ids: [prerequisite.id], expected_version: dependent.version}, OWNER));
  await analyze(f);await approve(f, prerequisite.id);await approve(f, dependent.id);
  const applied = await apply(f, await prepare(f, [prerequisite.revision_id]));
  return {prerequisite, dependent, applied};
}
const dependencyBlocked = mrId => error => error.code === 'MR_BLOCKED'
  && error.details.reasons.some(reason => reason.mr_id === mrId && reason.code.startsWith('DEPENDENCY_'));

test('a historical merged dependency removed by canonical force-push cannot authorize dependent application', async t => {
  const f = await fixture(t), {prerequisite, dependent} = await appliedDependency(f);
  await git(f.adapter.dir(f.repo), ['update-ref', f.repo.canonical_ref, f.repo.baseline]);
  await f.run(() => f.engine.syncHeads());
  assert.equal(f.engine.mr.get(prerequisite.id).status, 'merged');
  assert.equal(await f.adapter.isAncestor(f.repo, prerequisite.head_commit, await canonical(f)), false);
  const review = await prepare(f, [dependent.revision_id]);
  await assert.rejects(() => apply(f, review), dependencyBlocked(dependent.id));
  assert.equal(await canonical(f), f.repo.baseline);
  assert.equal(f.writes.length, 1);
  assert.equal(f.engine.mr.get(dependent.id).status, 'open');
});

test('reverted dependency remains historical ancestry but cannot authorize dependent application', async t => {
  const f = await fixture(t), {prerequisite, dependent, applied} = await appliedDependency(f);
  const inverse = await f.run(() => f.engine.prepareRevert({decision_id: applied.decision_id}, OWNER));
  const reverted = await apply(f, inverse);
  assert.equal(f.engine.mr.get(prerequisite.id).status, 'merged');
  assert.equal(f.engine.mr.get(prerequisite.id).reverted_by_decision, reverted.decision_id);
  assert.equal(await f.adapter.isAncestor(f.repo, prerequisite.head_commit, await canonical(f)), true,
    'Git ancestry alone cannot show that a previously merged change remains active after a revert.');
  const review = await prepare(f, [dependent.revision_id]);
  await assert.rejects(() => apply(f, review), dependencyBlocked(dependent.id));
  assert.equal(await canonical(f), reverted.canonical_head);assert.equal(f.writes.length, 2);
  assert.equal(f.engine.mr.get(dependent.id).status, 'open');
});

test('reviewed inverse of an external Git merge marks its historical MR dependency reverted', async t => {
  const f = await fixture(t), source = await branch(f, 'external-prerequisite', {'external-prerequisite.md': 'External prerequisite.\n'});
  const prerequisite = await open(f, source);
  let dependent = await open(f, await branch(f, 'external-dependent', {'external-dependent.md': 'Requires external prerequisite.\n'}));
  dependent = await f.run(() => f.engine.mr.dependencies(dependent.id,
    {dependency_ids: [prerequisite.id], expected_version: dependent.version}, OWNER));
  await analyze(f);await approve(f, dependent.id);
  const work = path.join(f.root, 'external-prerequisite-merge');
  await git(f.root, ['clone', '--quiet', f.adapter.dir(f.repo), work]);
  await git(work, ['merge', '--quiet', '--no-ff', `origin/${source.name}`, '-m', 'External reviewed prerequisite merge']);
  const merged = await git(work, ['rev-parse', 'HEAD']);await git(work, ['push', '--quiet', 'origin', 'main']);
  await f.run(() => f.engine.syncHeads());
  assert.equal(f.engine.mr.get(prerequisite.id).resolution, 'external-ancestry');
  assert.equal(f.engine.mr.get(prerequisite.id).resolution_decision_id, undefined);
  const inverse = await f.run(() => f.engine.prepareRevert({repo: f.repo.id, target_commit: merged, mainline: 1}, OWNER));
  const reverted = await apply(f, inverse);
  assert.equal(f.engine.mr.get(prerequisite.id).reverted_by_decision, reverted.decision_id);
  assert.equal(await f.adapter.file(f.repo, reverted.canonical_head, 'external-prerequisite.md'), null);
  assert.equal(await f.adapter.isAncestor(f.repo, source.head, reverted.canonical_head), true);
  const review = await prepare(f, [dependent.revision_id]);
  await assert.rejects(() => apply(f, review), dependencyBlocked(dependent.id));
  assert.equal(await canonical(f), reverted.canonical_head);assert.equal(f.writes.length, 1);
});

test('current review counts include unanalysed work once, exclude draft/closed MRs and remove settled selections', async t => {
  const f = await fixture(t), selected = await branch(f, 'count-selected', {'count-selected.md': 'Selected ordinary work.\n'});
  const selectedIngress = await f.run(() => f.engine.ingest({repo: f.repo.id, ref: selected.ref, after: selected.head}));
  let view = await f.run(() => f.engine.view());
  assert.equal(view.summary.decisionsRequired, 1);
  assert.equal(view.summary.conventionalReview, 1);
  assert.deepEqual(view.discovery.conventional_review_ids, [selectedIngress.revision_id]);
  assert.equal(f.state.evidence.length, 0, 'Counting pending review must not depend on a prior analysis run.');
  const unrelated = await branch(f, 'count-unrelated', {'count-unrelated.md': 'Unrelated raw work.\n'});
  const unrelatedIngress = await f.run(() => f.engine.ingest({repo: f.repo.id, ref: unrelated.ref, after: unrelated.head}));
  const ready = await open(f, await branch(f, 'count-ready', {'count-ready.md': 'Ready request.\n'}));
  const draft = await open(f, await branch(f, 'count-draft', {'count-draft.md': 'Draft request.\n'}), {draft: true});
  let closed = await open(f, await branch(f, 'count-closed', {'count-closed.md': 'Closed request.\n'}));
  closed = await f.run(() => f.engine.mr.transition(closed.id, {action: 'close', expected_version: closed.version}, OWNER));
  view = await f.run(() => f.engine.view());
  assert.equal(view.summary.decisionsRequired, 3);assert.equal(view.summary.conventionalReview, 3);
  assert.ok(!view.discovery.conventional_review_ids.includes(draft.revision_id));
  assert.ok(!view.discovery.conventional_review_ids.includes(closed.revision_id));
  const review = await prepare(f, [selectedIngress.revision_id]);
  view = await f.run(() => f.engine.view());
  assert.equal(view.summary.decisionsRequired, 3, 'One prepared selection replaces, rather than duplicates, its conventional review.');
  assert.equal(view.summary.conventionalReview, 2);
  assert.deepEqual([...view.discovery.conventional_review_ids].sort(), [unrelatedIngress.revision_id, ready.revision_id].sort());
  assert.equal(view.decisionComponents.filter(component => component.id === review.id && component.status === 'open').length, 1);
  await apply(f, review);
  view = await f.run(() => f.engine.view());
  assert.equal(view.summary.decisionsRequired, 2);assert.equal(view.summary.conventionalReview, 2);
  assert.ok(!view.discovery.conventional_review_ids.includes(selectedIngress.revision_id));
  assert.ok(f.state.dispositions.some(disposition => disposition.revision_id === selectedIngress.revision_id && disposition.status === 'applied'));
  assert.equal(f.engine.mr.get(ready.id).status, 'open');
  assert.equal(f.engine.mr.get(draft.id).draft, true);assert.equal(f.engine.mr.get(closed.id).status, 'closed');
});

test('direct and registered fork MR pushes create exact revisions and stale earlier approval/check eligibility', async t => {
  const f = await fixture(t), forkId = 'workflow-producer-fork';
  await git(f.root, ['clone', '--quiet', '--bare', f.adapter.dir(f.repo), f.adapter.dir({id: forkId})]);
  f.state.forks.push({id: forkId, repo: f.repo.id});
  const forkFixture = {...f, repo: {...f.repo, id: forkId}};
  const sources = [
    {source: await branch(f, 'same-source-name', {'direct.md': 'Direct version one.\n'}), sourceRepo: f.repo.id, file: 'direct.md'},
    {source: await branch(forkFixture, 'same-source-name', {'fork.md': 'Fork version one.\n'}), sourceRepo: forkId, file: 'fork.md'},
  ];
  const requests = [];
  for (const item of sources) requests.push(await open(f, item.source, {source_repo: item.sourceRepo}));
  assert.notEqual(requests[0].proposal_id, requests[1].proposal_id);
  await analyze(f);
  for (let index = 0; index < sources.length; index++) {
    const {source, sourceRepo, file} = sources[index];
    let mr = await approve(f, requests[index].id);
    mr = await f.run(() => f.engine.mr.reportCheck(mr.id, {name: 'reported-check', status: 'passed',
      expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER));
    const oldRevision = mr.revision_id, oldEvidence = [...mr.checks_state.evidence_ids];
    assert.ok(oldEvidence.length);
    await writeFile(path.join(source.work, file), `Version two from ${sourceRepo}.\n`);
    await git(source.work, ['add', '.']);await git(source.work, ['commit', '--quiet', '-m', `Push to ${sourceRepo}`]);
    const head = await git(source.work, ['rev-parse', 'HEAD']);await git(source.work, ['push', '--quiet', 'origin', source.name]);
    await f.run(() => f.engine.ingest({repo: f.repo.id, source_repo: sourceRepo, ref: source.ref, before: source.head, after: head}));
    mr = f.engine.mr.get(mr.id);
    assert.notEqual(mr.revision_id, oldRevision);assert.equal(mr.head_commit, head);
    assert.equal(f.engine.revision(mr.revision_id).source_repo, sourceRepo);
    assert.equal(mr.review_state.approvals, 0);assert.ok(mr.reviews.every(review => review.stale));
    assert.ok(mr.check_runs.every(check => check.stale));assert.deepEqual(mr.checks_state.evidence_ids, []);
    assert.ok(oldEvidence.every(id => f.state.evidence.find(evidence => evidence.id === id).result.passed));
    assert.ok(f.state.revisions.some(revision => revision.id === oldRevision));
  }
  assert.equal(await canonical(f), f.repo.baseline);assert.equal(f.writes.length, 0);
});

test('failed cancelled and pending exact platform runs block applicable resolution until fresh passing proof', async t => {
  for (const status of ['failed', 'cancelled', 'pending']) {
    const f = await fixture(t), source = await branch(f, `platform-${status}`, {[`${status}.md`]: 'Exact platform run subject.\n'});
    const mr = await open(f, source);
    await f.run(() => f.engine.validateRevision(mr.revision_id, {actor: OWNER}));await approve(f, mr.id);
    const formerlyPassing = await prepare(f, [mr.revision_id]);
    const trustedValidate = f.adapter.validate.bind(f.adapter);
    f.adapter.validate = async (...args) => {
      const observed = await trustedValidate(...args);
      return {...observed, passed: false, status,
        checks: [{name: 'Platform run has passing completion', passed: false, detail: `The platform run is ${status}; no passing proof is established.`}]};
    };
    const checked = await f.run(() => f.engine.validateRevision(mr.revision_id, {actor: OWNER}));
    const evidence = f.state.evidence.find(item => item.id === checked.evidence_id);
    const composition = f.state.compositions.find(item => item.id === checked.composition_id);
    assert.equal(evidence.result.status, status);assert.equal(evidence.result.passed, false);
    assert.equal(evidence.subject_ref, mr.revision_id);assert.equal(evidence.tree_hash, composition.resulting_tree);
    assert.equal(evidence.config_hash, f.adapter.configHash);assert.equal(evidence.source, 'platform-owned checks');
    assert.deepEqual(f.engine.mr.get(mr.id).checks_state.missing, ['trusted-validation'], status);
    await assert.rejects(() => apply(f, formerlyPassing), error => ['DECISION_STALE', 'VALIDATION_REQUIRED', 'MR_BLOCKED'].includes(error.code), status);
    const blocked = await prepare(f, [mr.revision_id]);
    await assert.rejects(() => apply(f, blocked), error => ['DECISION_STALE', 'VALIDATION_REQUIRED', 'MR_BLOCKED'].includes(error.code), status);
    assert.equal(f.writes.length, 0);assert.equal(await canonical(f), f.repo.baseline);
    f.adapter.validate = trustedValidate;
    await f.run(() => f.engine.validateRevision(mr.revision_id, {actor: OWNER}));
    const fresh = await prepare(f, [mr.revision_id]);
    assert.equal(fresh.alternatives[0].validation, 'passed');
    await apply(f, fresh);assert.equal(f.writes.length, 1);
  }
});

test('a stacked native MR updated under its dependent requires redeclaration and checked current batch', async t => {
  const f = await fixture(t), aSource = await branch(f, 'stacked-prerequisite', {'stacked-a.md': 'Stacked prerequisite version one.\n'});
  const bSource = await branch(f, 'stacked-dependent', {'stacked-b.md': 'Dependent on prerequisite version one.\n'}, {parent: aSource.head});
  let a = await open(f, aSource), b = await open(f, bSource);
  b = await f.run(() => f.engine.mr.dependencies(b.id, {dependency_ids: [a.id], expected_version: b.version}, OWNER));
  await analyze(f);await approve(f, a.id);await approve(f, b.id);
  const oldBatch = await prepare(f, [a.revision_id, b.revision_id]), originalARevision = a.revision_id;
  assert.equal(await f.adapter.isAncestor(f.repo, a.head_commit, b.head_commit), true);
  await writeFile(path.join(aSource.work, 'stacked-a.md'), 'Stacked prerequisite version two.\n');
  await git(aSource.work, ['add', '.']);await git(aSource.work, ['commit', '--quiet', '-m', 'Update prerequisite under existing dependent']);
  const newAHead = await git(aSource.work, ['rev-parse', 'HEAD']);await git(aSource.work, ['push', '--quiet', 'origin', aSource.name]);
  await f.run(() => f.engine.ingest({repo: f.repo.id, ref: aSource.ref, before: aSource.head, after: newAHead}));
  a = f.engine.mr.get(a.id);b = f.engine.mr.get(b.id);
  assert.notEqual(a.revision_id, originalARevision);assert.equal(b.head_commit, bSource.head);
  assert.equal(b.dependencies[0].declared_revision_id, originalARevision);
  assert.equal(b.dependencies[0].revision_id, a.revision_id);
  await assert.rejects(() => apply(f, oldBatch), error => error.code === 'DECISION_STALE');
  await approve(f, a.id);
  const undeclared = await prepare(f, [a.revision_id, b.revision_id]);
  await assert.rejects(() => apply(f, undeclared), error => error.code === 'MR_BLOCKED'
    && error.details.reasons.some(reason => reason.code === 'DEPENDENCY_STALE'));
  b = f.engine.mr.get(b.id);
  await f.run(() => f.engine.mr.dependencies(b.id, {dependency_ids: [a.id], expected_version: b.version}, OWNER));
  const reviewed = await prepare(f, [a.revision_id, b.revision_id]), applied = await apply(f, reviewed);
  assert.match(await f.adapter.file(f.repo, applied.canonical_head, 'stacked-a.md'), /version two/);
  assert.match(await f.adapter.file(f.repo, applied.canonical_head, 'stacked-b.md'), /Dependent on prerequisite/);
  for (const mr of [a, b]) {
    assert.equal(f.engine.mr.get(mr.id).status, 'merged');
    assert.equal(await f.adapter.isAncestor(f.repo, mr.head_commit, applied.canonical_head), true);
  }
  assert.equal(f.writes.length, 1);assert.ok(f.state.revisions.some(revision => revision.id === originalARevision));
});

test('merge queue target movement while exact platform validation runs preserves the reviewed ticket and stops CAS', async t => {
  const f = await fixture(t), source = await branch(f, 'queue-validation-race', {'queue-race.md': 'Pinned queued work.\n'});
  const mr = await open(f, source);await analyze(f);await approve(f, mr.id);
  const component = await prepare(f, [mr.revision_id]), entry = await enqueue(f, component, 'target-race-ticket');
  const originalTicket = structuredClone(entry.ticket), trustedValidate = f.adapter.validate.bind(f.adapter);
  let began, release;
  const started = new Promise(resolve => {began = resolve;});
  const resume = new Promise(resolve => {release = resolve;});
  f.adapter.validate = async (...args) => {began();await resume;return trustedValidate(...args);};
  const inFlight = f.run(() => f.engine.validateRevision(mr.revision_id, {actor: OWNER}));
  await started;
  let external;
  try {external = await f.adapter.externalAdvance(f.repo);} finally {release();}
  const validation = await inFlight;
  assert.equal(validation.result.passed, true, 'The finite check applies only to its captured immutable inputs.');
  const writesBeforeProcessing = f.writes.length;
  const processed = await f.run(() => f.engine.queue.process({request_id: 'target-race-process'}, OWNER));
  assert.equal(processed.processed, false);assert.equal(processed.reason, 'needs_review');
  assert.equal(f.engine.queue.get(entry.id).status, 'needs_review');
  assert.deepEqual(f.engine.queue.get(entry.id).ticket, originalTicket);
  assert.equal(f.writes.length, writesBeforeProcessing, 'The queued decision must perform no CAS against the moved target.');
  assert.equal(f.state.operations.length, 0);assert.equal(await canonical(f), external);
  assert.equal(f.engine.evidenceValidity(f.state.evidence.find(item => item.id === validation.evidence_id)).status, 'stale');
  assert.equal(f.engine.mr.get(mr.id).status, 'open');
});

test('a real external branch merge after native MR review defeats captured canonical CAS without overwriting merged code', async t => {
  const f = await fixture(t), source = await branch(f, 'literal-reviewed', {'literal-reviewed.md': 'Reviewed native MR implementation.\n'});
  const mr = await open(f, source);await analyze(f);await approve(f, mr.id);
  const reviewed = await prepare(f, [mr.revision_id]), expectedHead = reviewed.canonical_head_seen;
  const external = await branch(f, 'literal-external', {'literal-external.md': 'Preserve the real external merge.\n'});
  let mergedHead;
  f.engine.save = async current => {
    if (!mergedHead && current.operations.some(operation => operation.status === 'prepared')) {
      await git(external.work, ['checkout', '--quiet', 'main']);
      await git(external.work, ['merge', '--quiet', '--no-ff', external.name, '-m', 'External merge while reviewed CAS is prepared']);
      mergedHead = await git(external.work, ['rev-parse', 'HEAD']);
      await git(external.work, ['push', '--quiet', 'origin', 'main']);
    }
    await f.save(current);
  };
  await assert.rejects(() => apply(f, reviewed), error => error.code === 'DECISION_STALE');
  assert.ok(mergedHead);assert.notEqual(mergedHead, expectedHead);
  assert.equal((await git(f.adapter.dir(f.repo), ['rev-list', '--parents', '-n', '1', mergedHead])).split(/\s+/).length, 3,
    'The racing update is an actual two-parent branch merge, rather than a same-tree head advance.');
  assert.equal(await canonical(f), mergedHead);
  assert.match(await f.adapter.file(f.repo, mergedHead, 'literal-external.md'), /Preserve the real external merge/);
  assert.equal(await f.adapter.file(f.repo, mergedHead, 'literal-reviewed.md'), null);
  assert.equal(f.writes.length, 1);assert.equal(f.writes[0].expected, expectedHead);
  assert.equal(f.state.operations.length, 1);assert.equal(f.state.operations[0].status, 'cas-failed');
  assert.equal(f.state.dispositions.length, 0);assert.equal(f.engine.mr.get(mr.id).status, 'open');
  assert.equal(f.state.mergeQueue.length, 0);assert.equal(f.state.queueEvents.length, 0);
});

test('a native MR crash after Git update before final persistence recovers its exact disposition once without repeating CAS', async t => {
  const f = await fixture(t), source = await branch(f, 'literal-crash', {'literal-crash.md': 'One durable native MR application.\n'});
  const mr = await open(f, source);await analyze(f);await approve(f, mr.id);
  const reviewed = await prepare(f, [mr.revision_id]);let preparedSnapshot;
  f.engine.save = async current => {
    if (current.operations.some(operation => operation.status === 'prepared')) preparedSnapshot = structuredClone(current);
    if (current.operations.some(operation => operation.status === 'applied')) throw new Error('Native MR crashed before final persistence');
    await f.save(current);
  };
  await assert.rejects(() => apply(f, reviewed), /Native MR crashed before final persistence/);
  assert.ok(preparedSnapshot);assert.equal(preparedSnapshot.operations.length, 1);
  const prepared = preparedSnapshot.operations[0];
  assert.equal(prepared.status, 'prepared');assert.equal(await canonical(f), prepared.target_commit);
  assert.equal(preparedSnapshot.mergeRequests.find(item => item.id === mr.id).status, 'open');
  assert.equal(preparedSnapshot.dispositions.length, 0);assert.equal(f.writes.length, 1);
  const durable = JSON.parse(f.persisted());
  assert.equal(durable.operations[0].status, 'prepared');
  assert.equal(durable.mergeRequests.find(item => item.id === mr.id).status, 'open');
  const adapter = await new LocalGit(f.root).init();let repeatedWrites = 0;
  adapter.cas = async () => {repeatedWrites++;throw new Error('Recovery must not repeat the already applied Git CAS.');};
  const restored = new Engine(durable, adapter, f.save);
  await restored.serial(() => restored.recover());
  assert.equal(restored.state.operations[0].status, 'applied');
  assert.equal(restored.state.decisions.length, 1);assert.equal(restored.component(reviewed.id).status, 'resolved');
  const merged = restored.mr.get(mr.id);
  assert.equal(merged.status, 'merged');assert.equal(merged.resolution_decision_id, prepared.decision_id);
  assert.equal(merged.merge_commit, prepared.target_commit);
  const dispositions = restored.state.dispositions.filter(item => item.revision_id === mr.revision_id);
  assert.equal(dispositions.length, 1);assert.equal(dispositions[0].status, 'applied');
  assert.equal(dispositions[0].decision_id, prepared.decision_id);assert.equal(dispositions[0].commit, prepared.target_commit);
  const eventCount = restored.state.mrEvents.filter(event => event.mr_id === mr.id && event.type === 'decision.selected').length;
  assert.equal(eventCount, 1);
  await restored.serial(() => restored.recover());
  assert.equal(restored.state.mrEvents.filter(event => event.mr_id === mr.id && event.type === 'decision.selected').length, eventCount);
  assert.equal(restored.state.dispositions.length, 1);assert.equal(restored.state.operations.length, 1);
  assert.equal(repeatedWrites, 0);
  assert.equal(await adapter.ref(restored.repo(f.repo.id), f.repo.canonical_ref), prepared.target_commit);
});
