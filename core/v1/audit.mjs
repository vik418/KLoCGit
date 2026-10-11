/** Append-only records commit with the state transition they describe. */
import {
  V1Error,
  ERROR_TAXONOMY,
  assertSchemaVersion,
  assertIdempotencyKey,
  parseDigest,
  parseObjectId,
  objectId,
} from './conventions.mjs';
import { copyJsonData, gitOid } from './domain.mjs';
import { coordinationScope, coordinationKey } from './coordination.mjs';
import { digestCanonical } from './encoding.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}

function text(value) {
  valid(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 1024 &&
      !/[\u0000-\u001f\u007f]/.test(value),
  );
}

function eventSnapshot(input) {
  const event = copyJsonData(input);
  assertSchemaVersion(event);
  const fields = [
    'schema_version',
    'event_key',
    'actor_id',
    'trace_id',
    'action',
    'subject_id',
    'operation_id',
    'from_state',
    'to_state',
    'failure_class',
    'bindings',
  ];
  valid(
    Object.keys(event).length === fields.length && fields.every((key) => Object.hasOwn(event, key)),
  );
  assertIdempotencyKey(event.event_key);
  for (const key of ['actor_id', 'trace_id', 'subject_id']) text(event[key]);
  valid(
    typeof event.action === 'string' &&
      /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(event.action) &&
      event.action.length <= 64,
  );
  if (event.operation_id !== null) parseObjectId(event.operation_id, 'operation');
  for (const key of ['from_state', 'to_state'])
    valid(event[key] === null || /^[A-Z][A-Z_]{0,63}$/.test(event[key]));
  valid(
    event.failure_class === null ||
      Object.hasOwn(ERROR_TAXONOMY, event.failure_class) ||
      Object.values(ERROR_TAXONOMY).some((entry) => entry.failure_class === event.failure_class),
  );
  valid(
    event.bindings &&
      typeof event.bindings === 'object' &&
      !Array.isArray(event.bindings) &&
      Object.keys(event.bindings).length <= 32,
  );
  // Audit bindings carry identities, not provider responses, prompts or secrets.
  for (const [key, value] of Object.entries(event.bindings)) {
    valid(/^[a-z][a-z0-9_]{0,63}$/.test(key));
    if (typeof value === 'string' && value.startsWith('sha256:')) parseDigest(value);
    else gitOid(value);
  }
  return event;
}

export async function verifyAuditEntry(input, scopeInput) {
  const entry = copyJsonData(input),
    scope = coordinationScope(scopeInput);
  assertSchemaVersion(entry);
  valid(
    entry.retention_class === 'CANONICAL' &&
      Number.isSafeInteger(entry.sequence) &&
      entry.sequence > 0,
  );
  valid(entry.scope_digest === (await coordinationKey(scope)), 'INTEGRITY_MISMATCH');
  valid(Number.isSafeInteger(entry.occurred_at_ms) && entry.occurred_at_ms >= 0);
  if (entry.previous_digest !== null) parseDigest(entry.previous_digest, 'object-audit-entry');
  eventSnapshot(entry.event);
  const { id, digest, ...body } = entry;
  valid(
    digest === (await digestCanonical('object-audit-entry', body)) &&
      id === objectId('audit-entry', digest),
    'INTEGRITY_MISMATCH',
  );
  return entry;
}

/** Caller passes its active transaction: audit failure aborts the metadata change. */
export async function appendAudit(tx, scopeInput, input, now = Date.now) {
  const scope = coordinationScope(scopeInput),
    event = eventSnapshot(input);
  valid(
    typeof tx?.get === 'function' && typeof tx?.put === 'function' && typeof now === 'function',
  );
  const { trace_id, ...binding } = event;
  text(trace_id);
  const request_digest = await digestCanonical('audit-request', binding);
  const lookup =
    'audit-event:' +
    (await digestCanonical('audit-key', { action: event.action, key: event.event_key }));
  const existing = await tx.get(lookup);
  if (existing) {
    valid(existing.request_digest === request_digest, 'IDEMPOTENCY_CONFLICT');
    const entry = await verifyAuditEntry(await tx.get('audit-entry:' + existing.sequence), scope);
    valid(entry.digest === existing.digest, 'INTEGRITY_MISMATCH');
    return entry;
  }
  const head = await tx.get('audit-head');
  if (head) {
    const last = await verifyAuditEntry(await tx.get('audit-entry:' + head.sequence), scope);
    valid(last.digest === head.digest, 'INTEGRITY_MISMATCH');
  }
  const occurred_at_ms = now();
  valid(Number.isSafeInteger(occurred_at_ms) && occurred_at_ms >= 0);
  const sequence = (head?.sequence ?? 0) + 1;
  valid(Number.isSafeInteger(sequence));
  const body = {
    schema_version: 1,
    scope_digest: await coordinationKey(scope),
    sequence,
    previous_digest: head?.digest ?? null,
    occurred_at_ms,
    event,
    retention_class: 'CANONICAL',
  };
  const digest = await digestCanonical('object-audit-entry', body);
  const entry = { ...body, digest, id: objectId('audit-entry', digest) };
  await tx.put('audit-entry:' + sequence, entry);
  await tx.put(lookup, { schema_version: 1, request_digest, sequence, digest });
  await tx.put('audit-head', { schema_version: 1, sequence, digest });
  return entry;
}

export class AuditStream {
  constructor({ store, authorize, max_page_size }) {
    valid(
      typeof store?.transaction === 'function' &&
        typeof authorize === 'function' &&
        Number.isSafeInteger(max_page_size) &&
        max_page_size > 0,
    );
    Object.assign(this, { store, authorize, max_page_size });
  }

  async read(scopeInput, cursorInput, principalInput) {
    const scope = coordinationScope(scopeInput),
      principal = copyJsonData(principalInput),
      cursor = copyJsonData(cursorInput);
    assertSchemaVersion(cursor);
    valid(
      Object.keys(cursor).length === 4 &&
        Number.isSafeInteger(cursor.after) &&
        cursor.after >= 0 &&
        Number.isSafeInteger(cursor.limit) &&
        cursor.limit > 0 &&
        cursor.limit <= this.max_page_size,
    );
    if (cursor.after === 0) valid(cursor.expected_digest === null);
    else parseDigest(cursor.expected_digest, 'object-audit-entry');
    valid(
      principal?.tenant_id === scope.tenant_id &&
        (await this.authorize(principal, { ...scope, action: 'audit.read' })) === true,
      'FORBIDDEN',
    );
    return this.store.transaction(scope, async (tx) => {
      valid(
        (await this.authorize(principal, { ...scope, action: 'audit.read' })) === true,
        'FORBIDDEN',
      );
      const head = await tx.get('audit-head');
      valid(cursor.after <= (head?.sequence ?? 0), 'CONFLICT');
      let previous = cursor.expected_digest;
      if (cursor.after > 0) {
        const anchor = await verifyAuditEntry(await tx.get('audit-entry:' + cursor.after), scope);
        valid(anchor.digest === previous, 'INTEGRITY_MISMATCH');
      }
      const entries = [];
      const end = Math.min(head?.sequence ?? 0, cursor.after + cursor.limit);
      for (let sequence = cursor.after + 1; sequence <= end; sequence++) {
        const entry = await verifyAuditEntry(await tx.get('audit-entry:' + sequence), scope);
        valid(
          entry.sequence === sequence && entry.previous_digest === previous,
          'INTEGRITY_MISMATCH',
        );
        entries.push(entry);
        previous = entry.digest;
      }
      if (head && end === head.sequence) valid(previous === head.digest, 'INTEGRITY_MISMATCH');
      return {
        schema_version: 1,
        entries,
        cursor: { schema_version: 1, after: end, expected_digest: previous, limit: cursor.limit },
        head: head ?? null,
      };
    });
  }
}
