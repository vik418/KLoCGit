/** Verify against authoritative deployment records and retain the verification audit. */
import {
  V1Error,
  assertSchemaVersion,
  assertIdempotencyKey,
  parseDigest,
  operationId,
} from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { coordinationScope, coordinationKey } from './coordination.mjs';
import { digestCanonical } from './encoding.mjs';
import { appendAudit } from './audit.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

export class AttestationService {
  constructor({ store, verifier, loadAuthorized, authorize, now }) {
    valid(
      typeof store?.transaction === 'function' &&
        typeof verifier?.verify === 'function' &&
        typeof loadAuthorized === 'function' &&
        typeof authorize === 'function' &&
        typeof now === 'function',
    );
    Object.assign(this, { store, verifier, loadAuthorized, authorize, now });
  }

  async load(tx, scope, attestation_digest) {
    // Include the current observer grant and verification policy in this digest
    // so key retirement during a proof read invalidates the pending result.
    const state = copyJsonData(await this.loadAuthorized(tx, { scope, attestation_digest }));
    assertSchemaVersion(state);
    parseDigest(state.verification_policy_digest);
    valid(state.attestation?.digest === attestation_digest, 'INTEGRITY_MISMATCH');
    return { state, digest: await digestCanonical('attestation-verification-basis', state) };
  }

  async verify(input, principalInput) {
    const request = copyJsonData(input),
      principal = copyJsonData(principalInput);
    assertSchemaVersion(request);
    const fields = ['schema_version', 'scope', 'attestation_digest', 'idempotency_key', 'trace_id'];
    valid(
      Object.keys(request).length === fields.length &&
        fields.every((key) => Object.hasOwn(request, key)),
    );
    const scope = coordinationScope(request.scope);
    parseDigest(request.attestation_digest, 'object-deployment-attestation');
    assertIdempotencyKey(request.idempotency_key);
    valid(typeof request.trace_id === 'string' && request.trace_id.length > 0);
    const resource = { ...scope, action: 'attestation.verify', digest: request.attestation_digest };
    valid(
      principal?.tenant_id === scope.tenant_id &&
        (await this.authorize(principal, resource)) === true,
      'FORBIDDEN',
    );
    const operation_id = await operationId({
      tenant_id: scope.tenant_id,
      resource_id: await coordinationKey(scope),
      action: 'attestation.verify',
      idempotency_key: request.idempotency_key,
    });
    const request_digest = await digestCanonical('attestation-verification-request', {
      scope,
      attestation_digest: request.attestation_digest,
      actor_id: principal.actor_id,
    });
    const prepared = await this.store.transaction(scope, async (tx) => {
      valid((await this.authorize(principal, resource)) === true, 'FORBIDDEN');
      const existing = await tx.get('attestation-verification:' + operation_id);
      if (existing) {
        valid(existing.request_digest === request_digest, 'IDEMPOTENCY_CONFLICT');
        return { existing };
      }
      // The request supplies only an identity. A self-hashed caller-supplied
      // SystemRevision is not an authorization to attest or deploy that state.
      return this.load(tx, scope, request.attestation_digest);
    });
    if (prepared.existing) return prepared.existing;
    const { state } = prepared;
    const context = {
      schema_version: 1,
      tenant_id: scope.tenant_id,
      system_id: scope.system_id,
      principal,
      idempotency_key: request.idempotency_key,
      trace_id: request.trace_id,
    };
    // Proof storage and identity-provider I/O run outside coordination locks.
    let result, failure;
    try {
      result = await this.verifier.verify(state.attestation, state.revision, {
        context,
        handle: state.handle,
        constraints: state.constraints,
        observation: state.observation,
      });
      valid(
        result?.verified === true && result.attestation_digest === request.attestation_digest,
        'INTEGRITY_MISMATCH',
      );
    } catch (error) {
      failure = error instanceof V1Error ? error.code : 'PROVIDER_UNAVAILABLE';
    }
    return this.store.transaction(scope, async (tx) => {
      valid((await this.authorize(principal, resource)) === true, 'FORBIDDEN');
      const existing = await tx.get('attestation-verification:' + operation_id);
      if (existing) {
        valid(existing.request_digest === request_digest, 'IDEMPOTENCY_CONFLICT');
        return existing;
      }
      const current = await this.load(tx, scope, request.attestation_digest);
      valid(current.digest === prepared.digest, 'STALE_BASIS');
      const record = {
        schema_version: 1,
        operation_id,
        request_digest,
        status: failure ? 'REJECTED' : 'VERIFIED',
        failure_code: failure ?? null,
        result: failure ? null : copyJsonData(result),
      };
      await tx.put('attestation-verification:' + operation_id, record);
      await appendAudit(
        tx,
        scope,
        {
          schema_version: 1,
          event_key: operation_id.split(':').at(-1),
          actor_id: principal.actor_id,
          trace_id: request.trace_id,
          action: 'attestation.verify',
          subject_id: request.attestation_digest,
          operation_id,
          from_state: null,
          to_state: record.status,
          failure_class: failure ?? null,
          bindings: {
            attestation_digest: request.attestation_digest,
            system_revision_digest: state.revision.digest,
          },
        },
        this.now,
      );
      return record;
    });
  }
}
