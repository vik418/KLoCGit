/** Transactional receipts and outbox; external executors must honor idempotency. */
import { V1Error, operationId, parseObjectId, publicError } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { EventEnvelope, createEvent, eventLimits, readEventPayload } from './events.mjs';

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

function record(input) {
  const value = copyJsonData(input);
  valid(value?.schema_version === 1);
  return value;
}

export class EventConsumer {
  constructor({
    store,
    limits,
    objectStore,
    authorize,
    handler,
    reconcile,
    executor,
    deadLetters,
    max_attempts,
  }) {
    valid(typeof store?.transaction === 'function');
    valid(typeof authorize === 'function' && typeof handler === 'function');
    valid(reconcile === undefined || typeof reconcile === 'function');
    valid(executor?.idempotent === true && typeof executor.execute === 'function');
    valid(typeof deadLetters?.send === 'function');
    valid(Number.isSafeInteger(max_attempts) && max_attempts > 0);
    Object.assign(this, {
      store,
      limits: eventLimits(limits),
      objectStore,
      authorize,
      handler,
      reconcile,
      executor,
      deadLetters,
      max_attempts,
    });
  }

  async consume(input, { principal, attempt }) {
    valid(Number.isSafeInteger(attempt) && attempt > 0);
    const event = EventEnvelope(input, this.limits);
    const actor = freeze(copyJsonData(principal));
    // Scope claims cannot authorize storage access, including claim-check reads.
    if ((await this.authorize({ principal: actor, event })) !== true)
      throw new V1Error('FORBIDDEN');
    const scope = freeze({
      schema_version: 1,
      tenant_id: event.tenant_id,
      system_id: event.system_id,
      kind: 'OBJECTIVE',
      resource_id: event.objective_id ?? event.subject_id,
    });
    try {
      const payload = await readEventPayload(event, this.limits, this.objectStore);
      const receipt = await this.prepare(scope, event, payload, actor);
      if (['IGNORED', 'APPLIED', 'DEADLETTERED'].includes(receipt.state))
        return { disposition: 'ACK', state: receipt.state };
      await this.drain(scope, receipt);
      return { disposition: 'ACK', state: 'APPLIED' };
    } catch (error) {
      const failure = publicError(error);
      if (attempt < this.max_attempts) return { disposition: 'RETRY', failure };
      try {
        await this.deadLetter(scope, event, attempt, failure);
        return { disposition: 'ACK', state: 'DEADLETTERED', failure };
      } catch {
        // Never acknowledge a poison message until the DLQ accepts it.
        return { disposition: 'RETRY', failure: publicError(new V1Error('PROVIDER_UNAVAILABLE')) };
      }
    }
  }

  async prepare(scope, event, payload, principal) {
    const streamKey =
      'stream:' + (await digestCanonical('event-stream', [event.type, event.subject_id]));
    return this.store.transaction(scope, async (tx) => {
      const dead = await tx.get('deadletter:' + event.event_id);
      if (dead && record(dead).state === 'QUEUED') {
        return {
          schema_version: 1,
          event_id: event.event_id,
          state: 'DEADLETTERED',
          operations: [],
        };
      }
      const existing = await tx.get('receipt:' + event.event_id);
      if (existing) return record(existing);
      const previous = await tx.get(streamKey);
      if (previous) record(previous);
      const receipt = {
        schema_version: 1,
        event_id: event.event_id,
        state: 'PREPARED',
        operations: [],
      };
      if (previous && event.subject_version < previous.subject_version) {
        receipt.state = 'IGNORED';
      } else {
        // Distinct same-version observations are ambiguous. A gap requires an
        // authoritative reread, rather than assuming omitted events were harmless.
        const gap = event.subject_version > (previous?.subject_version ?? 0) + 1;
        const collision = previous && event.subject_version === previous.subject_version;
        if ((gap || collision) && !this.reconcile) throw new V1Error('OUTCOME_UNKNOWN');
        const handler = gap || collision ? this.reconcile : this.handler;
        const effects = copyJsonData(
          await handler({
            event,
            payload,
            principal,
            previous: freeze(previous ? record(previous) : null),
            transaction: tx,
          }),
        );
        valid(Array.isArray(effects));
        for (let index = 0; index < effects.length; index += 1) {
          const effect = effects[index];
          valid(effect && typeof effect === 'object' && !Array.isArray(effect));
          valid(
            Object.keys(effect).length === 3 &&
              ['action', 'resource_id', 'payload'].every((field) => Object.hasOwn(effect, field)),
          );
          const idempotency_key = parseObjectId(event.event_id, 'event').hex + '.' + index;
          const operation_id = await operationId({
            tenant_id: event.tenant_id,
            resource_id: effect.resource_id,
            action: effect.action,
            idempotency_key,
          });
          await tx.put('outbox:' + operation_id, {
            schema_version: 1,
            operation_id,
            idempotency_key,
            event_id: event.event_id,
            tenant_id: event.tenant_id,
            system_id: event.system_id,
            principal,
            effect,
            state: 'PENDING',
            result: null,
          });
          receipt.operations.push(operation_id);
        }
        await tx.put(streamKey, {
          schema_version: 1,
          subject_version: event.subject_version,
          event_id: event.event_id,
        });
      }
      await tx.put('receipt:' + event.event_id, receipt);
      return receipt;
    });
  }

  async drain(scope, receipt) {
    for (const operation of receipt.operations) {
      const pending = await this.store.transaction(scope, (tx) => tx.get('outbox:' + operation));
      if (!pending) throw new V1Error('OUTCOME_UNKNOWN');
      const entry = record(pending);
      if (entry.state === 'APPLIED') continue;
      valid(entry.state === 'PENDING');
      // Execution is outside the storage transaction. The executor must also
      // recheck authorization/preconditions such as current basis and Git CAS.
      const result = copyJsonData(await this.executor.execute(freeze(entry)));
      await this.store.transaction(scope, async (tx) => {
        const current = record(await tx.get('outbox:' + operation));
        if (current.state === 'PENDING')
          await tx.put('outbox:' + operation, { ...current, state: 'APPLIED', result });
      });
    }
    await this.store.transaction(scope, async (tx) => {
      const current = record(await tx.get('receipt:' + receipt.event_id));
      for (const operation of current.operations) {
        if (record(await tx.get('outbox:' + operation)).state !== 'APPLIED')
          throw new V1Error('OUTCOME_UNKNOWN');
      }
      await tx.put('receipt:' + receipt.event_id, { ...current, state: 'APPLIED' });
    });
  }

  async deadLetter(scope, event, attempt, failure) {
    const candidate = await createEvent(
      {
        schema_version: 1,
        type: 'consumer.deadletter',
        tenant_id: event.tenant_id,
        system_id: event.system_id,
        objective_id: event.objective_id,
        subject_id: event.subject_id,
        subject_version: event.subject_version,
        occurred_at: event.occurred_at,
        trace_id: event.trace_id,
      },
      { original_event: event, attempt, failure },
      this.limits,
      this.objectStore,
    );
    const entry = await this.store.transaction(scope, async (tx) => {
      const key = 'deadletter:' + event.event_id;
      const existing = await tx.get(key);
      if (existing) return record(existing);
      const value = { schema_version: 1, state: 'PENDING', event: candidate };
      await tx.put(key, value);
      return value;
    });
    if (entry.state === 'QUEUED') return;
    await this.deadLetters.send(freeze(entry.event));
    await this.store.transaction(scope, async (tx) => {
      await tx.put('deadletter:' + event.event_id, { ...entry, state: 'QUEUED' });
    });
  }
}
