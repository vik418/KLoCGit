import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../server/git.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { FileObjectStore } from '../../adapters/local/object-store.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { RetainedPayloadStore } from '../../core/v1/evidence-retention.mjs';
import { ResolutionService } from '../../core/v1/resolution.mjs';
import { createResolveHandler } from '../../api/resolve.mjs';
import { buildDecisionBasis } from '../../core/v1/decisions.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';
import {
  buildEvidence,
  verifyEvidence,
  candidateEvidenceSubject,
} from '../../core/v1/evidence.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { digestBytes, objectId } from '../../core/v1/conventions.mjs';
import { AuditStream } from '../../core/v1/audit.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-resolution-'));
  const repository = join(directory, 'repository');
  await mkdir(repository);
  await git(repository, ['init', '--bare', '--quiet']);
  const tree = await git(repository, ['mktree'], '');
  const head = await git(repository, ['commit-tree', tree, '-m', 'base']);
  const moved = await git(repository, ['commit-tree', tree, '-p', head, '-m', 'external']);
  const ref = 'refs/heads/main';
  await git(repository, ['update-ref', ref, head]);
  const backends = [];
  t.after(async () => {
    backends.forEach((backend) => backend.close());
    await rm(directory, { recursive: true, force: true });
  });
  const connect = () => {
    const backend = new SqliteCoordinationBackend({
      filename: join(directory, 'state.sqlite'),
      busy_timeout_ms: 1000,
    });
    backends.push(backend);
    return new CoordinationStore(backend);
  };
  const store = connect();
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'OBJECTIVE',
    resource_id: 'objective',
  };
  const principal = { actor_id: 'owner', tenant_id: scope.tenant_id };
  let allowed = true,
    policyAllows = true;
  const authorize = (actor, resource) =>
    allowed && actor.actor_id === principal.actor_id && actor.tenant_id === resource.tenant_id;
  let now = 0,
    pinHook;
  const payloads = new RetainedPayloadStore({
    tenant_id: scope.tenant_id,
    system_id: scope.system_id,
    principal,
    authorize,
    coordinationStore: store,
    objectStore: new FileObjectStore({
      root: join(directory, 'payloads'),
      max_bytes: 4096,
    }),
    ttl_ms: {
      schema_version: 1,
      EPHEMERAL: 10,
      REBUILDABLE: 10,
      DECISION_RECORD: null,
      CANONICAL: null,
    },
    now: () => now,
    max_payload_bytes: 4096,
  });
  const payloadScope = {
    schema_version: 1,
    tenant_id: scope.tenant_id,
    system_id: scope.system_id,
  };
  const bytes = new TextEncoder().encode('trusted check observed passing');
  const payload_digest = await digestBytes('evidence-payload', bytes);
  const saved = await payloads.put({
    schema_version: 1,
    scope: payloadScope,
    digest: payload_digest,
    bytes,
    retention_class: 'REBUILDABLE',
    idempotency_key: 'payload',
  });
  const candidate = await materializedCandidate(
    objectId(
      'candidate-spec',
      await digestCanonical('object-candidate-spec', { work: 'isolated' }),
    ),
    { repo: tree },
    { schema_version: 1, repo_commit_oids: { repo: head } },
  );
  const subject = await candidateEvidenceSubject(candidate);
  const evidence = await buildEvidence({
    schema_version: 1,
    subject_digest: subject.digest,
    type: 'test',
    producer_identity: 'trusted',
    producer_version: '1',
    config_digest: await digestCanonical('evaluation-config', { command: 'registered' }),
    environment_digest: await digestCanonical('evaluation-environment', { runtime: 'pinned' }),
    result: { status: 'PASSING', basis: 'OBSERVED' },
    payload_ref: saved.ref,
    created_at: '2026-10-11T00:00:00Z',
    retention_class: 'REBUILDABLE',
  });
  const basis = await buildDecisionBasis({
    schema_version: 1,
    candidate_digests: [candidate.digest],
    evidence_digests: [(await verifyEvidence(evidence)).digest],
    material_effect_digest: await digestCanonical('material-effect', { changes: [] }),
    policy_digest: await digestCanonical('policy', { required: ['semantic'] }),
    canonical_ref_oids: { repo: { [ref]: head } },
    required_analysis_status: { semantic: 'COMPLETE' },
  });
  const decision_id = objectId(
    'decision',
    await digestCanonical('object-decision', { objective: scope.resource_id }),
  );
  await store.createDecision(scope, {
    schema_version: 1,
    id: decision_id,
    state: 'DISCOVERED',
    basis: null,
    resolution: null,
  });
  await store.transitionDecision(scope, decision_id, 'REVIEWABLE', basis);
  const state = {
    schema_version: 1,
    basis,
    candidate,
    subject,
    effects: [],
    evidence_payloads: [{ schema_version: 1, evidence, payload_digest }],
  };
  await store.transaction(scope, (tx) => tx.put('inputs:' + decision_id, state));
  const options = {
    basisProvider: { current: (tx, context) => tx.get('inputs:' + context.request.decision_id) },
    policyEvaluator: { required_analysis: () => ['semantic'], can_resolve: () => policyAllows },
    observeRef: (repo, fullRef) => {
      assert.equal(repo, 'repo');
      return git(repository, ['rev-parse', '--verify', fullRef]);
    },
    payloadStore: {
      pin: async (input) => {
        await payloads.pin(input);
        if (pinHook) await pinHook();
      },
    },
    authorize,
    max_evidence: 10,
  };
  const service = new ResolutionService({ ...options, store });
  const request = {
    schema_version: 1,
    scope,
    decision_id,
    basis_digest: basis.digest,
    candidate_digest: candidate.digest,
    canonical_ref_oids: basis.canonical_ref_oids,
    idempotency_key: 'resolve',
    trace_id: 'trace-first',
  };
  const fetch = createResolveHandler({
    scope,
    service,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer test-owner' ? principal : null,
    max_request_bytes: 4096,
  });
  const http = (changes = {}, headers = {}) => {
    const { scope: ignored, ...body } = request;
    assert.ok(ignored);
    return fetch(
      new Request('https://klocgit.test/resolve', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-owner',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ ...body, ...changes }),
      }),
    );
  };
  return {
    store,
    service,
    scope,
    principal,
    basis,
    candidate,
    request,
    payloads,
    payloadScope,
    payload_digest,
    evidence,
    connect,
    options,
    http,
    fetch,
    decision: () => store.transaction(scope, (tx) => tx.get('decision:' + decision_id)),
    update: (changes) =>
      store.transaction(scope, (tx) => tx.put('inputs:' + decision_id, { ...state, ...changes })),
    pinHook: (hook) => {
      pinHook = hook;
    },
    revoke: () => {
      allowed = false;
    },
    rejectPolicy: () => {
      policyAllows = false;
    },
    time: (value) => {
      now = value;
    },
    move: () => git(repository, ['update-ref', ref, moved]),
    head: () => git(repository, ['rev-parse', ref]),
    original: head,
  };
}

test('HTTP resolution persists the exact choice, pins evidence and survives restart without changing Git', async (t) => {
  const f = await fixture(t);
  const response = await f.http();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { decision } = await response.json();
  assert.equal(decision.state, 'RESOLVED');
  assert.equal(decision.resolution.actor_id, f.principal.actor_id);
  assert.equal(await f.head(), f.original);
  f.time(100);
  const expired = await f.payloads.expire({
    schema_version: 1,
    scope: f.payloadScope,
    digest: f.payload_digest,
  });
  assert.equal(expired, false);
  const retried = await new ResolutionService({ ...f.options, store: f.connect() }).resolve(
    { ...f.request, trace_id: 'trace-retry' },
    { principal: f.principal },
  );
  assert.deepEqual(retried, decision);
  const audit = await new AuditStream({
    store: f.store,
    authorize: f.options.authorize,
    max_page_size: 10,
  }).read(f.scope, { schema_version: 1, after: 0, limit: 10, expected_digest: null }, f.principal);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].event.action, 'decision.resolve');
  assert.equal(audit.entries[0].event.bindings.candidate_digest, f.candidate.digest);
});

test('obsolete reviewed basis and moved canonical Git heads return 409', async (t) => {
  const f = await fixture(t);
  const changed = await buildDecisionBasis({
    ...Object.fromEntries(Object.entries(f.basis).filter(([key]) => key !== 'digest')),
    policy_digest: await digestCanonical('policy', { updated: true }),
  });
  await f.update({ basis: changed });
  let response = await f.http();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_BASIS');
  await f.update({ basis: f.basis });
  await f.move();
  response = await f.http();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_BASIS');
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('required PARTIAL analysis remains reviewable and cannot resolve', async (t) => {
  const f = await fixture(t);
  const { digest, ...body } = f.basis;
  assert.ok(digest);
  const basis = await buildDecisionBasis({
    ...body,
    required_analysis_status: { semantic: 'PARTIAL' },
  });
  await f.update({ basis });
  await f.store.transaction(f.scope, async (tx) => {
    const decision = await tx.get('decision:' + f.request.decision_id);
    await tx.put('decision:' + decision.id, { ...decision, basis });
  });
  const response = await f.http({ basis_digest: basis.digest });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'INCOMPLETE_ANALYSIS');
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('policy, authentication, tenant and request-body identities cannot be supplied by callers', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.http({}, { authorization: 'none' })).status, 401);
  assert.equal((await f.http({ actor_id: 'someone' })).status, 400);
  assert.equal((await f.http({ scope: { ...f.scope, tenant_id: 'other' } })).status, 400);
  await assert.rejects(
    f.service.resolve(
      { ...f.request, scope: { ...f.scope, tenant_id: 'other' } },
      { principal: f.principal },
    ),
    { code: 'FORBIDDEN' },
  );
  f.rejectPolicy();
  assert.equal((await f.http()).status, 409);
  f.revoke();
  assert.equal((await f.http()).status, 403);
});

test('pinning releases the coordination transaction and a racing external push invalidates the choice', async (t) => {
  const f = await fixture(t);
  f.pinHook(async () => {
    assert.equal((await f.decision()).state, 'REVIEWABLE');
    await f.move();
  });
  const response = await f.http();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'STALE_BASIS');
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('policy is rechecked after payload retention', async (t) => {
  const f = await fixture(t);
  f.pinHook(() => f.rejectPolicy());
  const response = await f.http();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'POLICY_REJECTED');
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('revoked authority cannot finish a prepared resolution', async (t) => {
  const f = await fixture(t);
  f.pinHook(() => f.revoke());
  const response = await f.http();
  assert.equal(response.status, 403);
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('all reviewed evidence requires an exact retained payload binding', async (t) => {
  const f = await fixture(t);
  await f.update({ evidence_payloads: [] });
  const response = await f.http();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'INCOMPLETE_ANALYSIS');
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('concurrent identical resolutions share one durable receipt and reused keys bind exact input', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.http(), f.http()]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  assert.deepEqual(await results[0].json(), await results[1].json());
  const response = await f.http({
    candidate_digest: await digestCanonical('object-candidate', { substituted: true }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('expired or substituted evidence payloads cannot create accepted decision history', async (t) => {
  const f = await fixture(t);
  f.time(100);
  await f.payloads.expire({ schema_version: 1, scope: f.payloadScope, digest: f.payload_digest });
  const response = await f.http();
  assert.equal(response.status, 404);
  assert.equal((await f.decision()).state, 'REVIEWABLE');
});

test('bounded requests reject malformed and oversized input without leaking errors', async (t) => {
  const f = await fixture(t);
  const response = await f.http({ trace_id: 'x'.repeat(5000) });
  assert.equal(response.status, 400);
  const malformed = await f.fetch(
    new Request('https://klocgit.test/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer test-owner', 'content-type': 'application/json' },
      body: '{',
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal((await f.fetch(new Request('https://klocgit.test/resolve'))).status, 405);
});
