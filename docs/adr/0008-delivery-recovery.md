# ADR 0008: Delivery receipts and effect recovery

Status: Accepted for T021.

The consumer prepares receipts, projections and an outbox in one atomic storage transaction. External execution happens after commit. Each effect carries a tenant/resource/action-scoped T001 operation ID and a stable idempotency key. Executors must explicitly support idempotent execution and recheck their own authorization/preconditions. A receipt alone cannot make an arbitrary remote service exactly-once.

Versions gate each event type and subject within its objective scope. Older observations are ignored. Version gaps and distinct same-version observations require a trusted reconciliation callback; absence of that capability retries without applying the event. The callback must reread authoritative state. Application callbacks may update local transaction state and return effect plans, but must not perform external effects inside the transaction.

After the configured attempt count, failures are published as bounded DLQ events with closed, sanitized error records. Publication failures keep the original delivery retryable. Published poison events remain terminal until an explicit recovery creates new work. DLQ transport is at-least-once; duplicate DLQ envelopes retain the same event identity.

Tests exercise restart, concurrent duplicates, version gaps, transactional rollback, remote-success/local-crash recovery, poison messages and DLQ outages. Provider guarantees and live transport validation remain separate acceptance work.
