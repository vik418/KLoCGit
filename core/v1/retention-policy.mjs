/** Explicit lifecycle settings; indexes suggest work, authoritative records decide deletion. */
import { V1Error, assertSchemaVersion, parseDigest } from './conventions.mjs';
import { copyJsonData, RETENTION_CLASSES } from './domain.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

export function retentionPeriods(input) {
  const periods = copyJsonData(input);
  assertSchemaVersion(periods);
  valid(
    Object.keys(periods).length === RETENTION_CLASSES.length + 1 &&
      RETENTION_CLASSES.every((key) => Object.hasOwn(periods, key)),
  );
  for (const retention of RETENTION_CLASSES) {
    const ttl = periods[retention];
    valid(
      (ttl === null && ['DECISION_RECORD', 'CANONICAL'].includes(retention)) ||
        (Number.isSafeInteger(ttl) && ttl >= 0),
    );
  }
  return Object.freeze(periods);
}

export function retentionConfiguration(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(
    Object.keys(value).length === 4 &&
      Number.isSafeInteger(value.sweep_interval_ms) &&
      value.sweep_interval_ms > 0 &&
      Number.isSafeInteger(value.batch_size) &&
      value.batch_size > 0,
  );
  value.ttl_ms = retentionPeriods(value.ttl_ms);
  return Object.freeze(value);
}

export class RetentionLifecycle {
  constructor({ scope, configuration, registry, payloadStore, authorize }) {
    const captured = copyJsonData(scope);
    assertSchemaVersion(captured);
    valid(
      Object.keys(captured).length === 3 &&
        typeof captured.tenant_id === 'string' &&
        captured.tenant_id.length > 0 &&
        typeof captured.system_id === 'string' &&
        captured.system_id.length > 0,
    );
    valid(
      typeof registry?.list === 'function' &&
        typeof payloadStore?.expire === 'function' &&
        typeof authorize === 'function',
    );
    Object.assign(this, {
      scope: Object.freeze(captured),
      configuration: retentionConfiguration(configuration),
      registry,
      payloadStore,
      authorize,
    });
  }

  async sweep(input, principalInput) {
    const request = copyJsonData(input),
      principal = copyJsonData(principalInput);
    assertSchemaVersion(request);
    valid(
      Object.keys(request).length === 2 &&
        (request.cursor === null ||
          (typeof request.cursor === 'string' &&
            request.cursor.length > 0 &&
            request.cursor.length <= 2048)),
    );
    const resource = { ...this.scope, action: 'retention.sweep' };
    valid(
      principal?.tenant_id === this.scope.tenant_id &&
        (await this.authorize(principal, resource)) === true,
      'FORBIDDEN',
    );
    const page = copyJsonData(
      await this.registry.list(this.scope, request.cursor, this.configuration.batch_size),
    );
    assertSchemaVersion(page);
    valid(
      Object.keys(page).length === 3 &&
        Array.isArray(page.records) &&
        page.records.length <= this.configuration.batch_size,
    );
    valid(
      page.next_cursor === null ||
        (typeof page.next_cursor === 'string' &&
          page.next_cursor.length > 0 &&
          page.next_cursor.length <= 2048),
    );
    const references = [];
    for (const item of page.records) {
      assertSchemaVersion(item);
      valid(Object.keys(item).length === 4);
      valid(
        item.tenant_id === this.scope.tenant_id && item.system_id === this.scope.system_id,
        'FORBIDDEN',
      );
      parseDigest(item.digest, 'evidence-payload');
      references.push(item.digest);
    }
    let expired = 0,
      protected_count = 0;
    for (const digest of new Set(references)) {
      valid((await this.authorize(principal, resource)) === true, 'FORBIDDEN');
      // Never delete a catalog-supplied object key. expire rereads the current
      // retention class, pins and storage generation before any effect.
      if (await this.payloadStore.expire({ schema_version: 1, scope: this.scope, digest }))
        expired++;
      else protected_count++;
    }
    return {
      schema_version: 1,
      expired,
      protected: protected_count,
      next_cursor: page.next_cursor,
    };
  }
}
