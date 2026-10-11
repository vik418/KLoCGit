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
