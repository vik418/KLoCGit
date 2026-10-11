import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttestationVerifier,
  attestationProofSigningBytes,
  buildDeploymentAttestation,
} from '../../core/v1/attestation.mjs';
import { buildDeploymentObservation } from '../../core/v1/deployment.mjs';
import { buildSystemRevision } from '../../core/v1/releases.mjs';
import { encodeCanonical } from '../../core/v1/encoding.mjs';
import { releaseFixture, deploymentAdapter } from './support/deployment.mjs';
import { SqliteCoordinationBackend } from '../../adapters/local/coordination.mjs';
import { CoordinationStore } from '../../core/v1/coordination.mjs';
import { AttestationService } from '../../core/v1/attestation-service.mjs';
import { AuditStream } from '../../core/v1/audit.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';

async function fixture() {
  const f = await releaseFixture();
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const hex = (bytes) =>
    [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const public_key = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const adapter = deploymentAdapter(
    {
      submit: () => ({ schema_version: 1, external_run_id: 'run' }),
      observe: () => ({
        schema_version: 1,
        status: 'SUCCEEDED',
        method: 'registered-deployment-observer',
        observed_repositories: f.revision.repositories,
      }),
    },
    'provider',
  );
  const handle = await adapter.submit(f.revision, f.constraints, f.context);
  const observation = (await adapter.observe(handle, f.context)).observation;
  const claim = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    provider_id: 'provider',
    producer_identity: 'observer',
    system_revision_digest: f.revision.digest,
    release_constraints_digest: f.constraints.digest,
    observation_digest: observation.digest,
    external_run_id: 'run',
    method: observation.method,
    observed_at: observation.observed_at,
    created_at: observation.observed_at,
    observed_repositories: f.revision.repositories,
  };
  const sign = async (statement) => {
    const unsigned = { schema_version: 1, key_id: 'key', statement };
    return {
      ...unsigned,
      signature: hex(
        await crypto.subtle.sign(
          'Ed25519',
          pair.privateKey,
          attestationProofSigningBytes(unsigned),
        ),
      ),
    };
  };
  let proof = await sign(claim),
    allowed = true,
    retired = false;
  const attestation = await buildDeploymentAttestation({
    schema_version: 1,
    system_revision_digest: f.revision.digest,
    observation_digest: observation.digest,
    producer_identity: 'observer',
    created_at: observation.observed_at,
    proof_ref: 'retained-proof',
  });
  const verifier = new AttestationVerifier({
    tenant_id: 'tenant',
    system_id: 'group',
    authorize: () => allowed,
    resolveAttester: () =>
      retired
        ? null
        : {
            schema_version: 1,
            producer_identity: 'observer',
            key_id: 'key',
            public_key,
            methods: [observation.method],
            providers: ['provider'],
          },
    readProof: () => new TextEncoder().encode(JSON.stringify(proof)),
    max_proof_bytes: 8192,
  });
  const options = { context: f.context, constraints: f.constraints, handle, observation };
  return {
    ...f,
    verifier,
    attestation,
    claim,
    sign,
    signBytes: async (input) => hex(await crypto.subtle.sign('Ed25519', pair.privateKey, input)),
    options,
    proof: () => proof,
    setProof: (value) => {
      proof = value;
    },
    authorize: (value) => {
      allowed = value;
    },
    retire: () => {
      retired = true;
    },
  };
}

test('registered exact-state deployment observations verify with bounded signed proof', async () => {
  const f = await fixture();
  const result = await f.verifier.verify(f.attestation, f.revision, f.options);
  assert.equal(result.verified, true);
  assert.equal(result.system_revision_digest, f.revision.digest);
  assert.equal(result.method, f.options.observation.method);
});

test('forged signatures, copied object identities and wrong signing domains are rejected', async () => {
  const f = await fixture();
  f.setProof({ ...f.proof(), signature: '0'.repeat(128) });
  await assert.rejects(f.verifier.verify(f.attestation, f.revision, f.options), {
    code: 'INTEGRITY_MISMATCH',
  });
  await assert.rejects(
    f.verifier.verify({ ...f.attestation, producer_identity: 'other' }, f.revision, f.options),
    { code: 'INTEGRITY_MISMATCH' },
  );
  const unsigned = { schema_version: 1, key_id: 'key', statement: f.claim };
  f.setProof({
    ...unsigned,
    signature: await f.signBytes(
      encodeCanonical({ domain: 'klocgit-external-ci-v1', proof: unsigned }),
    ),
  });
  await assert.rejects(f.verifier.verify(f.attestation, f.revision, f.options), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('a valid signer cannot attest another tenant, group, run, contract or observed Git state', async () => {
  const f = await fixture();
  for (const changed of [
    { tenant_id: 'other' },
    { system_id: 'other' },
    { external_run_id: 'other' },
    { release_constraints_digest: f.revision.digest },
    { observed_repositories: { app: 'b'.repeat(40) } },
    { observed_repositories: {} },
  ]) {
    f.setProof(await f.sign({ ...f.claim, ...changed }));
    await assert.rejects(f.verifier.verify(f.attestation, f.revision, f.options), {
      code: 'INTEGRITY_MISMATCH',
    });
  }
});

test('another authorized SystemRevision or incomplete observation cannot reuse an attestation', async () => {
  const f = await fixture();
  const revision = await buildSystemRevision({
    schema_version: 1,
    repositories: { app: 'b'.repeat(40) },
    configuration_digests: {},
    accepted_decisions: [],
  });
  await assert.rejects(f.verifier.verify(f.attestation, revision, f.options), {
    code: 'INTEGRITY_MISMATCH',
  });
  const observation = await buildDeploymentObservation({
    schema_version: 1,
    system_revision_digest: f.revision.digest,
    external_run_id: 'run',
    status: 'UNKNOWN',
    observed_at: f.options.observation.observed_at,
    method: f.options.observation.method,
  });
  const attestation = await buildDeploymentAttestation({
    schema_version: 1,
    system_revision_digest: f.revision.digest,
    observation_digest: observation.digest,
    producer_identity: 'observer',
    created_at: observation.observed_at,
    proof_ref: 'retained-proof',
  });
  await assert.rejects(f.verifier.verify(attestation, f.revision, { ...f.options, observation }), {
    code: 'POLICY_REJECTED',
  });
});

test('current authorization and key retirement apply to historical proofs', async () => {
  const f = await fixture();
  f.authorize(false);
  await assert.rejects(f.verifier.verify(f.attestation, f.revision, f.options), {
    code: 'FORBIDDEN',
  });
  f.authorize(true);
  f.retire();
  await assert.rejects(f.verifier.verify(f.attestation, f.revision, f.options), {
    code: 'FORBIDDEN',
  });
});

test('authoritative verification retains one audit record across retries and records forged proofs', async (t) => {
  const f = await fixture();
  const backend = new SqliteCoordinationBackend({ filename: ':memory:', busy_timeout_ms: 1000 });
  t.after(() => backend.close());
  const store = new CoordinationStore(backend);
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'OBJECTIVE',
    resource_id: 'deployment:provider',
  };
  const state = {
    schema_version: 1,
    attestation: f.attestation,
    revision: f.revision,
    ...f.options,
    verification_policy_digest: await digestCanonical('verification-policy', {
      observer: 'registered',
      version: 1,
    }),
  };
  delete state.context;
  const service = new AttestationService({
    store,
    verifier: f.verifier,
    loadAuthorized: () => state,
    authorize: () => true,
    now: () => 100,
  });
  const request = {
    schema_version: 1,
    scope,
    attestation_digest: f.attestation.digest,
    idempotency_key: 'verify',
    trace_id: 'trace',
  };
  const record = await service.verify(request, f.context.principal);
  assert.equal(record.status, 'VERIFIED');
  assert.deepEqual(await service.verify(request, f.context.principal), record);
  f.setProof({ ...f.proof(), signature: '0'.repeat(128) });
  const rejected = await service.verify(
    { ...request, idempotency_key: 'forged' },
    f.context.principal,
  );
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.failure_code, 'INTEGRITY_MISMATCH');
  assert.equal(rejected.result, null);
  const audit = await new AuditStream({ store, authorize: () => true, max_page_size: 10 }).read(
    scope,
    { schema_version: 1, after: 0, limit: 10, expected_digest: null },
    f.context.principal,
  );
  assert.deepEqual(
    audit.entries.map((entry) => entry.event.to_state),
    ['VERIFIED', 'REJECTED'],
  );
  assert.equal(audit.entries[0].event.bindings.system_revision_digest, f.revision.digest);
});

test('proof I/O releases coordination and a changed observation or observer policy cannot commit verification', async (t) => {
  const f = await fixture();
  const backend = new SqliteCoordinationBackend({ filename: ':memory:', busy_timeout_ms: 1000 });
  t.after(() => backend.close());
  const store = new CoordinationStore(backend);
  const scope = {
    schema_version: 1,
    tenant_id: 'tenant',
    system_id: 'group',
    kind: 'OBJECTIVE',
    resource_id: 'deployment:provider',
  };
  const state = {
    schema_version: 1,
    attestation: f.attestation,
    revision: f.revision,
    handle: f.options.handle,
    observation: f.options.observation,
    constraints: f.constraints,
    verification_policy_digest: await digestCanonical('verification-policy', { version: 1 }),
  };
  let canonicalRead = false;
  const service = new AttestationService({
    store,
    authorize: () => true,
    now: () => 100,
    loadAuthorized: () => state,
    verifier: {
      verify: async (...args) => {
        await store.transaction(
          { ...scope, kind: 'REF', resource_id: { repo_id: 'app', ref: 'refs/heads/main' } },
          async () => {
            canonicalRead = true;
          },
        );
        const result = await f.verifier.verify(...args);
        state.verification_policy_digest = await digestCanonical('verification-policy', {
          version: 2,
          retired: true,
        });
        return result;
      },
    },
  });
  await assert.rejects(
    service.verify(
      {
        schema_version: 1,
        scope,
        attestation_digest: f.attestation.digest,
        idempotency_key: 'verify',
        trace_id: 'trace',
      },
      f.context.principal,
    ),
    { code: 'STALE_BASIS' },
  );
  assert.equal(canonicalRead, true);
  assert.equal(
    (
      await new AuditStream({ store, authorize: () => true, max_page_size: 10 }).read(
        scope,
        { schema_version: 1, after: 0, limit: 10, expected_digest: null },
        f.context.principal,
      )
    ).entries.length,
    0,
  );
});
