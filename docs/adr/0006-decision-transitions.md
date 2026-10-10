# ADR 0006: Decision transitions and review eligibility

Status: Accepted for T012.

Decision transitions are pure, immutable snapshots. Coordination persistence, authenticated actors, idempotent writes and canonical Git CAS remain their later tasks. The caller supplies the current authoritative basis; this module does not establish authority from request data.

Basis identity includes every DecisionBasis field except its self digest. T011 normalizes candidate and evidence sets before deterministic CBOR hashing. Every transition verifies the supplied digest against those fields. A copied digest cannot conceal changed candidates, evidence, policy, effects, refs or analysis status.

The trusted PolicyEvaluator uses `required_analysis(subject, effects)` to return required status keys and `can_resolve(basis)` to check exact-state evidence and policy eligibility. Every required key must exist and be COMPLETE. Resolution checks the latest basis, the reviewed digest and policy again. Producer booleans cannot replace these application dependencies.

ConditionalReview is a schema-versioned record of the original Decision, basis, reviewed delta and ordered predicate IDs. The delta uses the `reviewed-delta` digest domain; another object's digest cannot substitute for it. Predicate order is the declared evaluation order. Its basis binds reviewed candidates and material effects. Late non-material evidence requires an explicit allowance, defaulting to false. Trusted, machine-checkable code classifies every addition and evaluates every declared predicate; missing or uncertain results make the Decision STALE. Removed evidence or changed material fields also makes it STALE.

Preservation retains the historical review and separately returns its eligible current basis digest. The old digest still cannot resolve. A RESOLVABLE Decision must satisfy policy again after preservation; failure makes it STALE rather than introducing a downgrade transition. Forward-port exceptions remain T083.

Tests cover legal and forbidden transitions, missing/incomplete analysis, all material basis fields, candidate substitution, conditional predicates and additive evidence. No architecture assumption changed.
