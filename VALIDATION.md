# KLoCGit v1 Validation and Falsification

## Principle

The architecture is a set of hypotheses constrained by invariants. Tests must be able to prove a hypothesis wrong.

## H1 - Candidate reduction remains bounded

Measure:

- raw Futures
- interaction candidates
- CandidateSpecs
- materialized Candidates
- compute/Future
- missed seeded high-severity interactions

Falsified if realistic workloads repeatedly approach pairwise/powerset expansion or lose high-severity interactions.

## H2 - Effect extraction is maintainable

Measure per language/toolchain:

- precision/recall against fixtures
- PARTIAL/FAILED/UNSUPPORTED rate
- crash rate
- incremental latency/cost
- update lag after supported language releases

Falsified if supported projects regularly fall to Tier 0 or maintenance cost makes declared support impractical.

## H3 - Partial hydration materially reduces workspace cost

Measure cold/warm:

- bytes transferred
- time to usable workspace
- Candidate materialization latency
- cache hit rate
- hydration failures

Falsified if target workloads see little benefit versus conventional fetch/clone.

## H4 - Evidence reuse avoids unnecessary CI duplication

Measure:

- isolated Future Evidence reuse rate
- composed Candidate exact-state cache miss rate
- new evaluation compute

Falsified if KLoCGit reproduces most existing CI even for isolated exact states.

## H5 - Optional ranking improves scheduling

A/B:

- deterministic scheduler
- deterministic + Ranker

Measure:

- high-risk recall at equal compute budget
- time to useful Evidence
- compute saved
- ranking stability

If benefit is insignificant, disable Ranker. Correctness must be unchanged.

## H6 - Selective forward-port reduces staleness safely

Measure:

- canonical-base movements
- forward-port attempts
- successful preserved reviews
- forced STALE rate
- post-forward-port failures

Falsified if either almost everything becomes STALE or unsafe forward-ports appear.

## H7 - KLoCGit reduces human attention

Compare: A. PR/MR B. PR/MR + AI review C. KLoCGit

Measure:

- reviewer minutes
- code inspected
- context switches
- decisions/questions
- integration rework
- missed defects
- time to accepted canonical state

Core product hypothesis fails if KLoCGit does not reduce human effort without worse defect detection.

## Security release criteria

Required:

- 0 unauthorized canonical promotions
- 0 successful stale-basis promotions
- 0 Candidate substitutions
- 0 successful cross-tenant disclosures in release suite
- 0 reuse of ineligible Evidence for authorization
- 0 canonical credentials in untrusted execution
- required incomplete semantic analysis always blocks resolution
- duplicate/out-of-order events do not duplicate irreversible actions
- forged DeploymentAttestation cannot satisfy observed-state verification

## Operational release criteria

Must demonstrate:

- bounded queue payloads and working DLQ
- reconciliation backoff/jitter under external CD outage
- no coordinator lock held while awaiting deployment
- hot-object/coordinator load characterized
- cold/warm workspace behavior characterized
- retention lifecycle tested
- extractor compatibility matrix automated
- recovery runbooks exercised

## v1 complete

v1 is complete when:

- Real repositories pass the complete pipeline without fixture-coded Decisions.
- Canonical mutation is protected by current basis + policy + CAS.
- Required PARTIAL analysis cannot authorize resolution/promotion.
- Candidate reduction stays bounded while retaining seeded high-severity interactions.
- Speculative Candidate trees require no durable Git write.
- Exact-state external CI Evidence is reused where eligible.
- Composed Candidates receive exact-state evaluation.
- Selective forward-port preserves review only when the reviewed change remains materially unchanged.
- SystemRevision + ReleaseConstraints work through two external CD integrations.
- Deployment reconciliation handles success, failure, cancellation, timeout/UNKNOWN and contradictory observation.
- Attestation is verified against the authorized SystemRevision.
- Security and recovery criteria above pass.
- Human-attention experiment supports the product hypothesis.

If a foundational hypothesis fails, record the evidence and reopen only the smallest affected architecture decision.
