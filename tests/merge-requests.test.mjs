import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, emptyState} from '../core/engine.mjs';
import {MergeRequests} from '../core/merge-requests.mjs';
import {record, DomainError} from '../core/hash.mjs';

const commit = value => Number(value).toString(16).padStart(40, '0');
const BASE = commit(1);
const OWNER = 'authenticated-owner';
const REVIEWER = 'authenticated-reviewer';

function fixture() {
  const state = emptyState();
  state.repositories.push({id: 'service', head: BASE, baseline: BASE, canonical_ref: 'refs/heads/main'});
  const heads = new Map([['service:refs/heads/main', BASE]]);
  const objects = new Map([[BASE, {tree: commit(1001), scope: []}]]);
  const ancestry = new Set();
  const writes = [];
  let nextCommit = 2;
  let saveCount = 0;
  const git = {
    configHash: 'trusted-config-v1',
    async ref(repo, ref) {return heads.get(`${repo.id}:${ref}`) ?? null;},
    async facts(_repo, head, base) {
      assert.ok(objects.has(head), `Git commit ${head} must exist independently of producer metadata`);
      return {head, base, tree: objects.get(head).tree, scope: objects.get(head).scope};
    },
    async file(_repo, _head, filename) {
      return filename === 'src/service.mjs' ? Array.from({length: 20}, (_, line) => `// immutable fixture line ${line + 1}`).join('\n') : null;
    },
    async isAncestor(repo, ancestor, descendant) {return ancestor === descendant || ancestry.has(`${repo.id}:${ancestor}:${descendant}`);},
    async cas(...args) {writes.push(args); throw new Error('Merge-request metadata must never advance canonical Git');},
  };
  const engine = new Engine(state, git, async () => {saveCount++;});
  const requests = engine.mr ?? new MergeRequests(engine);
  function push(name, {repo = 'service', tree, scope = ['src/service.mjs'], parent = BASE} = {}) {
    const head = commit(nextCommit++);
    objects.set(head, {tree: tree ?? commit(1000 + nextCommit), scope});
    heads.set(`${repo}:refs/heads/${name}`, head);
    if(parent)ancestry.add(`${repo}:${parent}:${head}`);
    return head;
  }
  const open = (name, input = {}, actor = OWNER) => {
    if(!heads.has(`service:refs/heads/${name}`))push(name);
    return requests.open({repo: 'service', source_ref: `refs/heads/${name}`, title: `${name} proposal`, ...input}, actor);
  };
  const current = id => requests.get(id);
  const expectError = (run, code) => assert.rejects(run, error => error.code === code);
  return {state, heads, objects, ancestry, writes, git, engine, requests, push, open, current, expectError,
    saved: () => saveCount};
}

async function trustedEvidence(f, revision, overrides = {}) {
  const evidence = await record('ev', {
    subject_ref: revision.id, tree_hash: revision.tree_hash, type: 'trusted-validation',
    config_hash: f.git.configHash, source: 'platform-owned checks',
    result: {passed: true, checks: [{name: 'Trusted finite test', passed: true}]},
    validity_heads: {service: f.state.repositories[0].head}, constraint_versions: [],
    created_at: '2026-10-03T10:00:00.000Z', ...overrides,
  });
  f.state.evidence.push(evidence);
  return evidence;
}

async function makeEligible(f, mr, reviewer = REVIEWER) {
  const current = await f.current(mr.id);
  const approved = await f.requests.review(current.id, {action: 'approve', expected_version: current.version,
    expected_revision_id: current.revision_id}, reviewer);
  await trustedEvidence(f, f.engine.revision(approved.revision_id));
  return approved;
}

async function trustedComposition(f, revisionIds, {composition: compositionOverrides = {}, evidence: evidenceOverrides = {}} = {}) {
  const candidateCommit = commit(11000 + f.state.compositions.length);
  const candidateTree = commit(12000 + f.state.compositions.length);
  const composition = await record('comp', {repo: 'service', proposal_revision_ids: [...revisionIds].sort(),
    base_commit: f.state.repositories[0].head, base_tree: f.objects.get(BASE).tree,
    resulting_tree: candidateTree, commit: candidateCommit, ...compositionOverrides});
  f.objects.set(candidateCommit, {tree: candidateTree, scope: ['src/service.mjs']});
  f.state.compositions.push(composition);
  const evidence = await record('ev', {subject_ref: composition.id, tree_hash: composition.resulting_tree,
    type: 'trusted-validation', config_hash: f.git.configHash, source: 'platform-owned checks',
    result: {passed: true, checks: [{check_ref: 'platform:composed-contract-v1', passed: true}]},
    validity_heads: Object.fromEntries(f.state.repositories.map(repo => [repo.id, repo.head])), constraint_versions: [],
    created_at: '2026-10-03T11:00:00.000Z', ...evidenceOverrides});
  f.state.evidence.push(evidence);
  return {composition, evidence};
}

test('opening a merge request ingests authoritative Git with unknown provenance and does not advance canonical state', async () => {
  const f = fixture();
  const head = f.push('ordinary-client', {scope: ['src/client.mjs']});
  const mr = await f.open('ordinary-client', {title: 'Improve the ordinary Git client change'});
  assert.equal(mr.status, 'open');
  assert.equal(mr.head_commit, head);
  assert.equal(mr.draft, false);
  assert.equal(mr.source_ref, 'refs/heads/ordinary-client');
  assert.equal(mr.target_ref, 'refs/heads/main');
  assert.ok(Number.isInteger(mr.version));
  const revision = f.engine.revision(mr.revision_id);
  assert.equal(revision.proposal_id, mr.proposal_id);
  assert.equal(revision.provenance_state, 'unknown');
  assert.equal(revision.head_commit, head);
  assert.deepEqual(revision.affected_scope, ['src/client.mjs']);
  assert.equal(f.state.repositories[0].head, BASE);
  assert.deepEqual(f.writes, []);
  assert.ok(f.saved() > 0);
  const listed = await f.requests.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, mr.id);
});

test('merge-request identity includes producer repository and preserves distinct histories for identical implementations', async () => {
  const f = fixture();
  const tree = commit(9090);
  f.state.forks.push({id: 'producer-fork', repo: 'service'});
  f.push('same-name', {tree});
  const canonicalSource = await f.open('same-name');
  f.push('same-name', {repo: 'producer-fork', tree});
  const forkSource = await f.requests.open({repo: 'service', source_repo: 'producer-fork', source_ref: 'refs/heads/same-name', title: 'Fork proposal'}, OWNER);
  assert.notEqual(canonicalSource.id, forkSource.id);
  assert.notEqual(canonicalSource.proposal_id, forkSource.proposal_id);
  assert.equal(f.engine.revision(canonicalSource.revision_id).implementation_ref, f.engine.revision(forkSource.revision_id).implementation_ref);
  assert.equal((await f.requests.list()).length, 2);
  assert.deepEqual(f.writes, []);
});

test('opening a merge request requires authenticated identity and a registered producer repository', async () => {
  const f = fixture();
  f.push('unauthorized');
  await assert.rejects(() => f.open('unauthorized', {}, ''), error => error.code === 'UNAUTHENTICATED');
  await assert.rejects(() => f.open('unauthorized', {source_repo: 'unregistered-fork'}), error => error.code === 'UNREGISTERED_FORK');
  assert.equal(f.state.revisions.length, 0);
  assert.deepEqual(f.writes, []);
});

test('lifecycle writes require the reviewed version and concurrent writes cannot both consume one version', async () => {
  const f = fixture();
  const mr = await f.open('lifecycle');
  await assert.rejects(() => f.requests.transition(mr.id, {action: 'draft'}, OWNER), error => error.code === 'MR_STALE');
  const outcomes = await Promise.allSettled([
    f.requests.transition(mr.id, {action: 'draft', expected_version: mr.version}, OWNER),
    f.requests.transition(mr.id, {action: 'close', expected_version: mr.version}, OWNER),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
  const fresh = await f.current(mr.id);
  assert.ok(fresh.version > mr.version);
  assert.ok(fresh.draft || fresh.status === 'closed');
  assert.deepEqual(f.writes, []);
});

test('lifecycle request IDs replay the original receipt and reject changed payloads or actors', async () => {
  const f = fixture();
  const mr = await f.open('idempotent');
  const input = {action: 'draft', expected_version: mr.version, request_id: 'draft-once'};
  const first = await f.requests.transition(mr.id, input, OWNER);
  const auditCount = f.state.audit.length;
  const replay = await f.requests.transition(mr.id, input, OWNER);
  assert.deepEqual(replay, first);
  assert.equal(f.state.audit.length, auditCount);
  await f.expectError(() => f.requests.transition(mr.id, {...input, action: 'ready'}, OWNER), 'IDEMPOTENCY_CONFLICT');
  await f.expectError(() => f.requests.transition(mr.id, input, REVIEWER), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.current(mr.id)).version, first.version);
});

test('draft, ready, close and reopen preserve Git and the revision history', async () => {
  const f = fixture();
  let mr = await f.open('draft', {draft: true});
  assert.equal(mr.draft, true);
  const revisionId = mr.revision_id;
  mr = await f.requests.transition(mr.id, {action: 'ready', expected_version: mr.event_id}, OWNER);
  assert.equal(mr.draft, false);
  mr = await f.requests.transition(mr.id, {action: 'close', expected_version: mr.version}, OWNER);
  assert.equal(mr.status, 'closed');
  mr = await f.requests.transition(mr.id, {action: 'reopen', expected_version: mr.version}, OWNER);
  assert.equal(mr.status, 'open');
  assert.equal(mr.revision_id, revisionId);
  assert.equal(f.state.revisions.length, 1);
  assert.equal(f.state.repositories[0].head, BASE);
  assert.deepEqual(f.writes, []);
});

test('review approval is attached to the exact revision and caller-supplied actor fields cannot impersonate another reviewer', async () => {
  const f = fixture();
  const mr = await f.open('review');
  await assert.rejects(() => f.requests.review(mr.id, {action: 'approve', expected_version: mr.version}, REVIEWER), error => error.code === 'MR_STALE');
  const approved = await f.requests.review(mr.id, {
    action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id,
    body: 'I reviewed this immutable version.', actor: 'forged-owner', created_at: '1900-01-01T00:00:00.000Z',
  }, REVIEWER);
  const review = approved.reviews.at(-1);
  assert.equal(review.actor, REVIEWER);
  assert.equal(review.revision_id, mr.revision_id);
  assert.notEqual(review.created_at, '1900-01-01T00:00:00.000Z');
  assert.ok(f.state.audit.some(entry => entry.actor === REVIEWER));
});

test('force-push creates a new immutable revision and makes existing approvals ineligible', async () => {
  const f = fixture();
  let mr = await f.open('rebased');
  mr = await f.requests.review(mr.id, {action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id}, REVIEWER);
  const original = f.engine.revision(mr.revision_id);
  const newHead = f.push('rebased', {parent: null, scope: ['src/new-service.mjs']});
  const receipt = await f.engine.ingest({repo: 'service', ref: mr.source_ref, after: newHead});
  await f.requests.observeRevision(f.engine.revision(receipt.revision_id));
  const changed = await f.current(mr.id);
  assert.notEqual(changed.revision_id, original.id);
  assert.equal(changed.head_commit, newHead);
  assert.deepEqual(f.engine.revision(original.id), original);
  assert.equal(changed.reviews[0].revision_id, original.id);
  assert.equal(changed.review_state.approvals, 0);
  assert.equal(changed.reviews[0].stale, true);
  await f.expectError(() => f.requests.review(mr.id, {action: 'approve', expected_version: changed.version, expected_revision_id: original.id}, REVIEWER), 'MR_STALE');
});

test('an external check is recorded as a producer declaration and cannot satisfy required platform validation', async () => {
  const f = fixture();
  let mr = await f.open('external-ci');
  mr = await f.requests.review(mr.id, {action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id}, REVIEWER);
  mr = await f.requests.check(mr.id, {name: 'trusted-validation', status: 'passed', expected_version: mr.version,
    expected_revision_id: mr.revision_id, details: 'All tests pass', source: 'platform-owned checks', trusted: true}, 'external-ci');
  assert.equal(mr.check_runs.at(-1).basis, 'declared');
  assert.equal(f.state.evidence.length, 0);
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_BLOCKED');
  await trustedEvidence(f, f.engine.revision(mr.revision_id));
  const guard = await f.requests.guardRevisionIds([mr.revision_id]);
  assert.equal(guard.allowed, true);
  assert.ok(guard.merge_request_ids.includes(mr.id));
  assert.ok(guard.basis_hash);
  assert.deepEqual(f.writes, []);
});

test('required trusted evidence rejects wrong trees, wrong subjects and untrusted sources', async () => {
  for(const overrides of [
    {tree_hash: commit(999)},
    {subject_ref: 'another-immutable-revision'},
    {source: 'producer-owned checks'},
    {type: 'human-observation'},
    {result: {passed: false, checks: [{name: 'Trusted finite test', passed: false}]}},
  ]) {
    const f = fixture();
    let mr = await f.open('bounded-evidence');
    mr = await f.requests.review(mr.id, {action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id}, REVIEWER);
    await trustedEvidence(f, f.engine.revision(mr.revision_id), overrides);
    await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_BLOCKED');
  }
});

test('canonical, configuration and constraint advances invalidate earlier merge-request evidence', async () => {
  for(const invalidate of [
    f => {f.state.repositories[0].head = commit(808); f.heads.set('service:refs/heads/main', commit(808));},
    f => {f.git.configHash = 'trusted-config-v2';},
    f => {f.state.constraints.push({id: 'new-constraint-v2', active: true, kind: 'checkable'});},
  ]) {
    const f = fixture();
    const mr = await makeEligible(f, await f.open('stale-evidence'));
    assert.equal((await f.requests.guardRevisionIds([mr.revision_id])).allowed, true);
    invalidate(f);
    await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_BLOCKED');
    assert.equal(f.state.evidence[0].result.passed, true, 'Historical evidence remains immutable; only eligibility changes');
  }
});

test('merge guards re-read the exact producer Git head before allowing a reviewed revision', async () => {
  const f = fixture();
  const mr = await makeEligible(f, await f.open('race'));
  f.push('race', {parent: null});
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_STALE');
  assert.equal((await f.current(mr.id)).revision_id, mr.revision_id, 'A Git observation must not fabricate an un-ingested revision');
  assert.deepEqual(f.writes, []);
});

test('requested changes block a passing revision until the request is dismissed or replaced by approval', async () => {
  const f = fixture();
  let mr = await makeEligible(f, await f.open('changes-requested'));
  mr = await f.requests.review(mr.id, {action: 'request_changes', body: 'Correct the API contract.',
    expected_version: mr.version, expected_revision_id: mr.revision_id}, 'another-reviewer');
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_BLOCKED');
  const blocking = mr.reviews.at(-1);
  mr = await f.requests.review(mr.id, {action: 'dismiss', review_id: blocking.id, body: 'The blocking review was withdrawn.',
    expected_version: mr.version, expected_revision_id: mr.revision_id}, 'demo-owner');
  assert.equal((await f.requests.guardRevisionIds([mr.revision_id])).allowed, true);
  assert.ok(mr.reviews.some(review => review.action === 'request_changes'));
});

test('repository-owner policy changes enforce a minimum count and named platform check references', async () => {
  const f = fixture();
  let mr = await f.open('policy');
  const policy = {minApprovals: 2, allowSelfApproval: false, requiredChecks: ['platform:api-contract-v1']};
  await assert.rejects(() => f.requests.transition(mr.id, {action: 'policy', policy, expected_version: mr.version}, 'external-ci'), error => error.status === 403);
  mr = await f.requests.transition(mr.id, {action: 'policy', policy, expected_version: mr.version}, 'demo-owner');
  mr = await f.requests.review(mr.id, {action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER);
  mr = await f.requests.review(mr.id, {action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id}, REVIEWER);
  const revision = f.engine.revision(mr.revision_id);
  await trustedEvidence(f, revision, {result: {passed: true, checks: [{name: 'platform:api-contract-v1', passed: true}]}});
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_BLOCKED');
  mr = await f.requests.review(mr.id, {action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id}, 'second-reviewer');
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_BLOCKED');
  await trustedEvidence(f, revision, {result: {passed: true, checks: [{check_ref: 'platform:api-contract-v1', passed: true}]}});
  assert.equal((await f.requests.guardRevisionIds([mr.revision_id])).allowed, true);
  assert.equal(mr.policy.minApprovals, 2);
});

test('file-anchored discussion threads preserve their immutable revision across push, resolution and reopen', async () => {
  const f = fixture();
  let mr = await f.open('discussion');
  const discussedRevision = mr.revision_id;
  mr = await f.requests.comment(mr.id, {body: 'Explain this branch.', file: 'src/service.mjs', line: 12,
    expected_version: mr.version, expected_revision_id: mr.revision_id}, REVIEWER);
  const first = mr.comments.at(-1);
  assert.equal(first.actor, REVIEWER);
  assert.equal(first.revision_id, discussedRevision);
  assert.equal(first.file, 'src/service.mjs');
  assert.equal(first.line, 12);
  const threadId = first.thread_id;
  assert.ok(threadId);
  mr = await f.requests.comment(mr.id, {action: 'resolve', thread_id: threadId,
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER);
  assert.equal(mr.threads.find(thread => thread.id === threadId).resolved, true);
  mr = await f.requests.comment(mr.id, {action: 'reopen', thread_id: threadId,
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER);
  assert.equal(mr.threads.find(thread => thread.id === threadId).resolved, false);
  const newHead = f.push('discussion');
  const receipt = await f.engine.ingest({repo: 'service', ref: mr.source_ref, after: newHead});
  await f.requests.observeRevision(f.engine.revision(receipt.revision_id));
  const updated = await f.current(mr.id);
  assert.notEqual(updated.revision_id, discussedRevision);
  assert.equal(updated.comments[0].revision_id, discussedRevision);
  await f.expectError(() => f.requests.comment(mr.id, {body: 'A stale inline comment', file: 'src/service.mjs', line: 12,
    expected_version: updated.version, expected_revision_id: discussedRevision}, REVIEWER), 'MR_STALE');
});

test('discussion input rejects invalid anchors and comment identity is derived from authentication', async () => {
  const f = fixture();
  const mr = await f.open('bad-anchor');
  for(const anchor of [{file: '../secret', line: 1}, {file: '/private/context', line: 1}, {file: 'src/service.mjs', line: -1}]) {
    await assert.rejects(() => f.requests.comment(mr.id, {body: 'Comment', ...anchor, expected_version: mr.version,
      expected_revision_id: mr.revision_id}, REVIEWER), error => error.status === 400);
  }
  const commented = await f.requests.comment(mr.id, {body: 'Ordinary discussion', actor: 'forged-reviewer',
    expected_version: mr.version, expected_revision_id: mr.revision_id}, OWNER);
  assert.equal(commented.comments.at(-1).actor, OWNER);
});

test('draft and closed merge requests are excluded from decision analysis without deleting ingested Git work', async () => {
  const f = fixture();
  let mr = await f.open('excluded', {draft: true});
  assert.equal(f.requests.analysisEligible(mr.revision_id), false);
  assert.equal(f.state.revisions.length, 1);
  mr = await f.requests.transition(mr.id, {action: 'ready', expected_version: mr.version}, OWNER);
  assert.equal(f.requests.analysisEligible(mr.revision_id), true);
  mr = await f.requests.transition(mr.id, {action: 'close', expected_version: mr.version}, OWNER);
  assert.equal(f.requests.analysisEligible(mr.revision_id), false);
  assert.equal(f.state.revisions.length, 1);
  assert.equal(f.engine.revision(mr.revision_id).head_commit, mr.head_commit);
  assert.deepEqual(f.writes, []);
});

test('dependency declarations reject cycles and cannot unblock a pending unselected dependency', async () => {
  const f = fixture();
  let first = await makeEligible(f, await f.open('dependency'));
  let second = await makeEligible(f, await f.open('dependent'));
  second = await f.requests.dependencies(second.id, {dependency_ids: [first.id], expected_version: second.version}, OWNER);
  assert.deepEqual(second.dependency_ids, [first.id]);
  await f.expectError(() => f.requests.guardRevisionIds([second.revision_id]), 'MR_BLOCKED');
  assert.equal((await f.requests.guardRevisionIds([first.revision_id, second.revision_id])).allowed, true);
  await assert.rejects(() => f.requests.dependencies(first.id, {dependency_ids: [second.id], expected_version: first.version}, OWNER), error => error.status === 409 || error.status === 422);
  assert.deepEqual((await f.current(first.id)).dependency_ids, []);
  await assert.rejects(() => f.requests.dependencies(first.id, {dependency_ids: [first.id], expected_version: first.version}, OWNER), error => error.status === 400 || error.status === 409 || error.status === 422);
  assert.deepEqual(f.writes, []);
});

test('a selected dependency still needs approval, trusted evidence and a current source head', async () => {
  const f = fixture();
  f.state.repositories[0].merge_request_policy = {minApprovals: 1};
  let dependency = await f.open('unchecked-dependency');
  let dependent = await makeEligible(f, await f.open('checked-dependent'));
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  await f.expectError(() => f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id]), 'MR_BLOCKED');
  dependency = await makeEligible(f, dependency);
  assert.equal((await f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id])).allowed, true);
  f.push('unchecked-dependency');
  await f.expectError(() => f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id]), 'MR_STALE');
});

test('same-batch cross-repository dependencies are not treated as an atomic merge', async () => {
  const f = fixture();
  f.state.repositories.push({id: 'other', head: BASE, baseline: BASE, canonical_ref: 'refs/heads/main'});
  f.heads.set('other:refs/heads/main', BASE);
  f.push('cross-repo-dependency', {repo: 'other'});
  let dependency = await f.requests.open({repo: 'other', source_ref: 'refs/heads/cross-repo-dependency', title: 'Other repo dependency'}, OWNER);
  dependency = await makeEligible(f, dependency);
  let dependent = await makeEligible(f, await f.open('same-repo-dependent'));
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  await f.expectError(() => f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id]), 'MR_BLOCKED');
  f.objects.set(commit(606), {tree: commit(1606), scope: ['src/service.mjs']});
  f.ancestry.add(`other:${dependency.head_commit}:${commit(606)}`);
  f.heads.set('other:refs/heads/main', commit(606));
  f.state.repositories.find(repo => repo.id === 'other').head = commit(606);
  await f.requests.reconcileDecision({id: 'dependency-applied', proposal_revision_ids: [dependency.revision_id], deferred_revision_ids: []}, commit(606));
  assert.equal((await f.requests.guardRevisionIds([dependent.revision_id])).allowed, true);
});

test('decision receipts mark exact selected revisions merged and deferred revisions closed, with idempotent recovery', async () => {
  const f = fixture();
  const selected = await f.open('selected');
  const deferred = await f.open('deferred');
  const decision = {id: 'immutable-decision', proposal_revision_ids: [selected.revision_id], deferred_revision_ids: [deferred.revision_id]};
  await f.requests.reconcileDecision(decision, commit(303));
  const merged = await f.current(selected.id);
  const closed = await f.current(deferred.id);
  assert.equal(merged.status, 'merged');
  assert.equal(closed.status, 'closed');
  assert.equal(f.requests.analysisEligible(selected.revision_id), false);
  assert.equal(f.requests.analysisEligible(deferred.revision_id), false);
  const auditCount = f.state.audit.length;
  await f.requests.reconcileDecision(decision, commit(303));
  assert.deepEqual(await f.current(selected.id), merged);
  assert.deepEqual(await f.current(deferred.id), closed);
  assert.equal(f.state.audit.length, auditCount);
  assert.equal(f.state.repositories[0].head, BASE, 'Receipt reconciliation records Git outcome; it never advances Git');
  assert.deepEqual(f.writes, []);
});

test('an old decision receipt cannot mark a force-pushed current revision merged', async () => {
  const f = fixture();
  const mr = await f.open('changed-after-review');
  const head = f.push('changed-after-review', {parent: null});
  const receipt = await f.engine.ingest({repo: 'service', ref: mr.source_ref, after: head});
  await f.requests.observeRevision(f.engine.revision(receipt.revision_id));
  const before = await f.current(mr.id);
  await f.requests.reconcileDecision({id: 'older-decision', proposal_revision_ids: [mr.revision_id], deferred_revision_ids: []}, commit(707));
  const after = await f.current(mr.id);
  assert.equal(after.revision_id, before.revision_id);
  assert.equal(after.status, 'open');
  assert.equal(after.head_commit, head);
});

test('external merge detection requires commit ancestry and never infers a merge from identical trees or squash descriptions', async () => {
  const f = fixture();
  const sharedTree = commit(8000);
  f.push('included', {tree: sharedTree});
  f.push('same-tree', {tree: sharedTree});
  const included = await f.open('included');
  const separate = await f.open('same-tree');
  const squashHead = commit(8001);
  f.objects.set(squashHead, {tree: sharedTree, scope: ['src/service.mjs']});
  f.heads.set('service:refs/heads/main', squashHead);
  await f.requests.reconcileCanonical('service', BASE, squashHead);
  assert.equal((await f.current(included.id)).status, 'open');
  assert.equal((await f.current(separate.id)).status, 'open');
  const mergeHead = commit(8002);
  f.objects.set(mergeHead, {tree: sharedTree, scope: ['src/service.mjs']});
  f.ancestry.add(`service:${included.head_commit}:${mergeHead}`);
  f.heads.set('service:refs/heads/main', mergeHead);
  await f.requests.reconcileCanonical(f.state.repositories[0], squashHead, mergeHead);
  assert.equal((await f.current(included.id)).status, 'merged');
  assert.equal((await f.current(separate.id)).status, 'open');
  assert.deepEqual(f.writes, []);
});

test('re-observing a revision is an idempotent metadata operation', async () => {
  const f = fixture();
  const mr = await f.open('observed');
  const before = await f.current(mr.id);
  const auditCount = f.state.audit.length;
  await f.requests.observeRevision(f.engine.revision(mr.revision_id));
  await f.requests.observeRevision(f.engine.revision(mr.revision_id));
  assert.deepEqual(await f.current(mr.id), before);
  assert.equal(f.state.audit.length, auditCount);
});

test('ordinary ingested Git work remains analyzable without adopting a merge-request-specific workflow', async () => {
  const f = fixture();
  const head = f.push('no-merge-request');
  const receipt = await f.engine.ingest({repo: 'service', ref: 'refs/heads/no-merge-request', after: head});
  assert.equal((await f.requests.list()).length, 0);
  assert.equal(f.requests.analysisEligible(receipt.revision_id), true);
  assert.equal((await f.requests.guardRevisionIds([receipt.revision_id])).allowed, true);
  assert.equal(f.engine.revision(receipt.revision_id).provenance_state, 'unknown');
  assert.deepEqual(f.writes, []);
});

test('an old revision observation cannot move the current merge-request pointer backwards', async () => {
  const f = fixture();
  const opened = await f.open('out-of-order');
  const older = f.engine.revision(opened.revision_id);
  const head = f.push('out-of-order');
  const receipt = await f.engine.ingest({repo: 'service', ref: opened.source_ref, after: head});
  await f.requests.observeRevision(f.engine.revision(receipt.revision_id));
  const current = await f.current(opened.id);
  await f.requests.observeRevision(older);
  assert.equal((await f.current(opened.id)).revision_id, current.revision_id);
  assert.equal((await f.current(opened.id)).head_commit, head);
});

test('opening with a request ID is idempotent and conflicting retries do not ingest a second proposal', async () => {
  const f = fixture();
  const input = {request_id: 'open-ordinary-change', title: 'Stable request payload'};
  const first = await f.open('open-idempotent', input);
  const auditCount = f.state.audit.length;
  const replay = await f.open('open-idempotent', input);
  assert.deepEqual(replay, first);
  assert.equal(f.state.audit.length, auditCount);
  await f.expectError(() => f.open('open-idempotent', {...input, title: 'Changed request payload'}), 'IDEMPOTENCY_CONFLICT');
  await f.expectError(() => f.open('open-idempotent', input, REVIEWER), 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.state.proposals.length, 1);
  assert.equal(f.state.revisions.length, 1);
});

test('default review policy preserves decision compression without requiring a separate approval for every merge request', async () => {
  const f = fixture();
  const mr = await f.open('canonical-decision-review');
  assert.equal(mr.policy.minApprovals, 0);
  assert.equal(mr.review_state.approvals, 0);
  await trustedEvidence(f, f.engine.revision(mr.revision_id));
  assert.equal((await f.requests.guardRevisionIds([mr.revision_id])).allowed, true);
  assert.deepEqual(f.writes, [], 'Merge eligibility still performs no canonical action without a coordinator decision');
});

test('dependency declarations do not silently follow a force-pushed dependency revision', async () => {
  const f = fixture();
  let dependency = await makeEligible(f, await f.open('versioned-dependency'));
  let dependent = await makeEligible(f, await f.open('versioned-dependent'));
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  const declaredRevision = dependency.revision_id;
  const head = f.push('versioned-dependency', {parent: null});
  const receipt = await f.engine.ingest({repo: 'service', ref: dependency.source_ref, after: head});
  await f.requests.observeRevision(f.engine.revision(receipt.revision_id));
  dependency = await makeEligible(f, await f.current(dependency.id));
  assert.equal((await f.current(dependent.id)).dependencies[0].declared_revision_id, declaredRevision);
  await f.expectError(() => f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id]), 'MR_BLOCKED');
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  assert.equal(dependent.dependencies[0].declared_revision_id, dependency.revision_id);
  assert.equal((await f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id])).allowed, true);
});

test('reviews re-read authoritative Git instead of accepting a stale metadata pointer', async () => {
  const f = fixture();
  const mr = await f.open('review-head-race');
  f.push('review-head-race', {parent: null});
  await f.expectError(() => f.requests.review(mr.id, {action: 'approve', expected_version: mr.version,
    expected_revision_id: mr.revision_id}, REVIEWER), 'MR_STALE');
  assert.equal((await f.current(mr.id)).reviews.length, 0);
  assert.equal((await f.current(mr.id)).version, mr.version);
  assert.deepEqual(f.writes, []);
});

test('one batch review records exact immutable approvals for several selected merge requests', async () => {
  const f = fixture();
  const first = await f.open('batch-first');
  const second = await f.open('batch-second');
  const items = [first, second].map(mr => ({mr_id: mr.id, action: 'approve', body: 'Review these selected exact revisions together.',
    expected_version: mr.version, expected_revision_id: mr.revision_id, request_id: `batch-${mr.id}`}));
  const snapshots = await f.requests.reviewBatch(items, REVIEWER);
  assert.equal(snapshots.length, 2);
  for(let index = 0; index < snapshots.length; index++) {
    const review = snapshots[index].reviews.at(-1);
    assert.equal(review.actor, REVIEWER);
    assert.equal(review.action, 'approve');
    assert.equal(review.revision_id, items[index].expected_revision_id);
    assert.equal(review.basis, 'declared');
  }
  const replay = await f.requests.reviewBatch(items, REVIEWER);
  assert.deepEqual(replay, snapshots);
  assert.equal(f.state.reviews.length, 2);
  assert.deepEqual(f.writes, []);
});

test('batch review preflights every immutable revision and fails without recording a partial review', async () => {
  for(const invalidate of [
    (_f, item) => {item.expected_revision_id = 'a-different-immutable-revision';},
    (f, _item) => {f.push('batch-stale-second', {parent: null});},
  ]) {
    const f = fixture();
    const first = await f.open('batch-stale-first');
    const second = await f.open('batch-stale-second');
    const items = [first, second].map(mr => ({mr_id: mr.id, action: 'approve', expected_version: mr.version,
      expected_revision_id: mr.revision_id}));
    invalidate(f, items[1]);
    await f.expectError(() => f.requests.reviewBatch(items, REVIEWER), 'MR_STALE');
    assert.equal(f.state.reviews.length, 0);
    assert.equal((await f.current(first.id)).version, first.version);
    assert.equal((await f.current(second.id)).version, second.version);
  }
});

test('a batch cannot count repeated copies of one merge request as distinct reviews', async () => {
  const f = fixture();
  const mr = await f.open('batch-duplicate');
  const item = {mr_id: mr.id, action: 'approve', expected_version: mr.version, expected_revision_id: mr.revision_id};
  await assert.rejects(() => f.requests.reviewBatch([item, item], REVIEWER), error => error.status === 400);
  assert.equal(f.state.reviews.length, 0);
});

test('source deletion is idempotent, blocks analysis and merge, and an exact restored revision clears the deletion marker', async () => {
  const f = fixture();
  const mr = await makeEligible(f, await f.open('deleted-source'));
  const revision = f.engine.revision(mr.revision_id);
  f.heads.delete(`service:${mr.source_ref}`);
  const deleted = await f.requests.observeDeletion('service', mr.source_ref);
  assert.equal(deleted.length, 1);
  assert.equal((await f.current(mr.id)).source_deleted, true);
  assert.equal((await f.current(mr.id)).status, 'open');
  assert.equal(f.requests.analysisEligible(mr.revision_id), false);
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id]), 'MR_STALE');
  const deletionVersion = (await f.current(mr.id)).version;
  assert.deepEqual(await f.requests.observeDeletion('service', mr.source_ref), []);
  assert.equal((await f.current(mr.id)).version, deletionVersion);
  const differentHead = f.push('deleted-source', {parent: null});
  assert.notEqual(differentHead, revision.head_commit);
  assert.deepEqual(await f.requests.observeRevision(revision), []);
  assert.equal((await f.current(mr.id)).source_deleted, true);
  f.heads.set(`service:${mr.source_ref}`, revision.head_commit);
  const restored = await f.requests.observeRevision(revision);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].source_deleted, false);
  assert.equal(restored[0].revision_id, revision.id);
  assert.equal(f.requests.analysisEligible(revision.id), true);
  assert.equal((await f.requests.guardRevisionIds([revision.id])).allowed, true);
  assert.deepEqual(await f.requests.observeRevision(revision), []);
  assert.deepEqual(f.writes, []);
});

test('a revert receipt records its immutable linkage while keeping the original request merged', async () => {
  const f = fixture();
  const original = await f.open('original-merge');
  const unrelated = await f.open('unrelated-merge');
  const firstDecision = await record('decision', {actor: OWNER, proposal_revision_ids: [original.revision_id], deferred_revision_ids: []});
  const otherDecision = await record('decision', {actor: OWNER, proposal_revision_ids: [unrelated.revision_id], deferred_revision_ids: []});
  await f.requests.reconcileDecision(firstDecision, commit(16001));
  await f.requests.reconcileDecision(otherDecision, commit(16002));
  const revert = await record('decision', {actor: REVIEWER, operation_kind: 'revert', reverts_decision_id: firstDecision.id,
    proposal_revision_ids: [], deferred_revision_ids: []});
  const changed = await f.requests.reconcileDecision(revert, commit(16003));
  assert.equal(changed.length, 1);
  const updated = await f.current(original.id);
  assert.equal(updated.status, 'merged');
  assert.equal(updated.resolution_decision_id, firstDecision.id);
  assert.equal(updated.merge_commit, commit(16001));
  assert.equal(updated.reverted_by_decision, revert.id);
  assert.equal((await f.current(unrelated.id)).reverted_by_decision, undefined);
  const event = f.state.mrEvents.find(event => event.mr_id === original.id && event.type === 'decision.reverted');
  assert.equal(event.actor, REVIEWER);
  assert.equal(event.data.original_decision_id, firstDecision.id);
  assert.equal(event.data.decision_id, revert.id);
  assert.equal(event.data.commit, commit(16003));
  assert.throws(() => {event.data.original_decision_id = 'fabricated-history';}, TypeError);
  assert.deepEqual(await f.requests.reconcileDecision(revert, commit(16003)), []);
  assert.deepEqual(await f.current(original.id), updated);
  await f.expectError(() => f.requests.transition(original.id, {action: 'reopen', expected_version: updated.version}, OWNER), 'MR_TERMINAL');
  assert.deepEqual(f.writes, []);
});

test('exact trusted composition evidence can satisfy selected checks without inventing a standalone passing claim', async () => {
  const f = fixture();
  f.state.repositories[0].merge_request_policy = {minApprovals: 0, requiredChecks: ['platform:composed-contract-v1']};
  const first = await f.open('composed-first');
  const second = await f.open('composed-second');
  const ids = [first.revision_id, second.revision_id];
  const {composition} = await trustedComposition(f, ids);
  assert.equal(f.state.evidence.some(evidence => ids.includes(evidence.subject_ref)), false);
  assert.deepEqual((await f.current(first.id)).checks_state.passed, []);
  await f.expectError(() => f.requests.guardRevisionIds(ids, OWNER), 'MR_BLOCKED');
  const guarded = await f.requests.guardRevisionIds(ids, OWNER, {composition_id: composition.id});
  assert.equal(guarded.allowed, true);
  assert.deepEqual(guarded.merge_request_ids.sort(), [first.id, second.id].sort());
  assert.deepEqual((await f.current(first.id)).checks_state.passed, [], 'A passing composed tree does not prove the standalone source tree passed');
  assert.deepEqual(f.writes, []);
});

test('composed validation must match the exact selected revision set', async () => {
  const f = fixture();
  const first = await f.open('subset-first');
  const second = await f.open('subset-second');
  const {composition} = await trustedComposition(f, [first.revision_id]);
  await f.expectError(() => f.requests.guardRevisionIds([first.revision_id, second.revision_id], OWNER, {composition_id: composition.id}), 'MR_STALE');
  await f.expectError(() => f.requests.guardRevisionIds([first.revision_id], OWNER, {composition_id: 'missing-composition'}), 'MR_STALE');
  assert.equal((await f.requests.guardRevisionIds([first.revision_id], OWNER, {composition_id: composition.id})).allowed, true);
});

test('composed proof rejects producer claims, mismatched subjects or trees, stale inputs and failed evidence', async () => {
  for(const overrides of [
    {source: 'external-ci'},
    {type: 'human-observation'},
    {subject_ref: 'different-composition'},
    {tree_hash: commit(17001)},
    {config_hash: 'old-platform-config'},
    {validity_heads: {service: commit(17002)}},
    {constraint_versions: ['obsolete-constraint-version']},
    {result: {passed: false, checks: [{check_ref: 'platform:composed-contract-v1', passed: true}]}},
  ]) {
    const f = fixture();
    const mr = await f.open('invalid-composed-proof');
    const {composition} = await trustedComposition(f, [mr.revision_id], {evidence: overrides});
    await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id], OWNER, {composition_id: composition.id}), 'MR_BLOCKED');
    assert.deepEqual(f.writes, []);
  }
});

test('a composition based on a former canonical head cannot grant validation eligibility', async () => {
  const f = fixture();
  const mr = await f.open('obsolete-composition-base');
  const {composition} = await trustedComposition(f, [mr.revision_id], {composition: {base_commit: commit(18001)}});
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id], OWNER, {composition_id: composition.id}), 'MR_BLOCKED');
});

test('an external composed CI report cannot authorize a candidate even when it labels itself trusted', async () => {
  const f = fixture();
  let mr = await f.open('declared-composed-ci');
  const {composition} = await trustedComposition(f, [mr.revision_id], {evidence: {source: 'producer-owned checks'}});
  mr = await f.requests.check(mr.id, {name: 'trusted-validation', status: 'passed', expected_version: mr.version,
    expected_revision_id: mr.revision_id, composition_id: composition.id, subject_ref: composition.id,
    source: 'platform-owned checks', trusted: true}, 'producer-ci');
  assert.equal(mr.check_runs.at(-1).basis, 'declared');
  await f.expectError(() => f.requests.guardRevisionIds([mr.revision_id], OWNER, {composition_id: composition.id}), 'MR_BLOCKED');
});

async function retainedRevision(f) {
  const head = commit(19001), tree = commit(19002);
  const proposal = {id: 'internal-revert-proposal', repo: 'service', source_repo: 'service', ref: `refs/converge/candidates/${head}`,
    title: 'Revert a reviewed implementation'};
  const revision = await record('rev', {proposal_id: proposal.id, repo: 'service', source_repo: 'service', source_kind: 'retained-candidate',
    base_commit: BASE, head_commit: head, tree_hash: tree, context_version: 'internal-revert-context', affected_scope: ['src/service.mjs'],
    provenance_state: 'declared', context_binding_state: 'unknown'});
  f.state.proposals.push(proposal);
  f.state.revisions.push(revision);
  f.state.refVersions[`service:${proposal.ref}`] = head;
  f.objects.set(head, {tree, scope: revision.affected_scope});
  return {proposal, revision};
}

test('retained internal candidates use exact immutable Git facts instead of requiring a producer branch', async () => {
  const f = fixture();
  const {proposal, revision} = await retainedRevision(f);
  const ordinaryRef = f.git.ref;
  f.git.ref = async (repo, ref) => {
    assert.notEqual(ref, proposal.ref, 'An internal retained candidate must not require an ordinary branch ref');
    return ordinaryRef(repo, ref);
  };
  assert.equal((await f.requests.guardRevisionIds([revision.id], OWNER)).allowed, true);
  assert.deepEqual(f.writes, []);
});

test('missing or mismatched immutable retained candidate objects block eligibility', async () => {
  for(const invalidate of [
    (f, revision) => {f.objects.delete(revision.head_commit);},
    (f, revision) => {f.objects.set(revision.head_commit, {tree: commit(19003), scope: revision.affected_scope});},
    (f, revision) => {f.git.facts = async () => ({head: commit(19004), tree: revision.tree_hash, scope: revision.affected_scope});},
  ]) {
    const f = fixture();
    const {revision} = await retainedRevision(f);
    invalidate(f, revision);
    await f.expectError(() => f.requests.guardRevisionIds([revision.id], OWNER), 'MR_STALE');
    assert.deepEqual(f.writes, []);
  }
});

test('failed selected composition blocks convergence even when each individual revision passed trusted validation', async () => {
  const f = fixture();
  const first = await f.open('individually-safe-first');
  const second = await f.open('individually-safe-second');
  const ids = [first.revision_id, second.revision_id];
  for(const id of ids)await trustedEvidence(f, f.engine.revision(id));
  assert.equal((await f.requests.guardRevisionIds(ids, OWNER)).allowed, true, 'Isolated checks establish only their individual revision claims');
  const {composition, evidence} = await trustedComposition(f, ids, {evidence: {
    result: {passed: false, checks: [{check_ref: 'platform:composed-contract-v1', passed: false,
      detail: 'The textually merged candidate repeats a non-idempotent side effect.'}]},
  }});
  await f.expectError(() => f.requests.guardRevisionIds(ids, OWNER, {composition_id: composition.id}), 'MR_BLOCKED');
  assert.equal(evidence.result.passed, false);
  assert.equal(f.state.evidence.filter(item => ids.includes(item.subject_ref)).every(item => item.result.passed), true,
    'Historical passing isolated checks remain intact without authorizing their failing composition');
  assert.deepEqual(f.writes, []);
});

async function canonicalDependency(f, dependency, {head = commit(26001), repo = dependency.repo} = {}) {
  f.objects.set(head, {tree: commit(27001), scope: ['src/service.mjs']});
  f.heads.set(`${repo}:refs/heads/main`, head);
  f.state.repositories.find(item => item.id === repo).head = head;
  f.ancestry.add(`${repo}:${dependency.head_commit}:${head}`);
  await f.requests.reconcileDecision({id: 'exact-dependency-merge', actor: OWNER, proposal_revision_ids: [dependency.revision_id], deferred_revision_ids: []}, head);
  return head;
}

test('a historical merged dependency cannot authorize work after canonical force-push removes its exact commit', async () => {
  const f = fixture();
  const dependency = await f.open('present-dependency');
  let dependent = await f.open('dependent-after-removal');
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  await canonicalDependency(f, dependency);
  await trustedEvidence(f, f.engine.revision(dependent.revision_id));
  assert.equal((await f.requests.guardRevisionIds([dependent.revision_id], OWNER)).allowed, true);
  const original = f.requests.get(dependency.id);
  const unrelatedHead = commit(26002);
  f.objects.set(unrelatedHead, {tree: commit(27002), scope: []});
  f.heads.set('service:refs/heads/main', unrelatedHead);
  f.state.repositories[0].head = unrelatedHead;
  await trustedEvidence(f, f.engine.revision(dependent.revision_id));
  await assert.rejects(() => f.requests.guardRevisionIds([dependent.revision_id], OWNER), error => error.code === 'MR_BLOCKED' && error.details.reasons.some(reason => reason.code === 'DEPENDENCY_NOT_PRESENT'));
  assert.deepEqual(f.requests.get(dependency.id), original, 'Current eligibility cannot rewrite historical merge facts.');
  assert.equal(f.requests.get(dependent.id).dependencies[0].declared_revision_id, dependency.revision_id);
  assert.deepEqual(f.writes, []);
});

test('a reverted dependency blocks eligibility even while its exact source commit remains an ancestor', async () => {
  const f = fixture();
  const dependency = await f.open('reverted-dependency');
  let dependent = await f.open('dependent-on-reverted');
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  const canonical = await canonicalDependency(f, dependency);
  await trustedEvidence(f, f.engine.revision(dependent.revision_id));
  assert.equal((await f.requests.guardRevisionIds([dependent.revision_id], OWNER)).allowed, true);
  await f.requests.reconcileDecision({id: 'undo-dependency', actor: OWNER, reverts_decision_id: 'exact-dependency-merge', proposal_revision_ids: [], deferred_revision_ids: []}, commit(26003));
  assert.equal(await f.git.isAncestor(f.state.repositories[0], dependency.head_commit, canonical), true);
  await assert.rejects(() => f.requests.guardRevisionIds([dependent.revision_id], OWNER), error => error.code === 'MR_BLOCKED' && error.details.reasons.some(reason => reason.code === 'DEPENDENCY_REVERTED'));
  assert.equal(f.requests.get(dependency.id).status, 'merged');
  assert.equal(f.requests.get(dependency.id).reverted_by_decision, 'undo-dependency');
  assert.equal(f.requests.get(dependent.id).dependencies[0].reverted_by_decision, 'undo-dependency');
  assert.deepEqual(f.writes, []);
});

test('current dependency presence fails closed when ancestry is unavailable or canonical observation is outdated', async () => {
  for (const invalidate of [
    f => {delete f.git.isAncestor;},
    f => {f.git.isAncestor = async () => {throw new Error('Ancestry unavailable');};},
    f => {f.heads.set('service:refs/heads/main', commit(26004));},
  ]) {
    const f = fixture();
    const dependency = await f.open('uncertain-dependency');
    let dependent = await f.open('dependent-with-uncertain-presence');
    dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
    await canonicalDependency(f, dependency);
    await trustedEvidence(f, f.engine.revision(dependent.revision_id));
    invalidate(f);
    await assert.rejects(() => f.requests.guardRevisionIds([dependent.revision_id], OWNER), error => error.code === 'MR_BLOCKED' && error.details.reasons.some(reason => reason.code === 'DEPENDENCY_NOT_PRESENT'));
    assert.equal(f.requests.get(dependency.id).status, 'merged');
    assert.deepEqual(f.writes, []);
  }
});

test('fork dependency ancestry receives its source-repository import descriptor', async () => {
  const f = fixture();
  f.state.forks.push({id: 'producer-fork', repo: 'service'});
  f.push('fork-dependency', {repo: 'producer-fork'});
  const dependency = await f.requests.open({repo: 'service', source_repo: 'producer-fork', source_ref: 'refs/heads/fork-dependency', title: 'Fork dependency'}, OWNER);
  let dependent = await f.open('dependent-on-fork');
  dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
  const head = await canonicalDependency(f, dependency);
  await trustedEvidence(f, f.engine.revision(dependent.revision_id));
  const calls = [], original = f.git.isAncestor;
  f.git.isAncestor = async (repo, ancestor, descendant) => {calls.push({repo, ancestor, descendant});return original(repo, ancestor, descendant);};
  assert.equal((await f.requests.guardRevisionIds([dependent.revision_id], OWNER)).allowed, true);
  const proof = calls.find(call => call.ancestor === dependency.head_commit && call.descendant === head);
  assert.equal(proof.repo.id, 'service');
  assert.equal(proof.repo.source_repo, 'producer-fork');
  assert.deepEqual(f.writes, []);
});

test('closed or draft dependencies cannot hide behind selection in a same-repository batch', async () => {
  for (const action of ['draft', 'close']) {
    const f = fixture();
    let dependency = await makeEligible(f, await f.open('unready-dependency'));
    let dependent = await makeEligible(f, await f.open('dependent-on-unready'));
    dependent = await f.requests.dependencies(dependent.id, {dependency_ids: [dependency.id], expected_version: dependent.version}, OWNER);
    dependency = await f.requests.transition(dependency.id, {action, expected_version: dependency.version}, OWNER);
    await assert.rejects(() => f.requests.guardRevisionIds([dependency.revision_id, dependent.revision_id], OWNER), error => error.code === 'MR_BLOCKED' && error.details.reasons.some(reason => reason.mr_id === dependent.id && reason.code === 'DEPENDENCY_REQUIRED'));
    assert.equal(f.requests.get(dependency.id).status, action === 'close' ? 'closed' : 'open');
  }
});

test('reverting an externally observed merge commit marks matching historical merge requests without a platform decision ID', async () => {
  const f = fixture();
  const dependency = await f.open('external-dependency');
  const unrelated = await f.open('external-unrelated');
  const mergedHead = commit(26005);
  f.objects.set(mergedHead, {tree: commit(27005), scope: ['src/service.mjs']});
  f.ancestry.add(`service:${dependency.head_commit}:${mergedHead}`);
  f.heads.set('service:refs/heads/main', mergedHead);
  await f.requests.reconcileCanonical('service', BASE, mergedHead);
  assert.equal(f.requests.get(dependency.id).resolution_decision_id, undefined);
  assert.equal(f.requests.get(dependency.id).merge_commit, mergedHead);
  const revert = {id: 'revert-external-merge', actor: OWNER, reverts_commit: mergedHead, proposal_revision_ids: [], deferred_revision_ids: []};
  const changed = await f.requests.reconcileDecision(revert, commit(26006));
  assert.equal(changed.length, 1);
  const history = f.requests.get(dependency.id);
  assert.equal(history.status, 'merged');
  assert.equal(history.merge_commit, mergedHead);
  assert.equal(history.reverted_by_decision, revert.id);
  assert.equal(f.requests.get(unrelated.id).status, 'open');
  assert.equal(f.requests.get(unrelated.id).reverted_by_decision, undefined);
  const event = history.events.find(event => event.type === 'decision.reverted');
  assert.equal(event.data.original_decision_id, null);
  assert.equal(event.data.original_merge_commit, mergedHead);
  assert.equal(event.data.reverts_commit, mergedHead);
  assert.deepEqual(await f.requests.reconcileDecision(revert, commit(26006)), []);
  assert.deepEqual(f.requests.get(dependency.id), history);
  assert.deepEqual(f.writes, []);
});

test('unavailable source ancestry preserves workspace reads and native canonical ingestion without inventing a merge', async () => {
  for (const code of ['MISSING_COMMIT', 'ANCESTRY_UNAVAILABLE', 'GIT_EXECUTOR_UNAVAILABLE', 'REPO_NOT_CONFIGURED', 'REMOTE_GIT_FAILED', 'CONFIG_STALE']) {
    const f = fixture();
    const mr = await f.open('unavailable-old-source');
    const before = f.requests.get(mr.id);
    const firstHead = commit(28001), secondHead = commit(28002);
    f.objects.set(firstHead, {tree: commit(29001), scope: []});
    f.objects.set(secondHead, {tree: commit(29002), scope: []});
    f.objects.delete(mr.head_commit);
    f.git.isAncestor = async () => {throw new DomainError(code, 'Bounded ancestry input or executor unavailable', 503);};
    f.heads.set('service:refs/heads/main', firstHead);
    assert.equal(await f.engine.syncHeads(), true);
    assert.equal(f.state.repositories[0].head, firstHead);
    const view = await f.engine.view();
    assert.equal(view.repositories[0].head, firstHead);
    assert.deepEqual(f.requests.get(mr.id), before);
    const audit = f.state.audit.filter(event => event.type === 'mr.ancestry-unavailable' && event.data.mr_id === mr.id && event.data.canonical_head === firstHead);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].data.source_commit, mr.head_commit);
    assert.equal(audit[0].data.code, code);
    await f.requests.reconcileCanonical('service', BASE, firstHead);
    assert.equal(f.state.audit.filter(event => event.type === 'mr.ancestry-unavailable' && event.data.canonical_head === firstHead).length, 1);
    f.heads.set('service:refs/heads/main', secondHead);
    const event = await f.engine.ingest({repo: 'service', ref: 'refs/heads/main', after: secondHead});
    assert.equal(event.canonical, true);
    assert.equal(event.head, secondHead);
    assert.equal((await f.engine.view()).repositories[0].head, secondHead);
    assert.deepEqual(f.requests.get(mr.id), before);
    assert.equal(f.state.audit.filter(event => event.type === 'mr.ancestry-unavailable' && event.data.canonical_head === secondHead).length, 1);
    assert.deepEqual(f.writes, []);
  }
});

test('one unavailable source does not prevent exact observed ancestry from reconciling another merge request', async () => {
  const f = fixture();
  const unavailable = await f.open('unknown-old-source');
  const included = await f.open('known-source-ancestor');
  const head = commit(28003);
  f.objects.set(head, {tree: commit(29003), scope: []});
  f.ancestry.add(`service:${included.head_commit}:${head}`);
  f.heads.set('service:refs/heads/main', head);
  const original = f.git.isAncestor;
  f.git.isAncestor = async (repo, ancestor, descendant) => {if (ancestor === unavailable.head_commit) throw new DomainError('MISSING_COMMIT', 'Old source object unavailable', 404);return original(repo, ancestor, descendant);};
  assert.equal(await f.engine.syncHeads(), true);
  assert.equal(f.requests.get(unavailable.id).status, 'open');
  assert.equal(f.requests.get(included.id).status, 'merged');
  assert.equal(f.requests.get(included.id).resolution, 'external-ancestry');
  assert.equal(f.state.audit.filter(event => event.type === 'mr.ancestry-unavailable').length, 1);
  assert.deepEqual(f.writes, []);
});

test('unexpected ancestry defects propagate without being mislabeled as ordinary unavailability', async () => {
  const f = fixture();
  const mr = await f.open('unexpected-ancestry-defect');
  f.git.isAncestor = async () => {throw new Error('Unexpected adapter defect');};
  await assert.rejects(() => f.requests.reconcileCanonical('service', BASE, commit(28004)), /Unexpected adapter defect/);
  assert.equal(f.requests.get(mr.id).status, 'open');
  assert.equal(f.state.audit.filter(event => event.type === 'mr.ancestry-unavailable').length, 0);
  assert.deepEqual(f.writes, []);
});

async function platformRerun(f, previous, result, overrides = {}) {
  const {id, ...inputs} = previous;
  const evidence = await record('ev', {...inputs, result, created_at: '2020-01-01T00:00:00.000Z', ...overrides});
  f.state.evidence.push(evidence);
  return evidence;
}

test('latest current platform failure, pending or cancellation supersedes an old pass and fresh success changes the reviewed MR basis', async () => {
  for (const required of ['trusted-validation', 'platform:finite-contract-v1']) for (const [status, passed] of [['failed', false], ['pending', true], ['cancelled', true], ['running', false]]) {
    const f = fixture();
    f.state.repositories[0].merge_request_policy = {requiredChecks: [required]};
    const mr = await f.open('latest-platform-result');
    const revision = f.engine.revision(mr.revision_id);
    const first = await trustedEvidence(f, revision, {result: {passed: true, checks: [{check_ref: 'platform:finite-contract-v1', passed: true}]}});
    const firstBasis = await f.requests.basisFor([revision.id]);
    assert.equal((await f.requests.guardRevisionIds([revision.id], OWNER)).allowed, true);
    const stopped = await platformRerun(f, first, {passed, status, checks: [{check_ref: 'platform:finite-contract-v1', passed: status !== 'failed'}]});
    const current = f.requests.get(mr.id).checks_state;
    assert.deepEqual(current.passed, []);
    assert.deepEqual(current.missing, [required]);
    assert.deepEqual(current.evidence_ids, [stopped.id]);
    assert.equal(current.evidence_states[0].status, status);
    assert.equal(current.evidence_states[0].passed, false);
    assert.equal(first.result.passed, true);
    const stoppedBasis = await f.requests.basisFor([revision.id]);
    assert.notEqual(stoppedBasis, firstBasis);
    await f.expectError(() => f.requests.guardRevisionIds([revision.id], OWNER), 'MR_BLOCKED');
    const fresh = await platformRerun(f, first, {passed: true, status: 'passed', checks: [{check_ref: 'platform:finite-contract-v1', passed: true}]}, {created_at: '2019-01-01T00:00:00.000Z'});
    assert.equal((await f.requests.guardRevisionIds([revision.id], OWNER)).allowed, true, 'Trusted append order supersedes outcome independently of timestamps.');
    assert.deepEqual(f.requests.get(mr.id).checks_state.evidence_ids, [fresh.id]);
    const freshBasis = await f.requests.basisFor([revision.id]);
    assert.notEqual(freshBasis, firstBasis);
    assert.notEqual(freshBasis, stoppedBasis);
    assert.equal(f.state.evidence.includes(first), true);
    assert.equal(f.state.evidence.includes(stopped), true);
    assert.deepEqual(f.writes, []);
  }
});

test('latest exact composition outcome controls selected checks rather than any historical passing run', async () => {
  for (const [status, passed] of [['failed', false], ['pending', true], ['cancelled', true]]) {
    const f = fixture();
    const first = await f.open('latest-composed-first'), second = await f.open('latest-composed-second');
    const ids = [first.revision_id, second.revision_id];
    const {composition, evidence} = await trustedComposition(f, ids);
    assert.equal((await f.requests.guardRevisionIds(ids, OWNER, {composition_id: composition.id})).allowed, true);
    const stopped = await platformRerun(f, evidence, {passed, status, checks: [{check_ref: 'platform:composed-contract-v1', passed: true}]});
    await f.expectError(() => f.requests.guardRevisionIds(ids, OWNER, {composition_id: composition.id}), 'MR_BLOCKED');
    assert.equal(evidence.result.passed, true);
    const fresh = await platformRerun(f, evidence, {passed: true, status: 'passed', checks: [{check_ref: 'platform:composed-contract-v1', passed: true}]}, {created_at: '2019-01-01T00:00:00.000Z'});
    assert.equal((await f.requests.guardRevisionIds(ids, OWNER, {composition_id: composition.id})).allowed, true);
    assert.notEqual(fresh.id, evidence.id);
    assert.equal(f.state.evidence.includes(stopped), true);
    assert.deepEqual(f.writes, []);
  }
});

test('passing a selected fix composition does not require an isolated failing revision to acquire an invented passing claim', async () => {
  const f = fixture();
  const broken = await f.open('isolated-failure'), fix = await f.open('repair');
  await trustedEvidence(f, f.engine.revision(broken.revision_id), {result: {passed: false, status: 'failed', checks: [{name: 'Finite observed failure', passed: false}]}});
  await trustedEvidence(f, f.engine.revision(fix.revision_id));
  const ids = [broken.revision_id, fix.revision_id];
  await f.expectError(() => f.requests.guardRevisionIds(ids, OWNER), 'MR_BLOCKED');
  const {composition} = await trustedComposition(f, ids);
  assert.equal((await f.requests.guardRevisionIds(ids, OWNER, {composition_id: composition.id})).allowed, true);
  assert.deepEqual(f.requests.get(broken.id).checks_state.passed, [], 'The selected composed proof establishes only its own tree.');
  assert.deepEqual(f.writes, []);
});

test('declared CI outcomes cannot supersede or revive current platform-owned validation', async () => {
  const f = fixture();
  let mr = await f.open('ci-declarations');
  const revision = f.engine.revision(mr.revision_id), first = await trustedEvidence(f, revision);
  for (const status of ['failed', 'pending', 'cancelled']) {
    mr = await f.requests.check(mr.id, {name: 'trusted-validation', status, source: 'platform-owned checks', basis: 'observed', expected_version: mr.version, expected_revision_id: mr.revision_id}, 'external-ci');
    assert.equal(mr.check_runs.at(-1).source, 'external-ci');
    assert.equal(mr.check_runs.at(-1).basis, 'declared');
    assert.equal((await f.requests.guardRevisionIds([revision.id], OWNER)).allowed, true);
    assert.deepEqual(f.requests.get(mr.id).checks_state.evidence_ids, [first.id]);
  }
  const failed = await platformRerun(f, first, {passed: false, status: 'failed', checks: [{name: 'Trusted failure', passed: false}]});
  mr = await f.requests.check(mr.id, {name: 'trusted-validation', status: 'passed', source: 'platform-owned checks', expected_version: mr.version, expected_revision_id: mr.revision_id}, 'external-ci');
  await platformRerun(f, first, {passed: true}, {source: 'external-ci', created_at: '2999-01-01T00:00:00.000Z'});
  await f.expectError(() => f.requests.guardRevisionIds([revision.id], OWNER), 'MR_BLOCKED');
  assert.deepEqual(f.requests.get(mr.id).checks_state.evidence_ids, [failed.id]);
  assert.deepEqual(f.writes, []);
});

test('latest pending or cancelled individual checks cannot inherit a stale aggregate passed flag', async () => {
  for (const status of ['pending', 'running', 'failed', 'cancelled']) {
    const f = fixture();
    f.state.repositories[0].merge_request_policy = {requiredChecks: ['platform:finite-contract-v1']};
    const mr = await f.open('partial-platform-check');
    const revision = f.engine.revision(mr.revision_id);
    const first = await trustedEvidence(f, revision, {result: {passed: true, checks: [{check_ref: 'platform:finite-contract-v1', passed: true}]}});
    const latest = await platformRerun(f, first, {passed: true, checks: [{check_ref: 'platform:finite-contract-v1', passed: true, status}]});
    await f.expectError(() => f.requests.guardRevisionIds([revision.id], OWNER), 'MR_BLOCKED');
    assert.deepEqual(f.requests.get(mr.id).checks_state.evidence_ids, [latest.id]);
    assert.equal(f.requests.get(mr.id).checks_state.evidence_states[0].status, status);
    assert.deepEqual(f.requests.get(mr.id).checks_state.passed, []);
  }
});

test('unrelated or stale validation lineages cannot supersede the exact current platform subject and tree', async () => {
  const f = fixture();
  const mr = await f.open('lineage-bounds'), revision = f.engine.revision(mr.revision_id);
  const first = await trustedEvidence(f, revision);
  for (const overrides of [
    {subject_ref: 'unrelated-subject'}, {tree_hash: commit(31001)}, {config_hash: 'retired-configuration'},
    {validity_heads: {service: commit(31002)}}, {constraint_versions: ['retired-constraint']},
  ]) await platformRerun(f, first, {passed: false, status: 'failed', checks: []}, overrides);
  assert.equal((await f.requests.guardRevisionIds([revision.id], OWNER)).allowed, true);
  assert.deepEqual(f.requests.get(mr.id).checks_state.evidence_ids, [first.id]);
  assert.deepEqual(f.writes, []);
});
