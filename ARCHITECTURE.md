# KLoCGit v1 Frozen Architecture

## 1. Product boundary

KLoCGit reduces concurrent human/agent implementations into a bounded set of materially distinct Candidates, evaluates exact states, surfaces Decisions, and records accepted multi-repository state.

Primary product metric:

Human attention required to safely reach accepted canonical state, without worse defect detection than the comparison workflow.

Native collaboration primitives are Candidate and Decision. PR/MR workflows are compatibility adapters.

## 2. Logical flow

```text
FutureRevision
-> effect/security analysis
-> candidate reduction
-> optional asynchronous ranking
-> CandidateSpec
-> local Candidate materialization
-> exact-state Evidence
-> Decision
-> SystemRevision + ReleaseConstraints
-> external CD
-> DeploymentAttestation / observed deployment state
```

This is a dependency order. Independent work may run concurrently.

## 3. Core objects

### FutureRevision

Immutable observation of a Future at exact Git refs/tree OIDs.

Required fields:

- id
- system_id
- repo_id
- ref
- commit_oid
- tree_oid
- parent_oids[]
- producer
- observed_at

### EffectSet

Versioned output from an Extractor.

- future_revision_id
- extractor_id
- extractor_version
- capability: PATH | STRUCTURAL | SEMANTIC
- status: COMPLETE | PARTIAL | UNSUPPORTED | FAILED
- effects[]
- security_effects[]
- digest

material_effect_digest is SHA-256 over a deterministic encoding of a normalized EffectSet, not a semantic-equivalence hash.

Canonicalization rules:

- include schema version and domain separator
- exclude timestamps, trace IDs, runtime metrics, transient locations
- normalize identifiers according to the schema
- sort only set-like collections using documented stable keys
- preserve semantically ordered collections
- deterministic CBOR for hashed immutable objects
- cross-language golden test vectors are mandatory

### CandidateSpec

Composition plan before Git materialization.

- id
- base_revision
- selected_future_revisions[]
- selections[]
- required_dependencies[]
- effect_summary_digest
- creation_reason

### Candidate

Exact materialized Git state.

- id
- candidate_spec_id
- repo_tree_oids{}
- digest
- materialization_record

### Evidence

Immutable observation bound to exact state.

- id
- subject_digest
- type
- producer_identity
- producer_version
- config_digest
- environment_digest
- result
- payload_ref
- created_at
- retention_class

Reuse requires exact subject compatibility plus evaluator/config/environment/policy compatibility.

### DecisionBasis

- candidate_digests[]
- evidence_digests[]
- material_effect_digest
- policy_digest
- canonical_ref_oids{}
- required_analysis_status{}
- digest

### Decision

```text
DISCOVERED -> REVIEWABLE -> RESOLVABLE -> RESOLVED
REVIEWABLE/RESOLVABLE -> STALE
```

REVIEWABLE: human can inspect even if some analysis is PARTIAL.

RESOLVABLE: every policy-required capability and Evidence item is satisfied.

Conditional review may survive late non-material Evidence if Candidate digest, reviewed delta, material effects, and declared predicates remain valid.

### SystemRevision

Exact accepted multi-repository state.

- id
- repositories { repo_id -> exact_oid }
- configuration_digests{}
- accepted_decisions[]
- digest

### ReleaseConstraints

Constraints external CD must respect.

- system_revision_digest
- ordering_constraints[]
- compatibility_requirements[]
- preconditions[]
- postconditions[]
- forward_only_operations[]
- digest

KLoCGit does not execute rollback/rollout logic.

### DeploymentObservation / DeploymentAttestation

Observed deployment state is tracked independently from Git coordination.

```text
SUBMITTED -> RUNNING -> SUCCEEDED
                     -> FAILED
                     -> CANCELLED
                     -> UNKNOWN
```

Timeout/network ambiguity produces UNKNOWN, never inferred failure.

Attestation binds an observation to an identity and SystemRevision. It does not prove more than the observation method can establish.

## 4. Stable interfaces

```text
GitStore
  observe_ref(repo, ref) -> oid
  fetch(revision, filter) -> workspace source
  read_tree(oid)
  compare_and_swap_ref(ref, expected_oid, target_oid)

Extractor
  capabilities(language, version)
  analyze(base, revision) -> EffectSet

CandidateReducer
  reduce(revisions, effects, policy, budget) -> CandidateSpec[]

Ranker
  rank(candidate_specs, evidence_summary) -> priorities

Materializer
  materialize(candidate_spec, workspace) -> Candidate

EvidenceProvider
  find_reusable(subject_digest, requirements)
  evaluate(candidate, requirements) -> Evidence[]

PolicyEvaluator
  required_analysis(subject, effects)
  can_resolve(decision_basis)
  can_promote(system_revision, release_constraints)

DeploymentAdapter
  submit(system_revision, release_constraints)
  observe(external_run_id)

AttestationVerifier
  verify(attestation, authorized_system_revision)
```

## 5. Cloudflare mapping

- Workers: API, cheap validation, routing, ingestion.
- Durable Objects: scoped authoritative coordination. Persist correctness-critical state. Never depend on process memory for correctness.
- Queues: at-least-once asynchronous transport. Consumers are idempotent.
- GitStore: Cloudflare Artifacts is the first-party implementation for repositories within its supported limits. Larger/unsupported repositories require another GitStore implementation.
- ArtifactFS/partial hydration: preferred workspace source for Artifacts-backed repositories. It reduces full-clone cost but does not remove cold I/O.
- Sandbox/Containers: untrusted analysis and targeted evaluation. No canonical credentials. Network denied by default and selectively brokered.
- R2/ObjectStore: large Evidence payloads, logs, attestations, and rebuildable artifacts. Apply policy-driven retention classes.
- Clef-flash or another model: optional asynchronous ranking only. Progress and correctness must not depend on it.

## 6. Candidate reduction

Order:

```text
exact duplicates
-> policy-invalid candidates
-> superseded revisions
-> security override
-> non-critical hub suppression
-> alternative clustering
-> deterministic dominance
-> preserve materially distinct approaches
-> enforce compute budget
-> optional asynchronous ranking
```

Security-sensitive dependency/build/CI/auth/IAM/schema/migration/secret effects bypass hub suppression.

Probabilistic scores may reorder analysis. They cannot be sole grounds for irreversible pruning.

## 7. Extractor model

Tiers:

- Tier 0: Git/path/manifest level
- Tier 1: parser/structure
- Tier 2: semantic/compiler/LSP

Initial semantic plugin targets: TypeScript/JavaScript, Python, Go, Rust.

Every plugin reports supported toolchain versions and capability status. If policy requires semantic capability and the plugin is PARTIAL, FAILED, or UNSUPPORTED, the Decision cannot become RESOLVABLE.

## 8. Candidate materialization

Do not persist speculative Candidate Git trees to the durable GitStore.

```text
workspace source / reusable cache
-> partial/blobless hydration
-> local Git composition
-> hydrate required blobs
-> targeted evaluation
```

Cold I/O remains measurable and must be benchmarked.

## 9. Evidence rules

```text
isolated Future exact state
-> external CI may be reusable

novel composed Candidate
-> existing Evidence only if exact subject state matches
-> otherwise run exact-state EvidenceProvider
```

EvidenceProvider may be an internal Sandbox or external evaluator capable of evaluating the exact Candidate.

## 10. Forward-port and staleness

When canonical base changes:

```text
inspect intervening changes/effects
-> possible interaction or uncertainty: STALE
-> conservatively disjoint: rematerialize on new base
-> verify reviewed delta/material effects unchanged
-> preserve only still-valid review/evidence
-> rerun base-sensitive checks
```

Never mutate only the expected OID and pretend the Candidate is unchanged.

## 11. Event transport

Events are bounded envelopes, not arbitrary object transport.

- event_id
- schema_version
- type
- tenant_id
- system_id
- objective_id
- subject_id
- subject_version
- occurred_at
- trace_id
- payload | payload_ref + payload_digest

Small bounded payloads may be inline. Unbounded/large structures use claim-check storage. Consumers verify digest before use.

A DLQ is required. Duplicate/out-of-order delivery is normal.

## 12. Deployment reconciliation

External CD owns execution and recovery.

KLoCGit:

- submits SystemRevision + ReleaseConstraints
- records external run identity
- consumes webhook/event status where available
- polls only as fallback
- uses exponential backoff, jitter, rate limits, and per-provider concurrency caps
- classifies ambiguous timeout as UNKNOWN
- verifies attestation/observed state against the authorized SystemRevision

Deployment tracking must not hold a canonical-ref coordinator lock.

## 13. Retention classes

```text
EPHEMERAL
  temporary execution logs / temporary artifacts
  -> short policy TTL

REBUILDABLE
  indexes / caches / derived effect payloads
  -> TTL or regenerate

DECISION_RECORD
  evidence required to justify material decisions
  -> project/compliance retention

CANONICAL
  SystemRevision / authorization / required audit checkpoints / required attestations
  -> pinned or long-term policy
```

## 14. Security invariants

- Git history/ref integrity cannot depend on KLoCGit metadata availability.
- AI cannot authorize canonical mutation.
- CAS is mandatory for canonical Git mutation.
- Reviewed/authorized state must match promoted state.
- Required incomplete analysis blocks resolution.
- Producer claims do not satisfy trusted Evidence requirements.
- No canonical credentials inside untrusted execution.
- Network is deny-by-default for untrusted execution.
- Every irreversible operation is idempotent.
- Derived indexes/projections are never authoritative.
- Tenant authorization applies at every resource boundary.
- Security-sensitive effects bypass reduction heuristics.
