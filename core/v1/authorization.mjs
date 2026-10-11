/** Current tenant grants authorize explicit actions and resources. Identity is separate. */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { encodeCanonical } from './encoding.mjs';

const dimensions = [
  'repo_id',
  'ref',
  'objective_id',
  'decision_id',
  'provider_id',
  'digest',
  'producer_identity',
  'resource_id',
  'candidate_digest',
];
function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}
function text(value) {
  valid(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 1024 &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function same(left, right) {
  const a = encodeCanonical(left),
    b = encodeCanonical(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export function authenticatedPrincipal(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(Object.keys(value).length === 5);
  for (const key of ['actor_id', 'tenant_id']) text(value[key]);
  valid(['human', 'service', 'agent'].includes(value.kind));
  valid(value.capability_id === null || typeof value.capability_id === 'string');
  if (value.capability_id !== null) text(value.capability_id);
  valid(value.kind !== 'agent' || value.capability_id !== null);
  return freeze(value);
}

/** The identity registry supplies tenancy and capability; token claims cannot self-grant them. */
export class PrincipalResolver {
  constructor({ authenticate, resolveIdentity }) {
    valid(typeof authenticate === 'function' && typeof resolveIdentity === 'function');
    this.authenticate = authenticate;
    this.resolveIdentity = resolveIdentity;
  }

  async resolve(request) {
    let identity, registered;
    try {
      identity = copyJsonData(await this.authenticate(request));
      if (!identity?.actor_id) throw new V1Error('UNAUTHENTICATED');
      registered = await this.resolveIdentity(freeze(identity));
    } catch (error) {
      if (error instanceof V1Error) throw error;
      throw new V1Error('UNAUTHENTICATED');
    }
    if (!registered) throw new V1Error('FORBIDDEN');
    const principal = authenticatedPrincipal(registered);
    if (principal.actor_id !== identity.actor_id) throw new V1Error('INTEGRITY_MISMATCH');
    return principal;
  }
}

export function authorizationGrant(input) {
  const grant = copyJsonData(input);
  assertSchemaVersion(grant);
  const fields = [
    'schema_version',
    'grant_id',
    'version',
    'tenant_id',
    'actor_id',
    'kind',
    'permissions',
    'not_before_ms',
    'expires_at_ms',
    'revoked',
  ];
  valid(
    Object.keys(grant).length === fields.length && fields.every((key) => Object.hasOwn(grant, key)),
  );
  for (const key of ['grant_id', 'tenant_id', 'actor_id']) text(grant[key]);
  valid(
    Number.isSafeInteger(grant.version) &&
      grant.version > 0 &&
      ['human', 'service', 'agent'].includes(grant.kind),
  );
  valid(
    Number.isSafeInteger(grant.not_before_ms) &&
      grant.not_before_ms >= 0 &&
      Number.isSafeInteger(grant.expires_at_ms) &&
      grant.expires_at_ms > grant.not_before_ms &&
      typeof grant.revoked === 'boolean',
  );
  valid(Array.isArray(grant.permissions) && grant.permissions.length > 0);
  const seen = new Set();
  for (const permission of grant.permissions) {
    assertSchemaVersion(permission);
    valid(Object.keys(permission).length === 5);
    text(permission.system_id);
    valid(
      typeof permission.action === 'string' &&
        /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(permission.action),
    );
    valid(['EXACT', 'SYSTEM'].includes(permission.scope));
    valid(
      permission.resources &&
        typeof permission.resources === 'object' &&
        !Array.isArray(permission.resources),
    );
    for (const [key, value] of Object.entries(permission.resources)) {
      valid(dimensions.includes(key));
      text(value);
    }
    valid(permission.scope !== 'SYSTEM' || Object.keys(permission.resources).length === 0);
    valid(grant.kind !== 'agent' || permission.scope === 'EXACT');
    const key = JSON.stringify([...encodeCanonical(permission)]);
    valid(!seen.has(key));
    seen.add(key);
  }
  grant.permissions.sort((a, b) => {
    const left = encodeCanonical(a),
      right = encodeCanonical(b);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1)
      if (left[index] !== right[index]) return left[index] - right[index];
    return left.length - right.length;
  });
  return freeze(grant);
}

function requestedResource(input) {
  const request = copyJsonData(input);
  assertSchemaVersion(request);
  for (const key of ['tenant_id', 'system_id', 'action']) text(request[key]);
  const resources = {};
  for (const key of dimensions) if (Object.hasOwn(request, key)) resources[key] = request[key];
  if (request.kind === 'REF') {
    valid(resources.resource_id && typeof resources.resource_id === 'object');
    const ref = resources.resource_id;
    valid(Object.keys(ref).length === 2);
    valid(resources.repo_id === undefined || resources.repo_id === ref.repo_id);
    valid(resources.ref === undefined || resources.ref === ref.ref);
    resources.repo_id = ref.repo_id;
    resources.ref = ref.ref;
    delete resources.resource_id;
  } else if (request.kind === 'OBJECTIVE') {
    valid(resources.objective_id === undefined || resources.objective_id === resources.resource_id);
    resources.objective_id = resources.resource_id;
    delete resources.resource_id;
  }
  valid(request.kind === undefined || ['REF', 'OBJECTIVE'].includes(request.kind));
  for (const value of Object.values(resources)) text(value);
  return {
    tenant_id: request.tenant_id,
    system_id: request.system_id,
    action: request.action,
    resources,
  };
}

export class AuthorizationPolicy {
  constructor({ resolveGrants, now, max_grants, max_permissions }) {
    valid(
      typeof resolveGrants === 'function' &&
        typeof now === 'function' &&
        Number.isSafeInteger(max_grants) &&
        max_grants > 0 &&
        Number.isSafeInteger(max_permissions) &&
        max_permissions > 0,
    );
    Object.assign(this, { resolveGrants, now, max_grants, max_permissions });
  }

  authorize = async (principalInput, resourceInput) => {
    const principal = authenticatedPrincipal(principalInput),
      request = requestedResource(resourceInput);
    if (principal.tenant_id !== request.tenant_id) return false;
    let registered;
    try {
      registered = await this.resolveGrants(principal);
    } catch (error) {
      if (error instanceof V1Error) throw error;
      throw new V1Error('PROVIDER_UNAVAILABLE');
    }
    if (!Array.isArray(registered) || registered.length > this.max_grants)
      throw new V1Error('INCOMPLETE_ANALYSIS');
    const grants = registered.map(authorizationGrant),
      now = this.now();
    valid(Number.isSafeInteger(now) && now >= 0);
    if (grants.reduce((sum, grant) => sum + grant.permissions.length, 0) > this.max_permissions)
      throw new V1Error('INCOMPLETE_ANALYSIS');
    return grants.some(
      (grant) =>
        grant.tenant_id === principal.tenant_id &&
        grant.actor_id === principal.actor_id &&
        grant.kind === principal.kind &&
        (principal.capability_id === null || grant.grant_id === principal.capability_id) &&
        !grant.revoked &&
        grant.not_before_ms <= now &&
        now < grant.expires_at_ms &&
        grant.permissions.some(
          (permission) =>
            permission.action === request.action &&
            permission.system_id === request.system_id &&
            (permission.scope === 'SYSTEM' || same(permission.resources, request.resources)),
        ),
    );
  };
}
