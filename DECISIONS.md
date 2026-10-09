# Open Implementation Decisions

These are not architecture questions. Resolve with an ADR and evidence before depending on them broadly.

## D001 - Control-plane language/runtime

Evaluate:

- Cloudflare platform fit
- correctness/tooling
- latency/startup
- dependency maturity
- testability
- operational burden

Do not choose because of personal preference.

## D002 - Core composition/analysis implementation language

Evaluate representative Git composition, hashing, parser orchestration and sandbox workloads.

## D003 - Projection/query store

Authoritative state remains elsewhere. Choose only for read/query projections.

## D004 - Authorization provider

Must support tenant/resource/action authorization and service/agent identities. Domain authorization model must not depend on vendor-specific primitives.

## D005 - GitStore for repositories unsupported by Artifacts

Benchmark candidate backends for:

- Git protocol correctness
- CAS/ref mutation semantics
- large repo behavior
- partial fetch support
- rate limits
- deployment model
- cost

## D006 - Deterministic CBOR tooling

Requirements:

- RFC 8949 deterministic encoding
- maintained libraries for selected languages
- golden vectors
- schema evolution support

## D007 - External CD adapter protocol

Keep ReleaseConstraints provider-neutral. Provider adapters translate at the boundary.

## D008 - Claim-check inline threshold

Configure below provider message maximum with safety margin. Benchmark event size distribution before freezing a default.

## D009 - Workspace cache strategy

Correctness cannot depend on cache. Benchmark cold/warm behavior before choosing persistence/snapshot policy.

## D010 - Product SLOs

Do not invent. Establish after M12 measurements for ingestion, REVIEWABLE, RESOLVABLE, materialization, queue delay and recovery.
