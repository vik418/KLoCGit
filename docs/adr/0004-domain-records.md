# ADR 0004: v1 domain record representation

Status: Accepted for T010.

The frozen architecture names the records and their required fields. This ADR fixes their JSON representation without changing their behavior or provider boundaries.

- Every top-level record requires schema_version 1. Constructors copy and deeply freeze plain data; unknown top-level fields are rejected. JSON persistence preserves data, including opaque map keys. Accessors, cycles, sparse arrays, custom prototypes, undefined, non-finite numbers, negative zero, unsafe integers and unpaired Unicode surrogates are rejected.
- IDs use the T001 object kinds: future-revision, candidate-spec, candidate, evidence, decision, system-revision, deployment-observation and deployment-attestation. System, repository and external producer identities remain opaque strings.
- EffectSet, DecisionBasis and ReleaseConstraints digests use effect-set, decision-basis and release-constraints domains. Material effects use material-effect. Candidate and SystemRevision ID/digest pairs must agree syntactically. Constructors do not recompute or authenticate content; deterministic CBOR and hashing belong to T011.
- CandidateSpec.base_revision references an immutable SystemRevision ID. Selected revisions and dependencies reference FutureRevision IDs. Ordered selections and materialization steps retain their original order.
- Git OIDs are full lowercase SHA-1 or SHA-256 values. Zero deletion sentinels are not existing state. A FutureRevision and each repository's canonical refs use one object format; different repositories may use different formats. Parent order is preserved.
- DecisionBasis.canonical_ref_oids is a map from repository ID to a map of full Git ref to exact OID. This avoids ambiguous compound keys.
- FutureRevision.producer is null for unknown provenance or a plain JSON record containing producer claims. Evidence identifies its evaluator. Neither form establishes trust.
- Timestamps use UTC ISO 8601 seconds or milliseconds. Invalid calendar dates and ambiguous local timestamps are rejected.
- Effects, security effects, selections and release-constraint entries are plain JSON records. Materialization records and resolution metadata retain arbitrary JSON data. Evidence.result accepts any supported JSON value. Their owning tasks add semantic validation; T010 does not infer compatibility, evidence eligibility or deployment behavior.
- A Decision snapshot contains id, state, basis and resolution. Only DISCOVERED permits a null basis. Unresolved snapshots require null resolution. RESOLVABLE and RESOLVED require at least one candidate and COMPLETE for every listed required analysis. RESOLVED identifies resolution.candidate_digest from that basis. These are snapshot checks, not policy completeness, current-basis verification or authorization.
- DeploymentObservation contains id, digest, system_revision_digest, external_run_id, status, observed_at and method. DeploymentAttestation contains id, digest, system_revision_digest, observation_digest, producer_identity, created_at and proof_ref. These references establish representation-level bindings. Reconciliation and attestation verification belong to T095 and T096.

Set ordering, normalized effects and canonical encoding remain T011. Decision transitions and conditional review remain T012. No architecture assumption was falsified.
