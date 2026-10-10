# ADR 0010: Durable Object coordination

Status: Accepted.

Each object binds one deterministic coordination scope in durable storage. Misrouting a different scope fails before record access. Domain transactions use Durable Object storage transactions and an input gate; correctness does not depend on an in-memory queue.

Transaction failures roll back before leaving the input gate. Routine rejected transitions do not escape `blockConcurrencyWhile`, because Cloudflare resets an object when that callback rejects.

Local `workerd` tests exercise runtime restart with persisted SQLite storage, concurrent writes, rollback and misrouting. The configurable benchmark records warm throughput and latency for one hot key and multiple scopes. These measurements characterize this local runtime, not production capacity or an SLO.
