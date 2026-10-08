import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { webcrypto } from 'node:crypto';
import { AccessControl } from '../core/access.mjs';
import { record, stable } from '../core/hash.mjs';
import { Engine, emptyState } from '../core/engine.mjs';
import { handlePublicRequest, readBoundedRequest } from '../worker/http.mjs';
import { handleCoordinatorRequest } from '../worker/routes.mjs';
import { consumeEvents } from '../worker/events.mjs';
import { WorkspaceCoordinator } from '../worker/index.mjs';
import { trustedPrincipal, forwardPrincipal } from '../worker/identity.mjs';
import { handleLocalRequest } from '../server/local-api.mjs';
import { authenticatedPrincipal, readRequestPayload } from '../server/local-http.mjs';

const owner = { actor_id: 'owner', kind: 'human', auth_method: 'owner-token' };
const member = (actor_id) => ({ actor_id, kind: 'human', auth_method: 'oidc' });
const secret = 'owner-secret-with-adequate-entropy-for-tests';
const config = { WORKSPACE_ID: 'space', AUTH_TOKEN: secret, ACTOR_ID: 'owner', INGEST_TOKEN: 'ingress-secret' };

function fixture() {
  const state = {
    version: 0, workspace: { id: 'space', name: 'space', owner_id: 'owner', producers: ['private-producer'] },
    repositories: [{ id: 'app' }, { id: 'private' }], nativeRepositories: [],
    audit: [], proposals: [{ id: 'public-proposal', repo: 'app' }, { id: 'private-proposal', repo: 'private' }],
    revisions: [{ id: 'public-revision', repo: 'app', stale: false }, { id: 'private-revision', repo: 'private', stale: false }],
    relationships: [{ id: 'private-edge', from_revision: 'public-revision', to_revision: 'private-revision' }],
    tasks: [], decisionComponents: [{ id: 'mixed-decision', actionable: true,
      revision_ids: ['public-revision', 'private-revision'], alternatives: [] }], operations: [],
    futures: [{ id: 'mixed-future', repositories: [
      { repo_id: 'app-fork', canonical_repo_id: 'app' }, { repo_id: 'private-fork', canonical_repo_id: 'private' },
    ] }],
    candidateStates: [{ id: 'mixed-candidate', repositories: [{ repo_id: 'app' }],
      base_heads: { app: 'public-head', private: 'private-head' } }],
    events: { private: 'private-revision' }, analysisCache: { private: 'private-analysis' },
  };
  const engine = {
    state, save: async () => {},
    audit: async (type, actor, data) => state.audit.push(await record('audit', {
      type, actor, data, previous: state.audit.at(-1)?.id ?? null,
    })),
    mr: { get: () => ({ id: 'mr', repo: 'app' }) },
  };
  engine.access = new AccessControl(engine);
  engine.view = async (principal) => engine.access.project({
    ...state, nativeState: {
      repositories: state.repositories, futures: state.futures, candidates: state.candidateStates,
      requests: [], attention: { kind: 'recovery', count: 100 },
    },
    mergeRequests: [], mergeQueue: [], discovery: {}, summary: { proposals: 2 },
    analysis: { status: 'deterministic', analyzer: 'git-tree-v0' },
  }, principal);
  return { engine, state };
}
async function grant(f, actor_id, repo_id, roles) {
  await f.engine.access.update({
    expected_version: f.engine.access.state.version, changes: [{ actor_id, repo_id, roles }],
  }, owner);
}
async function transport(f, kind, path, method = 'GET', input = {}, principal = owner) {
  const url = new URL(path, 'https://app.example');
  if (kind === 'worker') {
    const response = await handleCoordinatorRequest(f.engine, config, {
      method, url, input, principal, actor: 'forged-body-actor',
    });
    return response.json();
  }
  return handleLocalRequest(f.engine, {
    method, url, input, principal, actor: 'forged-body-actor',
  }, { save: f.engine.save, root: '/unused-test-root' });
}

test('public gateway verifies credentials and replaces forged actor transport headers', async () => {
  let calls = 0;
  const env = { ...config, COORDINATOR: {
    idFromName: (name) => name,
    get: () => ({ fetch: async (request) => {
      calls += 1;
      const principal = await trustedPrincipal(request, config);
      assert.equal(request.headers.get('Authorization'), null);
      return new Response(JSON.stringify({ principal, input: await request.json() }));
    } }),
  } };
  const request = new Request('https://app.example/api/futures', {
    method: 'POST', headers: {
      Authorization: 'Bearer ' + secret, 'X-Actor-ID': 'attacker',
      'X-Klocgit-Principal': 'forged', 'X-Klocgit-Principal-Signature': 'forged',
    }, body: JSON.stringify({ actor: 'attacker', request_id: 'one' }),
  });
  const response = await handlePublicRequest(request, env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.principal, owner);
  assert.equal(data.input.actor, 'attacker'); // It remains declared input, never authenticated authority.
  const denied = await handlePublicRequest(new Request('https://app.example/api/session', {
    headers: { Authorization: 'Bearer wrong', 'X-Actor-ID': 'owner' },
  }), env);
  assert.equal(denied.status, 401);
  assert.equal(calls, 1);
});

test('external evaluator callbacks require actual HMAC and bind service headers in private transport', async () => {
  const serviceSecret = 'external-evaluator-secret';
  const body = { run_id: 'run-one', pins_hash: 'exact-pins', result: { status: 'passing', trusted: true } };
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(serviceSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await webcrypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(stable({ run_id: 'run-one', body })))).toString('hex');
  let forwarded;
  const env = { ...config,
    EVALUATOR_SERVICES: JSON.stringify({ ci: { secret: serviceSecret, key_id: 'key-v1', repo_ids: ['app'] } }),
    COORDINATOR: {
      idFromName: (name) => name, get: () => ({ fetch: async (request) => {
        forwarded = request;
        const principal = await trustedPrincipal(request, env);
        assert.equal(principal.actor_id, 'evaluator:ci');
        assert.equal(principal.auth_method, 'evaluator-hmac');
        return new Response(JSON.stringify({ forwarded: true }));
      } }),
    },
  };
  const request = () => new Request('https://app.example/api/evaluation-runs/run-one/report', {
    method: 'POST',
    headers: { 'X-Klocgit-Evaluator-Service': 'ci', 'X-Klocgit-Evaluator-Signature': signature },
    body: JSON.stringify(body),
  });
  assert.equal((await handlePublicRequest(request(), env)).status, 200);
  const headers = new Headers(forwarded.headers);
  headers.set('X-Klocgit-Evaluator-Service', 'other');
  await assert.rejects(() => trustedPrincipal(new Request(forwarded, { headers }), env), { code: 'UNAUTHENTICATED' });
  const altered = request();
  const denied = await handlePublicRequest(new Request(altered, {
    body: JSON.stringify({ ...body, pins_hash: 'different' }),
  }), env);
  assert.equal(denied.status, 401);
  // The domain evaluator still must validate the preissued run, pins and service scope.
});

for (const kind of ['local', 'worker']) {
  test(kind + ' transport permits unknown authenticated session discovery but blocks spoofing and cross-repository views', async () => {
    const f = fixture();
    const session = await transport(f, kind, '/api/session', 'GET', {}, member('ungranted'));
    assert.equal(session.member, false);
    assert.equal(session.actor_id, 'ungranted');
    await assert.rejects(() => transport(f, kind, '/api/workspace', 'GET', {}, member('ungranted')), { code: 'FORBIDDEN' });
    await grant(f, 'producer', 'app', ['producer']);
    const view = await transport(f, kind, '/api/workspace', 'GET', {}, member('producer'));
    assert.deepEqual(view.repositories.map((repo) => repo.id), ['app']);
    assert.deepEqual(view.visibility, { scope: 'repositories', repository_ids: ['app'] });
    assert.deepEqual(view.revisions.map((revision) => revision.id), ['public-revision']);
    assert.deepEqual(view.relationships, []);
    assert.deepEqual(view.nativeState.futures, []);
    assert.deepEqual(view.nativeState.candidates, []);
    assert.equal(view.summary.proposals, 1);
    assert.equal(view.summary.decisionsRequired, 1);
    assert.equal(view.summary.comparisonsAvoided, null);
    assert.equal(view.nativeState.attention.count, 0);
    assert.equal(view.events, undefined);
    assert.equal(view.analysisCache, undefined);
    assert.equal(view.access, undefined);
    assert.deepEqual(view.workspace.producers, []);
    await assert.rejects(() => transport(f, kind, '/api/access', 'POST', {
      expected_version: f.engine.access.state.version,
      changes: [{ actor_id: 'producer', repo_id: null, roles: ['admin'] }],
      actor: 'owner',
    }, member('producer')), { code: 'FORBIDDEN' });
    await assert.rejects(() => transport(f, kind, '/api/merge-requests/mr/reviews', 'POST', {
      action: 'approve', actor: 'owner',
    }, member('producer')), { code: 'FORBIDDEN' });
  });
}

test('local implicit owner access is restricted to a loopback host and credentials select a fixed actor', async () => {
  const request = { method: 'GET', headers: { host: 'localhost:43187', 'x-actor-id': 'attacker' } };
  assert.deepEqual(await authenticatedPrincipal(request, { actor: 'owner' }), owner);
  await assert.rejects(() => authenticatedPrincipal({
    ...request, headers: { host: 'attacker.example:43187' },
  }, { actor: 'owner' }), { code: 'AUTH_NOT_CONFIGURED', status: 503 });
  await assert.rejects(() => authenticatedPrincipal(request, { actor: 'owner', host: '0.0.0.0' }), { code: 'AUTH_NOT_CONFIGURED', status: 503 });
  assert.deepEqual(await authenticatedPrincipal({
    method: 'GET', headers: { host: 'remote.example', authorization: 'Bearer ' + secret, 'x-actor-id': 'attacker' },
  }, { actor: 'owner', host: '0.0.0.0', ownerToken: secret }), owner);
});

test('both request readers enforce byte limits for multibyte UTF-8 bodies', async () => {
  const body = JSON.stringify({ statement: '€'.repeat(400) });
  assert.ok(body.length < 1000);
  assert.ok(Buffer.byteLength(body) > 1000);
  await assert.rejects(() => readRequestPayload(Readable.from([body]), 1000), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  await assert.rejects(() => readBoundedRequest(new Request('https://app.example/api/objectives', {
    method: 'POST', body,
  }), 1000), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
});

test('queue jobs use signed fixed internal identities and unavailable signing credentials cause retry', async () => {
  const calls = [];
  let acknowledgments = 0;
  let retries = 0;
  const env = { ...config, ARTIFACTS_NAMESPACE: 'namespace', COORDINATOR: {
    idFromName: (name) => name,
    get: () => ({ fetch: async (request) => {
      const principal = await trustedPrincipal(request, env);
      calls.push({ path: new URL(request.url).pathname, principal, input: await request.json() });
      return new Response(JSON.stringify({ ignored: true }));
    } }),
  } };
  const message = (body) => ({ body, ack: () => { acknowledgments += 1; }, retry: () => { retries += 1; } });
  await consumeEvents({ messages: [
    message({ kind: 'analyze', workspace: 'space' }),
    message({ kind: 'process_merge_queue', workspace: 'space', request_id: 'process-one' }),
    message({ type: 'cf.artifacts.repo.pushed', source: { namespace: 'namespace', repoName: 'app' },
      payload: { ref: 'refs/klocgit/observations/pinned', after: 'a'.repeat(40) } }),
  ] }, env);
  assert.equal(acknowledgments, 3);
  assert.equal(retries, 0);
  assert.deepEqual(calls.map((call) => call.principal.actor_id), ['coordinator', 'merge-queue-coordinator', 'artifacts-ingress']);
  assert.equal(calls.every((call) => call.principal.kind === 'internal'), true);
  await consumeEvents({ messages: [message({ kind: 'analyze', workspace: 'space' })] }, {
    ...env, AUTH_TOKEN: undefined,
  });
  assert.equal(retries, 1);
  assert.equal(calls.length, 3);
});

test('private coordinator rejects unsigned requests and refuses a configured owner change before Git access', async () => {
  const state = emptyState();
  state.workspace.owner_id = 'existing-owner';
  const ctx = {
    storage: { get: async () => state, put: async () => {} },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const changed = new WorkspaceCoordinator(ctx, config);
  await assert.rejects(() => changed.ready, { code: 'OWNER_IDENTITY_CHANGED', status: 503 });
  const initial = new WorkspaceCoordinator({
    storage: { get: async () => undefined, put: async () => {} },
    blockConcurrencyWhile: (fn) => fn(),
  }, config);
  await initial.ready;
  const response = await initial.fetch(new Request('https://coordinator/api/session', {
    headers: { 'X-Actor-ID': 'owner' },
  }));
  assert.equal(response.status, 401);
  const signed = await forwardPrincipal(new Request('https://coordinator/api/session'), owner, config);
  assert.equal((await initial.fetch(signed)).status, 200);
});

test('retained observation refs do not become proposals or invoke Git analysis', async () => {
  const state = emptyState();
  state.workspace.owner_id = 'owner';
  state.repositories.push({ id: 'app', head: 'a'.repeat(40), baseline: 'a'.repeat(40), canonical_ref: 'refs/heads/main' });
  let gitCalls = 0;
  const engine = new Engine(state, {
    configHash: 'validation-config',
    ref: async () => { gitCalls += 1; throw new Error('Unexpected Git read'); },
  });
  for (const after of ['b'.repeat(40), '0'.repeat(40)])
    assert.deepEqual(await engine.ingest({
      repo: 'app', ref: 'refs/klocgit/observations/pinned', after,
    }), { ignored: true, reason: 'INTERNAL_OBSERVATION_REF' });
  assert.equal(gitCalls, 0);
  assert.equal(state.proposals.length, 0);
  assert.equal(state.revisions.length, 0);
});

test('governance changes invalidate conventional reviewed decision hashes without changing any Git input', async () => {
  const state = emptyState();
  state.workspace.owner_id = 'owner';
  state.repositories.push({ id: 'app', head: 'a'.repeat(40), baseline: 'a'.repeat(40), canonical_ref: 'refs/heads/main' });
  const engine = new Engine(state, { configHash: 'validation-config' });
  const component = { id: 'component', revision_ids: [], supplemental_revision_ids: [],
    alternatives: [], scope: ['app'] };
  const original = await engine.basis(component);
  await engine.access.update({ expected_version: 0,
    changes: [{ actor_id: 'reviewer', repo_id: 'app', roles: ['reviewer'] }],
  }, owner);
  const granted = await engine.basis(component);
  assert.notEqual(granted, original);
  assert.equal(granted, await engine.basis(component));
  await engine.access.update({ expected_version: 1,
    changes: [{ actor_id: 'reviewer', repo_id: 'app', roles: [] }],
  }, owner);
  assert.notEqual(await engine.basis(component), granted);
  assert.equal(state.repositories[0].head, 'a'.repeat(40));
});

function nativeFixture() {
  const state = emptyState();
  state.workspace.owner_id = 'owner';
  state.repositories = [{ id: 'app' }, { id: 'api' }];
  state.systems = [
    { id: 'app-system', repository_refs: [{ repo_id: 'app' }] },
    { id: 'shared-system', repository_refs: [{ repo_id: 'app' }, { repo_id: 'api' }] },
  ];
  state.futures = [{
    id: 'native-future', system_id: 'app-system',
    repositories: [{ repo_id: 'app-future', canonical_repo_id: 'app' }],
  }];
  state.futureRevisions = [];
  const engine = new Engine(state, { configHash: 'configuration' });
  const analyses = [];
  engine.futuresGraph.analyze = async (input, actor) => {
    analyses.push({ input, actor });
    return { run: { id: 'discovery-run' } };
  };
  return { engine, state, analyses };
}

test('automatic discovery targets an isolated Future and bounds shared canonical analysis across Systems', async () => {
  const f = nativeFixture();
  const trigger = { repo: 'app-future', ref: 'refs/heads/main', head: 'a'.repeat(40) };
  const first = await f.engine.analyzeNativeWork({
    actor: 'coordinator', request_id: 'delivery-one', trigger,
  });
  assert.deepEqual(first, { state: 'ready', run_id: 'discovery-run' });
  assert.equal(f.analyses[0].input.system_id, 'app-system');
  assert.equal(f.analyses[0].input.max_comparisons, 100);
  assert.equal(f.analyses[0].actor, 'coordinator');
  await f.engine.analyzeNativeWork({ actor: 'coordinator', request_id: 'delivery-one', trigger });
  assert.equal(f.analyses[1].input.request_id, f.analyses[0].input.request_id);
  await f.engine.analyzeNativeWork({
    actor: 'coordinator', request_id: 'delivery-two',
    trigger: { repo: 'app', ref: 'refs/heads/main', head: 'b'.repeat(40) },
  });
  assert.equal(f.analyses[2].input.system_id, undefined);
  assert.equal(f.analyses[2].input.max_comparisons, 100);
  assert.notEqual(f.analyses[2].input.request_id, f.analyses[0].input.request_id);
  assert.deepEqual(await f.engine.analyzeNativeWork({
    actor: 'coordinator', trigger: { repo: 'unregistered' },
  }), { state: 'not-needed' });
  assert.equal(f.analyses.length, 3);
});

test('the private queued analysis route invokes native discovery after conventional analysis', async () => {
  const f = nativeFixture();
  let conventional = 0;
  f.engine.analyzeWork = async () => { conventional += 1; return { state: 'ready' }; };
  const response = await handleCoordinatorRequest(f.engine, config, {
    method: 'POST', url: new URL('https://coordinator/internal/analysis'),
    input: {
      request_id: 'queued-delivery',
      trigger: { repo: 'app-future', ref: 'refs/heads/main', head: 'a'.repeat(40) },
    },
  });
  const result = await response.json();
  assert.equal(conventional, 1);
  assert.deepEqual(result.native_analysis, { state: 'ready', run_id: 'discovery-run' });
  assert.equal(f.analyses[0].actor, 'coordinator');
  assert.equal(f.analyses[0].input.system_id, 'app-system');
});

test('local native ingress retains observed work when automatic analysis is unavailable', async () => {
  const f = nativeFixture();
  f.engine.native.observeRepositoryPush = async () => {
    f.state.futureRevisions.push({ id: 'observed-revision' });
    return { handled: true, revision_id: 'observed-revision' };
  };
  const request = {
    method: 'POST', url: new URL('http://localhost/api/events'),
    input: { event: { repo: 'app-future', ref: 'refs/heads/main', after: 'a'.repeat(40) } },
    principal: { actor_id: 'git-ingress', kind: 'service', auth_method: 'ingest-token' },
  };
  const result = await handleLocalRequest(f.engine, request, { root: '/unused-test-root' });
  assert.equal(result.revision_id, 'observed-revision');
  assert.deepEqual(result.analysis, { state: 'ready', run_id: 'discovery-run' });
  assert.equal(f.analyses[0].actor, 'coordinator');
  f.engine.futuresGraph.analyze = async () => { throw new Error('Validation unavailable'); };
  const failed = await handleLocalRequest(f.engine, request, { root: '/unused-test-root' });
  assert.equal(failed.revision_id, 'observed-revision');
  assert.deepEqual(failed.analysis, { state: 'unavailable', reason: 'ANALYSIS_UNAVAILABLE' });
  assert.equal(f.state.futureRevisions.length, 2);
});

test('redelivered queued analysis binds one request identity while changed push heads get a new identity', async () => {
  const inputs = [];
  let acknowledgments = 0;
  const env = { ...config, COORDINATOR: {
    idFromName: (name) => name,
    get: () => ({ fetch: async (request) => {
      assert.equal((await trustedPrincipal(request, env)).actor_id, 'coordinator');
      inputs.push(await request.json());
      return new Response(JSON.stringify({ state: 'ready' }));
    } }),
  } };
  const trigger = { repo: 'app-future', ref: 'refs/heads/main', head: 'a'.repeat(40) };
  const message = (body) => ({
    body, ack: () => { acknowledgments += 1; },
    retry: () => { throw new Error('Unexpected retry'); },
  });
  await consumeEvents({ messages: [
    message({ kind: 'analyze', workspace: 'space', trigger }),
    message({ kind: 'analyze', workspace: 'space', trigger }),
    message({ kind: 'analyze', workspace: 'space', trigger: { ...trigger, head: 'b'.repeat(40) } }),
  ] }, env);
  assert.equal(acknowledgments, 3);
  assert.equal(inputs[0].request_id, inputs[1].request_id);
  assert.notEqual(inputs[0].request_id, inputs[2].request_id);
  assert.deepEqual(inputs[0].trigger, trigger);
});

for (const kind of ['local', 'worker']) {
  test(kind + ' forwards verified evaluator headers into the domain callback without floating actor authority', async () => {
    const f = fixture();
    const signature = 'a'.repeat(64);
    const input = { event_id: 'signed-observation', pins_hash: 'exact-pins' };
    const principal = { actor_id: 'evaluator:ci', kind: 'service', auth_method: 'evaluator-hmac' };
    let callbacks = 0;
    f.engine.evaluators = {
      report: async (runId, body, authentication) => {
        callbacks += 1;
        assert.equal(runId, 'issued-run');
        assert.deepEqual(body, input);
        assert.deepEqual(authentication, { service_id: 'ci', signature });
        return { run: { id: runId }, event: { id: 'observation', state: 'passing' } };
      },
    };
    const headers = kind === 'worker' ? new Headers({
      'X-Klocgit-Evaluator-Service': 'ci', 'X-Klocgit-Evaluator-Signature': signature,
    }) : {
      'x-klocgit-evaluator-service': 'ci', 'x-klocgit-evaluator-signature': signature,
    };
    const options = {
      method: 'POST', url: new URL('https://app.example/api/evaluation-runs/issued-run/report'),
      input, principal, actor: 'forged-body-actor', headers,
    };
    const result = kind === 'worker'
      ? await (await handleCoordinatorRequest(f.engine, config, options)).json()
      : await handleLocalRequest(f.engine, options, { root: '/unused-test-root' });
    assert.deepEqual(result, {
      run_id: 'issued-run', event_id: 'observation', state: 'passing', duplicate: false,
    });
    assert.equal(callbacks, 1);
  });
}
