/** Exact release contracts at the external CD boundary. No rollout or rollback logic. */
import {
  V1Error,
  assertSchemaVersion,
  assertIdempotencyKey,
  objectId,
  operationId,
  parseDigest,
  parseObjectId,
} from './conventions.mjs';
import { copyJsonData, DeploymentObservation, gitOid } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { verifySystemRevision, verifyReleaseConstraints } from './releases.mjs';

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
  valid(typeof value === 'string' && value.trim().length > 0 && value.length <= 1024);
  return value;
}

export function deploymentContext(input) {
  const context = copyJsonData(input);
  assertSchemaVersion(context);
  const fields = [
    'schema_version',
    'tenant_id',
    'system_id',
    'principal',
    'idempotency_key',
    'trace_id',
  ];
  valid(
    Object.keys(context).length === fields.length &&
      fields.every((key) => Object.hasOwn(context, key)),
  );
  text(context.tenant_id);
  text(context.system_id);
  text(context.trace_id);
  valid(
    context.principal && typeof context.principal === 'object' && !Array.isArray(context.principal),
  );
  text(context.principal.actor_id);
  text(context.principal.tenant_id);
  assertIdempotencyKey(context.idempotency_key);
  return freeze(context);
}

export function deploymentHandle(input) {
  const handle = copyJsonData(input);
  assertSchemaVersion(handle);
  const fields = [
    'schema_version',
    'tenant_id',
    'system_id',
    'provider_id',
    'external_run_id',
    'operation_id',
    'system_revision_digest',
    'release_constraints_digest',
  ];
  valid(
    Object.keys(handle).length === fields.length &&
      fields.every((key) => Object.hasOwn(handle, key)),
  );
  for (const key of ['tenant_id', 'system_id', 'provider_id', 'external_run_id']) text(handle[key]);
  parseDigest(handle.system_revision_digest, 'object-system-revision');
  parseDigest(handle.release_constraints_digest, 'release-constraints');
  // Operation IDs are scoped to the tenant, system, action and idempotency key.
  parseObjectId(handle.operation_id, 'operation');
  return freeze(handle);
}

export async function buildDeploymentObservation(input) {
  const body = copyJsonData(input);
  assertSchemaVersion(body);
  const digest = await digestCanonical('object-deployment-observation', body);
  return DeploymentObservation({ ...body, digest, id: objectId('deployment-observation', digest) });
}

export async function verifyDeploymentObservation(input) {
  const observation = DeploymentObservation(input);
  const { id, digest, ...body } = observation;
  if (
    (await digestCanonical('object-deployment-observation', body)) !== digest ||
    objectId('deployment-observation', digest) !== id
  )
    throw new V1Error('INTEGRITY_MISMATCH');
  return observation;
}

/** Transport callbacks are trusted registrations, never producer-supplied functions. */
export class DeploymentAdapter {
  constructor({ provider_id, transport, authorize, policyEvaluator, now }) {
    text(provider_id);
    valid(typeof transport?.submit === 'function' && typeof transport?.observe === 'function');
    valid(
      typeof authorize === 'function' &&
        typeof policyEvaluator?.can_promote === 'function' &&
        typeof now === 'function',
    );
    this.provider_id = provider_id;
    this.transport = transport;
    this.authorize = authorize;
    this.policy = policyEvaluator;
    this.now = now;
  }

  async #authorize(context, action) {
    if (
      context.principal.tenant_id !== context.tenant_id ||
      (await this.authorize(context.principal, {
        schema_version: 1,
        tenant_id: context.tenant_id,
        system_id: context.system_id,
        provider_id: this.provider_id,
        action,
      })) !== true
    )
      throw new V1Error('FORBIDDEN');
  }

  async submit(revisionInput, constraintsInput, contextInput) {
    const context = deploymentContext(contextInput);
    const revision = await verifySystemRevision(revisionInput);
    const constraints = await verifyReleaseConstraints(constraintsInput, revision);
    await this.#authorize(context, 'deployment.submit');
    if ((await this.policy.can_promote(revision, constraints)) !== true)
      throw new V1Error('POLICY_REJECTED');
    const operation_id = await operationId({
      tenant_id: context.tenant_id,
      resource_id: context.system_id,
      action: 'deployment.submit',
      idempotency_key: context.idempotency_key,
    });
    let response;
    try {
      response = copyJsonData(
        await this.transport.submit(revision, constraints, freeze({ ...context, operation_id })),
      );
    } catch (error) {
      if (error instanceof V1Error) throw error;
      // A failed reply cannot establish whether the external submission happened.
      throw new V1Error('OUTCOME_UNKNOWN');
    }
    assertSchemaVersion(response);
    valid(Object.keys(response).length === 2);
    return deploymentHandle({
      schema_version: 1,
      tenant_id: context.tenant_id,
      system_id: context.system_id,
      provider_id: this.provider_id,
      operation_id,
      external_run_id: response.external_run_id,
      system_revision_digest: revision.digest,
      release_constraints_digest: constraints.digest,
    });
  }

  async observe(handleInput, contextInput) {
    const handle = deploymentHandle(handleInput),
      context = deploymentContext(contextInput);
    if (
      handle.tenant_id !== context.tenant_id ||
      handle.system_id !== context.system_id ||
      handle.provider_id !== this.provider_id
    )
      throw new V1Error('FORBIDDEN');
    await this.#authorize(context, 'deployment.observe');
    let raw;
    try {
      raw = copyJsonData(await this.transport.observe(handle, context));
    } catch (error) {
      if (
        error instanceof V1Error &&
        !['PROVIDER_UNAVAILABLE', 'OUTCOME_UNKNOWN'].includes(error.code)
      )
        throw error;
      raw = {
        schema_version: 1,
        status: 'UNKNOWN',
        method: 'provider-unavailable',
        observed_repositories: null,
      };
    }
    assertSchemaVersion(raw);
    valid(Object.keys(raw).length === 4);
    text(raw.method);
    if (raw.observed_repositories !== null) {
      valid(
        raw.observed_repositories &&
          typeof raw.observed_repositories === 'object' &&
          !Array.isArray(raw.observed_repositories),
      );
      for (const [repo, oid] of Object.entries(raw.observed_repositories)) {
        text(repo);
        gitOid(oid);
      }
    }
    const observation = await buildDeploymentObservation({
      schema_version: 1,
      system_revision_digest: handle.system_revision_digest,
      external_run_id: handle.external_run_id,
      status: raw.status,
      observed_at: this.now(),
      method: raw.method,
    });
    return freeze({
      schema_version: 1,
      observation,
      observed_repositories: raw.observed_repositories,
    });
  }
}
