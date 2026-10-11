/** Read-only operational projection. Incidents never authorize state changes. */
import { V1Error, ERROR_TAXONOMY, assertSchemaVersion, objectId } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical, encodeCanonical } from './encoding.mjs';

const states = {
  PROVIDER: ['AVAILABLE', 'UNAVAILABLE', 'RATE_LIMITED'],
  QUEUE: ['HEALTHY', 'BACKLOG', 'DEADLETTERED'],
  EXTRACTOR: ['COMPLETE', 'PARTIAL', 'UNSUPPORTED', 'FAILED'],
  SANDBOX: ['AVAILABLE', 'AT_CAPACITY', 'FAILED'],
  GIT_STORE: ['AVAILABLE', 'UNAVAILABLE', 'RATE_LIMITED', 'UNSUPPORTED'],
  DEPLOYMENT: ['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'],
  ATTESTATION: ['VERIFIED', 'REJECTED'],
};
const healthy = new Set([
  'AVAILABLE',
  'HEALTHY',
  'COMPLETE',
  'SUBMITTED',
  'RUNNING',
  'SUCCEEDED',
  'CANCELLED',
  'VERIFIED',
]);
const runbooks = {
  PROVIDER: 'provider-outage',
  QUEUE: 'queue-backlog',
  EXTRACTOR: 'extractor-failure',
  SANDBOX: 'sandbox-capacity',
  GIT_STORE: 'git-store-error',
  DEPLOYMENT: 'deployment-unknown',
  ATTESTATION: 'attestation-mismatch',
};

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

function observation(input, scope) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  const fields = [
    'schema_version',
    'tenant_id',
    'system_id',
    'kind',
    'subject_id',
    'subject_version',
    'trace_id',
    'state',
    'count',
    'occurred_at_ms',
    'failure_class',
  ];
  valid(
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
  );
  valid(value.tenant_id === scope.tenant_id && value.system_id === scope.system_id, 'FORBIDDEN');
  valid(Object.hasOwn(states, value.kind) && states[value.kind].includes(value.state));
  for (const key of ['subject_id', 'trace_id'])
    valid(
      typeof value[key] === 'string' &&
        value[key].length > 0 &&
        value[key].length <= 1024 &&
        !/[\u0000-\u001f\u007f]/.test(value[key]),
    );
  valid(
    Number.isSafeInteger(value.subject_version) &&
      value.subject_version > 0 &&
      Number.isSafeInteger(value.count) &&
      value.count >= 0 &&
      Number.isSafeInteger(value.occurred_at_ms) &&
      value.occurred_at_ms >= 0,
  );
  valid(
    value.failure_class === null ||
      Object.hasOwn(ERROR_TAXONOMY, value.failure_class) ||
      Object.values(ERROR_TAXONOMY).some((entry) => entry.failure_class === value.failure_class),
  );
  return value;
}

export class OperationsService {
  constructor({ scope, registry, authorize, max_records }) {
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
      typeof registry?.read === 'function' &&
        typeof authorize === 'function' &&
        Number.isSafeInteger(max_records) &&
        max_records > 0,
    );
    Object.assign(this, { scope: Object.freeze(captured), registry, authorize, max_records });
  }

  async read(principalInput) {
    const principal = copyJsonData(principalInput);
    valid(
      principal?.tenant_id === this.scope.tenant_id &&
        (await this.authorize(principal, { ...this.scope, action: 'operations.read' })) === true,
      'FORBIDDEN',
    );
    const input = copyJsonData(await this.registry.read(this.scope, this.max_records));
    valid(Array.isArray(input));
    if (input.length > this.max_records) throw new V1Error('INCOMPLETE_ANALYSIS');
    const current = new Map();
    for (const row of input) {
      const item = observation(row, this.scope),
        key = JSON.stringify([item.kind, item.subject_id]);
      const digest = await digestCanonical('operational-observation', item),
        previous = current.get(key);
      if (previous?.item.subject_version === item.subject_version)
        valid(previous.digest === digest, 'INTEGRITY_MISMATCH');
      if (!previous || previous.item.subject_version < item.subject_version)
        current.set(key, { item, digest });
    }
    valid(
      (await this.authorize(principal, { ...this.scope, action: 'operations.read' })) === true,
      'FORBIDDEN',
    );
    // Sort encoded identity tuples, independent of the runtime's locale/ICU.
    const observations = [...current.values()]
      .map(({ item }) => ({ item, key: encodeCanonical([item.kind, item.subject_id]) }))
      .sort((a, b) => {
        for (let i = 0; i < Math.min(a.key.length, b.key.length); i++)
          if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        return a.key.length - b.key.length;
      })
      .map(({ item }) => item);
    const incidents = [];
    for (const item of observations) {
      if (healthy.has(item.state)) continue;
      const digest = await digestCanonical('object-operational-incident', {
        kind: item.kind,
        subject_id: item.subject_id,
        state: item.state,
        subject_version: item.subject_version,
        tenant_id: item.tenant_id,
        system_id: item.system_id,
      });
      incidents.push({
        schema_version: 1,
        id: objectId('operational-incident', digest),
        kind: item.kind,
        subject_id: item.subject_id,
        state: item.state,
        count: item.count,
        trace_id: item.trace_id,
        runbook_id: runbooks[item.kind],
        failure_class: item.failure_class,
      });
    }
    return {
      schema_version: 1,
      scope: this.scope,
      derived: true,
      retention_class: 'REBUILDABLE',
      snapshot_digest: await digestCanonical('operational-snapshot', observations),
      status: observations.length
        ? incidents.length
          ? 'ATTENTION_REQUIRED'
          : 'NO_REPORTED_INCIDENTS'
        : 'NO_OBSERVATIONS',
      observations,
      incidents,
    };
  }
}
