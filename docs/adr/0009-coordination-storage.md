# ADR 0009: Authoritative coordination storage

Status: Accepted.

The domain exposes scoped atomic transactions. Objective scopes carry an objective identity. Ref scopes carry separate repository and full-ref fields. Tenant, system, scope kind and resource participate in the deterministic scope key. Records are versioned immutable snapshots; transactions copy values on both sides of the adapter boundary.

Decision transitions and their authoritative reads share one transaction. Concurrent requests cannot repeat an edge or resolve a terminal stale Decision. Application services also require authorization, a current basis and Git CAS.

The local adapter uses Node's SQLite backend with WAL and full synchronization. SQLite provides process-independent transaction durability. A per-database local queue avoids blocking another connection in the same event loop. Neither the queue nor process memory is authoritative. Nested transactions fail explicitly. Paths and busy timeout are caller configuration.

SQLite provides local authoritative storage. Durable Objects provide Cloudflare storage. Tests cover persisted restart, rollback, concurrent writers, state transitions, scope separation and recovery of pending external effects.
