/** Provider-neutral authoritative transactions, scoped to objectives or refs. */
import { V1Error, assertSchemaVersion, parseObjectId } from './conventions.mjs';
import { copyJsonData, Decision } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { makeReviewable, makeResolvable, markStale, resolveDecision } from './decisions.mjs';

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

function text(value) {
  valid(typeof value === 'string' && value.trim().length > 0);
}

export function coordinationScope(input) {
  const scope = copyJsonData(input);
  valid(scope && typeof scope === 'object' && !Array.isArray(scope));
  assertSchemaVersion(scope);
  const fields = ['schema_version', 'tenant_id', 'system_id', 'kind', 'resource_id'];
  valid(
    Object.keys(scope).length === fields.length &&
      fields.every((field) => Object.hasOwn(scope, field)),
  );
  text(scope.tenant_id);
  text(scope.system_id);
  valid(['OBJECTIVE', 'REF'].includes(scope.kind));
  if (scope.kind === 'OBJECTIVE') text(scope.resource_id);
  else {
    const resource = scope.resource_id;
    valid(resource && typeof resource === 'object' && !Array.isArray(resource));
    valid(
      Object.keys(resource).length === 2 &&
        Object.hasOwn(resource, 'repo_id') &&
        Object.hasOwn(resource, 'ref'),
    );
    text(resource.repo_id);
    text(resource.ref);
    valid(
      resource.ref.startsWith('refs/') &&
        !resource.ref.endsWith('/') &&
        !resource.ref.endsWith('.'),
    );
    valid(!/[\u0000-\u0020\u007f~^:?*\[\\]/.test(resource.ref));
    valid(
      !resource.ref.includes('..') && !resource.ref.includes('@{') && !resource.ref.includes('//'),
    );
    valid(
      resource.ref
        .split('/')
        .every((part) => part.length && !part.startsWith('.') && !part.endsWith('.lock')),
    );
  }
  return freeze(scope);
}

export async function coordinationKey(input) {
  return digestCanonical('coordination-scope', coordinationScope(input));
}

function persisted(input) {
  const value = copyJsonData(input);
  valid(value && typeof value === 'object' && !Array.isArray(value));
  assertSchemaVersion(value);
  return freeze(value);
}

function transitionOptions(transition, input) {
  if (!['RESOLVABLE', 'RESOLVED'].includes(transition)) return undefined;
  valid(input && typeof input === 'object' && !Array.isArray(input));
  const prototype = Object.getPrototypeOf(input);
  valid(prototype === Object.prototype || prototype === null);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const fields = [
    'policyEvaluator',
    'subject',
    'effects',
    ...(transition === 'RESOLVED' ? ['expectedBasisDigest', 'resolution'] : []),
  ];
  const keys = Reflect.ownKeys(descriptors);
  valid(keys.length === fields.length && fields.every((field) => keys.includes(field)));
  valid(
    keys.every(
      (field) => Object.hasOwn(descriptors[field], 'value') && descriptors[field].enumerable,
    ),
  );
  const provider = descriptors.policyEvaluator.value;
  valid(
    provider &&
      typeof provider.required_analysis === 'function' &&
      typeof provider.can_resolve === 'function',
  );
  // Only trusted service callbacks remain references. Request data is captured
  // before hashing or waiting for another transaction to release the scope.
  const data = {};
  for (const field of fields) {
    if (field !== 'policyEvaluator') data[field] = copyJsonData(descriptors[field].value);
  }
  return Object.freeze({
    ...freeze(data),
    policyEvaluator: Object.freeze({
      required_analysis: provider.required_analysis.bind(provider),
      can_resolve: provider.can_resolve.bind(provider),
    }),
  });
}

export class CoordinationStore {
  constructor(backend) {
    valid(typeof backend?.transaction === 'function');
    this.backend = backend;
  }

  async transaction(scope, callback) {
    valid(typeof callback === 'function');
    const key = await coordinationKey(scope);
    return this.backend.transaction(key, async (storage) => {
      let active = true;
      const usable = (name) => {
        if (!active) throw new V1Error('CONFLICT');
        text(name);
      };
      const tx = Object.freeze({
        get: async (name) => {
          usable(name);
          const value = await storage.get(name);
          return value === undefined ? undefined : persisted(value);
        },
        put: async (name, value) => {
          usable(name);
          await storage.put(name, persisted(value));
        },
        delete: async (name) => {
          usable(name);
          await storage.delete(name);
        },
      });
      try {
        // Return snapshots, never aliases into backend transaction state.
        const result = await callback(tx);
        return result === undefined ? undefined : freeze(copyJsonData(result));
      } finally {
        active = false;
      }
    });
  }

  async createDecision(scope, input) {
    const decision = Decision(input);
    valid(decision.state === 'DISCOVERED');
    return this.transaction(scope, async (tx) => {
      const key = 'decision:' + decision.id;
      if (await tx.get(key)) throw new V1Error('CONFLICT');
      await tx.put(key, decision);
      return decision;
    });
  }

  async transitionDecision(scope, id, transition, basis, options) {
    parseObjectId(id, 'decision');
    const basisSnapshot = basis === undefined ? undefined : copyJsonData(basis);
    const transitions = {
      REVIEWABLE: makeReviewable,
      RESOLVABLE: makeResolvable,
      RESOLVED: resolveDecision,
      STALE: markStale,
    };
    valid(Object.hasOwn(transitions, transition));
    const optionsSnapshot = transitionOptions(transition, options);
    return this.transaction(scope, async (tx) => {
      const key = 'decision:' + id;
      const current = await tx.get(key);
      if (!current) throw new V1Error('NOT_FOUND');
      const next = await transitions[transition](current, basisSnapshot, optionsSnapshot);
      await tx.put(key, next);
      return next;
    });
  }
}
