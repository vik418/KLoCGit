import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactsGit } from '../worker/artifacts.mjs';
import worker, { WorkspaceCoordinator } from '../worker/index.mjs';
import { emptyState } from '../core/engine.mjs';
import { NativeState } from '../core/native-state.mjs';
import { DomainError } from '../core/hash.mjs';
import { registerRepository } from '../worker/repositories.mjs';
import { scheduleAnalysis } from '../worker/events.mjs';
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
    { AUTH_TOKEN: 'configured-owner-token', ACTOR_ID: 'owner' },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'UNAUTHENTICATED');
});

test('production authentication distinguishes incomplete runtime configuration from rejected owner credentials', async () => {
  const ownerToken = 'private-owner-test-token',
    ingressToken = 'private-ingress-test-token',
    wrongToken = 'wrong-private-test-token',
    forwarded = [];
  const coordinator = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async (request) => {
        forwarded.push(new URL(request.url).pathname);
        return Response.json({ forwarded: true });
      },
    }),
  };
  const configured = {
    WORKSPACE_ID: 'klocgit',
    AUTH_TOKEN: ownerToken,
    ACTOR_ID: 'configured-owner',
    INGEST_TOKEN: ingressToken,
    COORDINATOR: coordinator,
  };
  const call = (env, token = ownerToken, path = '/api/analysis') =>
    worker.fetch(
      new Request('https://example' + path, {
        method: 'POST',
        headers: token === null ? {} : { Authorization: 'Bearer ' + token },
        body: '{}',
      }),
      env,
    );
  const cases = [
    [{ AUTH_TOKEN: undefined }, ['AUTH_TOKEN']],
    [{ AUTH_TOKEN: ' \t' }, ['AUTH_TOKEN']],
    [{ AUTH_TOKEN: 123 }, ['AUTH_TOKEN']],
    [{ ACTOR_ID: undefined }, ['ACTOR_ID']],
    [{ ACTOR_ID: ' \t' }, ['ACTOR_ID']],
    [{ ACTOR_ID: { value: 'owner' } }, ['ACTOR_ID']],
    [{ AUTH_TOKEN: undefined, ACTOR_ID: undefined }, ['AUTH_TOKEN', 'ACTOR_ID']],
  ];
  for (const [override, missing] of cases) {
    const response = await call({ ...configured, ...override });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'AUTH_NOT_CONFIGURED');
    assert.deepEqual(payload.details, { missing });
    for (const binding of missing) assert.ok(payload.message.includes(binding));
    for (const secret of [ownerToken, ingressToken, wrongToken]) {
      assert.ok(!JSON.stringify(payload).includes(secret));
    }
  }
  for (const token of [null, wrongToken]) {
    const response = await call(configured, token);
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.equal(payload.error, 'UNAUTHENTICATED');
    assert.match(payload.message, /missing or incorrect/);
    assert.match(payload.message, /AUTH_TOKEN/);
    for (const secret of [ownerToken, ingressToken, wrongToken]) {
      assert.ok(!JSON.stringify(payload).includes(secret));
    }
  }
  assert.deepEqual(forwarded, []);
  assert.equal((await call(configured)).status, 200);
  assert.deepEqual(forwarded, ['/api/analysis']);
});

test('production ingress authentication depends only on its own configured token', async () => {
  let forwarded = 0;
  const coordinator = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async () => {
        forwarded++;
        return Response.json({ forwarded: true });
      },
    }),
  };
  const call = (env, path, token) =>
    worker.fetch(
      new Request('https://example' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: '{}',
      }),
      { WORKSPACE_ID: 'klocgit', ...env, COORDINATOR: coordinator },
    );
  for (const value of [undefined, ' \t', 123]) {
    const response = await call(
      { AUTH_TOKEN: 'owner-token', ACTOR_ID: 'owner', INGEST_TOKEN: value },
      '/api/events',
      'owner-token',
    );
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'AUTH_NOT_CONFIGURED');
    assert.deepEqual(payload.details, { missing: ['INGEST_TOKEN'] });
    assert.ok(!JSON.stringify(payload).includes('owner-token'));
  }
  const wrongIngress = await call(
    { INGEST_TOKEN: 'ingress-token' },
    '/api/events',
    'wrong-ingress-token',
  );
  assert.equal(wrongIngress.status, 401);
  const wrongPayload = await wrongIngress.json();
  assert.equal(wrongPayload.error, 'UNAUTHENTICATED');
  assert.match(wrongPayload.message, /INGEST_TOKEN/);
  assert.ok(!JSON.stringify(wrongPayload).includes('ingress-token'));
  assert.equal(forwarded, 0);
  assert.equal(
    (await call({ INGEST_TOKEN: 'ingress-token' }, '/api/events', 'ingress-token')).status,
    200,
  );
  assert.equal(
    (await call({ AUTH_TOKEN: 'owner-token', ACTOR_ID: 'owner' }, '/api/analysis', 'owner-token'))
      .status,
    200,
  );
  assert.equal(forwarded, 2);
});

test('authenticated production requests require an explicit workspace before selecting a coordinator', async () => {
  const selected = [],
    forwarded = [];
  const env = {
    AUTH_TOKEN: 'owner-token',
    ACTOR_ID: 'owner',
    INGEST_TOKEN: 'ingress-token',
    COORDINATOR: {
      idFromName: (name) => {
        selected.push(name);
        return name;
      },
      get: () => ({
        fetch: async (request) => {
          forwarded.push(new URL(request.url).pathname);
          return Response.json({ forwarded: true });
        },
      }),
    },
  };
  const call = (path, token, workspace) =>
    worker.fetch(
      new Request('https://example' + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: '{}',
      }),
      { ...env, WORKSPACE_ID: workspace },
    );
  for (const workspace of [undefined, null, '', ' \t', 123, {}]) {
    for (const [path, token] of [
      ['/api/analysis', 'owner-token'],
      ['/api/events', 'ingress-token'],
    ]) {
      assert.equal((await call(path, 'wrong-token', workspace)).status, 401);
      const response = await call(path, token, workspace);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'WORKSPACE_NOT_CONFIGURED');
    }
  }
  assert.deepEqual(selected, []);
  assert.deepEqual(forwarded, []);
  assert.equal((await call('/api/analysis', 'owner-token', 'klocgit')).status, 200);
  assert.deepEqual(selected, ['klocgit']);
  assert.deepEqual(forwarded, ['/api/analysis']);
});

test('queue configuration failures do not process or acknowledge messages and cannot schedule analysis', async () => {
  let selected = 0,
    sent = 0,
    acknowledged = 0,
    retried = 0;
  const env = {
    ARTIFACTS_NAMESPACE: 'test',
    COORDINATOR: {
      idFromName: () => {
        selected++;
        throw new Error('Unexpected selection');
      },
    },
    ANALYSIS_QUEUE: {
      send: async () => {
        sent++;
      },
    },
  };
  const batch = {
    messages: [
      {
        body: { kind: 'analyze', workspace: 'klocgit' },
        ack: () => {
          acknowledged++;
        },
        retry: () => {
          retried++;
        },
      },
    ],
  };
  for (const workspace of [undefined, null, '', ' \t', 123]) {
    const configured = { ...env, WORKSPACE_ID: workspace };
    const unconfigured = (error) =>
      error.code === 'WORKSPACE_NOT_CONFIGURED' && error.status === 503;
    await assert.rejects(() => worker.queue(batch, configured), unconfigured);
    await assert.rejects(() => scheduleAnalysis(configured, { repo: 'app' }), unconfigured);
  }
  assert.deepEqual(
    { selected, sent, acknowledged, retried },
    { selected: 0, sent: 0, acknowledged: 0, retried: 0 },
  );
});

test('internal queue jobs cannot target a missing or different workspace', async () => {
  const paths = [],
    selected = [];
  let acknowledged = 0,
    retried = 0;
  const env = {
    WORKSPACE_ID: 'klocgit',
    COORDINATOR: {
      idFromName: (name) => {
        selected.push(name);
        return name;
      },
      get: () => ({
        fetch: async (request) => {
          paths.push(new URL(request.url).pathname);
          return Response.json({});
        },
      }),
    },
  };
  const messages = ['analyze', 'process_merge_queue'].flatMap((kind) =>
    [undefined, 'another-workspace'].map((workspace) => ({
      body: { kind, workspace, request_id: 'approved-job' },
      ack: () => {
        acknowledged++;
      },
      retry: () => {
        retried++;
      },
    })),
  );
  await worker.queue({ messages }, env);
  assert.equal(acknowledged, 0);
  assert.equal(retried, 4);
  assert.deepEqual(selected, []);
  assert.deepEqual(paths, []);
  await worker.queue(
    {
      messages: [
        {
          body: { kind: 'process_merge_queue', workspace: 'klocgit', request_id: 'approved-job' },
          ack: () => {
            acknowledged++;
          },
          retry: () => {
            retried++;
          },
        },
      ],
    },
    env,
  );
  assert.equal(acknowledged, 1);
  assert.equal(retried, 4);
  assert.deepEqual(selected, ['klocgit']);
  assert.deepEqual(paths, ['/internal/merge-queue']);
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
    adapter.suitesForScope({ validation_profile: 'checkout-effects-v0' }, ['client/retry.mjs']),
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
    WORKSPACE_ID: 'klocgit',
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
  assert.equal(analysis[0].workspace, 'klocgit');
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
    WORKSPACE_ID: 'klocgit',
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
          body: { kind: 'analyze', workspace: 'klocgit' },
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
    WORKSPACE_ID: 'klocgit',
    ACTOR_ID: 'owner',
    VALIDATION_CONFIG_HASH: 'test-config',
    GIT_BRIDGE_TOKEN: 'test-bridge',
    GIT_EXECUTOR: {
      fetch: async () =>
        Response.json({ validation_profile: 'checkout-effects-v0', context_repo: 'policy' }),
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
        validation_profile: 'checkout-effects-v0',
        context_repo: 'policy',
      }),
    }),
  );
  assert.equal(response.status, 201);
  const registered = await response.json();
  assert.equal(registered.validation_profile, 'checkout-effects-v0');
  assert.equal(registered.context_repo, 'policy');
  const mismatched = await coordinator.fetch(
    new Request('https://coordinator/api/repositories', {
      method: 'POST',
      body: JSON.stringify({ name: 'app-two', validation_profile: 'context-document-v0' }),
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
    WORKSPACE_ID: 'klocgit',
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
    503,
  );
  assert.equal(
    (await call('/api/events', { Authorization: 'Bearer test-ingress-token' })).status,
    200,
  );
});

function repositoryCreationFixture({ loseAcknowledgement = false } = {}) {
  const state = emptyState(),
    persisted = [],
    physical = new Map(),
    actors = [];
  let creates = 0,
    directBindingCalls = 0;
  const engine = {
    state,
    save: async (value) => persisted.push(structuredClone(value)),
    audit: async (type, actor) => actors.push({ type, actor }),
    git: {
      repositoryInfo: async ({ id }) => {
        if (!physical.has(id)) throw new DomainError('REPO_NOT_FOUND', 'Repository not found', 404);
        return structuredClone(physical.get(id));
      },
      repositoryCreate: async ({ id, ref, operation_id }) => {
        creates++;
        const journal = persisted.at(-1).nativeRequests[0];
        assert.equal(journal.status, 'prepared');
        assert.equal(journal.effects[0].status, 'prepared');
        assert.equal(journal.effects[0].method, 'repositoryCreate');
        assert.equal(journal.id, operation_id);
        const repository = {
          id,
          ref,
          provider: 'cloudflare-artifacts',
          remote: 'https://account.artifacts.cloudflare.net/git/test/' + id + '.git',
          status: 'empty',
          operation_id,
        };
        physical.set(id, repository);
        if (loseAcknowledgement) throw new Error('Reply lost after creation');
        return structuredClone(repository);
      },
    },
  };
  engine.native = new NativeState(engine);
  const env = {
    ARTIFACTS: {
      create: async () => {
        directBindingCalls++;
        throw new Error('Legacy create bypassed its journal');
      },
    },
  };
  return {
    engine,
    env,
    persisted,
    actors,
    counts: () => ({ creates, directBindingCalls }),
  };
}

test('legacy create uses the native durable journal and replays its receipt', async () => {
  const fixture = repositoryCreationFixture();
  const input = { name: 'app', create: true, description: 'Checkout', request_id: 'create-app' };
  const result = await registerRepository(fixture.engine, fixture.env, input, 'configured-owner');
  assert.equal(result.name, 'app');
  assert.equal(result.remote, 'https://account.artifacts.cloudflare.net/git/test/app.git');
  assert.equal(result.needs_initial_commit, true);
  assert.equal(fixture.engine.state.nativeRequests[0].actor, 'configured-owner');
  assert.equal(fixture.engine.state.nativeRequests[0].status, 'applied');
  assert.equal(fixture.engine.state.nativeRepositories[0].head, null);
  assert.deepEqual(fixture.engine.state.repositories, []);
  assert.ok(fixture.actors.every(({ actor }) => actor === 'configured-owner'));

  // The first external push may register a canonical head before a client retries.
  const head = 'a'.repeat(40);
  fixture.engine.state.repositories.push({
    id: 'app',
    head,
    baseline: head,
    canonical_ref: 'refs/heads/main',
  });
  assert.deepEqual(
    await registerRepository(fixture.engine, fixture.env, input, 'configured-owner'),
    result,
  );
  await assert.rejects(
    () =>
      registerRepository(
        fixture.engine,
        fixture.env,
        { ...input, description: 'Changed request' },
        'configured-owner',
      ),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
  assert.deepEqual(fixture.counts(), { creates: 1, directBindingCalls: 0 });
});

test('legacy create requires a stable request identity before any provider effect', async () => {
  const fixture = repositoryCreationFixture();
  await assert.rejects(
    () =>
      registerRepository(
        fixture.engine,
        fixture.env,
        { name: 'app', create: true },
        'configured-owner',
      ),
    (error) => error.code === 'INVALID_NATIVE_INPUT',
  );
  assert.deepEqual(fixture.counts(), { creates: 0, directBindingCalls: 0 });
  assert.deepEqual(fixture.engine.state.nativeRequests, []);
  assert.deepEqual(fixture.persisted, []);
});

test('lost legacy create acknowledgement requires ownership reconciliation rather than replay', async () => {
  const fixture = repositoryCreationFixture({ loseAcknowledgement: true });
  const input = { name: 'app', create: true, request_id: 'create-app' };
  const create = () => registerRepository(fixture.engine, fixture.env, input, 'configured-owner');
  await assert.rejects(create, (error) => error.code === 'RECOVERY_REQUIRED');
  const operation = fixture.engine.state.nativeRequests[0];
  assert.equal(operation.status, 'recovery_required');
  assert.deepEqual(fixture.engine.state.nativeRepositories, []);
  await assert.rejects(create, (error) => error.code === 'RECOVERY_REQUIRED');
  assert.deepEqual(fixture.counts(), { creates: 1, directBindingCalls: 0 });

  await fixture.engine.native.recoverRequest(
    operation.id,
    { request_id: 'recover-app' },
    'configured-owner',
  );
  assert.equal(operation.status, 'applied');
  const result = await create();
  assert.equal(result.name, 'app');
  assert.equal(result.needs_initial_commit, true);
  assert.deepEqual(fixture.counts(), { creates: 1, directBindingCalls: 0 });
});

test('legacy fork requests fail before invoking Artifacts or mutating fork history', async () => {
  const state = emptyState(),
    head = 'a'.repeat(40);
  state.repositories.push({ id: 'app', head, baseline: head, canonical_ref: 'refs/heads/main' });
  let providerCalls = 0;
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => state, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    {
      WORKSPACE_ID: 'klocgit',
      ACTOR_ID: 'owner',
      ARTIFACTS: {
        get: async () => {
          providerCalls++;
          throw new Error('Legacy fork accessed Artifacts');
        },
      },
    },
  );
  await coordinator.ready;
  const response = await coordinator.fetch(
    new Request('https://coordinator/api/repositories/fork', {
      method: 'POST',
      body: JSON.stringify({ source: 'app', name: 'work', request_id: 'fork-work' }),
    }),
  );
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.error, 'NATIVE_FUTURE_REQUIRED');
  assert.match(result.message, /POST \/api\/futures/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(state.forks, []);
});

test('historical fork push mappings remain ingestible without creating another physical fork', async () => {
  const state = emptyState(),
    head = 'a'.repeat(40);
  state.repositories.push({ id: 'app', head, baseline: head, canonical_ref: 'refs/heads/main' });
  state.forks.push({ id: 'work', repo: 'app', base_commit: head });
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => state, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    { WORKSPACE_ID: 'klocgit' },
  );
  await coordinator.ready;
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

test('native ingress uses its service identity without an owner or producer claim', async () => {
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => undefined, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    { WORKSPACE_ID: 'klocgit' },
  );
  await coordinator.ready;
  const calls = [];
  coordinator.engine.native.observeRepositoryPush = async (event, actor) => {
    calls.push({ event, actor });
    return { handled: true, revision_id: 'observed-native-revision' };
  };
  const event = { repo: 'work', ref: 'refs/heads/main', after: 'b'.repeat(40) };
  for (const path of ['/internal/push', '/api/events']) {
    const response = await coordinator.fetch(
      new Request('https://coordinator' + path, {
        method: 'POST',
        body: JSON.stringify({ event, actor: 'forged-producer' }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision_id, 'observed-native-revision');
  }
  assert.deepEqual(calls, [
    { event, actor: 'artifacts-ingress' },
    { event, actor: 'git-ingress' },
  ]);
});

test('canonical resolution reports durable success after enqueue failure and preserves stale-decision rejection', async () => {
  const coordinator = new WorkspaceCoordinator(
    {
      storage: { get: async () => undefined, put: async () => {} },
      blockConcurrencyWhile: (fn) => fn(),
    },
    {
      WORKSPACE_ID: 'klocgit',
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
