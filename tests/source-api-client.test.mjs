import assert from 'node:assert/strict';
import test from 'node:test';
import { apiRequest, setOwnerCredential } from '../src/lib/api.js';

test('source client retains authentication with extra headers and cancellation', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
    setOwnerCredential('');
  });
  setOwnerCredential('session-credential');
  const controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/source/repositories/example/tree');
    assert.equal(options.headers.get('authorization'), 'Bearer session-credential');
    assert.equal(options.headers.get('x-request-id'), 'source-read');
    assert.equal(options.signal, controller.signal);
    return Response.json({ schema_version: 1 });
  };
  assert.deepEqual(
    await apiRequest('/source/repositories/example/tree', {
      headers: new Headers({ 'x-request-id': 'source-read' }),
      signal: controller.signal,
    }),
    { schema_version: 1 },
  );
});

test('source client exposes both legacy and structured errors without hiding the reason', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [
    { error: 'FORBIDDEN', message: 'Repository read denied.' },
    {
      schema_version: 1,
      error: {
        code: 'FORBIDDEN',
        message: 'Repository read denied.',
        failure_class: 'AUTHORIZATION',
      },
    },
  ]) {
    globalThis.fetch = async () => Response.json(body, { status: 403 });
    await assert.rejects(apiRequest('/source/repositories/example/tree'), {
      code: 'FORBIDDEN',
      message: 'Repository read denied.',
    });
  }
});
