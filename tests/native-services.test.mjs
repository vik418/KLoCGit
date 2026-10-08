import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessControl } from '../core/access.mjs';
import { DomainError } from '../core/hash.mjs';
import { handleNativeRequest } from '../server/native-api.mjs';

const owner = { actor_id: 'owner', kind: 'human', auth_method: 'owner-token' };
const alice = { actor_id: 'alice', kind: 'human', auth_method: 'oidc' };

function fixture() {
  const calls = [];
  const objective = { id: 'objective', system_id: 'system', statement: 'Retry safely', scope: [] };
  const preparation = {
    id: 'preparation',
    objective_id: 'objective',
    sources: [{ repo_id: 'policy', path: 'policy.json', commit: 'a'.repeat(40) }],
    items: [],
    questions: [],
  };
  const candidate = {
    id: 'candidate',
    base_heads: { app: 'a'.repeat(40), policy: 'b'.repeat(40) },
    repositories: [{ repo_id: 'app', tree: 'c'.repeat(40), commit: 'd'.repeat(40) }],
    selection_ids: [],
  };
  const profile = { id: 'profile', repo_ids: ['app', 'policy'], mode: 'builtin' };
  const run = {
    id: 'run',
    candidate_id: candidate.id,
    profile_id: profile.id,
    pins: { repositories: candidate.repositories, canonical_heads: candidate.base_heads },
  };
  const engine = {
    state: {
      workspace: { id: 'workspace', owner_id: 'owner' },
      repositories: [{ id: 'app' }, { id: 'policy' }],
      nativeRepositories: [],
      objectives: [objective],
      systems: [{ id: 'system', repository_refs: [{ repo_id: 'app' }] }],
      nativeContextPreparations: [preparation],
      candidateStates: [candidate],
      evaluatorProfiles: [profile],
      evaluationRuns: [run],
      selections: [],
      operations: [{ id: 'operation', candidate_id: 'candidate' }],
      access: {
        schema_version: 1,
        owner_id: 'owner',
        version: 0,
        version_id: null,
        members: [{ actor_id: 'alice' }],
        grants: [{ actor_id: 'alice', repo_id: 'app', roles: ['producer'] }],
        limits: { pending_runs: 5 },
      },
    },
    native: {
      objective: (id) => {
        assert.equal(id, objective.id);
        return objective;
      },
      system: (id) => {
        assert.equal(id, 'system');
        return engine.state.systems[0];
      },
      async createFuture(input, actor) {
        calls.push({ operation: 'future', input, actor });
        return {
          future: {
            id: 'future',
            objective_id: objective.id,
            repository_ids: input.repository_ids,
          },
        };
      },
      async listRepositoryRefs(id, input) {
        calls.push({ operation: 'refs', id, input });
        return {
          repo_id: id,
          refs: [{ ref: 'refs/tags/v0', kind: 'tag' }],
          has_more: true,
          next_cursor: 'next',
        };
      },
      async retainRevision(id, input, actor) {
        calls.push({ operation: 'retain', id, input, actor });
        return { repo_id: 'app', retained: true };
      },
    },
    pipeline: {
      object: (collection, id) => {
        const value = engine.state[collection].find((item) => item.id === id);
        if (!value) throw new DomainError('NOT_FOUND', 'Object not found', 404);
        return value;
      },
      async reviewContinuation(id, candidateId) {
        calls.push({ operation: 'continuation.review', id, candidateId });
        return { candidate, continuation_of: id, decision_basis_hash: 'basis' };
      },
      async continuePromotion(id, input, actor) {
        calls.push({ operation: 'continuation', id, input, actor });
        return { operation: engine.state.operations[0] };
      },
      async settleOperation(id, input, actor) {
        calls.push({ operation: 'settle', id, input, actor });
        return { operation: engine.state.operations[0] };
      },
    },
    objectiveContext: {
      object: () => preparation,
      async prepare(id, input, actor) {
        calls.push({ operation: 'prepare', id, input, actor });
        return { preparation };
      },
      async review() {
        calls.push({ operation: 'context.review' });
        return { preparation };
      },
      async resolve(id, input, actor) {
        calls.push({ operation: 'resolve', id, input, actor });
        if (input.expected_basis_hash !== 'basis')
          throw new DomainError('CONTEXT_STALE', 'Context changed', 409);
        return { preparation, snapshot: { id: 'snapshot', objective_id: objective.id } };
      },
      export: () => ({
        system_id: 'system',
        preparations: [preparation],
        snapshots: [],
        resolutions: [],
      }),
      search: () => [{ preparation_id: preparation.id, item: { source: { repo_id: 'policy' } } }],
    },
    evaluators: {
      object: (collection, id) => engine.pipeline.object(collection, id),
      latest: () => ({ id: 'event', state: 'pending' }),
      view: () => ({ profiles: [profile], runs: [run] }),
      async report(id, body, authentication) {
        calls.push({ operation: 'report', id, body, authentication });
        return {
          run,
          event: { id: 'event', state: 'passing' },
          evidence: { private: 'unexposed' },
        };
      },
      async register(input, actor, principal) {
        calls.push({ operation: 'register', input, actor, principal });
        return { profile };
      },
    },
  };
  engine.access = new AccessControl(engine);
  return { engine, calls, candidate, preparation };
}

function request(
  engine,
  path,
  { method = 'GET', input = {}, principal = owner, requestHeaders } = {},
) {
  return handleNativeRequest(engine, {
    method,
    url: new URL(path, 'http://localhost'),
    input,
    actor: principal.actor_id,
    principal,
    requestHeaders,
  });
}

test('context authorization includes a source repository outside the Objective System', async () => {
  const { engine, calls } = fixture();
  for (const path of [
    '/api/context/preparation',
    '/api/context/search?system_id=system&query=retry',
    '/api/systems/system/context/export',
  ]) {
    await assert.rejects(() => request(engine, path, { principal: alice }), { code: 'FORBIDDEN' });
  }
  await assert.rejects(
    () =>
      request(engine, '/api/objectives/objective/context', {
        method: 'POST',
        principal: alice,
        input: { sources: [{ repo_id: 'policy', path: 'policy.json' }], request_id: 'prepare' },
      }),
    { code: 'FORBIDDEN' },
  );
  assert.deepEqual(calls, []);
  const result = await request(engine, '/api/objectives/objective/context', {
    method: 'POST',
    input: {
      sources: [{ repo_id: 'policy', path: 'policy.json' }],
      hypothesis: 'retry',
      request_id: 'prepare',
      actor: 'intruder',
      trusted: true,
    },
  });
  assert.equal(result.preparation.id, 'preparation');
  assert.equal(calls[0].actor, 'owner');
  assert.equal(Object.hasOwn(calls[0].input, 'trusted'), false);
});

test('context resolution preserves stale-basis errors and explicit answer versus assumption', async () => {
  const { engine, calls } = fixture();
  await assert.rejects(
    () =>
      request(engine, '/api/context/preparation/resolve', {
        method: 'POST',
        input: {
          expected_basis_hash: 'old',
          mode: 'answer',
          answers: { question: 'once' },
          request_id: 'old',
        },
      }),
    { code: 'CONTEXT_STALE', status: 409 },
  );
  const result = await request(engine, '/api/context/preparation/resolve', {
    method: 'POST',
    input: {
      expected_basis_hash: 'basis',
      mode: 'assumption',
      rationale: 'Awaiting the owner',
      request_id: 'new',
      evidence: { passing: true },
    },
  });
  assert.equal(result.snapshot.id, 'snapshot');
  assert.equal(calls.at(-1).input.mode, 'assumption');
  assert.equal(Object.hasOwn(calls.at(-1).input, 'evidence'), false);
});

test('authenticated identity cannot be replaced by body fields or a mismatched principal', async () => {
  const { engine, calls } = fixture();
  await assert.rejects(
    () =>
      handleNativeRequest(engine, {
        method: 'POST',
        url: '/api/futures',
        input: { repository_ids: ['app'] },
        actor: 'owner',
        principal: alice,
      }),
    { code: 'UNAUTHENTICATED' },
  );
  engine.state.nativeContextSnapshots = [
    {
      id: 'snapshot',
      objective_id: 'objective',
      preparation_id: 'preparation',
    },
  ];
  await assert.rejects(
    () =>
      request(engine, '/api/futures', {
        method: 'POST',
        principal: alice,
        input: {
          repository_ids: ['app'],
          objective_id: 'objective',
          context_snapshot_id: 'snapshot',
          request_id: 'private-fork',
          actor: 'owner',
        },
      }),
    { code: 'FORBIDDEN' },
  );
  await request(engine, '/api/futures', {
    method: 'POST',
    principal: alice,
    input: {
      repository_ids: ['app'],
      objective_id: 'objective',
      request_id: 'fork',
      actor: 'owner',
    },
  });
  assert.equal(calls[0].actor, 'alice');
  await request(engine, '/api/futures', {
    method: 'POST',
    input: {
      repository_ids: ['app'],
      objective_id: 'objective',
      context_snapshot_id: 'snapshot',
      request_id: 'owner-fork',
    },
  });
  assert.equal(calls[1].input.context_snapshot_id, 'snapshot');
});

test('tag pagination retains its scoped response and evaluator configuration requires policy rights', async () => {
  const { engine, calls } = fixture();
  const refs = await request(engine, '/api/repositories/app/refs?limit=5&cursor=start', {
    principal: alice,
  });
  assert.equal(refs.has_more, true);
  assert.equal(refs.next_cursor, 'next');
  assert.deepEqual(calls[0].input, { limit: 5, cursor: 'start' });
  await assert.rejects(
    () =>
      request(engine, '/api/evaluators', {
        method: 'POST',
        principal: alice,
        input: { repo_ids: ['app'], key: 'checks' },
      }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(calls.length, 1);
});

test('signed evaluator callback retains every signed body field but returns only a receipt', async () => {
  const { engine, calls } = fixture();
  const body = {
    event_id: 'callback',
    run_id: 'run',
    pins_hash: 'pins',
    state: 'passing',
    result: { checks: [{ id: 'integration', state: 'passing' }] },
    extra_signed_field: { value: 'must not be stripped before HMAC verification' },
  };
  const headers = new Headers({
    'x-klocgit-evaluator-service': 'trusted-ci',
    'x-klocgit-evaluator-signature': 'a'.repeat(64),
  });
  await assert.rejects(
    () =>
      request(engine, '/api/evaluation-runs/run/report', {
        method: 'POST',
        input: body,
        requestHeaders: headers,
      }),
    { code: 'UNAUTHENTICATED_EVALUATOR' },
  );
  assert.deepEqual(calls, []);
  const result = await request(engine, '/api/evaluation-runs/run/report', {
    method: 'POST',
    input: body,
    requestHeaders: headers,
    principal: { actor_id: 'evaluator:trusted-ci', kind: 'service', auth_method: 'evaluator-hmac' },
  });
  assert.equal(calls[0].body, body);
  assert.deepEqual(calls[0].authentication, {
    service_id: 'trusted-ci',
    signature: 'a'.repeat(64),
  });
  assert.deepEqual(result, {
    run_id: 'run',
    event_id: 'event',
    state: 'passing',
    duplicate: false,
  });
});

test('continuation is reviewed separately and requires authority for the complete dependency vector', async () => {
  const { engine, calls } = fixture();
  await assert.rejects(
    () =>
      request(engine, '/api/promotions/operation/continue', {
        method: 'POST',
        principal: alice,
        input: { candidate_id: 'candidate' },
      }),
    { code: 'FORBIDDEN' },
  );
  const review = await request(engine, '/api/promotions/operation/review?candidate_id=candidate');
  assert.equal(review.continuation_of, 'operation');
  await request(engine, '/api/promotions/operation/continue', {
    method: 'POST',
    input: {
      candidate_id: 'candidate',
      decision_basis_hash: 'basis',
      expected_heads: { app: 'a'.repeat(40), policy: 'b'.repeat(40) },
      rationale: 'Continue the remaining stage',
      request_id: 'continue',
      force: true,
    },
  });
  const call = calls.at(-1);
  assert.equal(call.input.decision_basis_hash, 'basis');
  assert.equal(Object.hasOwn(call.input, 'force'), false);
  await request(engine, '/api/promotions/operation/settle', {
    method: 'POST',
    input: {
      abandon: true,
      confirmed: true,
      expected_heads: { app: 'a'.repeat(40), policy: 'b'.repeat(40) },
      rationale: 'Keep the partial state for inspection',
      request_id: 'abandon',
    },
  });
  assert.equal(calls.at(-1).input.abandon, true);
  assert.deepEqual(calls.at(-1).input.expected_heads, {
    app: 'a'.repeat(40),
    policy: 'b'.repeat(40),
  });
});

test('unsupported service methods cannot fall through to another dispatcher', async () => {
  const { engine, calls } = fixture();
  await assert.rejects(() => request(engine, '/api/objectives/objective/context'), {
    code: 'METHOD_NOT_ALLOWED',
  });
  await assert.rejects(
    () => request(engine, '/api/evaluation-runs/run/report', { method: 'GET' }),
    { code: 'METHOD_NOT_ALLOWED' },
  );
  await assert.rejects(() => request(engine, '/api/context/missing/unknown', { method: 'POST' }), {
    code: 'NOT_FOUND',
  });
  assert.deepEqual(calls, []);
});

test('analyzer failure preserves an already ingested Future revision', async () => {
  const { engine, calls } = fixture();
  engine.native.future = () => ({
    id: 'future',
    objective_id: 'objective',
    repositories: [{ canonical_repo_id: 'app', repo_id: 'isolated-app' }],
  });
  engine.state.futures = [engine.native.future()];
  engine.native.observeFuture = async () => ({
    changed: true,
    future: engine.native.future(),
    revision: { id: 'revision', future_id: 'future', repository_heads: [{ repo_id: 'app' }] },
  });
  engine.futuresGraph = {
    async analyze(input, actor) {
      calls.push({ operation: 'analysis', input, actor });
      throw new Error('Analyzer unavailable');
    },
  };
  const result = await request(engine, '/api/futures/future/observe', {
    method: 'POST',
    input: { expected_version: 1, request_id: 'observe' },
  });
  assert.equal(result.revision.id, 'revision');
  assert.equal(result.analysis.state, 'unavailable');
  assert.equal(calls[0].input.max_comparisons, 100);
  assert.equal(calls[0].input.request_id, 'native-observe:revision');
  assert.equal(calls[0].actor, 'coordinator');
});

test('provenance preserves unknown intent and code facts while enforcing retrieved-source visibility', async () => {
  const { engine, preparation } = fixture();
  const revision = {
    id: 'revision',
    future_id: 'future',
    provenance_state: 'unknown',
    repository_heads: [{ repo_id: 'app', commit: 'a'.repeat(40) }],
    tree_hashes: [{ repo_id: 'app', tree: 'b'.repeat(40) }],
  };
  engine.native.future = () => ({ id: 'future', objective_id: 'objective' });
  engine.objectiveContext.trace = () => ({
    revisions: [revision],
    selections: [],
    candidates: [],
    decisions: [],
    snapshots: [],
    preparations: [preparation],
    code_provenance: [],
  });
  await assert.rejects(
    () => request(engine, '/api/provenance/revision/revision', { principal: alice }),
    { code: 'FORBIDDEN' },
  );
  const trace = await request(engine, '/api/provenance/revision/revision');
  assert.equal(trace.records.find((record) => record.kind === 'revision').basis, 'observed');
  assert.equal(
    trace.records.find((record) => record.kind === 'revision').provenance_state,
    'unknown',
  );
  assert.equal(trace.links.find((link) => link.type === 'requested_outcome').basis, 'unknown');
  assert.deepEqual(
    trace.records.find((record) => record.kind === 'revision').tree_hashes,
    revision.tree_hashes,
  );
});
