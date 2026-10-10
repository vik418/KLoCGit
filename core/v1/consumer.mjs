/** Transactional receipts and outbox; external executors must honor idempotency. */
import { V1Error, operationId, parseObjectId, publicError } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { digestCanonical } from './encoding.mjs';
import { EventEnvelope, eventLimits, readEventPayload, verifyEventEnvelope } from './events.mjs';
import { coordinationScope } from './coordination.mjs';

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
    resolveScope,
    handler,
    reconcile,
    executor,
    deadLetters,
    max_attempts,
  }) {
    valid(typeof store?.transaction === 'function');
    valid(typeof authorize === 'function' && typeof handler === 'function');
    valid(resolveScope === undefined || typeof resolveScope === 'function');
    valid(reconcile === undefined || typeof reconcile === 'function');
    valid(executor?.idempotent === true && typeof executor.execute === 'function');
    valid(typeof deadLetters?.send === 'function');
    valid(Number.isSafeInteger(max_attempts) && max_attempts > 0);
    Object.assign(this, {
      store,
      limits: eventLimits(limits),
      objectStore,
      authorize,
      resolveScope,
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
    let scope;
    if (event.objective_id !== null) {
      scope = coordinationScope({
        schema_version: 1,
        tenant_id: event.tenant_id,
        system_id: event.system_id,
        kind: 'OBJECTIVE',
        resource_id: event.objective_id,
      });
    } else {
      // A subject ID cannot stand in for an objective. The trusted adapter must
      // resolve observations outside objectives to their authoritative ref scope.
      if (!this.resolveScope) throw new V1Error('OUTCOME_UNKNOWN');
      scope = coordinationScope(await this.resolveScope({ event, principal: actor }));
      if (scope.tenant_id !== event.tenant_id || scope.system_id !== event.system_id)
        throw new V1Error('FORBIDDEN');
      valid(scope.kind === 'REF');
    }
    // An unverified claimed ID must never select a receipt or quarantine key.
    // Ingress quarantines malformed transport independently of domain journals.
    await verifyEventEnvelope(event, this.limits);
    try {
      let receipt = await this.store.transaction(scope, (tx) =>
        this.existingReceipt(tx, event.event_id),
      );
      if (!receipt) {
        const payload = await readEventPayload(event, this.limits, this.objectStore);
        receipt = await this.prepare(scope, event, payload, actor);
      }
      let state = receipt.state;
      if (state === 'PREPARED') state = await this.drain(scope, receipt);
      if (state === 'DEADLETTERING') state = await this.flushDeadLetter(scope, event.event_id);
      valid(['IGNORED', 'APPLIED', 'DEADLETTERED'].includes(state));
      return { disposition: 'ACK', state };
    } catch (error) {
      const failure = publicError(error);
      if (attempt < this.max_attempts) return { disposition: 'RETRY', failure };
      try {
        const state = await this.deadLetter(scope, event, attempt, failure);
        return { disposition: 'ACK', state, failure };
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
      const existing = await this.existingReceipt(tx, event.event_id);
      if (existing) return existing;
      const previous = await tx.get(streamKey);
      if (previous) record(previous);
      const receipt = {
        schema_version: 1,
        event_id: event.event_id,
        stream_key: streamKey,
        subject_version: event.subject_version,
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
            attempted: false,
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

  async existingReceipt(tx, eventId) {
    const dead = await tx.get('deadletter:' + eventId);
    if (dead) {
      return {
        schema_version: 1,
        event_id: eventId,
        state: record(dead).state === 'QUEUED' ? 'DEADLETTERED' : 'DEADLETTERING',
        operations: [],
      };
    }
    const existing = await tx.get('receipt:' + eventId);
    return existing ? record(existing) : undefined;
  }

  async drain(scope, receipt) {
    for (const operation of receipt.operations) {
      const next = await this.store.transaction(scope, async (tx) => {
        const current = await this.guardReceipt(tx, receipt.event_id);
        if (current.state !== 'PREPARED') return { state: current.state };
        const pending = await tx.get('outbox:' + operation);
        if (!pending) throw new V1Error('OUTCOME_UNKNOWN');
        const entry = record(pending);
        if (entry.state === 'PENDING')
          await tx.put('outbox:' + operation, { ...entry, attempted: true });
        return { entry: { ...entry, attempted: true } };
      });
      if (next.state) return next.state;
      const entry = next.entry;
      if (entry.state === 'APPLIED') continue;
      valid(entry.state === 'PENDING');
      // Execution is outside the storage transaction. The executor must also
      // recheck authorization/preconditions such as current basis and Git CAS.
      const result = copyJsonData(await this.executor.execute(freeze(entry)));
      await this.store.transaction(scope, async (tx) => {
        const current = record(await tx.get('outbox:' + operation));
        // An in-flight remote success remains an observation even if its receipt
        // was quarantined. It cannot reopen the receipt or start another effect.
        await tx.put('outbox:' + operation, { ...current, state: 'APPLIED', result });
      });
    }
    return this.store.transaction(scope, async (tx) => {
      const current = await this.guardReceipt(tx, receipt.event_id);
      if (current.state !== 'PREPARED') return current.state;
      for (const operation of current.operations) {
        if (record(await tx.get('outbox:' + operation)).state !== 'APPLIED')
          throw new V1Error('OUTCOME_UNKNOWN');
      }
      await tx.put('receipt:' + receipt.event_id, { ...current, state: 'APPLIED' });
      return 'APPLIED';
    });
  }

  async cancelPending(tx, receipt) {
    for (const operation of receipt.operations) {
      const entry = record(await tx.get('outbox:' + operation));
      if (entry.state === 'PENDING')
        await tx.put('outbox:' + operation, {
          ...entry,
          // Once issued, absence of a response cannot establish absence of effect.
          state: entry.attempted ? 'UNKNOWN' : 'CANCELLED',
        });
    }
  }

  async guardReceipt(tx, eventId) {
    const current = record(await tx.get('receipt:' + eventId));
    if (current.state !== 'PREPARED') return current;
    const stream = record(await tx.get(current.stream_key));
    if (
      stream.subject_version > current.subject_version ||
      (stream.subject_version === current.subject_version && stream.event_id !== eventId)
    ) {
      await this.cancelPending(tx, current);
      const ignored = { ...current, state: 'IGNORED' };
      await tx.put('receipt:' + eventId, ignored);
      return ignored;
    }
    return current;
  }

  async deadLetter(scope, event, attempt, failure) {
    const entry = await this.store.transaction(scope, async (tx) => {
      const key = 'deadletter:' + event.event_id;
      const existing = await tx.get(key);
      if (existing) return record(existing);
      const receipt = (await tx.get('receipt:' + event.event_id)) ?? {
        schema_version: 1,
        event_id: event.event_id,
        operations: [],
      };
      if (['IGNORED', 'APPLIED'].includes(receipt.state)) return { state: receipt.state };
      await this.cancelPending(tx, receipt);
      // The destination identifies this as a DLQ delivery. Reuse the exact
      // bounded envelope; adding error metadata could exceed its transport limit.
      const value = { schema_version: 1, state: 'PENDING', event, attempt, failure };
      await tx.put(key, value);
      await tx.put('receipt:' + event.event_id, { ...receipt, state: 'DEADLETTERING' });
      return value;
    });
    if (['IGNORED', 'APPLIED'].includes(entry.state)) return entry.state;
    return this.flushDeadLetter(scope, event.event_id);
  }

  async flushDeadLetter(scope, eventId) {
    const entry = await this.store.transaction(scope, (tx) => tx.get('deadletter:' + eventId));
    if (!entry) throw new V1Error('OUTCOME_UNKNOWN');
    if (entry.state !== 'QUEUED') await this.deadLetters.send(freeze(entry.event));
    await this.store.transaction(scope, async (tx) => {
      await tx.put('deadletter:' + eventId, { ...entry, state: 'QUEUED' });
      const receipt = record(await tx.get('receipt:' + eventId));
      await tx.put('receipt:' + eventId, { ...receipt, state: 'DEADLETTERED' });
    });
    return 'DEADLETTERED';
  }
}
