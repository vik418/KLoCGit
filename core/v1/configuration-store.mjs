/** Versioned policy and permission records, with atomic authorization audit. */
import { V1Error, assertSchemaVersion, assertIdempotencyKey, operationId } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { coordinationScope, coordinationKey } from './coordination.mjs';
import { digestCanonical } from './encoding.mjs';
import { appendAudit } from './audit.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

function resource(scope, kind, id, action) {
  return {
    schema_version: 1,
    tenant_id: scope.tenant_id,
    system_id: scope.system_id,
    action: kind + '.' + action,
    resource_id: id,
    ...(scope.kind === 'OBJECTIVE' ? { objective_id: scope.resource_id } : scope.resource_id),
  };
}

export class ConfigurationStore {
  constructor({ store, authorize, validators, now }) {
    valid(
      typeof store?.transaction === 'function' &&
        typeof authorize === 'function' &&
        typeof now === 'function',
    );
    valid(
      typeof validators?.policy === 'function' && typeof validators?.authorization === 'function',
    );
    Object.assign(this, { store, authorize, validators: { ...validators }, now });
  }

  async read(scopeInput, input, principalInput) {
    const scope = coordinationScope(scopeInput),
      request = copyJsonData(input),
      principal = copyJsonData(principalInput);
    assertSchemaVersion(request);
    valid(
      Object.keys(request).length === 4 &&
        ['policy', 'authorization'].includes(request.kind) &&
        typeof request.id === 'string' &&
        /^[A-Za-z0-9._~-]{1,128}$/.test(request.id),
    );
    valid(
      request.version === null || (Number.isSafeInteger(request.version) && request.version > 0),
    );
    valid(
      principal?.tenant_id === scope.tenant_id &&
        (await this.authorize(principal, resource(scope, request.kind, request.id, 'read'))) ===
          true,
      'FORBIDDEN',
    );
    return this.store.transaction(scope, async (tx) => {
      valid(
        (await this.authorize(principal, resource(scope, request.kind, request.id, 'read'))) ===
          true,
        'FORBIDDEN',
      );
      const key =
        'configuration:' +
        request.kind +
        ':' +
        request.id +
        (request.version === null ? '' : ':' + request.version);
      const record = await tx.get(key);
      if (!record) throw new V1Error('NOT_FOUND');
      return record;
    });
  }

  async update(scopeInput, input, principalInput) {
    const scope = coordinationScope(scopeInput),
      request = copyJsonData(input),
      principal = copyJsonData(principalInput);
    assertSchemaVersion(request);
    const fields = [
      'schema_version',
      'kind',
      'id',
      'expected_version',
      'value',
      'idempotency_key',
      'trace_id',
    ];
    valid(
      Object.keys(request).length === fields.length &&
        fields.every((key) => Object.hasOwn(request, key)),
    );
    valid(
      ['policy', 'authorization'].includes(request.kind) &&
        typeof request.id === 'string' &&
        /^[A-Za-z0-9._~-]{1,128}$/.test(request.id),
    );
    valid(
      request.expected_version === null ||
        (Number.isSafeInteger(request.expected_version) && request.expected_version > 0),
    );
    assertIdempotencyKey(request.idempotency_key);
    valid(typeof request.trace_id === 'string' && request.trace_id.length > 0);
    valid(
      principal?.tenant_id === scope.tenant_id &&
        (await this.authorize(principal, resource(scope, request.kind, request.id, 'update'))) ===
          true,
      'FORBIDDEN',
    );
    const value = copyJsonData(await this.validators[request.kind](request.value));
    assertSchemaVersion(value);
    if (request.kind === 'authorization')
      valid(
        value.tenant_id === scope.tenant_id &&
          value.grant_id === request.id &&
          value.version === (request.expected_version ?? 0) + 1,
        'FORBIDDEN',
      );
    const operation_id = await operationId({
      tenant_id: scope.tenant_id,
      resource_id: await coordinationKey(scope),
      action: request.kind + '.update',
      idempotency_key: request.idempotency_key,
    });
    const { trace_id, ...binding } = request;
    const request_digest = await digestCanonical('configuration-request', {
      ...binding,
      actor_id: principal.actor_id,
    });
    const digest = await digestCanonical('configuration-value', value);
    return this.store.transaction(scope, async (tx) => {
      valid(
        (await this.authorize(principal, resource(scope, request.kind, request.id, 'update'))) ===
          true,
        'FORBIDDEN',
      );
      const existing = await tx.get('configuration-operation:' + operation_id);
      if (existing) {
        valid(existing.request_digest === request_digest, 'IDEMPOTENCY_CONFLICT');
        return existing.record;
      }
      const key = 'configuration:' + request.kind + ':' + request.id;
      const current = await tx.get(key);
      valid((current?.version ?? null) === request.expected_version, 'CONFLICT');
      const record = {
        schema_version: 1,
        kind: request.kind,
        id: request.id,
        version: (current?.version ?? 0) + 1,
        digest,
        value,
      };
      await tx.put(key + ':' + record.version, record);
      await tx.put(key, record);
      await tx.put('configuration-operation:' + operation_id, {
        schema_version: 1,
        request_digest,
        record,
      });
      await appendAudit(
        tx,
        scope,
        {
          schema_version: 1,
          event_key: request.idempotency_key,
          actor_id: principal.actor_id,
          trace_id,
          action: request.kind + '.update',
          subject_id: request.id,
          operation_id,
          from_state: current ? 'CONFIGURED' : null,
          to_state: 'CONFIGURED',
          failure_class: null,
          bindings: {
            configuration_digest: digest,
            ...(current ? { previous_configuration_digest: current.digest } : {}),
          },
        },
        this.now,
      );
      return record;
    });
  }
}
