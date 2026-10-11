# ArtifactFS workspace acquisition

Status: Accepted

The adapter pins ArtifactFS to commit `2b87a48691ef4ae82d391b7bbe4976c06c7fadf7`.
It acquires the configured source ref with depth 1, requires the exact commit,
disables refresh, and verifies Git object bytes independently. A moved ref fails
fresh acquisition; it never substitutes the new head.

Each mount is private to the trusted hydration service. Evaluation receives a
separate local Candidate, not this writable mount or its Git transport. Inline
credentials are rejected. Missing FUSE support is an explicit capability failure.

Acquisition counters describe locally acquired object payloads before mounting.
Workspace counters describe exact payloads delivered into the workspace cache.
Neither claims network wire bytes or accounts for background prefetch. Cold/warm
network cost remains a separate benchmark.

Native FUSE tests cover blobless acquisition, selected hydration, warm reuse,
cache loss, exact source binding, concurrent reads and ref movement. Cache policy
is independent of source identity.
