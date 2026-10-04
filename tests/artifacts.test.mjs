import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactsGit } from '../worker/artifacts.mjs';
import worker, { WorkspaceCoordinator } from '../worker/index.mjs';
import { emptyState } from '../core/engine.mjs';
test('untrusted __proto__ filenames remain visible in observed affected scope', async () => {
  const binding = {
    get: async () => ({
      readCommit: async (h) => ({ hash: h, treeHash: h === 'head' ? 'new' : 'old' }),
      readTree: async (h) =>
        h === 'new' ? [{ name: '__proto__', type: 'blob', mode: '100644', hash: 'changed' }] : [],
      [Symbol.dispose]() {},
    }),
  };
  const adapter = new ArtifactsGit({ ARTIFACTS: binding });
  const facts = await adapter.facts({ id: 'repo' }, 'head', 'base');
  assert.deepEqual(facts.scope, ['__proto__']);
});
test('missing immutable Artifacts objects return a bounded domain failure', async () => {
  const adapter = new ArtifactsGit({
    ARTIFACTS: { get: async () => ({ readCommit: async () => null, [Symbol.dispose]() {} }) },
  });
  await assert.rejects(
    () => adapter.facts({ id: 'repo' }, 'missing', 'base'),
    (e) => e.code === 'MISSING_COMMIT' && e.status === 404,
  );
});
test('canonical Artifacts operations fail closed without a trusted Git executor', async () => {
  const adapter = new ArtifactsGit({});
  await assert.rejects(
    () => adapter.cas({ id: 'repo', canonical_ref: 'refs/heads/main' }, 'old', 'new'),
    (e) => e.code === 'GIT_EXECUTOR_UNAVAILABLE' && e.status === 503,
  );
});
test('production API requires authenticated identity before forwarding mutations', async () => {
  const response = await worker.fetch(
    new Request('https://example/api/decisions/x/resolve', { method: 'POST', body: '{}' }),
    {},
  );
  assert.equal(response.status, 401);
});
test('Artifacts context reads decode exact immutable Blob contents and retain the full message', async () => {
  const commit = 'a'.repeat(40),
    reads = [];
  const adapter = new ArtifactsGit({
    ARTIFACTS: {
      get: async () => ({
        readFile: async (input) => {
          reads.push(input);
          return input.path === 'missing.json' ? null : new Blob(['{"version":1}']);
        },
        readCommit: async () => ({ message: 'Subject\n\nDecision-Task: task_immutable\n' }),
        [Symbol.dispose]() {},
      }),
    },
  });
  assert.equal(await adapter.file({ id: 'policy' }, commit, 'policy.json'), '{"version":1}');
  assert.deepEqual(reads, [{ ref: commit, path: 'policy.json' }]);
  assert.match(await adapter.message({ id: 'policy' }, commit), /Decision-Task: task_immutable/);
  assert.equal(await adapter.file({ id: 'policy' }, commit, 'missing.json'), null);
  assert.deepEqual(
    adapter.suitesForScope({ validation_profile: 'checkout-effects-v2' }, ['client/retry.mjs']),
    ['checkout-effects'],
  );
  assert.deepEqual(adapter.suitesForScope({}, ['client/retry.mjs']), []);
});
test('native push ingestion is acknowledged only after separate analysis is queued', async () => {
  const paths = [],
    analysis = [];
  let acknowledged = 0,
    retried = 0;
  const env = {
    WORKSPACE_ID: 'live',
    ARTIFACTS_NAMESPACE: 'test',
    COORDINATOR: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          paths.push(new URL(request.url).pathname);
          return Response.json({ revision_id: 'immutable-revision' });
        },
      }),
    },
    ANALYSIS_QUEUE: { send: async (body) => analysis.push(body) },
  };
  const message = {
    body: {
      type: 'cf.artifacts.repo.pushed',
      source: { namespace: 'test', repoName: 'app' },
      payload: { ref: 'refs/heads/producer', after: 'a'.repeat(40) },
    },
    ack() {
      acknowledged++;
    },
    retry() {
      retried++;
    },
  };
  await worker.queue({ messages: [message] }, env);
  assert.deepEqual(paths, ['/internal/push']);
  assert.equal(acknowledged, 1);
  assert.equal(retried, 0);
  assert.equal(analysis[0].kind, 'analyze');
  assert.equal(analysis[0].trigger.head, 'a'.repeat(40));
  env.ANALYSIS_QUEUE.send = async () => {
    throw new Error('Queue unavailable');
  };
  await worker.queue({ messages: [message] }, env);
  assert.equal(acknowledged, 1);
  assert.equal(retried, 1);
});
test('queued analysis uses generic discovery rather than an owner-supplied component', async () => {
  const paths = [];
  let ack = 0;
  const env = {
    WORKSPACE_ID: 'live',
    COORDINATOR: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (request) => {
          paths.push(new URL(request.url).pathname);
          return Response.json({});
        },
      }),
    },
  };
  await worker.queue(
    {
      messages: [
        {
          body: { kind: 'analyze', workspace: 'live' },
          ack() {
            ack++;
          },
          retry() {
            throw new Error('Unexpected retry');
          },
        },
      ],
    },
    env,
  );
  assert.deepEqual(paths, ['/internal/analysis']);
  assert.equal(ack, 1);
});
test('authenticated repository registration preserves the selected trusted validation profile', async () => {
  const state = emptyState(),
    head = 'a'.repeat(40);
  state.repositories.push({ id: 'policy', head, baseline: head, canonical_ref: 'refs/heads/main' });
  const ctx = {
    storage: { get: async () => state, put: async () => {} },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const env = {
    ACTOR_ID: 'owner',
    VALIDATION_CONFIG_HASH: 'test-config',
    GIT_BRIDGE_TOKEN: 'test-bridge',
    GIT_EXECUTOR: {
      fetch: async () =>
        Response.json({ validation_profile: 'checkout-effects-v2', context_repo: 'policy' }),
    },
    ARTIFACTS: {
      get: async () => ({
        info: async () => ({
          defaultBranch: 'main',
          remote: 'https://account.artifacts.cloudflare.net/git/test/app.git',
        }),
        log: async () => [{ hash: head }],
        [Symbol.dispose]() {},
      }),
    },
  };
  const coordinator = new WorkspaceCoordinator(ctx, env);
  await coordinator.ready;
  const response = await coordinator.fetch(
    new Request('https://coordinator/api/repositories', {
      method: 'POST',
      body: JSON.stringify({
        name: 'app',
        validation_profile: 'checkout-effects-v2',
        context_repo: 'policy',
      }),
    }),
  );
  assert.equal(response.status, 201);
  const registered = await response.json();
  assert.equal(registered.validation_profile, 'checkout-effects-v2');
  assert.equal(registered.context_repo, 'policy');
  const mismatched = await coordinator.fetch(
    new Request('https://coordinator/api/repositories', {
      method: 'POST',
      body: JSON.stringify({ name: 'app-two', validation_profile: 'context-document-v1' }),
    }),
  );
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).error, 'VALIDATION_PROFILE_MISMATCH');
  assert.equal(
    (
      await coordinator.fetch(
        new Request('https://coordinator/api/decisions', { method: 'POST', body: '{}' }),
      )
    ).status,
    404,
  );
});

test('production middleware isolates ingress credentials, enforces origin and bounds actual UTF-8 request bytes', async () => {
  const forwarded = [];
  const env = {
    AUTH_TOKEN: 'test-owner-token',
    INGEST_TOKEN: 'test-ingress-token',
    ACTOR_ID: 'configured-owner',
    COORDINATOR: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          forwarded.push({ path: new URL(request.url).pathname, body: await request.text() });
          return Response.json({ forwarded: true });
        },
      }),
    },
  };
  const call = (path, headers = {}, body = '{}', method = 'POST') =>
    worker.fetch(
      new Request('https://example' + path, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
      }),
      env,
    );
  assert.equal(
    (await call('/api/events', { Authorization: 'Bearer test-owner-token' })).status,
    401,
  );
  assert.equal(
    (await call('/api/workspace', { Authorization: 'Bearer test-ingress-token' }, undefined, 'GET'))
      .status,
    401,
  );
  assert.equal(
    (
      await call('/api/analysis', {
        Authorization: 'Bearer test-owner-token',
        Origin: 'https://other.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('/api/analysis', {
        Authorization: 'Bearer test-owner-token',
        'Content-Length': '1000001',
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await call(
        '/api/analysis',
        { Authorization: 'Bearer test-owner-token' },
        JSON.stringify('é'.repeat(500001)),
      )
    ).status,
    413,
  );
  assert.equal(forwarded.length, 0);
  assert.equal(
    (
      await call(
        '/api/analysis',
        { Authorization: 'Bearer test-owner-token', Origin: 'https://example' },
        '{"refresh":true}',
      )
    ).status,
    200,
  );
  assert.deepEqual(forwarded, [{ path: '/api/analysis', body: '{"refresh":true}' }]);
  delete env.ACTOR_ID;
  assert.equal(
    (await call('/api/analysis', { Authorization: 'Bearer test-owner-token' })).status,
    401,
  );
  assert.equal(
    (await call('/api/events', { Authorization: 'Bearer test-ingress-token' })).status,
    200,
  );
});

test('fork transport disposes Artifacts capabilities, withholds minted tokens and maps pushes to the registered canonical repository', async () => {
  const state = emptyState(),
    head = 'a'.repeat(40);
  state.repositories.push({ id: 'app', head, baseline: head, canonical_ref: 'refs/heads/main' });
  let disposed = 0;
  const env = {
    ACTOR_ID: 'owner',
    ARTIFACTS: {
      get: async () => ({
        fork: async (name, options) => {
          assert.equal(options.defaultBranchOnly, true);
          return {
            id: 'artifact-id',
            name,
            remote: 'https://example/work.git',
            defaultBranch: 'main',
            token: 'private-test-token',
          };
        },
        [Symbol.dispose]() {
          disposed++;
        },
      }),
    },
  };
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => state, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    env,
  );
  await coordinator.ready;
  const response = await coordinator.fetch(
    new Request('https://coordinator/api/repositories/fork', {
      method: 'POST',
      body: JSON.stringify({ source: 'app', name: 'work' }),
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    id: 'artifact-id',
    name: 'work',
    remote: 'https://example/work.git',
    defaultBranch: 'main',
  });
  assert.equal(disposed, 1);
  assert.deepEqual(state.forks, [{ id: 'work', repo: 'app', base_commit: head }]);
  assert.ok(!JSON.stringify(state).includes('private-test-token'));
  const ingested = [];
  coordinator.engine.ingest = async (event) => {
    ingested.push(event);
    return { revision_id: 'revision-from-fork' };
  };
  const push = { repo: 'work', ref: 'refs/heads/work', after: 'b'.repeat(40) };
  const pushed = await coordinator.fetch(
    new Request('https://coordinator/internal/push', {
      method: 'POST',
      body: JSON.stringify({ event: push }),
    }),
  );
  assert.equal(pushed.status, 200);
  assert.deepEqual(ingested, [{ ...push, repo: 'app', source_repo: 'work' }]);
  const unknown = await coordinator.fetch(
    new Request('https://coordinator/internal/push', {
      method: 'POST',
      body: JSON.stringify({ event: { ...push, repo: 'unregistered' } }),
    }),
  );
  assert.deepEqual(await unknown.json(), { ignored: true, reason: 'UNREGISTERED_REPOSITORY' });
  assert.equal(ingested.length, 1);
});

test('canonical resolution reports durable success after enqueue failure and preserves stale-decision rejection', async () => {
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => undefined, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    {
      ACTOR_ID: 'configured-owner',
      ANALYSIS_QUEUE: {
        send: async () => {
          throw new Error('Queue unavailable');
        },
      },
    },
  );
  await coordinator.ready;
  const calls = [],
    input = {
      alternative_id: 'selected',
      basis_hash: 'reviewed-basis',
      expected_canonical_head: 'reviewed-head',
      rationale: 'Reviewed',
      actor: 'forged',
    };
  coordinator.engine = {
    serial: async (fn) => fn(),
    resolve: async (...args) => {
      calls.push(args);
      return { decision_id: 'immutable-decision', canonical_head: 'applied-head' };
    },
  };
  const request = () =>
    new Request('https://coordinator/api/decisions/component/resolve', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  const resolved = await coordinator.fetch(request());
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), {
    decision_id: 'immutable-decision',
    canonical_head: 'applied-head',
    analysis: 'enqueue-failed',
  });
  assert.deepEqual(calls, [['component', input, 'configured-owner']]);
  const { DomainError } = await import('../core/hash.mjs');
  coordinator.engine.resolve = async () => {
    throw new DomainError('DECISION_STALE', 'Review the changed basis', 409, {
      canonical_head: 'new-head',
    });
  };
  const stale = await coordinator.fetch(request());
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: 'DECISION_STALE',
    message: 'Review the changed basis',
    details: { canonical_head: 'new-head' },
  });
});
