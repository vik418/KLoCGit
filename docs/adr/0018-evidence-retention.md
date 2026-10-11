# Evidence payload retention

Status: accepted.

Payload content is immutable. Scoped authoritative metadata records its retention class, storage generation, lifecycle and decision references. Temporary/rebuildable data expires under explicit TTL policy; decision records and canonical data remain protected. A higher retention class cannot be downgraded by a duplicate write.

Pinning verifies both payload identity and its exact storage reference. Deletion is prepared durably before object storage changes. An ambiguous response leaves deletion unresolved and blocks new references until an idempotent retry reconciles it. Recreated payloads receive a new storage generation, so delayed deletion retries cannot affect them.

Nine SQLite/filesystem tests cover expiration, retention upgrades, restart, corruption, authorization, pinned references, ambiguous deletion and recreation races. Production retention periods and lifecycle scheduling remain explicit configuration work.
