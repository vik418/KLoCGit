import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { record } from '../core/hash.mjs';
import { AccessControl, redactSensitive } from '../core/access.mjs';
import {
  JwtVerifier, authenticateRequest, forwardPrincipal, trustedPrincipal, internalPrincipal,
} from '../worker/identity.mjs';

const issuer = 'https://team.cloudflareaccess.com';
const audience = 'application-audience';
const clock = 1_900_000_000_000;
const seconds = Math.floor(clock / 1000);
const human = (actor_id) => ({ actor_id, kind: 'human', auth_method: 'owner-token' });
const owner = human('owner');
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const rsa = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const ec = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rsaJwk = { ...await webcrypto.subtle.exportKey('jwk', rsa.publicKey), kid: 'rsa-one', alg: 'RS256', use: 'sig' };
const ecJwk = { ...await webcrypto.subtle.exportKey('jwk', ec.publicKey), kid: 'ec-one', alg: 'ES256', use: 'sig' };
function jwks(keys = [rsaJwk]) {
  return new Response(JSON.stringify({ keys }), { headers: { 'Content-Type': 'application/json' } });
}
function verifier(options = {}) {
  return new JwtVerifier({
    issuer, audience, jwksUrl: issuer + '/cdn-cgi/access/certs',
    fetch: async () => jwks(), now: () => clock, crypto: webcrypto, ...options,
  });
}
async function jwt(claims = {}, header = {}, pair = rsa) {
  const h = { alg: 'RS256', kid: rsaJwk.kid, typ: 'JWT', ...header };
  const c = { iss: issuer, aud: [audience], sub: 'subject-one', iat: seconds - 10, exp: seconds + 3600, ...claims };
  const input = encoded(h) + '.' + encoded(c);
  const algorithm = pair === ec ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const signature = await webcrypto.subtle.sign(algorithm, pair.privateKey, new TextEncoder().encode(input));
  return input + '.' + Buffer.from(signature).toString('base64url');
}

test('real RSA verification yields a stable issuer/subject actor and ignores producer identity claims', async () => {
  const check = verifier();
  const first = await check.verify(await jwt({ actor_id: 'owner', email: 'pretend@example.com' }));
  const second = await check.verify(await jwt({ name: 'Different display name', email: 'changed@example.com' }));
  assert.equal(first.actor_id, second.actor_id);
  assert.match(first.actor_id, /^actor_[a-f0-9]{64}$/);
  assert.equal(first.kind, 'human');
  assert.equal(first.auth_method, 'oidc');
  assert.equal(first.email, undefined);
  const otherIssuer = 'https://different.example.com';
  const third = await verifier({ issuer: otherIssuer }).verify(await jwt({ iss: otherIssuer }));
  assert.notEqual(third.actor_id, first.actor_id);
});

test('real ES256 signatures work only when the deployment explicitly enables ES256', async () => {
  const token = await jwt({}, { alg: 'ES256', kid: ecJwk.kid }, ec);
  await assert.rejects(() => verifier({ fetch: async () => jwks([ecJwk]) }).verify(token), { code: 'UNAUTHENTICATED' });
  const principal = await verifier({ algorithms: ['ES256'], fetch: async () => jwks([ecJwk]) }).verify(token);
  assert.equal(principal.kind, 'human');
});

test('JWT issuer, audience, time bounds and key-source policy fail closed', async () => {
  const check = verifier();
  for (const claims of [
    { iss: issuer + '/' }, { aud: 'another-application' }, { exp: seconds },
    { nbf: seconds + 1 }, { iat: seconds + 1 }, { exp: String(seconds + 100) },
    { sub: '' }, { aud: [audience, 'another-app'] }, { aud: [audience, audience] },
  ]) await assert.rejects(() => jwt(claims).then((token) => check.verify(token)), { code: 'UNAUTHENTICATED' });
  for (const header of [
    { alg: 'none' }, { alg: 'HS256' }, { jku: 'https://attacker.example/keys' },
    { jwk: rsaJwk }, { x5u: 'https://attacker.example/cert' }, { crit: ['b64'] }, { b64: false },
  ]) await assert.rejects(() => jwt({}, header).then((token) => check.verify(token)), { code: 'UNAUTHENTICATED' });
  assert.equal((await check.verify(await jwt({ aud: [audience, 'another-app'], azp: audience }))).kind, 'human');
});

test('tampered payloads and signatures cannot impersonate another actor', async () => {
  const token = await jwt();
  const segments = token.split('.');
  const forged = { iss: issuer, aud: [audience], sub: 'owner', exp: seconds + 3600 };
  await assert.rejects(() => verifier().verify([segments[0], encoded(forged), segments[2]].join('.')), { code: 'UNAUTHENTICATED' });
  const signature = Buffer.from(segments[2], 'base64url');
  signature[0] ^= 1;
  await assert.rejects(() => verifier().verify([segments[0], segments[1], signature.toString('base64url')].join('.')), { code: 'UNAUTHENTICATED' });
});

test('JWKS cache coalesces requests, bounds unknown-key refresh and refuses expired keys during outages', async () => {
  let time = clock;
  let calls = 0;
  let outage = false;
  let keys = [rsaJwk];
  const check = verifier({
    now: () => time,
    fetch: async () => { calls += 1; if (outage) throw new Error('offline'); return jwks(keys); },
  });
  const token = await jwt();
  await Promise.all([check.verify(token), check.verify(token), check.verify(token)]);
  assert.equal(calls, 1);
  const rotated = await jwt({}, { kid: 'rsa-two' });
  await assert.rejects(() => check.verify(rotated), { code: 'UNAUTHENTICATED' });
  assert.equal(calls, 1);
  keys = [{ ...rsaJwk, kid: 'rsa-two' }];
  time += 31_000;
  assert.equal((await check.verify(rotated)).kind, 'human');
  assert.equal(calls, 2);
  time += 300_000;
  outage = true;
  await assert.rejects(() => check.verify(rotated), { code: 'IDENTITY_PROVIDER_UNAVAILABLE', status: 503 });
});

test('invalid, oversized and timed-out JWKS responses are bounded failures', async () => {
  const token = await jwt();
  await assert.rejects(() => verifier({ fetch: async () => jwks(Array.from({ length: 33 }, (_, index) => ({ ...rsaJwk, kid: String(index) }))) }).verify(token), { code: 'IDENTITY_PROVIDER_UNAVAILABLE', status: 503 });
  for (const fetcher of [
    async () => jwks([rsaJwk, rsaJwk]),
    async () => new Response('not-json'),
    async () => new Response('x'.repeat(65_537)),
    async () => new Promise(() => {}),
  ]) await assert.rejects(
    () => verifier({ fetch: fetcher, timeoutMs: 100 }).verify(token),
    { code: 'IDENTITY_PROVIDER_UNAVAILABLE', status: 503 },
  );
});

test('legacy owner and ingestion tokens select fixed principals despite forged actor headers or JSON', async () => {
  const env = { AUTH_TOKEN: 'owner-secret', ACTOR_ID: 'owner', INGEST_TOKEN: 'ingress-secret' };
  const request = new Request('https://app.example/api/futures', {
    method: 'POST', headers: { Authorization: 'Bearer owner-secret', 'X-Actor-ID': 'admin' },
    body: JSON.stringify({ actor: 'admin' }),
  });
  assert.deepEqual(await authenticateRequest(request, env), owner);
  assert.deepEqual(await authenticateRequest(new Request('https://app.example/api/session', {
    headers: { Authorization: 'bearer owner-secret' },
  }), env), owner);
  const ingress = await authenticateRequest(new Request('https://app.example/api/events', {
    headers: { Authorization: 'Bearer ingress-secret' },
  }), env, { ingress: true });
  assert.deepEqual(ingress, { actor_id: 'git-ingress', kind: 'service', auth_method: 'ingest-token' });
  await assert.rejects(() => authenticateRequest(request, { AUTH_TOKEN: 'owner-secret' }), { code: 'AUTH_NOT_CONFIGURED', status: 503 });
  await assert.rejects(() => authenticateRequest(new Request('https://app.example/api/events', {
    headers: { Authorization: 'Bearer owner-secret' },
  }), env, { ingress: true }), { code: 'UNAUTHENTICATED' });
});

test('Cloudflare Access assertion headers require actual signature verification against configured issuer and audience', async (t) => {
  const accessIssuer = 'https://unique-team.cloudflareaccess.com';
  const currentSeconds = Math.floor(Date.now() / 1000);
  const token = await jwt({ iss: accessIssuer, sub: 'access-user', iat: currentSeconds - 1, exp: currentSeconds + 3600 });
  t.mock.method(globalThis, 'fetch', async () => jwks());
  const env = {
    OIDC_ISSUER: accessIssuer, OIDC_AUDIENCE: audience,
    OIDC_JWKS_URL: accessIssuer + '/cdn-cgi/access/certs',
  };
  const request = new Request('https://app.example/api/session', { headers: { 'Cf-Access-Jwt-Assertion': token } });
  const principal = await authenticateRequest(request, env);
  assert.match(principal.actor_id, /^actor_/);
  await assert.rejects(() => authenticateRequest(new Request(request, {
    headers: { 'Cf-Access-Jwt-Assertion': token, Authorization: 'Bearer different-token' },
  }), env), { code: 'UNAUTHENTICATED' });
  await assert.rejects(() => authenticateRequest(request, { OIDC_ISSUER: accessIssuer }), { code: 'AUTH_NOT_CONFIGURED', status: 503 });
});

test('private coordinator envelopes bind actor, body, path, workspace and expiration and strip public credentials', async () => {
  const env = { WORKSPACE_ID: 'workspace', AUTH_TOKEN: 'transport-secret' };
  const request = new Request('https://app.example/api/futures?view=current', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer public-credential', Cookie: 'private=session',
      'Cf-Access-Jwt-Assertion': 'raw-jwt', 'X-Klocgit-Principal': 'forged',
    },
    body: JSON.stringify({ actor: 'forged', request_id: 'create-one' }),
  });
  const forwarded = await forwardPrincipal(request, owner, env, { now: () => clock });
  assert.equal(forwarded.headers.get('Authorization'), null);
  assert.equal(forwarded.headers.get('Cookie'), null);
  assert.equal(forwarded.headers.get('Cf-Access-Jwt-Assertion'), null);
  assert.deepEqual(await trustedPrincipal(forwarded, env, { now: () => clock }), owner);
  const changedBody = new Request(forwarded, { body: '{"actor":"owner","request_id":"different"}' });
  await assert.rejects(() => trustedPrincipal(changedBody, env, { now: () => clock }), { code: 'UNAUTHENTICATED' });
  const changedPath = new Request('https://app.example/api/promotions', {
    method: 'POST', headers: forwarded.headers, body: await forwarded.clone().text(),
  });
  await assert.rejects(() => trustedPrincipal(changedPath, env, { now: () => clock }), { code: 'UNAUTHENTICATED' });
  await assert.rejects(() => trustedPrincipal(forwarded, { ...env, WORKSPACE_ID: 'other' }, { now: () => clock }), { code: 'UNAUTHENTICATED' });
  await assert.rejects(() => trustedPrincipal(forwarded, env, { now: () => clock + 60_000 }), { code: 'UNAUTHENTICATED' });
  await assert.rejects(() => trustedPrincipal(request, env), { code: 'UNAUTHENTICATED' });
  assert.equal(internalPrincipal('artifacts-ingress').kind, 'internal');
  assert.throws(() => internalPrincipal('caller-selected-admin'), { code: 'UNAUTHENTICATED' });
});

function workspace() {
  const state = {
    workspace: { owner_id: 'owner' }, repositories: [{ id: 'app' }, { id: 'api' }],
    nativeRepositories: [{ id: 'empty-native' }], audit: [],
  };
  let saves = 0;
  const engine = {
    state,
    audit: async (type, actor, data) => state.audit.push(await record('audit', {
      type, actor, data, previous: state.audit.at(-1)?.id ?? null,
    })),
    save: async () => { saves += 1; },
  };
  return { state, engine, access: new AccessControl(engine), saves: () => saves };
}
async function grant(f, actor_id, repo_id, roles, principal = owner) {
  return f.access.update({
    expected_version: f.access.state.version, changes: [{ actor_id, repo_id, roles }],
  }, principal);
}

test('legacy metadata starts owner-only and explicit grants persist independent producer/reviewer roles', async () => {
  const f = workspace();
  assert.equal(f.access.state.version, 0);
  assert.equal(f.access.require(owner, 'repository.create'), 'owner');
  assert.equal(f.access.session(human('new-user')).member, false);
  assert.throws(() => f.access.require(human('new-user'), 'workspace.read'), { code: 'FORBIDDEN' });
  await grant(f, 'producer', 'app', ['producer']);
  await grant(f, 'reviewer', 'app', ['reviewer']);
  assert.equal(f.access.require(human('producer'), 'proposal.create', ['app']), 'producer');
  assert.throws(() => f.access.require(human('producer'), 'review.write', ['app']), { code: 'FORBIDDEN' });
  assert.equal(f.access.require(human('reviewer'), 'review.write', ['app']), 'reviewer');
  assert.throws(() => f.access.require(human('reviewer'), 'proposal.create', ['app']), { code: 'FORBIDDEN' });
  assert.equal(f.access.session(human('producer')).member, true);
  assert.deepEqual(f.access.visibleRepositories(human('producer')), ['app']);
  const restored = new AccessControl({ ...f.engine, state: structuredClone(f.state) });
  assert.equal(restored.require(human('producer'), 'repository.read', ['app']), 'producer');
  assert.equal(f.saves(), 2);
  f.state.workspace.owner_id = 'changed-owner';
  assert.throws(() => f.access.session(human('changed-owner')), { code: 'ACCESS_POLICY_UNAVAILABLE' });
});

test('all affected repositories require permission and repository administrators cannot widen scope or replace the owner', async () => {
  const f = workspace();
  await grant(f, 'repo-admin', 'app', ['admin']);
  const admin = human('repo-admin');
  assert.throws(() => f.access.require(admin, 'decision.resolve', ['app', 'api']), { code: 'FORBIDDEN' });
  await grant(f, 'reader', 'app', ['reader'], admin);
  assert.deepEqual(f.access.policy(admin, 'app').grants.map((entry) => entry.repo_id), ['app', 'app']);
  await assert.rejects(() => grant(f, 'reader', 'api', ['admin'], admin), { code: 'FORBIDDEN' });
  await assert.rejects(() => grant(f, 'repo-admin', null, ['admin'], admin), { code: 'FORBIDDEN' });
  await assert.rejects(() => grant(f, 'reader', 'app', ['admin'], human('reader')), { code: 'FORBIDDEN' });
  await assert.rejects(() => grant(f, 'owner', null, [], owner), { code: 'OWNER_ROLE_IMMUTABLE' });
  assert.throws(() => f.access.require(admin, 'repository.create'), { code: 'FORBIDDEN' });
  assert.throws(() => f.access.require(owner, 'arbitrary-unmapped-operation', ['app']), { code: 'FORBIDDEN' });
});

test('revocations take effect immediately, stale policy writes fail, and audit/version history remains immutable', async () => {
  const f = workspace();
  await grant(f, 'user', 'app', ['maintainer']);
  const original = structuredClone(f.state.accessVersions[0]);
  const oldVersion = f.access.state.version;
  await grant(f, 'user', 'app', []);
  assert.throws(() => f.access.require(human('user'), 'decision.resolve', ['app']), { code: 'FORBIDDEN' });
  assert.equal(f.access.session(human('user')).member, false);
  await assert.rejects(() => f.access.update({
    expected_version: oldVersion, changes: [{ actor_id: 'user', repo_id: 'app', roles: ['admin'] }],
  }, owner), { code: 'ACCESS_POLICY_STALE', status: 409 });
  assert.deepEqual(f.state.accessVersions[0], original);
  assert.deepEqual(f.state.audit.map((entry) => entry.type), ['access.granted', 'access.revoked']);
  assert.equal(f.state.audit[1].previous, f.state.audit[0].id);
});

test('service and internal principals cannot become user reviewers or membership administrators', () => {
  const f = workspace();
  const service = { actor_id: 'git-ingress', kind: 'service', auth_method: 'ingest-token' };
  assert.equal(f.access.require(service, 'ingress.write', ['app']), 'git-ingress');
  assert.throws(() => f.access.require(service, 'decision.resolve', ['app']), { code: 'FORBIDDEN' });
  assert.throws(() => f.access.require(service, 'access.manage'), { code: 'FORBIDDEN' });
  assert.equal(f.access.require(internalPrincipal(), 'analysis.run'), 'coordinator');
  assert.throws(() => f.access.require(internalPrincipal(), 'review.write', ['app']), { code: 'FORBIDDEN' });
});

test('bounded governance quotas reject additional work without deleting history', async () => {
  const f = workspace();
  await f.access.update({ expected_version: 0, changes: [], limits: { members: 2, pending_runs: 1 } }, owner);
  await grant(f, 'one-user', 'app', ['reader']);
  await assert.rejects(() => grant(f, 'another-user', 'app', ['reader']), { code: 'WORKSPACE_QUOTA_EXCEEDED', status: 429 });
  assert.throws(() => f.access.assertQuota('pending_runs', 1), { code: 'WORKSPACE_QUOTA_EXCEEDED', status: 429 });
  assert.equal(f.state.accessVersions.length, 2);
  assert.equal(f.state.audit.length, 2);
  await assert.rejects(() => f.access.update({ expected_version: 2, changes: [], limits: { request_bytes: 1_000_001 } }, owner), { code: 'INVALID_ACCESS_POLICY' });
});

test('failed membership persistence rolls back grants, versions and the in-memory audit suffix', async () => {
  const f = workspace();
  f.engine.save = async () => { throw new Error('storage failed'); };
  await assert.rejects(() => grant(f, 'user', 'app', ['admin']), /storage failed/);
  assert.equal(f.state.access, undefined);
  assert.equal(f.state.accessVersions, undefined);
  assert.equal(f.state.audit.length, 0);
  assert.equal(f.engine.accessPersistenceFailed, true);
  assert.throws(() => f.access.require(internalPrincipal(), 'analysis.run'), { code: 'ACCESS_POLICY_UNAVAILABLE', status: 503 });
  assert.throws(() => f.access.require(human('user'), 'access.manage', ['app']), { code: 'ACCESS_POLICY_UNAVAILABLE', status: 503 });
});

test('audit export redacts credentials and omits other repository scopes for restricted maintainers', async () => {
  const f = workspace();
  await grant(f, 'maintainer', 'app', ['maintainer']);
  await f.engine.audit('repository.operation', 'owner', {
    repo_id: 'app', password: 'private', prompt: 'private-context',
    remote: 'https://user:password@example.com/repo?token=secret&ref=main',
    nested: { access_token: 'secret', body: 'Bearer secret' },
  });
  await f.engine.audit('repository.operation', 'maintainer', { repo_id: 'api', details: 'hidden' });
  await f.engine.audit('unknown.scope', 'maintainer', { details: 'also hidden' });
  const scoped = f.access.redactAudit(human('maintainer'));
  assert.equal(scoped.length, 2);
  const entry = scoped.find((row) => row.type === 'repository.operation');
  assert.equal(entry.data.password, '[redacted]');
  assert.equal(entry.data.prompt, '[redacted]');
  assert.equal(entry.data.remote, 'https://example.com/repo?ref=main');
  assert.equal(entry.data.nested.access_token, '[redacted]');
  assert.equal(entry.data.nested.body, '[redacted]');
  assert.equal(f.state.audit.find((row) => row.type === 'repository.operation').data.password, 'private');
  assert.equal(redactSensitive({ private_context: 'secret' }).private_context, '[redacted]');
});

test('scoped native reads preserve ref pagination while cross-repository context remains private', async () => {
  const f = workspace();
  await grant(f, 'maintainer', 'app', ['maintainer']);
  const principal = human('maintainer');
  const refs = {
    repo_id: 'app',
    refs: [{ ref: 'refs/heads/main', object_id: 'a'.repeat(40), commit: 'a'.repeat(40) }],
    has_more: true,
    next_cursor: 'refs/heads/main',
  };
  assert.deepEqual(f.access.projectNative(refs, principal), refs);
  f.state.nativeContextPreparations = [{
    id: 'private-preparation', sources: [{ repo_id: 'api', path: 'policy.json' }],
  }];
  f.state.nativeContextSnapshots = [{
    id: 'bound-snapshot', preparation_id: 'private-preparation',
  }];
  const revision = {
    id: 'context-bound-revision', repositories: [{ repo_id: 'app' }],
    context_snapshot: 'bound-snapshot',
  };
  f.state.futureRevisions = [revision];
  assert.deepEqual(f.access.resourceRepositories(revision), ['api', 'app']);
  assert.equal(f.access.readable(principal, revision), false);
  assert.deepEqual(f.access.projectNative([revision], principal), []);
  const view = f.access.project({
    ...f.state, workspace: { ...f.state.workspace, id: 'space' },
    nativeState: {
      futureRevisions: [revision],
      contextSnapshots: f.state.nativeContextSnapshots,
      contextPreparations: f.state.nativeContextPreparations,
    },
  }, principal);
  assert.deepEqual(view.nativeState.futureRevisions, []);
  assert.deepEqual(view.nativeState.contextSnapshots, []);
  assert.deepEqual(view.nativeState.contextPreparations, []);
  await f.engine.audit('candidate.observed', 'owner', {
    repo_id: 'app', context_snapshot: 'bound-snapshot', rationale: 'Private policy reasoning',
  });
  assert.equal(f.access.redactAudit(principal).some((entry) => entry.type === 'candidate.observed'), false);
});

test('scoped discovery counts only visible decision groups and unresolved work', async () => {
  const f = workspace();
  await grant(f, 'reader', 'app', ['reader']);
  const visible = { id: 'visible-native', repositories: [{ repo_id: 'app' }] };
  const privateRevision = { id: 'private-native', repositories: [{ repo_id: 'api' }] };
  f.state.futureRevisions = [visible, privateRevision];
  f.state.nativeDecisionGroups = [
    { id: 'visible-group', revision_ids: [visible.id], status: 'open' },
    { id: 'mixed-group', revision_ids: [visible.id, privateRevision.id], status: 'open' },
  ];
  f.state.candidateStates = [
    { id: 'visible-probe', repositories: [{ repo_id: 'app' }] },
    { id: 'private-probe', repositories: [{ repo_id: 'api' }] },
  ];
  const view = f.access.project({
    ...f.state, workspace: { ...f.state.workspace, id: 'space' },
    nativeState: {
      futureRevisions: f.state.futureRevisions,
      decisionGroups: f.state.nativeDecisionGroups,
      candidates: f.state.candidateStates,
      discovery: {
        analysis_candidate_ids: ['visible-probe', 'private-probe'],
        ungrouped_revision_ids: [visible.id, privateRevision.id],
        unknown_revision_ids: [privateRevision.id],
        classified_revision_ids: [visible.id, privateRevision.id],
        blocking_decision_count: 2, conventional_review_count: 2,
        human_attention_count: 4, comparisons: 500, diagnostics: [{ private: 'hidden' }],
      },
    },
  }, human('reader'));
  assert.deepEqual(view.nativeState.decisionGroups.map((group) => group.id), ['visible-group']);
  assert.deepEqual(view.nativeState.discovery.ungrouped_revision_ids, [visible.id]);
  assert.deepEqual(view.nativeState.discovery.unknown_revision_ids, []);
  assert.deepEqual(view.nativeState.discovery.analysis_candidate_ids, ['visible-probe']);
  assert.equal(view.nativeState.discovery.blocking_decision_count, 1);
  assert.equal(view.nativeState.discovery.conventional_review_count, 1);
  assert.equal(view.nativeState.discovery.human_attention_count, 2);
  assert.equal(view.nativeState.discovery.comparisons, null);
  assert.deepEqual(view.nativeState.discovery.diagnostics, []);
});
