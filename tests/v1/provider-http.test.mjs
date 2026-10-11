import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderHttp } from '../../adapters/cd/http.mjs';

function client(fetch, options = {}) {
  return new ProviderHttp({
    base_url: 'https://provider.example',
    credential: () => 'test-credential',
    fetch,
    timeout_ms: 1000,
    max_bytes: 100,
    ...options,
  });
}

test('provider requests retain TLS, reject redirects and keep credentials out of returned failures', async () => {
  let captured;
  const http = client((url, options) => {
    captured = { url, options };
    throw new Error('test-credential');
  });
  await assert.rejects(http.request('POST', '/dispatch', {}), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(http.request('GET', '/state'), { code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(captured.url, 'https://provider.example/state');
  assert.equal(captured.options.redirect, 'error');
  await assert.rejects(http.request('GET', '//untrusted.example'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => client(() => {}, { base_url: 'http://untrusted.example' }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('provider error bodies are not exposed and rate/auth/ref errors preserve their failure classes', async () => {
  for (const [status, code] of [
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [500, 'OUTCOME_UNKNOWN'],
  ]) {
    await assert.rejects(
      client(() => new Response('secret', { status })).request('POST', '/dispatch', {}),
      { code },
    );
  }
});

test('request and streamed response budgets fail explicitly without accepting truncated JSON', async () => {
  let calls = 0;
  const http = client(() => {
    calls += 1;
    return new Response(JSON.stringify({ value: 'x'.repeat(100) }));
  });
  await assert.rejects(http.request('POST', '/dispatch', { value: 'x'.repeat(100) }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.equal(calls, 0);
  await assert.rejects(http.request('GET', '/state'), { code: 'PROVIDER_UNAVAILABLE' });
  await assert.rejects(http.request('POST', '/dispatch', {}), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(
    client(() => new Response('invalid-json')).request('POST', '/dispatch', {}),
    { code: 'OUTCOME_UNKNOWN' },
  );
});
