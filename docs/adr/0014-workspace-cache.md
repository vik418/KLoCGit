# Workspace caching

Status: accepted for process-local caching. Persistent storage and production defaults remain open under D009.

Object caching is optional. A configured cache has explicit payload-byte, entry and TTL limits. Least-recently-used objects are evicted; oversized objects bypass the cache. Every hit is checked against the requested Git OID before use. Cache loss causes another provider read and cannot change source identity.

Native acquisitions and materialized Candidates have explicit capacity limits. Capacity exhaustion returns a retryable error rather than evicting an active workspace. The job owner closes acquisitions and releases Candidates. These resources contain no authoritative coordination state.

Native ArtifactFS tests show zero provider payload transfer for a warm targeted read and renewed exact-object transfer after clearing the cache. Rematerialization after local Candidate loss produces the same Candidate digest. These measurements do not establish network savings, production TTLs or persistent-cache value; T122 supplies broader measurements.
