import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { AuditStream, appendAudit } from '../../core/v1/audit.mjs';
import { ConfigurationStore } from '../../core/v1/configuration-store.mjs';
import { authorizationGrant } from '../../core/v1/authorization.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';

const scope = {
  schema_version: 1,
  tenant_id: 'tenant',
  system_id: 'group',
  kind: 'OBJECTIVE',
  resource_id: 'policy',
};
const principal = {
  schema_version: 1,
  actor_id: 'owner',
  tenant_id: 'tenant',
  kind: 'human',
  capability_id: null,
};
const cursor = { schema_version: 1, after: 0, limit: 100, expected_digest: null };
const event = (key) => ({
  schema_version: 1,
  event_key: key,
  actor_id: 'owner',
  trace_id: 'trace',
  action: 'policy.update',
  subject_id: 'policy',
  operation_id: null,
  from_state: null,
  to_state: 'CONFIGURED',
  failure_class: null,
  bindings: {},
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-audit-')),
    backends = [];
  let allowed = true;
  const authorize = (actor, request) =>
    allowed && actor.actor_id === principal.actor_id && actor.tenant_id === request.tenant_id;
  const open = () => {
    const backend = new SqliteCoordinationBackend({
      filename: join(directory, 'state.sqlite'),
      busy_timeout_ms: 1000,
    });
    backends.push(backend);
    const store = new CoordinationStore(backend),
      stream = new AuditStream({ store, authorize, max_page_size: 100 });
    return { backend, store, stream };
  };
  t.after(async () => {
    backends.forEach((backend) => backend.close());
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...open(),
    open,
    authorize,
    revoke: () => {
      allowed = false;
    },
  };
}

test('audit append, pagination and retry identity survive backend restart', async (t) => {
  const f = await fixture(t);
  const first = await f.store.transaction(scope, (tx) =>
    appendAudit(tx, scope, event('first'), () => 100),
  );
  const retry = await f.store.transaction(scope, (tx) =>
    appendAudit(tx, scope, { ...event('first'), trace_id: 'retry' }, () => 200),
  );
  assert.deepEqual(retry, first);
  await f.store.transaction(scope, (tx) => appendAudit(tx, scope, event('second'), () => 200));
  await assert.rejects(
    f.store.transaction(scope, (tx) =>
      appendAudit(tx, scope, { ...event('first'), actor_id: 'other' }),
    ),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const page = await f.stream.read(scope, { ...cursor, limit: 1 }, principal);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].retention_class, 'CANONICAL');
  f.backend.close();
  const resumed = f.open();
  const next = await resumed.stream.read(scope, page.cursor, principal);
  assert.equal(next.entries[0].previous_digest, first.digest);
  assert.equal(next.entries[0].sequence, 2);
});

test('concurrent appenders form one contiguous chain without lost entries', async (t) => {
  const f = await fixture(t),
    second = f.open();
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      [f.store, second.store][i % 2].transaction(scope, (tx) =>
        appendAudit(tx, scope, event('entry-' + i), () => i),
      ),
    ),
  );
  const page = await f.stream.read(scope, cursor, principal);
  assert.deepEqual(
    page.entries.map((entry) => entry.sequence),
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
  assert.equal(new Set(page.entries.map((entry) => entry.id)).size, 40);
});

test('audit failure rolls back the privileged metadata transition', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.store.transaction(scope, async (tx) => {
      await tx.put('policy', { schema_version: 1, enabled: true });
      await appendAudit(
        {
          ...tx,
          put: async () => {
            throw new V1Error('PROVIDER_UNAVAILABLE');
          },
        },
        scope,
        event('change'),
      );
    }),
    { code: 'PROVIDER_UNAVAILABLE' },
  );
  assert.equal(await f.store.transaction(scope, (tx) => tx.get('policy')), undefined);
  assert.equal((await f.stream.read(scope, cursor, principal)).entries.length, 0);
});

test('foreign reads, oversized pages, changed bindings and tampered entries are rejected', async (t) => {
  const f = await fixture(t);
  await f.store.transaction(scope, (tx) => appendAudit(tx, scope, event('entry')));
  await assert.rejects(f.stream.read({ ...scope, tenant_id: 'other' }, cursor, principal), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(f.stream.read(scope, { ...cursor, limit: 101 }, principal), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(
    f.store.transaction(scope, (tx) =>
      appendAudit(tx, scope, { ...event('secret'), bindings: { response: 'private-token' } }),
    ),
    { code: 'INVALID_ARGUMENT' },
  );
  await f.store.transaction(scope, async (tx) => {
    const entry = await tx.get('audit-entry:1');
    await tx.put('audit-entry:1', { ...entry, event: { ...entry.event, actor_id: 'substituted' } });
  });
  await assert.rejects(f.stream.read(scope, cursor, principal), { code: 'INTEGRITY_MISMATCH' });
  await assert.rejects(
    f.store.transaction(scope, (tx) => appendAudit(tx, scope, event('later'))),
    { code: 'INTEGRITY_MISMATCH' },
  );
});

test('policy versions and authorization changes retain history and atomic audit', async (t) => {
  const f = await fixture(t);
  const configurations = new ConfigurationStore({
    store: f.store,
    authorize: f.authorize,
    validators: { policy: (input) => input, authorization: authorizationGrant },
    now: () => 100,
  });
  const request = {
    schema_version: 1,
    kind: 'policy',
    id: 'integration',
    expected_version: null,
    value: { schema_version: 1, required_checks: ['test'] },
    idempotency_key: 'initial',
    trace_id: 'trace',
  };
  const first = await configurations.update(scope, request, principal);
  assert.deepEqual(await configurations.update(scope, request, principal), first);
  const changed = await configurations.update(
    scope,
    {
      ...request,
      expected_version: 1,
      value: { schema_version: 1, required_checks: ['test', 'security'] },
      idempotency_key: 'second',
    },
    principal,
  );
  assert.equal(changed.version, 2);
  assert.deepEqual(
    await configurations.read(
      scope,
      { schema_version: 1, kind: 'policy', id: 'integration', version: 1 },
      principal,
    ),
    first,
  );
  assert.equal(
    (
      await configurations.read(
        scope,
        { schema_version: 1, kind: 'policy', id: 'integration', version: null },
        principal,
      )
    ).version,
    2,
  );
  await assert.rejects(
    configurations.update(scope, { ...request, idempotency_key: 'obsolete' }, principal),
    { code: 'CONFLICT' },
  );
  const grant = {
    schema_version: 1,
    grant_id: 'agent-grant',
    version: 1,
    tenant_id: 'tenant',
    actor_id: 'agent',
    kind: 'agent',
    permissions: [
      {
        schema_version: 1,
        system_id: 'group',
        action: 'repository.observe',
        scope: 'EXACT',
        resources: { repo_id: 'app', ref: 'refs/heads/main' },
      },
    ],
    not_before_ms: 0,
    expires_at_ms: 200,
    revoked: false,
  };
  await configurations.update(
    scope,
    {
      ...request,
      kind: 'authorization',
      id: 'agent-grant',
      value: grant,
      idempotency_key: 'agent',
    },
    principal,
  );
  await configurations.update(
    scope,
    {
      ...request,
      kind: 'authorization',
      id: 'agent-grant',
      expected_version: 1,
      value: { ...grant, version: 2, revoked: true },
      idempotency_key: 'revoke',
    },
    principal,
  );
  assert.deepEqual(
    (await f.stream.read(scope, cursor, principal)).entries.map((entry) => entry.event.action),
    ['policy.update', 'policy.update', 'authorization.update', 'authorization.update'],
  );
  f.revoke();
  await assert.rejects(
    configurations.update(scope, { ...request, idempotency_key: 'unauthorized' }, principal),
    { code: 'FORBIDDEN' },
  );
});
