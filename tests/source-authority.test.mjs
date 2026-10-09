import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactsGit } from '../worker/artifacts.mjs';
import { RemoteGit } from '../server/remote-git.mjs';
import {
  admittedSources,
  requestSourceBindings,
  SOURCE_TOKEN_TTL,
} from '../server/source-authority.mjs';

const sourceId = 'app--' + 'a'.repeat(40);
const canonical = {
  remote: 'https://account.artifacts.cloudflare.net/git/klocgit/app.git',
  tokenEnv: 'SOURCE_AUTHORITY_TEST_CANONICAL_TOKEN',
  validation_profile: 'checkout-effects-v0',
  context_repo: 'policy',
};
const manifest = { repositories: { app: canonical } };
const credential = (overrides = {}) => ({
  id: sourceId,
  canonical_repo: 'app',
  remote: 'https://account.artifacts.cloudflare.net/git/klocgit/' + sourceId + '.git',
  scope: 'read',
  plaintext: 'inert-private-read-token',
  expiresAt: new Date(Date.now() + SOURCE_TOKEN_TTL * 1000).toISOString(),
  ...overrides,
});
const payload = (overrides = {}) => ({
  repo: 'app',
  selections: [{ source_repo: sourceId }],
  source_credentials: [credential()],
  ...overrides,
});

test('private dynamic sources inherit canonical policy without becoming configured write repositories', () => {
  const input = payload(),
    original = JSON.stringify(manifest);
  const adapter = new RemoteGit('/unused', manifest).forRequest('compose-selections', input);
  const entry = adapter.entry(sourceId);
  assert.equal(entry.readonly, true);
  assert.equal(entry.validation_profile, 'checkout-effects-v0');
  assert.equal(entry.context_repo, 'policy');
  assert.equal(Object.hasOwn(entry, 'plaintext'), false);
  assert.equal(Object.hasOwn(entry, 'tokenEnv'), false);
  assert.equal(JSON.stringify(manifest), original);
  assert.equal(JSON.stringify(adapter).includes(input.source_credentials[0].plaintext), false);
  assert.throws(
    () => new RemoteGit('/unused', manifest).entry(sourceId),
    (error) => error.code === 'REPO_NOT_CONFIGURED',
  );
  assert.throws(
    () => adapter.configured({ id: sourceId, canonical_repo: 'policy' }),
    (error) => error.code === 'SOURCE_AUTHORITY_INVALID',
  );
});

test('dynamic source credentials cannot issue pushes, CAS, candidate writes or reversions', async () => {
  const adapter = new RemoteGit('/unused', manifest).forRequest('compose-selections', payload());
  let work = 0;
  adapter.ensureCommit = async () => {
    work++;
  };
  const repo = { id: sourceId, canonical_repo: 'app', canonical_ref: 'refs/heads/main' };
  for (const action of [
    () => adapter.remote(sourceId, ['push', 'origin', 'HEAD:refs/heads/main']),
    () => adapter.cas(repo, 'a'.repeat(40), 'b'.repeat(40)),
    () => adapter.compose(repo, 'a'.repeat(40), []),
    () => adapter.composeSelections(repo, 'a'.repeat(40), []),
    () => adapter.revert(repo, 'a'.repeat(40), 'b'.repeat(40)),
    () => adapter.retainCandidate(repo, { commit: 'a'.repeat(40) }),
  ])
    await assert.rejects(action, (error) => error.code === 'SOURCE_WRITE_FORBIDDEN');
  assert.equal(work, 0);
});

test('canonical operations cannot promote a read-only source through a forged canonical descriptor', () => {
  for (const operation of ['cas', 'compose', 'compose-selections', 'revert']) {
    assert.throws(
      () => requestSourceBindings(operation, { repo: sourceId, canonical_repo: 'app' }),
      (error) => error.code === 'SOURCE_WRITE_FORBIDDEN',
    );
  }
  assert.throws(
    () =>
      admittedSources(manifest, 'cas', {
        repo: 'app',
        source_credentials: [credential()],
      }),
    (error) => error.code === 'SOURCE_AUTHORITY_INVALID',
  );
});

test('source authority rejects mismatched repository, canonical policy, remote, scope and expiry', () => {
  const invalid = [
    { id: 'unrelated-source' },
    { canonical_repo: 'policy' },
    { scope: 'write' },
    { remote: 'https://other.artifacts.cloudflare.net/git/klocgit/' + sourceId + '.git' },
    { remote: 'https://account.artifacts.cloudflare.net/git/other/' + sourceId + '.git' },
    { remote: canonical.remote },
    { remote: 'https://secret@account.artifacts.cloudflare.net/git/klocgit/' + sourceId + '.git' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { expiresAt: new Date(Date.now() + 86400000).toISOString() },
    { plaintext: 'inert\nprivate-token' },
  ];
  for (const changed of invalid) {
    const input = payload({ source_credentials: [credential(changed)] });
    assert.throws(
      () => admittedSources(manifest, 'compose-selections', input),
      (error) =>
        error.code === 'SOURCE_AUTHORITY_INVALID' &&
        !error.message.includes('inert-private-read-token'),
    );
  }
  assert.throws(
    () => admittedSources({ repositories: {} }, 'compose-selections', payload()),
    (error) => error.code === 'SOURCE_AUTHORITY_INVALID',
  );
  assert.throws(
    () => admittedSources(manifest, 'compose-selections', payload({ source_credentials: [] })),
    (error) => error.code === 'SOURCE_CREDENTIAL_REQUIRED',
  );
  const repeated = credential();
  assert.throws(
    () =>
      admittedSources(
        manifest,
        'compose-selections',
        payload({ source_credentials: [repeated, repeated] }),
      ),
    (error) => error.code === 'SOURCE_AUTHORITY_INVALID',
  );
});

function artifactsFixture({
  responseLost = false,
  tokenOverrides = {},
  mintFailure = false,
  revokeFailure = false,
  leakResponse = false,
  secondSourceFailure = false,
} = {}) {
  const events = [],
    forwarded = [];
  const token = {
    id: 'token-id',
    scope: 'read',
    plaintext: 'inert-private-read-token',
    expiresAt: new Date(Date.now() + SOURCE_TOKEN_TTL * 1000).toISOString(),
    ...tokenOverrides,
  };
  const env = {
    VALIDATION_CONFIG_HASH: 'trusted-config',
    GIT_BRIDGE_TOKEN: 'inert-bridge-token',
    ARTIFACTS: {
      get: async (id) => {
        events.push({ kind: 'get', id });
        if (secondSourceFailure && id !== sourceId) throw new Error('inert-private-read-token');
        return {
          info: async () => ({
            remote: 'https://account.artifacts.cloudflare.net/git/klocgit/' + id + '.git',
          }),
          createToken: async (scope, ttl) => {
            events.push({ kind: 'mint', scope, ttl });
            if (mintFailure) throw new Error('inert-private-read-token');
            return token;
          },
          revokeToken: async (id) => {
            events.push({ kind: 'revoke', id });
            if (revokeFailure) throw new Error('inert-private-read-token');
            return true;
          },
          [Symbol.dispose]() {
            events.push({ kind: 'dispose' });
          },
        };
      },
    },
    GIT_EXECUTOR: {
      fetch: async (request) => {
        forwarded.push(await request.json());
        if (responseLost) throw new Error('inert-private-read-token');
        if (leakResponse) return Response.json({ secret: token.plaintext });
        if (new URL(request.url).pathname === '/trailers')
          return Response.json([{ key: 'Decision-Intent', value: 'declared' }]);
        if (new URL(request.url).pathname === '/diff') return Response.json({ diff: 'exact diff' });
        return Response.json({ commit: 'b'.repeat(40) });
      },
    },
  };
  return { adapter: new ArtifactsGit(env), events, forwarded, env };
}

test('Artifacts mints a bounded read token for one private call and revokes/disposes it afterwards', async () => {
  const fixture = artifactsFixture(),
    envBefore = JSON.stringify(fixture.env);
  const result = await fixture.adapter.execute('compose-selections', {
    repo: 'app',
    selections: [{ source_repo: sourceId }],
  });
  assert.equal(result.commit, 'b'.repeat(40));
  assert.deepEqual(
    fixture.events.map((entry) => entry.kind),
    ['get', 'mint', 'revoke', 'dispose'],
  );
  assert.deepEqual(fixture.events[1], { kind: 'mint', scope: 'read', ttl: 900 });
  assert.equal(fixture.events[2].id, 'token-id');
  assert.equal(fixture.forwarded.length, 1);
  assert.equal(fixture.forwarded[0].source_credentials[0].scope, 'read');
  assert.equal(fixture.forwarded[0].source_credentials[0].canonical_repo, 'app');
  assert.equal(JSON.stringify(result).includes('inert-private-read-token'), false);
  assert.equal(JSON.stringify(fixture.env), envBefore);
  assert.equal(JSON.stringify(fixture.adapter).includes('inert-private-read-token'), false);
});

test('token mint, validation and private transport failures never leak credentials and still clean up', async () => {
  for (const options of [
    { mintFailure: true },
    { tokenOverrides: { scope: 'write' } },
    { tokenOverrides: { expiresAt: 'invalid' } },
    { responseLost: true },
    { leakResponse: true },
  ]) {
    const fixture = artifactsFixture(options);
    await assert.rejects(
      () =>
        fixture.adapter.execute('compose-selections', {
          repo: 'app',
          selections: [{ source_repo: sourceId }],
        }),
      (error) => !error.message.includes('inert-private-read-token') && error.status === 503,
    );
    assert.equal(fixture.events.filter((entry) => entry.kind === 'dispose').length, 1);
    if (!options.mintFailure)
      assert.equal(fixture.events.filter((entry) => entry.kind === 'revoke').length, 1);
  }
});

test('failure minting a later source revokes earlier tokens before any executor call', async () => {
  const fixture = artifactsFixture({ secondSourceFailure: true });
  await assert.rejects(
    () =>
      fixture.adapter.execute('compose-selections', {
        repo: 'app',
        selections: [{ source_repo: sourceId }, { source_repo: 'app--' + 'b'.repeat(40) }],
      }),
    (error) => error.code === 'SOURCE_CREDENTIAL_UNAVAILABLE',
  );
  assert.equal(fixture.forwarded.length, 0);
  assert.equal(fixture.events.filter((entry) => entry.kind === 'revoke').length, 1);
  assert.equal(fixture.events.filter((entry) => entry.kind === 'dispose').length, 1);
});

test('failed token revocation preserves an acknowledged result with bounded read-only expiry', async () => {
  const fixture = artifactsFixture({ revokeFailure: true });
  assert.equal(
    (
      await fixture.adapter.execute('compose-selections', {
        repo: 'app',
        selections: [{ source_repo: sourceId }],
      })
    ).commit,
    'b'.repeat(40),
  );
  assert.equal(fixture.events.at(-1).kind, 'dispose');
  assert.equal(fixture.forwarded[0].source_credentials[0].scope, 'read');
});

test('caller-supplied credentials and source write requests are rejected before mint or dispatch', async () => {
  for (const [operation, input] of [
    ['compose-selections', { repo: 'app', source_credentials: [credential()] }],
    ['cas', { repo: sourceId, canonical_repo: 'app' }],
  ]) {
    const fixture = artifactsFixture();
    await assert.rejects(
      () => fixture.adapter.execute(operation, input),
      (error) => ['SOURCE_AUTHORITY_INVALID', 'SOURCE_WRITE_FORBIDDEN'].includes(error.code),
    );
    assert.deepEqual(fixture.events, []);
    assert.deepEqual(fixture.forwarded, []);
  }
});

test('source descriptors survive executor reads without conferring canonical write authority', async () => {
  const fixture = artifactsFixture();
  await fixture.adapter.readRef({ id: sourceId, canonical_repo: 'app' }, 'refs/tags/release');
  await fixture.adapter.listRefs({ id: sourceId, canonical_repo: 'app' }, { limit: 20 });
  assert.equal(
    await fixture.adapter.trailers({ id: sourceId, canonical_repo: 'app' }, 'a'.repeat(40)),
    'Decision-Intent: declared',
  );
  assert.equal(
    await fixture.adapter.diff(
      { id: sourceId, canonical_repo: 'app' },
      'a'.repeat(40),
      'b'.repeat(40),
    ),
    'exact diff',
  );
  assert.ok(
    fixture.forwarded.every(
      (input) => input.canonical_repo === 'app' && input.source_credentials[0].id === sourceId,
    ),
  );
});
