import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Run the actual gateway handler with only the Cloudflare runtime class stubbed.
const runtime = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      const stub =
        'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
      return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { GitExecutorContainer } = await import('../worker/executor.mjs');
runtime.deregister();

function fixture({ tests = false, uncertain = false } = {}) {
  const data = new Map(),
    calls = [];
  let destroyed = 0;
  const storage = {
    get: async (k) => data.get(k),
    put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async (k) => data.delete(k),
  };
  const container = {
    running: true,
    destroy: async () => {
      destroyed++;
      container.running = false;
    },
    getTcpPort: () => ({
      fetch: async (url, input) => {
        const request = url instanceof Request ? url : new Request(url, input);
        calls.push(new URL(request.url).pathname);
        if (new URL(request.url).pathname === '/health')
          return Response.json({ configHash: 'test' });
        if (uncertain) throw new Error('Response lost');
        return Response.json({ updated: true });
      },
    }),
  };
  const env = {
    GIT_BRIDGE_TOKEN: 'bridge-test',
    LIVE_TEST_TOKEN: 'fault-test',
    LIVE_TEST_ENABLED: tests ? 'true' : 'false',
  };
  return {
    gateway: new GitExecutorContainer({ storage, container, waitUntil() {} }, env),
    data,
    calls,
    get destroyed() {
      return destroyed;
    },
  };
}
function request(route, token, body) {
  return new Request('https://executor' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test('executor fault controls require both opt-in and a separate credential', async () => {
  const disabled = fixture();
  assert.equal(
    (
      await disabled.gateway.fetch(
        request('/control/arm', 'fault-test', {
          kind: 'drop-cas-response-once',
          repo: 'app',
          expected: 'old',
        }),
      )
    ).status,
    401,
  );
  const enabled = fixture({ tests: true });
  assert.equal(
    (
      await enabled.gateway.fetch(
        request('/control/arm', 'bridge-test', {
          kind: 'drop-cas-response-once',
          repo: 'app',
          expected: 'old',
        }),
      )
    ).status,
    401,
  );
  assert.equal(disabled.calls.length, 0);
  assert.equal(enabled.data.size, 0);
});
test('executor never retries a forwarded canonical operation after an uncertain result', async () => {
  const f = fixture({ uncertain: true });
  const response = await f.gateway.fetch(
    request('/cas', 'bridge-test', { repo: 'app', expected: 'old', commit: 'target' }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(f.calls, ['/health', '/cas']);
});
test('recovery fault records one actual CAS result durably before withholding its reply', async () => {
  const f = fixture({ tests: true });
  assert.equal(
    (
      await f.gateway.fetch(
        request('/control/arm', 'fault-test', {
          kind: 'drop-cas-response-once',
          repo: 'app',
          expected: 'old',
        }),
      )
    ).status,
    200,
  );
  const response = await f.gateway.fetch(
    request('/cas', 'bridge-test', { repo: 'app', expected: 'old', commit: 'target' }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'LIVE_TEST_RESPONSE_DROPPED');
  assert.equal(f.data.get('faultReceipt').updated, true);
  assert.equal(f.data.get('faultReceipt').target, 'target');
  assert.equal(f.data.has('armedFault'), false);
  assert.deepEqual(f.calls, ['/health', '/cas']);
  assert.equal((await f.gateway.fetch(request('/control/restart', 'fault-test', {}))).status, 200);
  assert.equal(f.destroyed, 1);
});
