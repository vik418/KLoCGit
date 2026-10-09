# KLoCGit v1 Ordered Task Backlog

Complete in dependency order. Do not skip acceptance criteria.

## Progress

- T000: COMPLETE. [Passing verification](https://github.com/vik418/KLoCGit/actions/runs/37960093987) on `c72610ce`.
- T001: COMPLETE. [Passing golden tests](https://github.com/vik418/KLoCGit/actions/runs/37966913365) on `efa41b72`.
- T010: COMPLETE. [Passing record tests](https://github.com/vik418/KLoCGit/actions/runs/37969107882) on `5184798a`.
- Next incomplete task: T011.
- All remaining tasks: INCOMPLETE.

Existing v0 behavior does not establish v1 completion. Task completion requires the tests and acceptance criteria below.

## M0 - Repository and engineering contract

### T000 - Initialize repository

Dependencies: none

Deliver:

- repository layout separating domain, adapters, API, workers, tests, benchmarks
- formatter/linter/test commands
- CI for unit/integration tests
- ADR directory
- config loading with environment validation

Acceptance:

- clean checkout can run all local checks with one command
- domain package has no Cloudflare SDK dependency

T000 validation on 2026-10-09: `npm run verify` passed 487 tests, browser smoke checks, formatting, lint, builds and Worker/executor dry runs. Domain dependency checks passed. ARCHITECTURE.md remained unchanged.

### T001 - Define schema/version conventions

Dependencies: T000

Deliver:

- ID format
- digest format: algorithm-tagged + domain-separated
- schema version convention
- error taxonomy
- idempotency-key convention

Acceptance:

- golden tests for IDs/digests/errors

## M1 - Domain state and deterministic identity

### T010 - Implement core domain types

Dependencies: T001

Implement: FutureRevision, EffectSet, CandidateSpec, Candidate, Evidence, DecisionBasis, Decision, SystemRevision, ReleaseConstraints, DeploymentObservation, DeploymentAttestation.

Acceptance:

- invalid state combinations rejected by constructors/validators
- serialization round-trip tests

### T011 - Implement canonical encoding and hashing

Dependencies: T010

Deliver:

- normalized EffectSet schema
- deterministic CBOR encoder for hashed immutable objects
- canonical ordering rules
- golden vectors

Acceptance:

- repeated encoding is byte-identical
- two supported language implementations, if present, produce identical golden digests
- timestamps/trace IDs do not affect material-effect digest

### T012 - Implement Decision state machine

Dependencies: T010, T011

Acceptance:

- PARTIAL can be REVIEWABLE but not RESOLVABLE when required
- stale basis cannot resolve
- conditional review survives only declared non-material changes

## M2 - Eventing and authoritative coordination

### T020 - Define event envelope

Dependencies: T001

Deliver bounded event envelope with inline-or-reference payload.

Acceptance:

- serializer refuses oversized inline event
- claim-check digest is verified before consumption

### T021 - Implement idempotent consumer framework

Dependencies: T020

Acceptance:

- duplicate event has no duplicate side effect
- out-of-order version is ignored/reconciled safely
- poison message reaches DLQ after configured retries

### T022 - Implement coordination store abstraction

Dependencies: T010, T021

Deliver authoritative per-Objective/per-ref coordination interface.

Acceptance:

- restart loses no correctness-critical state
- concurrent transitions obey state machine

### T023 - Cloudflare Durable Object adapter

Dependencies: T022

Acceptance:

- persisted state survives object restart/eviction simulation
- hot-key/load test produces measurable saturation data

## M3 - Git ingestion and promotion

### T030 - Implement GitStore interface

Dependencies: T001

Acceptance:

- provider-independent contract tests

### T031 - Implement Artifacts GitStore adapter

Dependencies: T030

Deliver observe/fetch/read/CAS behavior.

Acceptance:

- branch update, force push, rebase and external push are observed as new immutable revisions

### T032 - FutureRevision ingestion

Dependencies: T021, T031

Acceptance:

- duplicate/reordered provider events create no duplicate revisions
- Git is reread before authoritative conclusions

### T033 - CAS promotion

Dependencies: T012, T031

Acceptance:

- expected OID mismatch fails cleanly
- 0 stale-basis promotions in race tests
- retry never overwrites unrelated external push

## M4 - Extractor plugin system

### T040 - Extractor plugin contract

Dependencies: T010

Deliver capability/version metadata and COMPLETE|PARTIAL|UNSUPPORTED|FAILED results.

Acceptance:

- unsupported required capability blocks resolution

### T041 - Tier 0 extractor

Dependencies: T040

Deliver path, manifest, diff metadata and security-sensitive file/effect detection.

### T042 - Tier 1 structural extractor

Dependencies: T040

Use parser abstraction. Do not couple domain model to Tree-sitter APIs.

### T043-T046 - Semantic plugins

Dependencies: T040

Implement separately:

- T043 TypeScript/JavaScript
- T044 Python
- T045 Go
- T046 Rust

Each must publish supported toolchain versions and fixture coverage.

Acceptance per plugin:

- version matrix tests
- syntax/semantic fixture corpus
- failure returns explicit status, never silent downgrade

### T047 - Extractor compatibility CI

Dependencies: T043-T046

Deliver scheduled test matrix against supported language/toolchain versions.

## M5 - Candidate reduction

### T050 - Exact duplicate and supersession reduction

Dependencies: T010, T040

Acceptance:

- exact duplicates collapse deterministically
- superseded revision does not survive as an equal alternative

### T051 - Security override

Dependencies: T041

Acceptance:

- dependency/build/CI/auth/IAM/schema/migration/secret effects bypass suppression

### T052 - Effect clustering and hub suppression

Dependencies: T041, T042

Acceptance:

- common non-critical effects do not generate pairwise explosion
- high-risk shared effects are never suppressed

### T053 - Deterministic dominance

Dependencies: T050-T052

Use only measured/deterministic dimensions for irreversible pruning.

Acceptance:

- probabilistic score alone cannot delete a unique CandidateSpec

### T054 - Compute-density budget

Dependencies: T053

Acceptance:

- bounded CandidateSpec count under dense workloads
- preserves representative materially distinct approaches

### T055 - Optional Ranker adapter

Dependencies: T054

Asynchronous only.

Acceptance:

- disabling/failing Ranker changes priority only, not correctness/progress

## M6 - Candidate materialization and workspace I/O

### T060 - WorkspaceSource abstraction

Dependencies: T030

Support partial/blobless hydration and reusable cache hints.

### T061 - ArtifactFS-backed workspace

Dependencies: T031, T060

Acceptance:

- does not require full repo transfer for targeted workloads
- cold/warm bytes transferred are observable

### T062 - Local Materializer

Dependencies: T010, T060

Acceptance:

- Candidate exact tree is reproducible
- speculative Candidate requires no durable GitStore write
- textual conflict produces explicit materialization failure

### T063 - Workspace cache policy

Dependencies: T061, T062

Acceptance:

- cache is an optimization only
- cache loss cannot affect correctness

## M7 - Evidence

### T070 - EvidenceProvider interface and eligibility rules

Dependencies: T010

Acceptance:

- subject/config/environment mismatch prevents reuse

### T071 - External CI Evidence adapter

Dependencies: T070

Acceptance:

- isolated exact-state CI can be reused
- Future A Evidence cannot validate composed Candidate A+B

### T072 - Sandbox Evidence provider

Dependencies: T062, T070

Acceptance:

- no canonical credentials
- network denied by default
- brokered access is explicit/audited

### T073 - Evidence scheduling

Dependencies: T071, T072, T054

Acceptance:

- reuse matching Evidence first
- run missing/stale/composition-specific checks only
- full suite only by policy

### T074 - Evidence retention

Dependencies: T070

Acceptance:

- retention class assigned at creation
- deletion of EPHEMERAL/REBUILDABLE data cannot break canonical audit records

## M8 - Decision lifecycle and forward-port

### T080 - Decision formulation

Dependencies: T012, T073

Deliver material question, alternatives, relevant code slices, evidence, uncertainty.

### T081 - Resolve API with basis check

Dependencies: T080

Acceptance:

- stale basis returns conflict
- required PARTIAL capability blocks resolution

### T082 - Conservative intersection check

Dependencies: T041-T046

Acceptance:

- uncertainty returns possible interaction, never disjoint

### T083 - Forward-port pipeline

Dependencies: T062, T073, T082

Flow:

```text
canonical base moved
inspect intervening effects
possible interaction -> STALE
conservatively disjoint -> rematerialize on new base
verify reviewed delta/material effects
preserve only still-valid reviews/Evidence
rerun base-sensitive checks
```

Acceptance:

- never updates only expected OID
- changed reviewed delta forces re-review

## M9 - SystemRevision and external CD boundary

### T090 - SystemRevision builder

Dependencies: T081

Acceptance:

- exact repository OIDs only
- deterministic digest

### T091 - ReleaseConstraints builder

Dependencies: T090

Acceptance:

- ordering, compatibility, pre/postconditions and forward-only operations represented without provider-specific syntax

### T092 - DeploymentAdapter interface

Dependencies: T091

Deliver submit/observe contract only. No rollout engine.

### T093-T094 - Two reference adapters

Dependencies: T092

Implement one GitOps-style and one conventional CI-style adapter selected by implementation decision/availability.

Acceptance:

- adapter translates contract without leaking provider types into domain model

### T095 - Deployment observation/reconciliation

Dependencies: T092

Rules:

- webhook/event first
- polling fallback only
- exponential backoff + jitter
- provider rate limit + concurrency cap
- timeout -> UNKNOWN
- deployment tracking never holds canonical-ref coordinator

### T096 - Attestation verification

Dependencies: T090, T095

Acceptance:

- observed state mismatch is explicit
- forged/wrong-system attestation rejected

## M10 - Security, tenancy, audit

### T100 - Tenant authorization boundary tests

Dependencies: M1-M9 relevant interfaces

Acceptance:

- 0 cross-tenant disclosures in adversarial tests

### T101 - Capability-scoped agent authorization

Acceptance:

- agent cannot exceed explicit resource/action scope

### T102 - Secret/network broker

Dependencies: T072

Acceptance:

- secrets do not enter sandbox environment/files/args unless explicitly allowed by a narrowly scoped broker operation

### T103 - Audit stream

Acceptance:

- privileged transitions, policy changes, decisions, CAS and attestation verification are auditable

### T104 - Replay/forgery tests

Acceptance:

- Evidence replay, event replay and attestation forgery do not authorize promotion

## M11 - Operations and observability

### T110 - Structured metrics/tracing

Measure at minimum:

- ingestion latency
- REVIEWABLE latency
- RESOLVABLE latency
- Candidate materialization p50/p95
- bytes hydrated cold/warm
- Evidence queue latency
- coordinator load
- forward-port success/stale rate
- cost per accepted change

### T111 - Retention lifecycle configuration

Dependencies: T074

### T112 - Failure dashboards/runbooks

Cover:

- provider outage
- queue backlog/DLQ
- extractor failure spike
- sandbox capacity
- GitStore limit/rate errors
- external CD UNKNOWN backlog
- attestation mismatch

## M12 - Validation and release

### T120 - Candidate reduction benchmark

Use 10, 100, 1,000, 10,000 Future metadata/event workloads including dense hubs and seeded interactions.

### T121 - Extractor benchmark

Measure precision/recall, crash/PARTIAL rate, version coverage, incremental cost.

### T122 - Workspace benchmark

Cold/warm repository tests, bytes transferred, hydration latency, cache hit rate.

### T123 - Evidence reuse benchmark

Measure isolated CI reuse and composed-state new-compute cost.

### T124 - Ranker A/B test

Deterministic scheduling vs deterministic + model ranking.

### T125 - Human-attention experiment

Compare: A. PR/MR B. PR/MR + AI review C. KLoCGit

### T126 - Security/recovery suite

Must include stale promotion, substitution, cross-tenant access, replay, sandbox exfiltration, extractor failure, external push races, forged attestation, deployment UNKNOWN recovery.

### T127 - v1 release review

Dependencies: T120-T126

Release only if VALIDATION.md completion criteria pass.
