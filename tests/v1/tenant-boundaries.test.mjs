import assert from 'node:assert/strict';
import test from 'node:test';
import { PromotionService } from '../../core/v1/promotion.mjs';
import { ResolutionService } from '../../core/v1/resolution.mjs';
import { EventConsumer } from '../../core/v1/consumer.mjs';
import { createEvent } from '../../core/v1/events.mjs';
import { RetainedPayloadStore } from '../../core/v1/evidence-retention.mjs';
import { ExternalCIReceiptAdapter } from '../../adapters/ci/signed-evidence.mjs';
import { DeploymentAdapter } from '../../core/v1/deployment.mjs';
import { AttestationVerifier } from '../../core/v1/attestation.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { digestBytes, objectId } from '../../core/v1/conventions.mjs';
import { releaseFixture } from './support/deployment.mjs';

test('foreign and spoofed tenant identities cannot reach privileged storage, Git, CI or deployment providers', async (t) => {
  const f = await releaseFixture();
  const digest = (domain) => digestCanonical(domain, { test: 'tenant-boundaries' });
  const id = async (kind) => objectId(kind, await digest('object-' + kind));
  const privateCalls = [];
  const privateAccess = async (name) => {
    privateCalls.push(name);
    return { private: 'must-not-leak' };
  };
  const forbidden = (name) => () => privateAccess(name);
  const store = { transaction: forbidden('coordination') };
  const authorize = (principal, resource) =>
    principal.actor_id === 'owner' &&
    principal.tenant_id === 'tenant' &&
    resource.tenant_id === 'tenant';
  const policyEvaluator = {
    required_analysis: () => ({}),
    can_resolve: () => true,
    can_promote: () => true,
  };
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'OBJECTIVE',
    resource_id: 'objective',
  };
  const decision_id = await id('decision'),
    basis_digest = await digest('decision-basis'),
    candidate_digest = await digest('object-candidate');
  const revision = {
    schema_version: 1,
    repo_id: 'app',
    commit_oid: f.revision.repositories.app,
    tree_oid: f.revision.repositories.app,
    parent_oids: [],
  };
  const promotion = new PromotionService({
    store,
    gitStore: { observe_ref: forbidden('git-read'), compare_and_swap_ref: forbidden('git-write') },
    observeSnapshot: forbidden('git-snapshot'),
    basisProvider: { current: forbidden('promotion-basis') },
    policyEvaluator,
    authorize,
  });
  const promotionRequest = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    repo_id: 'app',
    ref: 'refs/heads/main',
    decision_id,
    basis_digest,
    candidate_digest,
    expected_oid: f.revision.repositories.app,
    idempotency_key: 'promote',
  };
  const resolution = new ResolutionService({
    store,
    basisProvider: { current: forbidden('resolution-basis') },
    policyEvaluator,
    observeRef: forbidden('resolution-git'),
    payloadStore: { pin: forbidden('evidence-pin') },
    authorize,
    max_evidence: 10,
  });
  const resolutionRequest = {
    schema_version: 1,
    scope,
    decision_id,
    basis_digest,
    candidate_digest,
    canonical_ref_oids: { app: { 'refs/heads/main': f.revision.repositories.app } },
    idempotency_key: 'resolve',
    trace_id: 'trace',
  };
  const limits = { max_event_bytes: 8192, inline_payload_bytes: 1, max_claim_bytes: 8192 };
  const event = await createEvent(
    {
      schema_version: 1,
      type: 'future.observed',
      tenant_id: 'tenant',
      system_id: 'group',
      objective_id: 'objective',
      subject_id: 'app',
      subject_version: 1,
      occurred_at: '2026-10-11T00:00:00Z',
      trace_id: 'trace',
    },
    { revision },
    limits,
    { put: () => 'private-payload' },
  );
  const consumer = new EventConsumer({
    store,
    limits,
    objectStore: { get: forbidden('claim-check') },
    authorize: ({ principal, event }) => authorize(principal, event),
    handler: forbidden('event-handler'),
    executor: { idempotent: true, execute: forbidden('event-effect') },
    deadLetters: { send: forbidden('dead-letter') },
    max_attempts: 3,
  });
  const ci = new ExternalCIReceiptAdapter({
    tenant_id: 'tenant',
    system_id: 'group',
    resolveEvaluator: forbidden('ci-registry'),
    observeSnapshot: forbidden('ci-git'),
    authorize,
    retention_class: 'DECISION_RECORD',
    max_receipt_bytes: 8192,
  });
  const receipt = {
    schema_version: 1,
    issuer: 'observer',
    key_id: 'key',
    signature: btoa(String.fromCharCode(...new Uint8Array(64))).replaceAll('=', ''),
    observation: {
      schema_version: 1,
      tenant_id: 'tenant',
      system_id: 'group',
      run_id: 'run',
      type: 'test',
      payload_ref: 'private-payload',
      created_at: '2026-10-11T00:00:00Z',
      config_digest: await digest('config'),
      environment_digest: await digest('environment'),
      result: { status: 'PASSING' },
      sources: [revision],
    },
  };
  const deployment = new DeploymentAdapter({
    provider_id: 'provider',
    transport: { submit: forbidden('cd-submit'), observe: forbidden('cd-observe') },
    authorize,
    policyEvaluator,
    now: () => '2026-10-11T00:00:00Z',
  });
  const payload = new TextEncoder().encode('private-evidence'),
    payload_digest = await digestBytes('evidence-payload', payload);
  for (const principal of [
    { actor_id: 'owner', tenant_id: 'foreign' },
    { actor_id: 'foreign-owner', tenant_id: 'tenant' },
    { actor_id: 'foreign-owner', tenant_id: 'foreign', kind: 'service' },
  ]) {
    await t.test(JSON.stringify(principal), async () => {
      await assert.rejects(promotion.promote(promotionRequest, { principal }), {
        code: 'FORBIDDEN',
      });
      await assert.rejects(resolution.resolve(resolutionRequest, { principal }), {
        code: 'FORBIDDEN',
      });
      await assert.rejects(consumer.consume(event, { principal, attempt: 1 }), {
        code: 'FORBIDDEN',
      });
      await assert.rejects(ci.ingest(receipt, { principal }), { code: 'FORBIDDEN' });
      await assert.rejects(
        deployment.submit(f.revision, f.constraints, { ...f.context, principal }),
        { code: 'FORBIDDEN' },
      );
      const retained = new RetainedPayloadStore({
        tenant_id: 'tenant',
        system_id: 'group',
        principal,
        authorize,
        coordinationStore: store,
        objectStore: {
          put: forbidden('object-write'),
          get: forbidden('object-read'),
          delete: forbidden('object-delete'),
        },
        ttl_ms: {
          schema_version: 1,
          EPHEMERAL: 1,
          REBUILDABLE: 1,
          DECISION_RECORD: null,
          CANONICAL: null,
        },
        now: () => 0,
        max_payload_bytes: 8192,
      });
      await assert.rejects(
        retained.put({
          schema_version: 1,
          scope: { schema_version: 1, tenant_id: 'tenant', system_id: 'group' },
          digest: payload_digest,
          bytes: payload,
          retention_class: 'DECISION_RECORD',
          idempotency_key: 'write',
        }),
        { code: 'FORBIDDEN' },
      );
      assert.deepEqual(privateCalls, []);
    });
  }
  // Attestation identity/proof boundary is covered with real signatures by the
  // dedicated suite; this registration also requires authorization callbacks.
  assert.throws(
    () =>
      new AttestationVerifier({
        tenant_id: 'tenant',
        system_id: 'group',
        readProof: forbidden('proof'),
        resolveAttester: forbidden('attester-registry'),
        max_proof_bytes: 8192,
      }),
    { code: 'INVALID_ARGUMENT' },
  );
});
