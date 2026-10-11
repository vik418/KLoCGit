/** A registered observer can attest exact deployed OIDs, never general correctness. */
import { V1Error, assertSchemaVersion, objectId } from './conventions.mjs';
import { copyJsonData, DeploymentAttestation, gitOid } from './domain.mjs';
import { digestCanonical, encodeCanonical } from './encoding.mjs';
import { verifySystemRevision, verifyReleaseConstraints } from './releases.mjs';
import { deploymentContext, deploymentHandle, verifyDeploymentObservation } from './deployment.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

function bytes(hex, length) {
  valid(typeof hex === 'string' && new RegExp('^[a-f0-9]{' + length * 2 + '}$').test(hex));
  return Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
}

function statement(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  const fields = [
    'schema_version',
    'tenant_id',
    'system_id',
    'provider_id',
    'producer_identity',
    'system_revision_digest',
    'release_constraints_digest',
    'observation_digest',
    'external_run_id',
    'method',
    'observed_at',
    'created_at',
    'observed_repositories',
  ];
  valid(
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
  );
  valid(
    value.observed_repositories &&
      typeof value.observed_repositories === 'object' &&
      !Array.isArray(value.observed_repositories),
  );
  for (const [repo, oid] of Object.entries(value.observed_repositories)) {
    valid(repo.length > 0);
    gitOid(oid);
  }
  return value;
}

/** Stable signing bytes are shared by external publishers and the verifier. */
export function attestationProofSigningBytes(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(
    Object.keys(value).length === 3 && typeof value.key_id === 'string' && value.key_id.length > 0,
  );
  return encodeCanonical({
    domain: 'klocgit-deployment-attestation-v1',
    proof: { ...value, statement: statement(value.statement) },
  });
}

export async function buildDeploymentAttestation(input) {
  const body = copyJsonData(input),
    digest = await digestCanonical('object-deployment-attestation', body);
  return DeploymentAttestation({ ...body, digest, id: objectId('deployment-attestation', digest) });
}

async function verifyAttestation(input) {
  const attestation = DeploymentAttestation(input);
  const { id, digest, ...body } = attestation;
  valid(
    (await digestCanonical('object-deployment-attestation', body)) === digest &&
      objectId('deployment-attestation', digest) === id,
    'INTEGRITY_MISMATCH',
  );
  return attestation;
}

export class AttestationVerifier {
  constructor({ tenant_id, system_id, authorize, resolveAttester, readProof, max_proof_bytes }) {
    valid(
      typeof tenant_id === 'string' &&
        tenant_id.length > 0 &&
        typeof system_id === 'string' &&
        system_id.length > 0,
    );
    valid(
      typeof authorize === 'function' &&
        typeof resolveAttester === 'function' &&
        typeof readProof === 'function' &&
        Number.isSafeInteger(max_proof_bytes) &&
        max_proof_bytes > 0,
    );
    Object.assign(this, {
      tenant_id,
      system_id,
      authorize,
      resolveAttester,
      readProof,
      max_proof_bytes,
    });
  }

  async verify(input, revisionInput, options) {
    const attestation = await verifyAttestation(input),
      revision = await verifySystemRevision(revisionInput);
    const context = deploymentContext(options?.context),
      handle = deploymentHandle(options?.handle);
    const constraints = await verifyReleaseConstraints(options?.constraints, revision);
    const observation = await verifyDeploymentObservation(options?.observation);
    const scope = {
      schema_version: 1,
      tenant_id: this.tenant_id,
      system_id: this.system_id,
      action: 'attestation.verify',
      producer_identity: attestation.producer_identity,
    };
    valid(
      context.tenant_id === this.tenant_id &&
        context.system_id === this.system_id &&
        context.principal.tenant_id === this.tenant_id &&
        handle.tenant_id === this.tenant_id &&
        handle.system_id === this.system_id,
      'FORBIDDEN',
    );
    valid((await this.authorize(context.principal, scope)) === true, 'FORBIDDEN');
    valid(
      attestation.system_revision_digest === revision.digest &&
        observation.system_revision_digest === revision.digest &&
        attestation.observation_digest === observation.digest &&
        handle.system_revision_digest === revision.digest &&
        handle.release_constraints_digest === constraints.digest &&
        handle.external_run_id === observation.external_run_id,
      'INTEGRITY_MISMATCH',
    );
    valid(observation.status === 'SUCCEEDED', 'POLICY_REJECTED');
    const proofBytes = await this.readProof(attestation.proof_ref, scope, this.max_proof_bytes);
    valid(proofBytes instanceof Uint8Array && proofBytes.length <= this.max_proof_bytes);
    let proof;
    try {
      proof = copyJsonData(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proofBytes)),
      );
    } catch {
      throw new V1Error('INTEGRITY_MISMATCH');
    }
    assertSchemaVersion(proof);
    valid(Object.keys(proof).length === 4);
    const claim = statement(proof.statement);
    const unsigned = { schema_version: 1, key_id: proof.key_id, statement: claim };
    const signingBytes = attestationProofSigningBytes(unsigned);
    valid(signingBytes.length <= this.max_proof_bytes);
    const grant = copyJsonData(await this.resolveAttester({ ...scope, key_id: proof.key_id }));
    valid(grant, 'FORBIDDEN');
    assertSchemaVersion(grant);
    valid(
      grant.producer_identity === attestation.producer_identity &&
        grant.key_id === proof.key_id &&
        Array.isArray(grant.providers) &&
        grant.providers.includes(handle.provider_id) &&
        Array.isArray(grant.methods) &&
        grant.methods.includes(observation.method),
      'FORBIDDEN',
    );
    let verified;
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        bytes(grant.public_key, 32),
        'Ed25519',
        false,
        ['verify'],
      );
      verified = await crypto.subtle.verify(
        'Ed25519',
        key,
        bytes(proof.signature, 64),
        signingBytes,
      );
    } catch {
      throw new V1Error('INTEGRITY_MISMATCH');
    }
    valid(verified, 'INTEGRITY_MISMATCH');
    valid(
      claim.tenant_id === this.tenant_id &&
        claim.system_id === this.system_id &&
        claim.provider_id === handle.provider_id &&
        claim.producer_identity === attestation.producer_identity &&
        claim.system_revision_digest === revision.digest &&
        claim.release_constraints_digest === constraints.digest &&
        claim.observation_digest === observation.digest &&
        claim.external_run_id === observation.external_run_id &&
        claim.method === observation.method &&
        claim.observed_at === observation.observed_at &&
        claim.created_at === attestation.created_at,
      'INTEGRITY_MISMATCH',
    );
    valid(
      (await digestCanonical('deployment-observed-repositories', claim.observed_repositories)) ===
        (await digestCanonical('deployment-observed-repositories', revision.repositories)),
      'INTEGRITY_MISMATCH',
    );
    return Object.freeze({
      schema_version: 1,
      verified: true,
      attestation_digest: attestation.digest,
      system_revision_digest: revision.digest,
      observation_digest: observation.digest,
      method: observation.method,
    });
  }
}
