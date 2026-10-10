# ADR 0008: Delivery receipts and effect recovery

Status: Accepted.

The consumer prepares receipts, projections and an outbox in one atomic storage transaction. External execution happens after commit. Each effect carries a tenant/resource/action-scoped operation ID and a stable idempotency key. Executors must support idempotent execution and recheck authorization/preconditions. A receipt alone cannot make a remote service exactly-once.

Versions gate each event type and subject within its authoritative scope. Objective-free observations require a trusted ref-scope resolver. Older observations are ignored. Version gaps and distinct same-version observations require a trusted reconciliation callback; absence of that capability retries without applying the event. The callback must reread authoritative state. Application callbacks may update local transaction state and return effect plans, but must not perform external effects inside the transaction.

After the configured attempt count, the original bounded envelope is sent unchanged to the DLQ. Its versioned journal stores the attempt and sanitized failure. Quarantine stops new effects before publication; in-flight outcomes remain observations. Publication failures keep the delivery retryable. Published poison events remain terminal until explicit recovery creates new work. DLQ transport is at-least-once; duplicates retain the same event identity.

Tests exercise restart, concurrent duplicates, version gaps, transactional rollback, remote-success/local-crash recovery, poison messages and DLQ outages. Provider guarantees and live transport validation remain separate acceptance work.
