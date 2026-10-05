import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { getCapabilities } from '../core/capabilities.mjs';
import { handleWorkflowRequest } from '../server/workflow-api.mjs';

const request = {
  method: 'GET',
  url: 'https://workspace/api/capabilities',
  input: {},
  actor: 'owner',
};

// A capability read must not inspect repositories, invoke services or mutate state.
const inaccessibleEngine = new Proxy(
  {},
  {
    get() {
      throw new Error('Capability reads must be independent of engine state');
    },
    set() {
      throw new Error('Capability reads must not change engine state');
    },
  },
);

test('current capability registry keeps bounded trust and deployment limits visible', () => {
  const registry = getCapabilities();
  assert.equal(registry.version, 0);
  const statuses = new Set(registry.statuses.map((status) => status.id));
  assert.deepEqual(statuses, new Set(['SUPPORTED', 'PARTIAL', 'EXPERIMENTAL', 'UNSUPPORTED']));
  const entries = new Map(registry.capabilities.map((capability) => [capability.id, capability]));
  assert.equal(entries.size, registry.capabilities.length, 'Capability IDs must be unique');
  for (const capability of entries.values()) {
    assert.ok(statuses.has(capability.status), `Unknown status for ${capability.id}`);
    for (const field of ['category', 'title', 'scope', 'limits']) {
      assert.ok(
        typeof capability[field] === 'string' && capability[field].trim(),
        `${capability.id} needs ${field}`,
      );
    }
  }
  for (const id of [
    'git.clients',
    'evidence.trusted',
    'decisions.groups',
    'canonical.cas',
    'provenance.binding',
  ]) {
    assert.ok(entries.has(id), `Missing core capability ${id}`);
  }
  assert.match(registry.verification_scope, /finite.*does not prove global correctness/i);
  assert.match(entries.get('evidence.external').limits, /never sole verification/i);
  assert.match(
    entries.get('provenance.binding').limits,
    /unknown provenance.*accepted.*remains unknown/i,
  );
  assert.equal(entries.get('security.identity').status, 'PARTIAL');
  assert.match(entries.get('security.identity').limits, /no multi-user authentication/i);
  assert.equal(entries.get('cloudflare.live').status, 'EXPERIMENTAL');
  assert.match(entries.get('cloudflare.live').limits, /live provisioning.*unverified/i);
});

test('capability snapshots cannot change later responses', () => {
  const expected = getCapabilities();
  const edited = getCapabilities();
  edited.version = 999;
  edited.statuses[0].label = 'Forged';
  edited.capabilities[0].status = 'UNSUPPORTED';
  edited.capabilities[0].limits = '';
  edited.capabilities[0].tests.pop();
  edited.capabilities.pop();
  assert.deepEqual(getCapabilities(), expected);
});

test('supported capability claims link to existing automated coverage suites', async () => {
  const entries = getCapabilities().capabilities;
  for (const entry of entries.filter((value) => value.status === 'SUPPORTED')) {
    assert.ok(Array.isArray(entry.tests) && entry.tests.length, `${entry.id} needs coverage links`);
  }
  const files = new Set(entries.flatMap((entry) => entry.tests ?? []));
  await Promise.all(
    [...files].map(async (file) => {
      assert.match(
        file,
        /^tests\/[\w-]+\.test\.mjs$/,
        'Coverage links must be relative test-suite paths',
      );
      assert.ok(
        (await stat(new URL(`../${file}`, import.meta.url))).isFile(),
        `${file} must exist`,
      );
    }),
  );
});

test('capability API is authenticated, read-only and independent of producer input or engine state', async () => {
  await assert.rejects(
    () =>
      handleWorkflowRequest(inaccessibleEngine, {
        ...request,
        input: { actor: 'owner' },
        actor: '',
      }),
    (error) => error.status === 401,
  );
  const result = await handleWorkflowRequest(inaccessibleEngine, {
    ...request,
    input: { actor: 'forged-owner', status: 'SUPPORTED', capabilities: [] },
  });
  assert.deepEqual(result, getCapabilities());
  result.capabilities[0].limits = 'Forged';
  assert.deepEqual(await handleWorkflowRequest(inaccessibleEngine, request), getCapabilities());
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(
      () => handleWorkflowRequest(inaccessibleEngine, { ...request, method }),
      (error) => error.status === 405,
    );
  }
});
