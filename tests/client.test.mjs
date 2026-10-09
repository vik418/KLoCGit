import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, KlocgitError } from '../clients/javascript/client.mjs';

test('canonical stale rejection is returned without retrying or altering the reviewed basis', async () => {
  const calls = [];
  const client = createClient({
    baseUrl: 'https://klocgit.example',
    getToken: async () => 'test-credential',
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json(
        { error: 'DECISION_STALE', message: 'Review the changed basis' },
        { status: 409 },
      );
    },
  });
  const body = {
    request_id: 'stable-op',
    decision_basis_hash: 'reviewed',
    expected_heads: { app: '1'.repeat(40) },
    rationale: 'Chosen behavior',
  };
  await assert.rejects(
    () => client.promote('candidate/a', body),
    (error) =>
      error instanceof KlocgitError && error.status === 409 && error.code === 'DECISION_STALE',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://klocgit.example/api/candidates/candidate%2Fa/promote');
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer test-credential');
});

test('lost responses require caller reuse of an operation identity', async () => {
  let calls = 0;
  const client = createClient({
    baseUrl: 'https://klocgit.example/api/',
    fetch: async () => {
      calls++;
      throw new Error('Connection lost');
    },
  });
  assert.throws(() => client.createFuture({ title: 'Future' }), /stable request_id/);
  assert.equal(calls, 0);
  await assert.rejects(
    () => client.createFuture({ request_id: 'same-operation' }),
    /Connection lost/,
  );
  assert.equal(calls, 1);
});

test('requests read current credentials and preserve cancellation', async () => {
  let token = 'first';
  const calls = [];
  const controller = new AbortController();
  const client = createClient({
    baseUrl: 'http://localhost:43187',
    getToken: () => token,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ version: 0 });
    },
  });
  await client.state({ signal: controller.signal });
  token = 'second';
  await client.session();
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer first');
  assert.equal(calls[1].options.headers.get('authorization'), 'Bearer second');
  for (const baseUrl of [
    'https://user:password@example.org',
    'https://example.org/?token=x',
    'file:///tmp',
  ])
    assert.throws(() => createClient({ baseUrl }));
});
