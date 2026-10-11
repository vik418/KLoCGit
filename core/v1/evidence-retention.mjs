/** Authoritative payload retention. Cleanup cannot remove decision-pinned data. */
import {
  V1Error,
  assertSchemaVersion,
  assertIdempotencyKey,
  digestBytes,
  parseDigest,
  parseObjectId,
  operationId,
} from './conventions.mjs';
import { copyJsonData, RETENTION_CLASSES } from './domain.mjs';
import { coordinationKey } from './coordination.mjs';
import { retentionPeriods } from './retention-policy.mjs';
import { appendAudit } from './audit.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

async function trustedCall(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('PROVIDER_UNAVAILABLE');
  }
}

export class RetainedPayloadStore {
  constructor({
    tenant_id,
    system_id,
    principal,
    authorize,
    coordinationStore,
    objectStore,
    ttl_ms,
    now,
    max_payload_bytes,
  }) {
    valid([tenant_id, system_id].every((value) => typeof value === 'string' && value.trim()));
    valid(typeof authorize === 'function' && typeof coordinationStore?.transaction === 'function');
    valid(['put', 'get', 'delete'].every((method) => typeof objectStore?.[method] === 'function'));
    valid(
      typeof now === 'function' && Number.isSafeInteger(max_payload_bytes) && max_payload_bytes > 0,
    );
    const policy = retentionPeriods(ttl_ms);
    Object.assign(this, {
      tenant_id,
      system_id,
      principal: freeze(copyJsonData(principal)),
      authorize,
      coordinationStore,
      objectStore,
      policy: freeze(policy),
      now,
      max_payload_bytes,
    });
  }

  #time() {
    const now = this.now();
    valid(Number.isSafeInteger(now) && now >= 0);
    return now;
  }

  async #scope(input, action) {
    const scope = freeze(copyJsonData(input.scope));
    assertSchemaVersion(input);
    assertSchemaVersion(scope);
    const identity = parseDigest(input.digest, 'evidence-payload');
    if (scope.tenant_id !== this.tenant_id || scope.system_id !== this.system_id)
      throw new V1Error('FORBIDDEN');
    if (!this.principal?.actor_id) throw new V1Error('UNAUTHENTICATED');
    if (
      (await trustedCall(() =>
        this.authorize(this.principal, freeze({ ...scope, action, digest: input.digest })),
      )) !== true
    )
      throw new V1Error('FORBIDDEN');
    const coordination = freeze({
      schema_version: 1,
      tenant_id: this.tenant_id,
      system_id: this.system_id,
      kind: 'OBJECTIVE',
      resource_id: 'payload:' + input.digest,
    });
    const key =
      parseDigest(await coordinationKey(coordination)).hex +
      '/' +
      identity.domain +
      '-' +
      identity.hex;
    return { coordination, key };
  }

  async put(input) {
    valid(input?.bytes instanceof Uint8Array && RETENTION_CLASSES.includes(input.retention_class));
    assertIdempotencyKey(input.idempotency_key);
    const request = { ...copyJsonData({ ...input, bytes: null }), bytes: input.bytes.slice() };
    if (request.bytes.length > this.max_payload_bytes) throw new V1Error('INCOMPLETE_ANALYSIS');
    const { coordination, key } = await this.#scope(request, 'evidence.payload.write');
    if ((await digestBytes('evidence-payload', request.bytes)) !== request.digest)
      throw new V1Error('INTEGRITY_MISMATCH');
    const created = this.#time();
    const prepared = await this.coordinationStore.transaction(coordination, async (tx) => {
      const previous = await tx.get('retention');
      if (previous?.state === 'DELETING') throw new V1Error('OUTCOME_UNKNOWN');
      const retained = previous?.state !== 'DELETED' ? previous : null;
      const generation = retained?.generation ?? (previous?.generation ?? 0) + 1;
      valid(Number.isSafeInteger(generation) && generation > 0);
      const retention_class =
        retained &&
        RETENTION_CLASSES.indexOf(retained.retention_class) >
          RETENTION_CLASSES.indexOf(request.retention_class)
          ? retained.retention_class
          : request.retention_class;
      const created_ms = retained?.created_ms ?? created;
      const ttl = this.policy[retention_class];
      valid(ttl === null || Number.isSafeInteger(created_ms + ttl));
      // Concurrent writers using older settings cannot shorten an existing
      // retention commitment. New payloads use the configured period.
      const expires_ms =
        ttl === null || retained?.expires_ms === null
          ? null
          : Math.max(retained?.expires_ms ?? 0, created_ms + ttl);
      const record = {
        schema_version: 1,
        digest: request.digest,
        key: key + '-g' + generation,
        generation,
        state: 'WRITING',
        retention_class,
        created_ms,
        expires_ms,
        pins: retained?.pins ?? [],
      };
      await tx.put('retention', record);
      return record;
    });
    // Identical retries write the same bytes. A prepared write cannot be expired.
    await trustedCall(() =>
      this.objectStore.put({
        schema_version: 1,
        key: prepared.key,
        bytes: request.bytes,
        idempotency_key: request.idempotency_key,
      }),
    );
    await this.coordinationStore.transaction(coordination, async (tx) => {
      const current = await tx.get('retention');
      if (
        !current ||
        current.generation !== prepared.generation ||
        !['WRITING', 'READY'].includes(current.state)
      )
        throw new V1Error('OUTCOME_UNKNOWN');
      await tx.put('retention', { ...current, state: 'READY' });
    });
    return freeze({ schema_version: 1, digest: request.digest, ref: 'payload:' + prepared.key });
  }

  async #read(context, digest, ref) {
    const record = await this.coordinationStore.transaction(context.coordination, (tx) =>
      tx.get('retention'),
    );
    if (!record || record.state === 'DELETED') throw new V1Error('NOT_FOUND');
    if (record.state !== 'READY') throw new V1Error('OUTCOME_UNKNOWN');
    if (ref !== undefined && ref !== 'payload:' + record.key) throw new V1Error('NOT_FOUND');
    const bytes = await trustedCall(() => this.objectStore.get(record.key));
    if (bytes === null) throw new V1Error('NOT_FOUND');
    valid(bytes instanceof Uint8Array);
    if (bytes.length > this.max_payload_bytes) throw new V1Error('INCOMPLETE_ANALYSIS');
    if ((await digestBytes('evidence-payload', bytes)) !== digest)
      throw new V1Error('INTEGRITY_MISMATCH');
    return bytes.slice();
  }

  async read(input) {
    const request = copyJsonData({
      schema_version: input.schema_version,
      scope: input.scope,
      digest: input.digest,
      ...(input.payload_ref === undefined ? {} : { payload_ref: input.payload_ref }),
    });
    return this.#read(
      await this.#scope(request, 'evidence.payload.read'),
      request.digest,
      request.payload_ref,
    );
  }

  async pin(input) {
    const request = freeze(copyJsonData(input));
    const reference = parseObjectId(request.reference_id);
    valid(typeof request.payload_ref === 'string' && request.payload_ref.length > 0);
    valid(['decision', 'system-revision', 'deployment-attestation'].includes(reference.kind));
    const context = await this.#scope(request, 'evidence.payload.pin');
    // Verify payload availability before an accepted record can reference it.
    await this.#read(context, request.digest, request.payload_ref);
    await this.coordinationStore.transaction(context.coordination, async (tx) => {
      const current = await tx.get('retention');
      if (!current || current.state === 'DELETED') throw new V1Error('NOT_FOUND');
      if (current.state !== 'READY') throw new V1Error('OUTCOME_UNKNOWN');
      if (request.payload_ref !== 'payload:' + current.key) throw new V1Error('NOT_FOUND');
      await tx.put('retention', {
        ...current,
        pins: [...new Set([...current.pins, request.reference_id])].sort(),
      });
    });
  }

  async expire(input) {
    const request = freeze(
      copyJsonData({
        schema_version: input.schema_version,
        scope: input.scope,
        digest: input.digest,
      }),
    );
    const context = await this.#scope(request, 'evidence.payload.expire');
    const prepared = await this.coordinationStore.transaction(context.coordination, async (tx) => {
      const current = await tx.get('retention');
      if (!current || current.state === 'DELETED') return { schema_version: 1, state: 'DELETED' };
      if (current.state === 'WRITING') throw new V1Error('OUTCOME_UNKNOWN');
      if (current.state === 'DELETING') return current;
      if (current.pins.length || current.expires_ms === null || this.#time() < current.expires_ms)
        return { schema_version: 1, state: 'PROTECTED' };
      const deleting = { ...current, state: 'DELETING' };
      await tx.put('retention', deleting);
      await this.#auditDeletion(tx, context, deleting, 'READY', 'DELETING');
      return deleting;
    });
    if (prepared.state === 'PROTECTED') return false;
    if (prepared.state === 'DELETED') return true;
    try {
      await this.objectStore.delete({
        schema_version: 1,
        key: prepared.key,
        idempotency_key: parseDigest(request.digest).hex + '.' + prepared.generation,
      });
    } catch {
      // A lost response might follow a successful deletion. Pins/writes remain
      // blocked until retry reconciles the prepared, idempotent delete.
      throw new V1Error('OUTCOME_UNKNOWN');
    }
    await this.coordinationStore.transaction(context.coordination, async (tx) => {
      const current = await tx.get('retention');
      if (current && current.generation !== prepared.generation) return;
      if (current?.state === 'DELETED') return;
      if (current?.state !== 'DELETING') throw new V1Error('OUTCOME_UNKNOWN');
      await tx.put('retention', { ...current, state: 'DELETED' });
      await this.#auditDeletion(tx, context, current, 'DELETING', 'DELETED');
    });
    return true;
  }

  async #auditDeletion(tx, context, record, from_state, to_state) {
    const key = parseDigest(record.digest).hex + '.' + record.generation;
    const operation_id = await operationId({
      tenant_id: this.tenant_id,
      resource_id: await coordinationKey(context.coordination),
      action: 'evidence.payload.expire',
      idempotency_key: key,
    });
    return appendAudit(
      tx,
      context.coordination,
      {
        schema_version: 1,
        event_key: key + '.' + to_state,
        actor_id: this.principal.actor_id,
        trace_id: operation_id,
        action: 'evidence.payload.expire',
        subject_id: record.digest,
        operation_id,
        from_state,
        to_state,
        failure_class: null,
        bindings: { payload_digest: record.digest },
      },
      this.now,
    );
  }
}
