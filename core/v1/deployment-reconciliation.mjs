/** Durable external-CD observation. Provider calls never hold a coordination transaction. */
import {
  V1Error,
  assertSchemaVersion,
  operationId,
  objectId,
  parseObjectId,
} from './conventions.mjs';
import { copyJsonData, gitOid } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { verifySystemRevision, verifyReleaseConstraints } from './releases.mjs';
import {
  deploymentContext,
  deploymentHandle,
  buildDeploymentObservation,
  verifyDeploymentObservation,
} from './deployment.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const rejected = new Set([
  'INVALID_ARGUMENT',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'CONFLICT',
  'UNSUPPORTED_CAPABILITY',
  'POLICY_REJECTED',
  'IDEMPOTENCY_CONFLICT',
]);

export class DeploymentCoordinator {
  constructor({ store, providers, authorize, policyEvaluator, now, random, settings }) {
    valid(
      typeof store?.transaction === 'function' &&
        typeof authorize === 'function' &&
        typeof policyEvaluator?.can_promote === 'function' &&
        typeof now === 'function' &&
        typeof random === 'function',
    );
    const configuration = copyJsonData(settings);
    assertSchemaVersion(configuration);
    const fields = [
      'webhook_grace_ms',
      'poll_base_ms',
      'poll_max_ms',
      'lease_ms',
      'concurrency_cap',
      'max_calls_per_window',
      'rate_window_ms',
      'max_event_bytes',
    ];
    valid(Object.keys(configuration).length === fields.length + 1);
    for (const key of fields)
      valid(Number.isSafeInteger(configuration[key]) && configuration[key] > 0);
    valid(configuration.poll_max_ms >= configuration.poll_base_ms);
    valid(providers && Object.keys(providers).length > 0);
    this.providers = new Map(Object.entries(providers));
    for (const [id, provider] of this.providers)
      valid(provider.adapter?.provider_id === id && typeof provider.verify_event === 'function');
    this.store = store;
    this.authorize = authorize;
    this.policy = policyEvaluator;
    this.now = now;
    this.random = random;
    this.settings = Object.freeze(configuration);
  }

  #scope(context, provider_id) {
    valid(this.providers.has(provider_id));
    return {
      schema_version: 1,
      tenant_id: context.tenant_id,
      system_id: context.system_id,
      kind: 'OBJECTIVE',
      resource_id: 'deployment:' + provider_id,
    };
  }

  async #authorize(context, provider_id, action) {
    if (
      context.principal.tenant_id !== context.tenant_id ||
      (await this.authorize(context.principal, {
        schema_version: 1,
        tenant_id: context.tenant_id,
        system_id: context.system_id,
        provider_id,
        action,
      })) !== true
    )
      throw new V1Error('FORBIDDEN');
  }

  async #permit(tx, operation_id, lease_token, now) {
    const control = (await tx.get('provider-control')) ?? {
      schema_version: 1,
      calls: [],
      leases: {},
    };
    const calls = control.calls.filter((time) => time > now - this.settings.rate_window_ms);
    const leases = Object.fromEntries(
      Object.entries(control.leases).filter(([, value]) => value.expires_at > now),
    );
    if (
      calls.length >= this.settings.max_calls_per_window ||
      Object.keys(leases).length >= this.settings.concurrency_cap
    )
      throw new V1Error('RATE_LIMITED');
    calls.push(now);
    leases[lease_token] = {
      schema_version: 1,
      operation_id,
      expires_at: now + this.settings.lease_ms,
    };
    await tx.put('provider-control', { schema_version: 1, calls, leases });
  }

  async #release(tx, lease_token) {
    const control = await tx.get('provider-control');
    if (!control) return;
    const leases = { ...control.leases };
    delete leases[lease_token];
    await tx.put('provider-control', { ...control, leases });
  }

  async #save(tx, record, context, previous, failure_class = null) {
    await tx.put('deployment:' + record.operation_id, record);
    await tx.put('audit:' + record.operation_id + ':' + record.version, {
      schema_version: 1,
      trace_id: context.trace_id,
      object_id: record.operation_id,
      actor_id: context.principal.actor_id,
      from_state: previous,
      to_state: record.status,
      version: record.version,
      occurred_at_ms: this.now(),
      failure_class,
    });
    return record;
  }

  async submit(provider_id, revisionInput, constraintsInput, contextInput) {
    const context = deploymentContext(contextInput);
    const revision = await verifySystemRevision(revisionInput),
      constraints = await verifyReleaseConstraints(constraintsInput, revision);
    const scope = this.#scope(context, provider_id);
    await this.#authorize(context, provider_id, 'deployment.submit');
    if ((await this.policy.can_promote(revision, constraints)) !== true)
      throw new V1Error('POLICY_REJECTED');
    const operation_id = await operationId({
      tenant_id: context.tenant_id,
      resource_id: context.system_id,
      action: 'deployment.submit',
      idempotency_key: context.idempotency_key,
    });
    const request_digest = await digestCanonical('deployment-request', {
      schema_version: 1,
      provider_id,
      actor_id: context.principal.actor_id,
      revision,
      constraints,
    });
    const prepared = await this.store.transaction(scope, async (tx) => {
      await this.#authorize(context, provider_id, 'deployment.submit');
      if ((await this.policy.can_promote(revision, constraints)) !== true)
        throw new V1Error('POLICY_REJECTED');
      const old = await tx.get('deployment:' + operation_id);
      if (old) {
        valid(old.request_digest === request_digest, 'IDEMPOTENCY_CONFLICT');
        return { record: old, dispatch: false };
      }
      const now = this.now(),
        lease_token = objectId(
          'operation',
          await digestCanonical('object-operation', { operation_id, purpose: 'submit' }),
        );
      await this.#permit(tx, operation_id, lease_token, now);
      const record = {
        schema_version: 1,
        operation_id,
        request_digest,
        provider_id,
        revision,
        constraints,
        handle: null,
        status: 'SUBMITTED',
        phase: 'DISPATCHING',
        version: 1,
        lease_token,
        lease_expires_at: now + this.settings.lease_ms,
        observation: null,
        observed_repositories: null,
        event_version: 0,
        next_poll_at: now + this.settings.webhook_grace_ms,
        failures: 0,
      };
      await this.#save(tx, record, context, null);
      return { record, dispatch: true };
    });
    if (!prepared.dispatch) return prepared.record;
    let handle, error;
    try {
      handle = await this.providers.get(provider_id).adapter.submit(revision, constraints, context);
    } catch (failure) {
      error = failure instanceof V1Error ? failure.code : 'OUTCOME_UNKNOWN';
    }
    return this.store.transaction(scope, async (tx) => {
      const current = await tx.get('deployment:' + operation_id);
      await this.#release(tx, prepared.record.lease_token);
      // A verified event can recover a run before the dispatch response arrives.
      if (current.version !== prepared.record.version) return current;
      const next = {
        ...current,
        version: current.version + 1,
        lease_token: null,
        lease_expires_at: null,
      };
      if (handle) {
        next.handle = deploymentHandle(handle);
        next.phase = 'OBSERVING';
      } else {
        next.status = rejected.has(error) ? 'REJECTED' : 'UNKNOWN';
        next.phase = next.status;
      }
      return this.#save(tx, next, context, current.status, error ?? null);
    });
  }

  async get(provider_id, operation_id, contextInput) {
    const context = deploymentContext(contextInput);
    parseObjectId(operation_id, 'operation');
    const scope = this.#scope(context, provider_id);
    return this.store.transaction(scope, async (tx) => {
      await this.#authorize(context, provider_id, 'deployment.observe');
      const record = await tx.get('deployment:' + operation_id);
      if (!record) throw new V1Error('NOT_FOUND');
      return record;
    });
  }

  #delay(failures) {
    const jitter = this.random();
    valid(Number.isFinite(jitter) && jitter >= 0 && jitter < 1);
    const maximum = Math.min(
      this.settings.poll_max_ms,
      this.settings.poll_base_ms * 2 ** Math.min(failures, 30),
    );
    return Math.max(1, Math.floor(maximum * (0.5 + jitter / 2)));
  }

  async #report(handle, input) {
    const report = copyJsonData(input);
    assertSchemaVersion(report);
    valid(Object.keys(report).length === 3 && Object.hasOwn(report, 'observed_repositories'));
    const observation = await verifyDeploymentObservation(report.observation);
    valid(
      observation.system_revision_digest === handle.system_revision_digest &&
        observation.external_run_id === handle.external_run_id,
      'INTEGRITY_MISMATCH',
    );
    if (report.observed_repositories !== null) {
      valid(
        report.observed_repositories &&
          typeof report.observed_repositories === 'object' &&
          !Array.isArray(report.observed_repositories),
      );
      for (const [repo, oid] of Object.entries(report.observed_repositories)) {
        valid(repo.length > 0);
        gitOid(oid);
      }
    }
    return { schema_version: 1, observation, observed_repositories: report.observed_repositories };
  }

  async #apply(tx, current, report, context, extra = {}) {
    const status =
      current.observation &&
      terminal.has(current.status) &&
      current.status !== report.observation.status
        ? 'UNKNOWN'
        : report.observation.status;
    const failures = status === 'UNKNOWN' ? current.failures + 1 : 0;
    const next = {
      ...current,
      ...extra,
      version: current.version + 1,
      phase: 'OBSERVING',
      status,
      observation: report.observation,
      observed_repositories: report.observed_repositories,
      failures,
      next_poll_at: terminal.has(status) ? null : this.now() + this.#delay(failures),
      lease_token: null,
      lease_expires_at: null,
    };
    return this.#save(tx, next, context, current.status, status === 'UNKNOWN' ? 'AMBIGUOUS' : null);
  }

  async reconcile(provider_id, operation_id, contextInput) {
    const context = deploymentContext(contextInput);
    parseObjectId(operation_id, 'operation');
    const scope = this.#scope(context, provider_id);
    const prepared = await this.store.transaction(scope, async (tx) => {
      await this.#authorize(context, provider_id, 'deployment.observe');
      const current = await tx.get('deployment:' + operation_id);
      if (!current) throw new V1Error('NOT_FOUND');
      const now = this.now();
      if (current.lease_token && current.lease_expires_at > now)
        return { record: current, poll: false };
      if (current.lease_token) await this.#release(tx, current.lease_token);
      if (!current.handle) {
        if (current.phase !== 'DISPATCHING') return { record: current, poll: false };
        const next = {
          ...current,
          version: current.version + 1,
          status: 'UNKNOWN',
          phase: 'UNKNOWN',
          lease_token: null,
          lease_expires_at: null,
        };
        return {
          record: await this.#save(tx, next, context, current.status, 'AMBIGUOUS'),
          poll: false,
        };
      }
      if (current.next_poll_at === null || current.next_poll_at > now)
        return { record: current, poll: false };
      const version = current.version + 1;
      const lease_token = objectId(
        'operation',
        await digestCanonical('object-operation', { operation_id, purpose: 'observe', version }),
      );
      await this.#permit(tx, operation_id, lease_token, now);
      const next = {
        ...current,
        version,
        lease_token,
        lease_expires_at: now + this.settings.lease_ms,
      };
      await tx.put('deployment:' + operation_id, next);
      return { record: next, poll: true };
    });
    if (!prepared.poll) return prepared.record;
    let report;
    try {
      report = await this.#report(
        prepared.record.handle,
        await this.providers.get(provider_id).adapter.observe(prepared.record.handle, context),
      );
    } catch (error) {
      if (
        error instanceof V1Error &&
        !['PROVIDER_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'RATE_LIMITED'].includes(error.code)
      ) {
        await this.store.transaction(scope, async (tx) => {
          await this.#release(tx, prepared.record.lease_token);
        });
        throw error;
      }
      report = {
        schema_version: 1,
        observation: await buildDeploymentObservation({
          schema_version: 1,
          system_revision_digest: prepared.record.revision.digest,
          external_run_id: prepared.record.handle.external_run_id,
          status: 'UNKNOWN',
          observed_at: new Date(this.now()).toISOString(),
          method: 'provider-unavailable',
        }),
        observed_repositories: null,
      };
    }
    return this.store.transaction(scope, async (tx) => {
      await this.#release(tx, prepared.record.lease_token);
      const current = await tx.get('deployment:' + operation_id);
      if (current.version !== prepared.record.version) return current;
      return this.#apply(tx, current, report, context);
    });
  }

  async accept_event(provider_id, eventInput, contextInput) {
    const context = deploymentContext(contextInput),
      event = copyJsonData(eventInput);
    assertSchemaVersion(event);
    valid(
      Object.keys(event).length === 6 &&
        typeof event.event_id === 'string' &&
        event.event_id.length > 0 &&
        Number.isSafeInteger(event.version) &&
        event.version > 0,
    );
    valid(new TextEncoder().encode(JSON.stringify(event)).length <= this.settings.max_event_bytes);
    parseObjectId(event.operation_id, 'operation');
    const scope = this.#scope(context, provider_id);
    return this.store.transaction(scope, async (tx) => {
      await this.#authorize(context, provider_id, 'deployment.event');
      const current = await tx.get('deployment:' + event.operation_id);
      if (!current) throw new V1Error('NOT_FOUND');
      if ((await this.providers.get(provider_id).verify_event(event, context, current)) !== true)
        throw new V1Error('FORBIDDEN');
      const handle = deploymentHandle(event.handle);
      valid(
        handle.tenant_id === context.tenant_id &&
          handle.system_id === context.system_id &&
          handle.provider_id === provider_id &&
          handle.operation_id === current.operation_id &&
          handle.system_revision_digest === current.revision.digest &&
          handle.release_constraints_digest === current.constraints.digest,
        'INTEGRITY_MISMATCH',
      );
      if (current.handle)
        valid(current.handle.external_run_id === handle.external_run_id, 'INTEGRITY_MISMATCH');
      const report = await this.#report(handle, event.report);
      if (event.version <= current.event_version) return current;
      if (current.lease_token) await this.#release(tx, current.lease_token);
      return this.#apply(tx, current, report, context, { handle, event_version: event.version });
    });
  }
}
