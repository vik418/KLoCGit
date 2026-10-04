# Architecture and bounded guarantees

The browser calls an authenticated Worker. One Durable Object serializes coordination and canonical transitions per workspace. Git remains authoritative for code; the workspace aggregate holds immutable coordination inputs and mutable status. Native Artifacts pushes enter a Queue; accepted work schedules a separate analysis message. A trusted Container executor builds Git candidates, runs bounded platform-owned validation and performs normal Git writes.

Local development uses the same engine with ordinary bare repositories, a serialized Node HTTP coordinator and the host's isolated runner. The local v2 workspace starts in `.demo-v2/` with an unanswered cross-repository context question and zero coordinated producers.

## Invariants and their scope

- **I1 — immutable derivation:** Context sources/snapshots, revisions, implementations, relationships, compositions, evidence, decisions and audit entries use content hashes of canonical inputs. Records refer to immutable Git/configuration/policy versions. Evidence eligibility and operation status change separately. Storage remains an application-managed workspace aggregate; it does not independently enforce append-only database tables or signed audit roots.
- **I2 — safe advancement:** The basis covers graph/candidate membership, alternatives, relationships, contexts, assumptions, constraints, evidence identities/eligibility and observed heads. Resolution checks the submitted basis and expected target head, then uses actual old-OID Git CAS. Another repository can change after observation; this is not a multi-repository transaction.
- **I3 — machine-checkable automation:** Exact tree equivalence and bounded trusted check outcomes are deterministic. Human review chooses competing outcomes and resolves observed/unverified interactions. Declared producer choices and inferred hints never authorize autonomous canonical convergence. Candidate executable code runs only under isolation; producer tests do not establish trusted evidence.
- **I4 — epistemic integrity:** Policy sources are retrieved; user answers, producer alternatives and explicitly stated assumptions are declared; Git facts and provider counts are observed. Unresolved assumptions remain visibly unresolved. Missing provenance remains unknown. No aggregate confidence score is used.
- **I5 — bounded claims:** Evidence specifies exact subjects, checks, policy and runner versions. The normal/lost-response HTTP scenarios establish only their observed counts and amount/identity behavior. They do not establish global semantic correctness, production security or a complete sandbox audit.
- **I6 — Git failure floor:** Repositories retain ordinary Git storage and independently clone/fetch/push. Producer clones are isolated. Missing or corrupt coordination metadata does not trigger destructive repository recreation on startup. Explicit demo replay recreates only its disposable fixture.

## Context before coordinated production

The explicit `retry-response-v1` task reads a registered `payment-policy` source at an immutable commit before authorizing its producer. A supplied answer, reliably identified existing decision or single allowed checkable value can avoid clarification. Otherwise it asks one material retry question. The interactive answer stays pending until submitted; test actors do not answer for the actual user.

An answer or explicit assumption produces a versioned ContextSnapshot and authorization. The producer commits a context artifact and Git trailers. Ingestion verifies their binding to stored authorization. Changed source content invalidates the context; missing/forged bindings do not become authority. Ordinary unrelated Git work remains ingestible while the coordinated task waits. The compiler is one schema, not an arbitrary prose interpreter or general context retrieval system.

## Relationships, groups and candidates

Ingress filters costly comparisons by repository, path/tree identity and declared decision key. Shared trusted-suite footprints select interaction pairs. Exact trees share implementation identity without collapsing intent/provenance histories. Overlap alone remains unknown. Metadata declaring different choices for one decision key produces declared alternative edges, not inferred semantics.

A trusted interaction edge requires exact individually passing revisions and a cleanly composed tree failing the finite check. Connected unresolved alternative/conflict edges produce generic decision components. Unknown/compatible/equivalent/dependency edges do not join unrelated decisions. Bounded maximal consistent subsets generate options; exhausted budgets or unverified claims remain review work.

Independent checked revisions may accompany explicitly reviewed alternatives, which are rebuilt and validated as actual Git trees. Unknown executable work or unattached work counts as conventional review. Whole-tree duplicate identity is the only automatic implementation-equivalence claim. No LLM semantic analyzer is implemented.

This filters expensive comparisons but still scans metadata arrays. Subsystem/symbol/dependency inverted indexes and high-scale scheduling are unfinished. Absent graph edges are not evidence of global compatibility.

## Trusted executable application checks

The checkout fixture and policy repository are executable application/pinned context inputs. The real interaction is same-identity retry versus confirmation before replay detection: baseline/A/B yield one charge and confirmation, while clean A+B yields one charge and two confirmations in the lost-response case.

A platform-owned supervisor observes effects received by its external simulated HTTP provider. It suppresses one response only after processing. Candidate ledger, stdout and repository tests cannot supply provider counts. Read-only trees/runtime, private namespaces, scrubbed environment, Node permissions and resource limits bound execution. Unsafe entries are rejected before execution.

Unavailable isolation returns failing `validation-unavailable` evidence. There is no unsandboxed fallback. The host application suite passes; the default Docker sandbox's namespace probe fails and live Cloudflare Container namespace capability remains unverified.

## CAS journal and recovery

Native MRs are coordination records over exact Git branches and revisions. Their lifecycle, reviews, discussions, reported checks, policy and dependency declarations have immutable event histories. Producer CI reports remain declared; configured platform checks establish only their finite assertions. Canonical application rechecks every selected MR against the actual validated composition and includes MR/dependency versions in the reviewed basis.

Explicit single or batch reviews use the same candidate/evidence/decision protocol for MRs and standalone Git work. A queued authorization pins its exact composition, basis, evidence and expected head; changed inputs require renewed human review. Queue receipts require immutable request IDs, and recovery correlates exact internal ticket/attempt identifiers on both the decision and prepared operation. Later direct application cannot be misattributed to a queue attempt.

Dependency eligibility requires the declared source revision to remain an ancestor of current canonical Git and no recorded revert of its applied composition. Historical merged status alone is insufficient. Reverts retain inverse candidate commits against current canonical Git, validate them and present their scope for review before CAS. Unknown ancestry leaves observed merge status unresolved and blocks dependency authorization; it does not break workspace reads.

Persist an immutable decision and prepared operation before external Git CAS. Pin exact expected old head and target commit. Retain candidate Git objects; the remote executor pushes/observes candidate refs before a canonical operation can be prepared. After success, persist applied/deferred dispositions and an audit receipt.

An uncertain write blocks further advancement. Recovery compares authoritative Git to the exact prepared target, records a match without another push and preserves ambiguity otherwise. The Container gateway never retries a canonical request after forwarding it. A later analysis-enqueue failure does not misreport an already completed canonical update.

Only one repository advances per operation. Other heads are evidence/basis dependencies, not an atomic lock over external clients. Production dependency handling requires immutable pinned releases or an explicit recoverable multi-repository protocol.

## Live and production limits

Cloudflare code provides Artifacts reads/create/fork, native ingress/analysis queues, a workspace Durable Object and authenticated Container executor. Exact diffs are routed through that executor. Live account integration remains blocked by missing credentials. Worker/image build checks are not evidence of native delivery, Artifacts ref retention, remote lease races or deployed sandbox behavior.

Local identity is one fixed demo principal, optionally token-authenticated. Cloudflare has a configured owner identity and separate ingress/service credentials. Organizational multi-user identity, independent immutable storage enforcement, a general checkable-constraint language, broad evidence runners and a production CI fleet remain unfinished.

See the [detailed briefing](implementation-briefing.md), [Cloudflare setup](cloudflare.md) and [live acceptance status](live-cloudflare.md).
