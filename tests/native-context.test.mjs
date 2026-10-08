import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, emptyState } from '../core/engine.mjs';
import { NativeContext } from '../core/native-context.mjs';
import { LocalGit, git } from '../server/git.mjs';
import { record } from '../core/hash.mjs';

const ref = 'refs/heads/main';
const policy = {
  id: 'delivery-policy',
  visibility: 'coordination',
  version: 'v0',
  type: 'constraint',
  kind: 'advisory',
  statement: 'Delivery must preserve the chosen behavior after a lost response.',
  scope: [{ repo_id: 'app', path: 'client/delivery.mjs' }],
  choice: {
    key: 'lost-response-behavior',
    question: 'Should the client retry after the server processed a request but its response was lost?',
    options: [
      { id: 'retry', label: 'Retry', effects: ['The client repeats the request after a lost response.'] },
      { id: 'surface', label: 'Surface failure', effects: ['The client returns an uncertain result without retrying.'] },
    ],
  },
};

async function fixture(t, document = { constraints: [policy], secret: 'HIDDEN_SECRET' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-native-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'repositories'));
  const adapter = new LocalGit(root);
  const repositories = [];
  const workspaces = {};
  for (const id of ['app', 'policy']) {
    const work = path.join(root, id + '-work');
    await git(root, ['init', '--quiet', '-b', 'main', work]);
    await writeFile(path.join(work, id === 'policy' ? 'policy.json' : 'README.md'),
      id === 'policy' ? JSON.stringify(document) : '# Application\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'baseline']);
    const head = await git(work, ['rev-parse', 'HEAD']);
    const tree = await git(work, ['rev-parse', 'HEAD^{tree}']);
    await git(root, ['clone', '--quiet', '--bare', work, adapter.dir({ id })]);
    repositories.push({ id, canonical_ref: ref, head, tree, baseline: head });
    workspaces[id] = work;
  }
  const state = {
    ...emptyState(),
    repositories,
    systems: [{ id: 'system', name: 'Delivery', repository_refs: repositories.map((repo) => ({
      repo_id: repo.id, ref,
    })) }],
    objectives: [{
      id: 'objective', system_id: 'system', statement: 'Improve response handling.',
      scope: ['client/delivery.mjs'], status: 'open', source: { basis: 'declared', actor: 'owner' },
    }],
    futures: [], futureRevisions: [],
  };
  const engine = new Engine(state, adapter);
  engine.objectiveContext = new NativeContext(engine);
  const context = engine.objectiveContext;
  return {
    root, state, adapter, engine, context, workspaces,
    async prepare(requestId = 'prepare', sources = [{ repo_id: 'policy', path: 'policy.json' }]) {
      return context.prepare('objective', { sources, request_id: requestId }, 'owner');
    },
    async resolve(preparation, mode = 'answer', requestId = 'answer', option = 'retry') {
      return context.resolve(preparation.id, {
        expected_basis_hash: preparation.basis_hash,
        mode,
        answers: Object.fromEntries(preparation.questions.map((question) => [question.id, option])),
        ...(mode === 'assumption' ? { rationale: 'Proceed under this explicit assumption until confirmed.' } : {}),
        request_id: requestId,
      }, 'owner');
    },
    async changePolicy(document) {
      const work = workspaces.policy;
      await writeFile(path.join(work, 'policy.json'), JSON.stringify(document));
      await git(work, ['add', '.']);
      await git(work, ['commit', '--quiet', '-m', 'update context source']);
      await git(work, ['push', '--quiet', adapter.dir({ id: 'policy' }), 'HEAD:' + ref]);
    },
    async bindRevision(snapshotId = null, provenance = 'unknown') {
      const binding = await context.bindFuture(state.objectives[0], snapshotId);
      const future = {
        id: 'future-' + state.futures.length,
        objective_id: 'objective', system_id: 'system', provenance_state: provenance,
        ...binding,
      };
      state.futures.push(future);
      const repo = repositories[0];
      const revision = await record('future_revision', {
        future_id: future.id,
        repository_heads: [{ repo_id: 'app', source_repo_id: 'app', ref, commit: repo.head }],
        tree_hashes: [{ repo_id: 'app', tree: repo.tree }],
        baseline_refs: [{ repo_id: 'app', ref, commit: repo.head, tree: repo.tree }],
        affected_scope: [{ repo_id: 'app', paths: ['client/delivery.mjs'] }],
        provenance_state: provenance, ...binding,
      });
      state.futureRevisions.push(revision);
      return revision;
    },
  };
}

test('plain Objectives retrieve exact cross-repository context and ask only a material annotated question', async (t) => {
  const redundant = {
    ...policy, id: 'logging-policy',
    choice: {
      key: 'log-format', question: 'Which log spelling?',
      options: [
        { id: 'a', label: 'First', effects: ['Records the same event.'] },
        { id: 'b', label: 'Second', effects: ['Records the same event.'] },
      ],
    },
  };
  const f = await fixture(t, { constraints: [policy, redundant] });
  const { preparation, snapshot } = await f.prepare();
  assert.equal(snapshot, null);
  assert.equal(preparation.questions.length, 1);
  assert.equal(preparation.questions[0].basis, 'inferred');
  assert.equal(preparation.questions[0].rule, 'distinct-declared-effects-v0');
  const source = preparation.sources[0];
  assert.equal(source.repo_id, 'policy');
  assert.equal(source.commit, await f.adapter.ref(f.engine.repo('policy'), ref));
  assert.equal(source.tree, (await f.adapter.facts(f.engine.repo('policy'), source.commit, source.commit)).tree);
  assert.ok(preparation.items.some((item) => item.type === 'objective' && item.basis === 'declared'));
  assert.ok(preparation.items.some((item) => item.type === 'constraint' && item.basis === 'retrieved'));
  assert.ok(preparation.items.some((item) => item.type === 'git-state' && item.basis === 'observed'));
  assert.equal((await f.prepare('same-stable-inputs')).preparation.id, preparation.id);
  assert.ok(Object.isFrozen(preparation));
  assert.ok(Object.isFrozen(preparation.questions[0].options));
});

test('answers bind immutable snapshots; provenance does not claim unknown producers were identified', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  const result = await f.resolve(preparation);
  assert.equal(result.snapshot.resolutions[0].type, 'answer');
  assert.equal(result.snapshot.resolutions[0].basis, 'declared');
  assert.equal(result.snapshot.resolutions[0].unresolved_truth, false);
  assert.deepEqual(result.snapshot.assumption_refs, []);
  const revision = await f.bindRevision(result.snapshot.id);
  assert.equal(revision.provenance_state, 'unknown');
  assert.equal(revision.context_binding_state, 'bound');
  assert.equal(revision.context_snapshot, result.snapshot.id);
  const trace = f.context.trace({ kind: 'revision', id: revision.id });
  assert.equal(trace.revisions[0].provenance_state, 'unknown');
  assert.equal(trace.snapshots[0].id, result.snapshot.id);
  assert.equal(trace.preparations[0].questions[0].id, preparation.questions[0].id);
  const retry = await f.resolve(preparation);
  assert.equal(retry.snapshot.id, result.snapshot.id);
  assert.equal(f.state.nativeContextResolutions.length, 1);
  await assert.rejects(f.resolve(preparation, 'answer', 'another-answer'), { code: 'CONTEXT_ALREADY_RESOLVED' });
});

test('unanswered questions become explicit assumptions and unrelated producers can remain unknown', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  const unknown = await f.bindRevision();
  assert.equal(unknown.context_snapshot, null);
  assert.equal(f.context.provenanceForRevision(unknown).context_state, 'unknown');
  const { snapshot } = await f.resolve(preparation, 'assumption', 'assume');
  assert.equal(snapshot.assumption_refs.length, 1);
  assert.equal(snapshot.resolutions[0].unresolved_truth, true);
  const assumed = await f.bindRevision(snapshot.id);
  const status = await f.context.revisionsValidity([unknown.id, assumed.id]);
  assert.equal(status.status, 'current');
  assert.equal(status.unknown_revision_count, 1);
  assert.equal(status.requires_human_judgment, true);
  assert.deepEqual(status.snapshots[0].assumption_refs, snapshot.assumption_refs);
});

test('question answers use reviewed basis CAS and remain stale after source ref movement', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  await assert.rejects(f.context.resolve(preparation.id, {
    expected_basis_hash: 'unreviewed-basis',
    mode: 'answer', answers: { [preparation.questions[0].id]: 'retry' }, request_id: 'stale-answer',
  }, 'owner'), { code: 'CONTEXT_STALE' });
  await f.changePolicy({ constraints: [{ ...policy, version: 'v1' }] });
  const review = await f.context.review(preparation.id);
  assert.equal(review.validity.status, 'stale');
  await assert.rejects(f.resolve(preparation), { code: 'CONTEXT_STALE' });
  assert.equal(f.state.nativeContextSnapshots.length, 0);
});

test('context remains historical after a source or relevant constraint version changes', async (t) => {
  const f = await fixture(t);
  f.state.constraints.push({
    id: 'constraint-v0', active: true, kind: 'advisory',
    statement: 'Response handling must remain observable.', scope: ['client/delivery.mjs'],
  });
  const { preparation } = await f.prepare();
  const { snapshot } = await f.resolve(preparation);
  const revision = await f.bindRevision(snapshot.id);
  f.state.constraints[0] = { ...f.state.constraints[0], id: 'constraint-v1', statement: 'Record response uncertainty.' };
  assert.equal((await f.context.validity(snapshot.id)).status, 'stale');
  assert.equal((await f.context.revisionsValidity([revision.id])).status, 'stale');
  assert.equal(f.context.trace({ kind: 'revision', id: revision.id }).snapshots[0].id, snapshot.id);
  await assert.rejects(f.context.bindFuture(f.state.objectives[0], snapshot.id), { code: 'CONTEXT_STALE' });
  assert.equal(preparation.applicable.constraints[0].id, 'constraint-v0');
});

test('unrelated scoped constraints do not invalidate context', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  const { snapshot } = await f.resolve(preparation);
  f.state.constraints.push({
    id: 'unrelated', active: true, kind: 'advisory',
    statement: 'Dashboard layout is separate.', scope: ['dashboard/layout.jsx'],
  });
  assert.equal((await f.context.validity(snapshot.id)).status, 'current');
});

test('raw files and producer secrets are excluded from scoped search and metadata export', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  await f.resolve(preparation);
  const exported = f.context.export('system');
  assert.equal(JSON.stringify(exported).includes('HIDDEN_SECRET'), false);
  assert.equal(JSON.stringify(exported).includes('"content":'), false);
  assert.equal(f.context.search({ system_id: 'system', query: 'HIDDEN_SECRET' }).length, 0);
  const matches = f.context.search({ system_id: 'system', query: 'lost response', limit: 1 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].objective_id, 'objective');
  await assert.rejects(f.prepare('secret-path', [{ repo_id: 'policy', path: '.env' }]), { code: 'INVALID_CONTEXT_PATH' });
  await assert.rejects(f.prepare('parent-path', [{ repo_id: 'policy', path: '../policy.json' }]), { code: 'INVALID_CONTEXT_PATH' });
});

test('generic non-retry choices work, while unannotated prose remains retrieved data', async (t) => {
  const document = {
    id: 'cache-policy', version: 'v0', visibility: 'coordination',
    statement: 'Choose the cache invalidation strategy.',
    scope: [{ repo_id: 'app', path: 'client/delivery.mjs' }],
    choice: {
      key: 'cache-invalidation', question: 'Use bounded TTL or explicit invalidation?',
      options: [
        { id: 'ttl', label: 'TTL', effects: ['Stale data is bounded by the chosen TTL.'] },
        { id: 'explicit', label: 'Explicit', effects: ['Every update must invalidate matching keys.'] },
      ],
    },
  };
  const f = await fixture(t, document);
  const { preparation } = await f.prepare();
  assert.equal(preparation.questions.length, 1);
  assert.equal(preparation.questions[0].key, 'cache-invalidation');
  const result = await f.resolve(preparation, 'answer', 'cache-answer', 'ttl');
  assert.equal(result.snapshot.resolutions[0].value.option_id, 'ttl');
  const plain = await f.prepare('readme-context', [{ repo_id: 'app', path: 'README.md' }]);
  assert.equal(plain.preparation.questions.length, 0);
  assert.ok(plain.snapshot);
  assert.ok(plain.preparation.items.some((item) => item.type === 'source' && item.basis === 'retrieved'));
  assert.equal(JSON.stringify(plain.preparation).includes('# Application'), false);
});

test('decision trace preserves rationale and exact selected Git origins without trusting producer metadata', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  const { snapshot } = await f.resolve(preparation);
  const revision = await f.bindRevision(snapshot.id);
  const repo = f.engine.repo('app');
  const selection = await record('selection', {
    future_revision_id: revision.id, kind: 'future',
    entries: [{ repo_id: 'app', source_repo: 'app', head_commit: repo.head, commits: [] }],
  });
  const candidate = await record('candidate', {
    selection_ids: [selection.id],
    repositories: [{ repo_id: 'app', commit: repo.head, tree: repo.tree }],
  });
  const decision = await record('native-decision', {
    candidate_id: candidate.id, resolution: 'accept',
    rationale: 'Keep the explicit retry choice and retain its uncertainty.',
    actor: 'owner', decision_basis_hash: 'reviewed-basis',
  });
  f.state.selections = [selection];
  f.state.candidateStates = [candidate];
  f.state.nativeDecisions = [decision];
  f.state.operations = [{ id: 'operation', decision_id: decision.id, status: 'applied' }];
  const trace = f.context.trace({ kind: 'decision', id: decision.id });
  assert.equal(trace.decisions[0].rationale, decision.rationale);
  assert.equal(trace.code_provenance[0].head_commit, repo.head);
  assert.equal(trace.code_provenance[0].basis, 'observed');
  assert.equal(trace.snapshots[0].id, snapshot.id);
  const reverse = f.context.trace({ kind: 'code', repo_id: 'app', id: repo.head });
  assert.equal(reverse.decisions[0].id, decision.id);
  assert.equal(reverse.snapshots[0].objective_id, 'objective');
  const forward = f.context.trace({ kind: 'objective', id: 'objective' });
  assert.equal(forward.decisions[0].id, decision.id);
  const later = await f.prepare('historical-context');
  assert.equal(later.preparation.applicable.decisions[0].id, decision.id);
  assert.equal(later.preparation.applicable.decisions[0].application_state, 'applied');
  // The newly recorded decision cannot invalidate its own immutable context.
  assert.equal((await f.context.validity(snapshot.id)).status, 'current');
});

test('two concurrent answers serialize to one immutable resolution and rejected alternatives remain absent', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  const results = await Promise.allSettled([
    f.engine.serial(() => f.resolve(preparation, 'answer', 'answer-one', 'retry')),
    f.engine.serial(() => f.resolve(preparation, 'answer', 'answer-two', 'surface')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CONTEXT_ALREADY_RESOLVED');
  assert.equal(f.state.nativeContextResolutions.length, 1);
  assert.equal(f.state.nativeContextSnapshots.length, 1);
  assert.equal(f.state.nativeContextSnapshots[0].resolutions[0].value.option_id, 'retry');
});

test('context cannot be bound to another Objective and answer fields cannot silently introduce extra choices', async (t) => {
  const f = await fixture(t);
  const { preparation } = await f.prepare();
  await assert.rejects(f.context.resolve(preparation.id, {
    expected_basis_hash: preparation.basis_hash, mode: 'answer',
    answers: { [preparation.questions[0].id]: 'retry', extra: 'surface' }, request_id: 'extra-choice',
  }, 'owner'), { code: 'INVALID_CONTEXT_ANSWER' });
  const { snapshot } = await f.resolve(preparation);
  await assert.rejects(f.context.bindFuture({ ...f.state.objectives[0], id: 'other' }, snapshot.id), { code: 'CONTEXT_OBJECTIVE_MISMATCH' });
  await assert.rejects(f.context.resolve(preparation.id, {
    expected_basis_hash: preparation.basis_hash, mode: 'answer',
    answers: { [preparation.questions[0].id]: 'retry' }, request_id: 'unauthenticated',
  }, ''), { code: 'UNAUTHENTICATED' });
});

test('named competing approaches preserve separate answers to the same pinned material question', async (t) => {
  const f = await fixture(t);
  const first = await f.context.prepare('objective', {
    sources: [{ repo_id: 'policy', path: 'policy.json' }],
    hypothesis: 'Retry strategy', request_id: 'prepare-retry',
  }, 'owner');
  const second = await f.context.prepare('objective', {
    sources: [{ repo_id: 'policy', path: 'policy.json' }],
    hypothesis: 'Surface uncertainty', request_id: 'prepare-surface',
  }, 'owner');
  assert.notEqual(first.preparation.id, second.preparation.id);
  assert.equal(first.preparation.questions[0].id, second.preparation.questions[0].id);
  const retry = await f.resolve(first.preparation, 'answer', 'answer-retry', 'retry');
  const surface = await f.resolve(second.preparation, 'answer', 'answer-surface', 'surface');
  assert.notEqual(retry.snapshot.id, surface.snapshot.id);
  assert.equal(retry.snapshot.hypothesis.basis, 'declared');
  assert.equal(retry.snapshot.resolutions[0].value.option_id, 'retry');
  assert.equal(surface.snapshot.resolutions[0].value.option_id, 'surface');
  assert.equal(f.state.nativeContextResolutions.length, 2);
});
