# KLoCGit v1 Ordered Task Backlog

Complete in dependency order. Do not skip acceptance criteria.

## Progress

- T000: COMPLETE. [Passing verification](https://github.com/vik418/KLoCGit/actions/runs/37960093987) on `c72610ce`.
- T001: COMPLETE. [Passing golden tests](https://github.com/vik418/KLoCGit/actions/runs/37966913365) on `efa41b72`.
- T010: COMPLETE. [Passing record tests](https://github.com/vik418/KLoCGit/actions/runs/37969107882) on `5184798a`.
- T011: COMPLETE. Local `npm run verify` passed 585 tests and browser/build checks on 2026-10-10. Node and Python matched all 13 encoding vectors.
- T012: COMPLETE. Local `npm run verify` passed 628 tests and browser/build checks on 2026-10-10. Node and Python matched all 14 encoding vectors.
- T020: COMPLETE. Local event tests verify byte bounds, claim-check integrity, transport substitution rejection and tenant-scoped storage calls on 2026-10-10. Threshold defaults remain open under D008.
- T021: COMPLETE. Local consumer tests cover restart, concurrent duplicates, out-of-order delivery, reconciliation, atomic rollback, idempotent external-effect recovery and bounded DLQ delivery on 2026-10-10.
- T022: COMPLETE. Local SQLite-backed tests verify restart persistence, atomic rollback, concurrent connections, guarded Decision transitions, scope separation and durable outbox recovery on 2026-10-10.
- T023: COMPLETE. Local workerd tests verify persisted runtime restart, concurrent writes, rollback and scope misrouting. [Load measurements](benchmarks/results/coordination-local.json) cover 512 requests at concurrency 1/4/16/64 over one/eight scopes, with zero request failures. Live deployment remains a release gate.
- T030: COMPLETE. Provider-independent contract tests exercise exact ref/tree reads, source identity, guarded writes and an external-push race against ordinary local Git. Substituted states and invalid write requests are rejected.
- T031: COMPLETE. Artifacts binding/transport contract tests use real Git objects to verify branch updates, force pushes, rebases, external pushes, annotated tags, immutable reads, tree modes and ambiguous CAS replies. Workspace hydration remains injected; live account verification remains a release gate.
- T032: COMPLETE. Real Git/SQLite tests cover duplicate delivery and restart, reordered events, delayed delivery, force pushes, rebases, unknown provenance and tenant/ref authorization. Ingestion rereads Git and preserves declared producer claims separately from observed state.
- T033: COMPLETE. Eighteen real Git/SQLite promotion tests cover stale basis/policy, required analysis, candidate substitution, concurrent resolutions, external-push races, idempotency binding and crash/restart recovery. Current authorization is rechecked after durable preparation. Ambiguous unchanged refs remain blocked; multi-repository acceptance belongs to its own coordination layer.
- T040: COMPLETE. Nine contract tests verify registered version/capability metadata, exact source identity, deterministic effects, explicit failures and policy blocking for required incomplete analysis. Plugins cannot silently change tier or claim complete analysis from partial capability.
- T041: COMPLETE. Seven real-Git tests cover exact path/blob changes, targeted manifest hydration, declared dependencies, security path hints, traversal budgets, unavailable observations and file/directory replacements. Incomplete traversal never establishes absence.
- T042: COMPLETE. Twenty-four structural tests cover ordered declarations, signatures, bodies, references, modules, whitespace, omitted source, parser failures and version limits. Parser nodes remain inside the adapter.
- T043: COMPLETE. Fourteen TypeScript/JavaScript compiler tests cover resolved types/references/calls, configuration, JSDoc, modules, hydrated dependencies, CommonJS loaders, version limits and incomplete analysis.
- T044: COMPLETE. Thirty-six CPython tests cover compiled lexical scopes, closures, imports, static calls, shadowing, compiler failures and unresolved/dynamic behavior. Producer code is never imported or executed.
- T045: COMPLETE. Real semantic/syntax fixtures and helper tests pass on Go 1.26.9 and 1.27.2. Build configurations, unavailable dependencies and dynamic dispatch retain explicit limits.
- T046: COMPLETE. Pinned Rust 1.90.0 compiler fixtures cover typed MIR, modules, generics, calls, editions, source/type failures and blocked build hooks. Coverage remains PARTIAL; required Rust analysis cannot authorize resolution.
- T047: COMPLETE. Scheduled compatibility CI covers each declared compiler version and executes actual compiler fixtures. CI provisions verified toolchains; missing compilers fail validation rather than skipping it.
- T050: COMPLETE. Six reduction tests verify exact-tree sharing, preserved origins, separate targets/bases, explicit acyclic supersession, deterministic CandidateSpec identity and substituted-plan rejection. Distinct trees are never discarded on effect similarity.
- T051: COMPLETE. Security override tests preserve dependency/build/CI/auth/IAM/schema/migration/secret effects regardless of non-critical hub thresholds. Hints cannot authorize mutation.
- T052: COMPLETE. Four indexing tests cover dense hyperedges, security bypass, scope separation, deterministic ordering, incomplete analysis and substituted payload rejection. A 1,000-member shared effect requires no pairwise expansion.
- T060: COMPLETE. Thirteen real-Git workspace tests cover blobless/targeted hydration, exact object verification, scoped raw-object access, source substitution, binary/missing objects, SHA-256 repositories, UTF-8 preservation and cache loss. Transfer counters describe their provider boundary.
- T053: COMPLETE. Six dominance tests verify trusted measured dimensions, preserved distinct Git states, inferred-score rejection, ties, bounded comparisons and immutable verification records.
- T054: COMPLETE. Seven reducer tests cover 1,000 distinct revisions, bounded CandidateSpecs, a lossless deferred frontier, security priority, target fairness, dependency closure/cycles, stale dependencies and verified checkable rejection. Deferred work remains unresolved.
- T055: COMPLETE. Four ranking tests verify immediate deterministic scheduling, complete priority permutations, provider failure/timeout, immutable inputs and stale-batch rejection. Ranking output remains INFERRED and cannot delete plans or authorize promotion.
- T061: COMPLETE. Four native FUSE tests verify pinned ArtifactFS acquisition without initial blobs, exact selected hydration, cold/warm payload counters, cache loss, source movement, scoped access and concurrent reads. Network framing/prefetch cost and live Cloudflare remain separate release measurements.
- T062: COMPLETE. Eleven real-Git tests cover whole-Future and commit composition, reproducibility, source immutability, lazy unchanged-file hydration, explicit conflicts, source/plan substitution, dependency eligibility, SHA-256, bounded work, multi-repository states and disposable workspace recovery. Candidate objects remain local; materialization does not establish behavioral correctness.
- T063: COMPLETE. Bounded byte/entry/TTL caching is optional and every hit is verified. Thirty-four focused tests cover cache loss, expiration, corruption, oversized objects, native acquisition limits, Candidate capacity and deterministic rematerialization. Active workspaces are not evicted; job owners explicitly release them. Production persistence/default policies remain open under D009.
- T070: COMPLETE. Nine Evidence tests verify immutable content identity; exact repository trees/commits; configuration, environment and evaluator-version matching; authenticated provenance; current policy; bounded provider results; mutation resistance and sanitized outages. Thirteen materialization tests also verify preserving the original isolated commit for exact-state CI reuse. Eligibility alone does not authorize promotion.
- T071: COMPLETE. Seven real-Git/Ed25519 tests verify exact-state CI reuse, composed-state rejection, immutable receipts, forged signatures, evaluator/recipe grants, tenant/actor/repository boundaries, cancelled/failed observations and historical Git reads. Publishers must use an independently controlled recipe and keep signing keys outside producer execution. Live CI publisher wiring remains a release gate.
- T072: COMPLETE. Six native Git/Linux tests verify isolated candidate execution, denied host credentials/files/network, bounded input/output/time, scoped and audited broker access, exact workspace identity and independently evaluated producer output. Cloudflare execution remains a release gate.
- T073: COMPLETE. Seven scheduling tests verify exact-state reuse before evaluation, current policy/configuration/environment/provenance checks, composed-state evaluation, bounded deferral, missing results and preserved conflicting observations. Only policy-listed checks run; the scheduling report grants no resolution authority.
- T074: COMPLETE. Nine SQLite/filesystem tests verify retention assignment, temporary/rebuildable expiration, protected decision/canonical records, reference pinning, monotonic retention upgrades, restart, authorization, corruption and ambiguous/delayed deletion recovery. Storage generations prevent old cleanup retries from deleting recreated payloads. Production periods and lifecycle scheduling remain explicit configuration work.
- T080: COMPLETE. Nine formulation tests verify discovered components, separate unrelated work, exact-state isolated/composed observations, required-analysis uncertainty, whole-Future versus commit selection, stable identities, mixed-baseline rejection and bounded dense/security hubs. Fifty-two focused lifecycle/index tests pass. The result remains reviewable; it grants no resolution authority.
- T081: COMPLETE. Eleven HTTP/Git/SQLite tests verify basis and canonical-ref conflicts, required PARTIAL blocking, authenticated scope, exact retained Evidence bindings, policy/authorization races, concurrent retries and restart. Thirty-eight focused resolution/retention/promotion tests pass. Resolution records the choice; Git promotion still requires its own current-policy CAS.
- T082: COMPLETE. Five compiler-backed tests verify independent static footprints, resolved dependency intersections, incomplete/missing capability, security override, bounded analysis, cross-repository uncertainty and payload substitution. DISJOINT is explicitly limited to registered static scope; runtime compatibility remains subject to rematerialization and exact-state checks.
- T083: COMPLETE. Six forward-port tests and thirteen real-Git materialization tests verify rematerialization on a moved base, unchanged reviewed delta, material-observation checks, exact-state Evidence scheduling, source integrity, policy/predicate changes and conservative staleness. Grouped alternatives require rediscovery. Preserved review retains its historical basis; the new Candidate/basis must still pass current resolution and CAS checks.
- T090: COMPLETE. Accepted-state builder tests verify deterministic multi-repository OIDs, canonical ordering of accepted decisions, immutable snapshots, invalid/symbolic OID rejection and substituted-state detection. Authorization and current Git observation remain service responsibilities.
- T091: COMPLETE. Release-contract tests retain provider-neutral ordering, compatibility, pre/postconditions and forward-only operations. Sequence order remains significant; constraints cannot be substituted or rebound to another SystemRevision. Five combined builder/verification tests pass.
- T092: COMPLETE. Five contract tests verify exact release bindings, current authorization/policy, scoped operation identity, immutable observations and UNKNOWN on unavailable observation. Deployment execution remains external; successful execution does not establish deployed state.
- T093: COMPLETE. Six Argo HTTP contract tests verify exact Git source mapping, project/namespace isolation, resource-version guards, operation-marker recovery, external edits and contradictory observations. Native constraints require an explicitly registered translator; unsupported constraints block submission. Live Argo execution remains a release gate.
- T094: COMPLETE. Four GitHub Actions HTTP tests verify full provider-neutral contract delivery, actual dispatch run identity, workflow/ref/operation binding and execution-state mapping. Three shared HTTP tests cover bounded payloads, authorization/rate failures, TLS/redirect handling and ambiguous effects. Timeout remains UNKNOWN; a green run alone does not verify deployed state. Live workflow enforcement remains a release gate.
- T095: COMPLETE. Eight SQLite/restart tests verify one-time dispatch preparation, ambiguous crash recovery, authenticated/versioned events, webhook-first observation, bounded exponential jitter, persisted provider limits, delayed-poll races and contradictory outcomes. Provider calls run outside coordination transactions; deployment never waits on canonical-ref coordination. Live provider outage exercise remains a release gate.
- T096: COMPLETE. Five Ed25519 tests verify registered exact-state observations, domain-separated signatures, object integrity, tenant/system/run/contract/OID bindings, required successful observation, current authorization and key retirement. A valid signature alone cannot establish that the observed state matches the authorized SystemRevision.
- T100: COMPLETE. Adversarial boundary tests reject foreign and spoofed identities before Git, coordination, claim-check, CI registry, evidence payload or deployment access. Existing signed-attestation and scoped-store tests cover proof identity and tenant/system partitioning. No tested foreign request disclosed data or performed an effect. Application routing remains subject to the release integration suite.
- T101: COMPLETE. Seven authorization tests verify exact agent capability scope, tenant/actor bindings, revocation/expiry, explicit system grants, authoritative identity mapping, bounded registry reads and sanitized failures. Conflicting scope aliases and wildcard permissions are rejected. Domain authorization remains independent of the OIDC provider.
- T102: COMPLETE. Twelve broker/native-sandbox tests verify resource and Candidate scope, denied origins, host-only read credentials, secret-purpose rejection, common-encoding screening, exact resource digests and bounded responses. A native process receives approved bytes without inheriting broker credentials. Credential screening does not claim to detect arbitrary encodings; process isolation remains the primary boundary.
- T103: COMPLETE. Forty-nine focused audit/decision/promotion/deployment tests pass. Policy and permission revisions, reviewed choices, prepared/final CAS outcomes and attestation verification commit with append-only scoped audit records. Tests cover restart, concurrent appenders, idempotency, tamper detection, bounded export, authorization and rollback on audit failure. Hash links detect changes against retained checkpoints; they do not provide an external signing anchor.
- T104: COMPLETE. Seventy-five focused security tests pass. Selected-Candidate policy rejects wrong subject/configuration/environment/evaluator, unverified or declared results and conflicting observations. A real-Git/SQLite resolution-to-CAS flow survives duplicate events without another write. Forged CI/deployment signatures remain rejected, and a different commit with the same tree cannot substitute for evaluated history. Promotion preserves and revalidates an already resolved choice.
- T110: COMPLETE. Five telemetry tests verify traced operation timing, lifecycle/queue latency, cold/warm bytes, coordinator wait/transaction duration, materialization percentiles, forward-port rates and explicitly estimated cost per accepted change. Observations and summaries are bounded and rebuildable; telemetry outages do not alter operation results. Production export and pipeline instrumentation remain application integration work. No SLOs or provider invoice claims are inferred from these tests.
- T111: COMPLETE. Thirteen retention tests verify explicit lifecycle settings, bounded sweep pages, project-defined long-term periods, pinned references, monotonic commitments, current authorization and storage-generation recovery. Catalog entries are hints and cannot authorize deletion. Cleanup preparation/completion commits with audit records. Scheduler wiring and production periods remain explicit deployment configuration.
- T112: COMPLETE. Twenty-six focused operations/resolution/deployment tests pass. A bounded, authenticated operational projection and read-only HTTP handler cover provider outages, queue/DLQ backlog, extractor failures, sandbox capacity, GitStore errors, deployment UNKNOWN and attestation mismatch. Runbooks preserve exact-state, CAS, idempotency and external-CD boundaries. Dashboard wiring and live recovery exercises remain release integration work.
- T120: COMPLETE. [Local metadata/event measurements](benchmarks/results/candidate-reduction-local.json) cover 10/100/1,000/10,000 Futures. CandidateSpecs remain within the 64-plan budget; all origin records and seeded security interactions survive. Duplicate and reordered events use verified bounded claim-check envelopes without irreversible effects. Negative controls detect lost origins, missing interactions and exceeded budgets. This characterizes indexing and scheduling, not semantic-conflict detection or running compositions.
- T121: COMPLETE. [Compiler measurements](benchmarks/results/extractors-local.json) contain 66 runs across TypeScript/JavaScript 6.0.3, CPython 3.12.14, Go 1.26.9/1.27.2 and Rust 1.90.0. The curated change-localization oracle reports precision/recall, explicit status, crashes, wall time and control-plane CPU; unchanged-state comparisons measure repeated analysis cost. Go formatting fingerprints produce measured false positives. Rust remains PARTIAL. Status expectations follow each published static scope; no behavioral completeness, production accuracy or release-update lag is inferred.
- T122: COMPLETE. [Local workspace measurements](benchmarks/results/workspaces-local.json) compare native ArtifactFS cold/warm reads with a conventional full fetch over 0.25/4/16 MiB binary fixtures. Selected reads hydrate nine blob bytes; warm application-cache reads transfer none. The smallest fixture favors full-fetch startup; larger fixtures favor partial hydration. Local composed Candidates reproduce after cache reuse without changing source refs/objects. Failure controls record unavailable native capability. OS caches, provider wire framing, historical Artifacts access and live Cloudflare performance remain outside this experiment.
- T123: COMPLETE. [Evidence reuse measurements](benchmarks/results/evidence-reuse-local.json) exercise actual Git compositions, denied-network Linux evaluation, independently observed results and Ed25519 CI receipts. Ten scheduling repetitions reuse both exact isolated states without another run; the novel composition receives its own evaluation, exposing a retry/charge interaction that passes alone and merges textually. Repeated failed Evidence is reused as an observation, never authorization. Subject/configuration/environment/evaluator matching remains enforced. Live CI and billed provider compute remain release measurements.
- T124: INCOMPLETE. The runnable comparison materializes seven real Git compositions and evaluates exact states in denied-network Linux execution. Repeated arms alternate order, preserve failures, report priority stability and leave source Git unchanged. The authenticated Ranker transport bounds payloads and propagates cancellation. A hosted workflow retains raw measurements; pull-request runs have no ranking credentials. Thirteen focused ranking tests pass. [Full verification on d668345](https://github.com/vik418/KLoCGit/actions/runs/38155617560) passes, including the compiler matrix. Missing/failed providers remain UNMEASURED. No live model comparison or scheduling benefit has been established; ranking remains disabled for the application.
- Next incomplete task: T124.
- All remaining tasks: INCOMPLETE.

Existing v0 behavior does not establish v1 completion. Task completion requires the tests and acceptance criteria below.

## Repository browser integration

Status: PARTIAL. Read-only source APIs and the shadcn browser expose exact-commit directories, text/raw views, branch/tag selection, first-parent history, parent commits, bounded counts and permalinks. Local Git tests cover SHA-1/SHA-256, access denial, provider substitution, ref movement and unchanged source objects. Browser verification covers authentication, keyboard focus and mobile layout. Artifacts binding behavior is contract-tested; live provider verification remains open. Editing, blame, syntax/symbol navigation, comparisons, archives and release management are incomplete. This surface does not establish enterprise GA or change the core task count.

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
