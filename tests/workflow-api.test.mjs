import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWorkflowRequest } from '../server/workflow-api.mjs';
import { AccessControl } from '../core/access.mjs';
import { forwardPrincipal, internalPrincipal, trustedPrincipal } from '../worker/identity.mjs';
import worker, { WorkspaceCoordinator } from '../worker/index.mjs';
import { Readable } from 'node:stream';
import { handleLocalRequest } from '../server/local-api.mjs';
import {
  authenticatedActor,
  authenticatedPrincipal,
  assertSameOrigin,
  readRequestBody,
} from '../server/local-http.mjs';

const request = (url, input = {}, method = 'POST', actor = 'authenticated-owner') => ({
  url: 'https://coordination' + url,
  input,
  method,
  actor,
});
function fixture() {
  const calls = [],
    snapshot = { id: 'mr_1', revision_id: 'rev_current', version: 2, event_id: 'event_current' },
    capture =
      (name) =>
      (...args) => {
        calls.push({ name, args });
        return { handled: name };
      };
  const engine = {
    mr: {
      list: () => [snapshot],
      get: () => snapshot,
      open: capture('open'),
      transition: capture('transition'),
      review: capture('review'),
      reviewBatch: capture('review-batch'),
      comment: capture('comment'),
      check: capture('check'),
      dependencies: capture('dependencies'),
      getPolicy: () => ({ version: 0, requiredChecks: ['trusted-validation'] }),
      setPolicy: capture('policy'),
    },
    queue: {
      list: () => [{ id: 'queue_1' }],
      enqueue: capture('enqueue'),
      process: capture('process'),
      cancel: capture('cancel'),
    },
    prepareReview: capture('prepare-review'),
    prepareRevert: capture('prepare-revert'),
    validateRevision: capture('trusted-validation'),
  };
  return { engine, calls, snapshot };
}
test('shared dispatcher leaves unrelated routes untouched and requires authenticated actors for workflows', async () => {
  const f = fixture();
  assert.equal(
    await handleWorkflowRequest(f.engine, request('/api/workspace', {}, 'GET', '')),
    null,
  );
  await assert.rejects(
    () => handleWorkflowRequest(f.engine, request('/api/merge-requests', {}, 'GET', '')),
    (e) => e.status === 401,
  );
  assert.equal(f.calls.length, 0);
});
test('MR declarations cannot replace authenticated actor, event time or server trust', async () => {
  const f = fixture();
  await handleWorkflowRequest(
    f.engine,
    request('/api/merge-requests', {
      repo: 'repo',
      source_ref: 'refs/heads/work',
      title: 'Work',
      request_id: 'open-1',
      actor: 'forged-owner',
      created_at: 'past',
      trusted: true,
      status: 'merged',
    }),
  );
  assert.deepEqual(f.calls[0], {
    name: 'open',
    args: [
      { repo: 'repo', source_ref: 'refs/heads/work', title: 'Work', request_id: 'open-1' },
      'authenticated-owner',
    ],
  });
  await handleWorkflowRequest(
    f.engine,
    request('/api/merge-requests/mr_1/checks', {
      name: 'trusted-validation',
      status: 'passed',
      expected_revision_id: 'rev_current',
      expected_version: 2,
      request_id: 'check-1',
      source: 'platform-owned checks',
      trusted: true,
      check_ref: 'platform:forged',
      actor: 'ci-owner',
      config_hash: 'fake',
    }),
  );
  const check = f.calls[1];
  assert.equal(check.name, 'check');
  assert.equal(check.args[2], 'authenticated-owner');
  assert.deepEqual(Object.keys(check.args[1]).sort(), [
    'expected_revision_id',
    'expected_version',
    'name',
    'request_id',
    'status',
  ]);
});
test('reviews, dependencies and owner policy preserve optimistic pins while stripping authority claims', async () => {
  const f = fixture();
  await handleWorkflowRequest(
    f.engine,
    request('/api/merge-requests/mr_1/reviews', {
      action: 'approve',
      expected_revision_id: 'rev_current',
      expected_version: 'event_current',
      request_id: 'review-1',
      actor: 'forged-reviewer',
      dismissed_by: 'owner',
    }),
  );
  assert.equal(f.calls[0].args[1].expected_revision_id, 'rev_current');
  assert.equal(f.calls[0].args[2], 'authenticated-owner');
  assert.equal(f.calls[0].args[1].dismissed_by, undefined);
  await handleWorkflowRequest(
    f.engine,
    request('/api/repositories/repo/policy', {
      policy: {
        minApprovals: 2,
        requiredChecks: ['platform:immutable-check'],
        owner_id: 'attacker',
        trusted: true,
      },
      expected_version: 0,
      request_id: 'policy-1',
      actor: 'attacker',
    }),
  );
  assert.deepEqual(f.calls[1].args, [
    'repo',
    {
      expected_version: 0,
      request_id: 'policy-1',
      policy: { minApprovals: 2, requiredChecks: ['platform:immutable-check'] },
    },
    'authenticated-owner',
  ]);
});
test('MR prepare binds its immutable current revision and rejects stale displayed pins before creating review', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      handleWorkflowRequest(
        f.engine,
        request('/api/merge-requests/mr_1/prepare', {
          expected_revision_id: 'rev_old',
          expected_version: 2,
        }),
      ),
    (e) => e.status === 409,
  );
  assert.equal(f.calls.length, 0);
  await handleWorkflowRequest(
    f.engine,
    request('/api/merge-requests/mr_1/prepare', {
      expected_revision_id: 'rev_current',
      expected_version: 'event_current',
      revision_ids: ['attacker-selected'],
      title: 'Review current',
    }),
  );
  assert.deepEqual(f.calls[0].args, [
    { title: 'Review current', revision_ids: ['rev_current'] },
    'authenticated-owner',
  ]);
});
test('trusted validate runs the exact revision including draft work and returns bounded evidence with the refreshed MR', async () => {
  const f = fixture();
  f.snapshot.draft = true;
  const result = await handleWorkflowRequest(
    f.engine,
    request('/api/merge-requests/mr_1/validate', {
      expected_revision_id: 'rev_current',
      result: { passed: true },
      source: 'producer',
    }),
  );
  assert.equal(result.mergeRequest, f.snapshot);
  assert.deepEqual(result.validation, { handled: 'trusted-validation' });
  assert.deepEqual(f.calls, [
    { name: 'trusted-validation', args: ['rev_current', { actor: 'authenticated-owner' }] },
  ]);
});
test('batch reviews preserve each displayed version and revision under one authenticated actor', async () => {
  const f = fixture(),
    items = [
      {
        mr_id: 'mr_1',
        action: 'approve',
        expected_revision_id: 'rev_current',
        expected_version: 2,
        request_id: 'approval-1',
        actor: 'forged',
        trusted: true,
      },
      {
        mr_id: 'mr_2',
        action: 'request_changes',
        body: 'Needs revision',
        expected_revision_id: 'rev_other',
        expected_version: 3,
        request_id: 'approval-2',
        created_at: 'past',
      },
    ];
  const result = await handleWorkflowRequest(
    f.engine,
    request('/api/merge-requests/reviews/batch', { items, actor: 'forged' }),
  );
  assert.deepEqual(result, { mergeRequests: { handled: 'review-batch' } });
  assert.equal(f.calls[0].args[1], 'authenticated-owner');
  assert.deepEqual(
    f.calls[0].args[0],
    items.map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(([key]) => !['actor', 'trusted', 'created_at'].includes(key)),
      ),
    ),
  );
  await assert.rejects(
    () =>
      handleWorkflowRequest(
        f.engine,
        request('/api/merge-requests/reviews/batch', { items: [null] }),
      ),
    (e) => e.code === 'INVALID_MR_INPUT',
  );
  assert.equal(f.calls.length, 1);
});
test('queue API preserves exact reviewed ticket pins and one process call without automatic rereview', async () => {
  const f = fixture(),
    input = {
      request_id: 'queue-1',
      component_id: 'component_1',
      alternative_id: 'alternative_1',
      basis_hash: 'reviewed_basis',
      expected_canonical_head: 'reviewed_head',
      mr_basis_hash: 'reviewed_mr_basis',
      rationale: 'Reviewed choice',
      actor: 'forged',
      auto_refresh: true,
      approved: true,
    };
  await handleWorkflowRequest(f.engine, request('/api/merge-queue', input));
  assert.equal(f.calls[0].name, 'enqueue');
  assert.equal(f.calls[0].args[1], 'authenticated-owner');
  assert.equal(f.calls[0].args[0].basis_hash, 'reviewed_basis');
  assert.equal(f.calls[0].args[0].auto_refresh, undefined);
  await handleWorkflowRequest(
    f.engine,
    request('/api/merge-queue/process', {
      request_id: 'process-1',
      refresh: true,
      actor: 'forged',
    }),
  );
  assert.deepEqual(f.calls[1], {
    name: 'process',
    args: [{ request_id: 'process-1' }, 'authenticated-owner'],
  });
  await handleWorkflowRequest(
    f.engine,
    request('/api/merge-queue/queue_1/cancel', { request_id: 'cancel-1', actor: 'forged' }),
  );
  assert.equal(f.calls[2].name, 'cancel');
});
test('generic review/revert preparation receives selected immutable subjects without trust or actor overrides', async () => {
  const f = fixture();
  await handleWorkflowRequest(
    f.engine,
    request('/api/reviews/prepare', {
      revision_ids: ['revision-a', 'revision-b'],
      title: 'Batch review',
      request_id: 'prepare-1',
      actor: 'fake',
      auto_merge: true,
    }),
  );
  assert.deepEqual(f.calls[0].args, [
    { revision_ids: ['revision-a', 'revision-b'], title: 'Batch review', request_id: 'prepare-1' },
    'authenticated-owner',
  ]);
  await handleWorkflowRequest(
    f.engine,
    request('/api/reverts/prepare', {
      repo: 'repo',
      target_commit: 'commit-a',
      decision_id: 'decision-a',
      mainline: 1,
      title: 'Revert',
      trusted: true,
      actor: 'fake',
      commit: 'ignored',
      operation_id: 'ignored',
    }),
  );
  assert.deepEqual(f.calls[1].args, [
    {
      repo: 'repo',
      target_commit: 'commit-a',
      decision_id: 'decision-a',
      mainline: 1,
      title: 'Revert',
    },
    'authenticated-owner',
  ]);
});
test('Worker routes queue processing through the serialization boundary and configured internal actor', async () => {
  const calls = [],
    coordinator = new WorkspaceCoordinator(
      {
        storage: { get: async () => undefined, put: async () => {} },
        blockConcurrencyWhile: (fn) => fn(),
      },
      {
        WORKSPACE_ID: 'klocgit',
        ACTOR_ID: 'owner',
        COORDINATOR_AUTH_SECRET: 'workflow-api-private-coordinator-fixture-secret',
        ANALYSIS_QUEUE: { send: async (body) => calls.push({ analysis: body }) },
      },
    );
  await coordinator.ready;
  assert.equal(coordinator.engine.state.workspace.owner_id, 'owner');
  Object.assign(coordinator.engine, {
    serial: async (fn) => {
      calls.push({ serialized: true });
      return fn();
    },
    queue: {
      process: async (input, actor) => {
        calls.push({ input, actor });
        return { processed: true, entry: { id: 'queue_1' } };
      },
    },
  });
  const response = await coordinator.fetch(
    await forwardPrincipal(
      new Request('https://coordinator/internal/merge-queue', {
        method: 'POST',
        body: JSON.stringify({ request_id: 'process-1', actor: 'injected' }),
      }),
      internalPrincipal('merge-queue-coordinator'),
      coordinator.env,
    ),
  );
  assert.equal(response.status, 200);
  assert.equal(calls[1].actor, 'merge-queue-coordinator');
  assert.deepEqual(calls[1].input, { request_id: 'process-1' });
  assert.equal(calls[2].analysis.kind, 'analyze');
});
test('Queue consumer ignores producer actor claims and forwards only an exact processing request ID', async () => {
  let forwarded,
    acked = 0;
  const env = {
    WORKSPACE_ID: 'workspace',
    COORDINATOR_AUTH_SECRET: 'workflow-api-queue-consumer-fixture-secret',
    COORDINATOR: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async (req) => {
          assert.deepEqual(
            await trustedPrincipal(req, env),
            internalPrincipal('merge-queue-coordinator'),
          );
          forwarded = { path: new URL(req.url).pathname, body: await req.json() };
          return Response.json({ processed: false });
        },
      }),
    },
  };
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: 'process_merge_queue',
            workspace: 'workspace',
            request_id: 'process-1',
            actor: 'forged',
          },
          ack() {
            acked++;
          },
          retry() {
            throw new Error('Unexpected retry');
          },
        },
      ],
    },
    env,
  );
  assert.deepEqual(forwarded, { path: '/internal/merge-queue', body: { request_id: 'process-1' } });
  assert.equal(acked, 1);
});
test('malformed merge-queue jobs are acknowledged without coordinator or Git mutation', async () => {
  let fetched = 0,
    acked = 0,
    retried = 0;
  const ids = [undefined, '', '   ', 12, null, {}, 'x'.repeat(201)],
    env = {
      WORKSPACE_ID: 'workspace',
      COORDINATOR: {
        idFromName: (id) => id,
        get: () => ({
          fetch: async () => {
            fetched++;
            throw new Error('Malformed jobs must not reach the coordinator');
          },
        }),
      },
    };
  await worker.queue(
    {
      messages: ids.map((request_id) => ({
        body: { kind: 'process_merge_queue', workspace: 'workspace', request_id },
        ack() {
          acked++;
        },
        retry() {
          retried++;
        },
      })),
    },
    env,
  );
  assert.equal(acked, ids.length);
  assert.equal(fetched, 0);
  assert.equal(retried, 0);
});
test('native Git branch deletion reaches version-gated withdrawal and schedules reanalysis', async () => {
  const after = '0'.repeat(40),
    calls = [];
  let acked = 0;
  const env = {
    WORKSPACE_ID: 'workspace',
    ARTIFACTS_NAMESPACE: 'namespace',
    COORDINATOR_AUTH_SECRET: 'workflow-api-artifacts-ingress-fixture-secret',
    COORDINATOR: {
      idFromName: (id) => id,
      get: () => ({
        fetch: async (req) => {
          assert.deepEqual(await trustedPrincipal(req, env), internalPrincipal('artifacts-ingress'));
          calls.push({ path: new URL(req.url).pathname, body: await req.json() });
          return Response.json({ withdrawn: true });
        },
      }),
    },
    ANALYSIS_QUEUE: { send: async (body) => calls.push({ analysis: body }) },
  };
  await worker.queue(
    {
      messages: [
        {
          body: {
            type: 'cf.artifacts.repo.pushed',
            source: { namespace: 'namespace', repoName: 'repo' },
            payload: { ref: 'refs/heads/producer', before: 'a'.repeat(40), after },
          },
          ack() {
            acked++;
          },
          retry() {
            throw new Error('Unexpected retry');
          },
        },
      ],
    },
    env,
  );
  assert.equal(calls[0].path, '/internal/push');
  assert.equal(calls[0].body.event.after, after);
  assert.equal(calls[1].analysis.kind, 'analyze');
  assert.equal(calls[1].analysis.trigger.head, after);
  assert.equal(acked, 1);
});

test('local middleware authenticates only the configured principal and rejects cross-origin, malformed and oversized mutations', async () => {
  const config = { actor: 'configured-local-owner', ownerToken: 'test-local-token' };
  assert.throws(
    () => authenticatedActor({ headers: {}, actor: 'forged' }, config),
    (error) => error.status === 401,
  );
  assert.equal(
    authenticatedActor(
      { headers: { authorization: 'Bearer test-local-token' }, actor: 'forged' },
      config,
    ),
    'configured-local-owner',
  );
  assert.throws(
    () =>
      assertSameOrigin({
        method: 'POST',
        headers: { origin: 'https://other.example', host: 'localhost:43187' },
      }),
    (error) => error.status === 403,
  );
  assert.doesNotThrow(() =>
    assertSameOrigin({
      method: 'POST',
      headers: { origin: 'http://localhost:43187', host: 'localhost:43187' },
    }),
  );
  assert.deepEqual(await readRequestBody(Readable.from(['{"refresh":', 'true}'])), {
    refresh: true,
  });
  await assert.rejects(
    () => readRequestBody(Readable.from(['{invalid}'])),
    (error) => error.code === 'INVALID_JSON',
  );
  await assert.rejects(
    () => readRequestBody(Readable.from(['x'.repeat(1000001)])),
    (error) => error.status === 413,
  );
});

test('local route extraction preserves task wrappers, trusted actor and the requirement to answer before starting producers', async () => {
  const calls = [],
    task = { task: { id: 'task-1' }, question: { statement: 'One material question' } },
    engine = {
      state: { workspace: { owner_id: 'configured-local-owner' }, tasks: [task] },
      prepareTask: async (...args) => {
        calls.push(args);
        return { prepared: true };
      },
      resolveTask: async (...args) => {
        calls.push(args);
        return { answered: true };
      },
    };
  engine.access = new AccessControl(engine);
  const principal = await authenticatedPrincipal(
    { headers: { authorization: 'Bearer workflow-api-local-fixture-token' } },
    { actor: 'configured-local-owner', ownerToken: 'workflow-api-local-fixture-token' },
  );
  // The transport supplies the verified principal and parsed URL.
  const route = (path, input = {}, method = 'POST') =>
    handleLocalRequest(
      engine,
      {
        ...request(path, input, method, 'configured-local-owner'),
        principal,
        url: new URL('https://coordination' + path),
      },
      {},
    );
  assert.deepEqual(await route('/api/tasks', {}, 'GET'), { tasks: [task] });
  assert.equal(await route('/api/tasks/task-1', {}, 'GET'), task);
  await route('/api/tasks', { task: { statement: 'Task' }, actor: 'forged' });
  assert.deepEqual(calls[0], [{ statement: 'Task' }, 'configured-local-owner']);
  await route('/api/tasks/task-1/answer', { value: true, rationale: 'Reviewed', actor: 'forged' });
  assert.deepEqual(calls[1], [
    'task-1',
    { value: true, rationale: 'Reviewed' },
    'configured-local-owner',
    false,
  ]);
  await assert.rejects(
    () => route('/api/demo/start'),
    (error) => error.code === 'CONTEXT_REQUIRED',
  );
  await assert.rejects(
    () => route('/api/tasks/missing', {}, 'GET'),
    (error) => error.code === 'TASK_NOT_FOUND',
  );
});
