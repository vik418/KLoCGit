# Evidence payload retention

Status: accepted.

Payload content is immutable. Scoped authoritative metadata records its retention class, storage generation, lifecycle and decision references. Temporary/rebuildable data requires an explicit TTL. Decision records and canonical data use project-defined long-term periods or remain pinned. References protect payloads regardless of TTL. Duplicate writes cannot lower a retention class or shorten an existing retention period.

Pinning verifies both payload identity and its exact storage reference. Deletion is prepared durably before object storage changes. An ambiguous response leaves deletion unresolved and blocks new references until an idempotent retry reconciles it. Recreated payloads receive a new storage generation, so delayed deletion retries cannot affect them.

Cleanup uses bounded catalog pages, then rereads authoritative metadata before deletion. Catalog loss delays cleanup; it cannot authorize deletion. Prepared and completed deletions commit with scoped audit records. SQLite/filesystem tests cover these boundaries, including restart, corruption, ambiguous deletion and recreation races. Operators configure periods, sweep interval and batch size explicitly.
