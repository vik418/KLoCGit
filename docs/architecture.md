# Architecture and guarantees

Browser → authenticated Worker → workspace Durable Object → immutable coordination records. Native Artifacts push events enter through a Queue. Expensive Git composition and platform-owned validation run in the trusted executor, separate from API event handling. Local development uses the same engine with ordinary bare Git repositories and a serialized HTTP coordinator.

## Invariants

- **I1:** Revision, context, implementation, relationship, evidence and decision IDs hash canonical serialized inputs. Immutable decisions are separate from mutable operation envelopes. Evidence refers to exact tree/configuration/constraint/dependency versions; derived eligibility changes without rewriting historical evidence. Audit records reference the previous immutable audit ID.
- **I2:** All application operations go through the workspace serialization gate. The basis covers candidate membership, shown alternatives, relationships, assumptions, constraint versions, evidence identities/eligibility and observed repository heads. The exact reviewed head is captured before persistence, then passed to an actual Git old-OID CAS.
- **I3:** Exact Git tree identity is machine-checkable; platform checks inspect data without executing producer scripts. Human resolution is required for architecture, unknown provenance included in review, assumptions, and semantic interactions. No inferred confidence authorizes Git advancement.
- **I4:** Producer intent is declared; Git facts and fixture results are observed; missing provenance is unknown. There is no aggregate confidence score. The demo's alternatives are declared scenarios, not inferred facts.
- **I5:** Evidence lists checks, subject trees and configuration; finite structural checks and a currency fixture do not establish global correctness.
- **I6:** Coordination never changes Git storage format or requires its service for ordinary Git operations. Producer clones remain isolated. Canonical Git repositories are independently cloneable.

## Canonical journal and recovery

Persist the immutable decision and a prepared operation before the external Git CAS. Pin the expected old head and target commit. After Git advancement, append an audit receipt and persist applied operation status. On startup, reconcile uncertain operations against the exact target head. An ambiguous outcome blocks further canonical transitions until reconciled. Recovery does not blindly repeat a push.

There is no multi-repository transaction. A decision chooses an applicable tree for one repository. Other repository heads are pinned evidence/basis inputs; they are checked when presenting and resolving a decision. External changes to another repository can still occur after the last observation. This is a known cross-repository race and cannot be eliminated by the workspace Durable Object. Production dependency policy needs immutable pinned dependency releases or an explicit recoverable multi-repository protocol.

## Scope indexing and convergence

Candidates are filtered by canonical repository and affected-path intersection before comparison. Identical complete trees can share one implementation while retaining separate proposal histories. Scope overlap is classified as unknown. The prototype does not use LLM semantic reasoning or equate textual merge success with compatibility. Path indexing is intentionally minimal; subsystem/symbol/dependency indexes remain future scale work.

The demo groups declared retry alternatives into one decision and the observed currency-contract interaction into another. Compatible work is included in reviewed compositions. Generic incoming work is preserved for conventional review; the prototype does not autonomously synthesize decision components for arbitrary semantics.

## Known prototype limits

Metadata is one durable aggregate per workspace rather than an indexed production database. The trusted validator is specific to the demonstrated checkout configuration; it does not provide a general CI scheduler or security scanner. A generic checkable-constraint rejection engine and optional context retrieval compiler are not implemented. Constraints participate in evidence and basis versioning; the demo's retry-budget constraint is enforced by platform code.

The local demo uses a named demo principal. Cloudflare uses a configured owner credential with a fixed authenticated identity; organizational multi-user identity is not implemented. Tokens are never embedded in provenance or browser build output. Live Cloudflare integration was not possible without account credentials and executor infrastructure.
