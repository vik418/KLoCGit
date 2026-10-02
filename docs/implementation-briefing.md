# Implementation briefing

Converge is a deterministic prototype of the decision-centric Git model. It demonstrates real Git ingestion, immutable coordination records, composed candidates, versioned evidence, reviewed decision bases, and conditional canonical advancement. The browser is now intentionally small: a summary line, one navigation row, and the decisions that need attention.

This briefing distinguishes functioning local behavior, Cloudflare integration code, scripted demonstration behavior, and work still needed. The complete specification has not yet been implemented or verified on live infrastructure.

## Why the interface was simplified

The original interface presented four metric tiles, a sidebar, duplicate navigation tabs, a convergence diagram, repository-head panels, producer avatars and included-work details alongside the decisions. That made the default screen behave like an operations dashboard. The primary job is to choose an outcome, so the extra framing created avoidable reading.

The revised screen removes the sidebar, dashboard tiles, duplicate navigation, convergence diagram and producer stack. It shows the workspace, the count of proposals and pending decisions, and the decisions themselves. Each card has the question, the reason judgment is needed, the scope, evidence/staleness status, and one Review decision action.

Alternatives are shown inside the decision. Rationale, included work and material assumptions remain visible because they affect the choice. Technical hashes, constraint versions and Git destination are behind a collapsed Technical review details disclosure. Metrics and canonical heads are behind Workspace details on the Proposals view. Evidence and Activity remain available through the single navigation row. The source stylesheet was reduced from roughly 40 KB to roughly 20 KB of built CSS rather than retaining the removed dashboard styling.

The safety behavior did not change: stale decisions still require a refresh and renewed review, validation still refers to exact trees, and canonical writes still use Git's expected-old-head check.

## Deliverable and source map

The project is in `/workspace/decision-git`. It uses React for the browser, Vite for local development and browser builds, Node for the local HTTP/Git executor, and Cloudflare Worker code for the production API path. It introduces no coding agent, Git storage format, IDE, or complete repository-hosting UI.

| File | Responsibility |
|---|---|
| `core/hash.mjs` | Stable sorted serialization, SHA-256 identifiers, immutable record creation, domain errors |
| `core/engine.mjs` | Ingestion, revision identity, relationships, evidence eligibility, compositions, decision bases, canonical transitions, recovery, workspace views |
| `server/git.mjs` | Real local Git commands and platform-owned fixture checks |
| `server/local.mjs` | Local HTTP API, explicit demo actor, serialized operations, JSON persistence, Vite integration |
| `server/bridge.mjs` | Authenticated remote Git execution bridge, scoped credential selectors and lease-protected push |
| `worker/artifacts.mjs` | Artifacts binding reads, observed scope traversal, trusted executor calls |
| `worker/index.mjs` | Worker API authentication, Durable Object coordinator, repository create/register/fork, Queue ingestion |
| `scripts/demo.mjs` | Concurrent producer simulation, repository fixtures, eight proposals and two declared decision components |
| `scripts/verify-demo.mjs` | Bounded metric report, two resolutions, stale rejection, clone and Git integrity checks |
| `src/main.jsx` | Minimal decisions, alternatives, evidence, proposals, local diffs and activity |
| `src/style.css` | Responsive layout, readable typography, disclosures and dialog styling |
| `tests/acceptance.test.mjs` | Sixteen deterministic local acceptance tests |
| `tests/artifacts.test.mjs` | Four mocked Artifacts/Worker boundary tests |
| `wrangler.jsonc` | Worker assets, Artifacts, Durable Object migration and Queue consumer declarations |

## Local code path

`npm run dev` starts the local application at `http://localhost:5173`. On a fresh workspace it generates the demonstration. Metadata is stored in `.demo/state.json`. Saves write a temporary file and rename it into place. The local HTTP coordinator serializes operations through the engine's queue.

The local actor is explicitly `demo-owner`. This is a demonstration identity, not proof of a real signed-in human. Cross-origin browser mutations are rejected. The live Worker path requires a separately configured owner credential and actor identity.

The engine treats Git refs as the source of truth for code. Producer statements are metadata. Stopping the platform leaves the Git repositories usable; they are not served through a proprietary storage format.

## Immutable records and histories

The implementation separates logical proposals from immutable revisions. A proposal identifies a repository, producer repository and branch. A revision binds the proposal to the observed base commit, head commit, Git tree, affected paths, context version, and provenance state.

Revision and other record identifiers are hashes of canonical serialized inputs. Object keys are sorted before hashing. Newly created record objects are recursively frozen in memory. The code creates separate implementation records keyed by repository and complete Git tree, so different proposals can share an implementation without losing their separate intents or producer histories.

Intents and context snapshots are stored, but the context system is minimal. It captures supplied intent, constraint identifiers, observed repository heads and affected scope. It does not retrieve issues, documentation or historical specifications, identify equivalent capabilities through semantic reasoning, or run a clarification pipeline. Context items do not yet provide the full separately versioned ContextItem/Assumption lifecycle from the specification.

The persistence model is one workspace aggregate. The storage layer does not independently enforce append-only immutable tables. Records reloaded from JSON are ordinary JavaScript objects; immutability is preserved through application behavior, not an external database guarantee. Audit hashes help expose changes to a chain, but there is no signed external audit anchor.

## Git ingestion and version gating

A push event supplies a repository, ref and immutable head. The engine resolves the current ref through the Git adapter before accepting it as the active version. If the event's head differs from the authoritative ref, it is treated as out of order. Delivery timestamps never establish freshness.

Immutable event-input hashing makes repeat delivery idempotent. Duplicate processing returns the existing revision receipt and reconciles the active ref pointer when appropriate. Force-pushes and rebases create new revisions, retaining historical revisions and their relationships. Returning a branch from A to B to A restores the observed active pointer without erasing the intermediate revision.

Missing provenance is accepted as `unknown`. It does not block ingestion. Producer statements are labeled declared or inferred; commit/tree/path facts are observed. Events for a canonical branch update the observed canonical state rather than creating a new producer proposal.

Forked producer repositories are mapped back to the approved canonical repository. This mapping participates in ingestion identity, preventing identical branch names in different forks from silently sharing one logical proposal.

The implementation currently uses a fixed registered repository baseline for affected-scope comparison. It does not provide a general evolving merge-base/context compiler for arbitrary histories, nor complete handling of all Git event types such as branch deletion.

## Deterministic relationships and actual compositions

Exact complete-tree identity establishes implementation equivalence. It does not establish identical intent. Overlapping paths without exact equality produce an `unknown` relationship. No LLM analysis or confidence score authorizes a merge.

Before relationship comparisons, the engine filters by canonical repository and affected-path overlap, while retaining an exact-tree identity check. This saves comparisons in the fixture. It still scans arrays of revision metadata; it is not a production inverted index. Subsystem, symbol and dependency indexing have not been implemented.

An offered alternative is built as an actual Git candidate. The local adapter creates an isolated temporary clone, starts at the current canonical head, applies selected revision patches with Git's three-way support, writes the resulting tree, creates a candidate commit, and retains it under a candidate ref. Identical selected trees are applied once while their proposal revision identifiers remain in the composition history.

A textual merge conflict rejects composition. It cannot be turned into an applicable baseline fallback. A textual success still requires validation and, for the demonstrated architectural/semantic choices, a human decision.

Generic incoming changes do not automatically become intelligently grouped decisions. In the demo the two components are explicitly authored. The production API can accept owner-created decision components, then builds and checks their alternatives. Automatic discovery of arbitrary decision components is future work.

## Evidence and its precise claims

The current validator is platform-owned JavaScript. It reads JSON configuration and does not execute repository scripts, producer-supplied tests or generated code. It checks valid configuration, a retry-attempt range, explicit currency units, and a small cross-repository currency scenario.

An evidence record includes an exact subject reference, tree hash, validation configuration hash, result, source, timestamp, constraint identifiers, and pinned canonical heads. Cross-repository fixture evidence additionally records both subject trees.

Evidence records stay historical. Current eligibility is derived. A relevant pinned head change, configuration change or constraint-version change makes previous evidence stale. A newly added active constraint also changes eligibility; checking only removed constraint versions would have missed this case.

During resolution, evidence must be current and passing, identify the exact selected composition and resulting tree, and come from the platform-owned trusted-validation path. A producer's passing-test claim does not satisfy that requirement.

The checks establish only their stated scope. They do not prove general semantic correctness, payment correctness across all inputs, production performance, security, or compatibility across all dependencies. There is no general CI scheduler, sandboxed test execution fleet, security scan engine or arbitrary checkable-constraint interpreter. The demo retry constraint is enforced by fixture-specific platform code.

## Reviewed decision basis and canonical advancement

The decision basis hashes the component's revisions, active candidate membership in its scope, relevant relationship identifiers, active constraints, offered alternatives, evidence identifiers and eligibility, unresolved assumptions, and observed repository heads. Adding a relevant candidate or changing a constraint can therefore invalidate a previously reviewed basis.

Resolution re-reads canonical heads, recalculates the basis, and compares the submitted basis and expected canonical head. A mismatch returns `409 DECISION_STALE`. The UI offers a refresh that constructs new candidates and evidence before another decision can be applied.

After passing those checks, the engine creates an immutable decision recording the selected revisions, reviewed basis, observed head, rationale, actor and time. Operational status is stored separately. It persists a prepared operation with the exact expected head and target commit before calling Git.

The local adapter uses `git update-ref <ref> <new> <old>`. This is an actual conditional ref update. The expected old head is captured before asynchronous persistence, so an external push during persistence cannot cause the operation to adopt and overwrite the new head.

The remote bridge uses `git push --force-with-lease=<ref>:<expected>`. The Durable Object serializes platform work and checks metadata; Git's old-OID enforcement protects against external Git clients that bypass the platform. A Durable Object metadata check alone would not be enough.

Only one repository advances per resolution. Other repository heads are basis/evidence dependencies. An external writer can change another repository after the last observation; the implementation does not claim atomic multi-repository advancement. A stronger production dependency policy would need immutable dependency versions or an explicit recoverable protocol.

## Journal, audit and crash recovery

Each audit entry references the previous entry's immutable hash. The prepared operation pins a decision and target commit. After successful Git CAS, an applied receipt and canonical-updated audit record are persisted.

If the executor's outcome is uncertain, the operation is marked for recovery and further canonical transitions are blocked. Startup recovery checks the authoritative ref against the exact prepared target. An exact match is recorded as applied without pushing again. Any ambiguous state remains recovery-required. The implementation does not silently retry an uncertain irreversible write.

The tests simulate the critical crash window after Git advancement and before the final persistence receipt. This is a deterministic recovery test, not a live Cloudflare or process-kill durability experiment across all possible crash windows.

## Cloudflare implementation and the external executor

The Worker declares an Artifacts binding, a native push-event Queue consumer, browser assets and a workspace Durable Object. It includes repository create/register/fork operations and immutable commit/tree reads. Approved forks are mapped to their canonical repository for ingestion. Untrusted paths such as `__proto__` are handled with a null-prototype path map rather than ordinary object assignment.

Creation and registration are separate when a repository is empty: create returns the remote and an initial-commit requirement; a normal Git client seeds the repository before it can be registered with a canonical head.

The documented Artifacts read binding did not expose a verified conditional ref-write method. The implementation therefore routes expensive composition, validation and canonical push through a trusted Node Git executor. The Worker refuses canonical advancement without the executor, its service credential, and an exact validation configuration hash.

`server/bridge.mjs` contains the service code. It selects repository-scoped credentials by configured environment-variable names, never through producer metadata. The bridge performs normal authenticated Git operations and protects remote writes with an explicit lease. A container/gateway connecting that Node service to the Worker service binding remains to be provisioned.

No Cloudflare account resources were created or deployed. Live repository authentication, fork object access, native event delivery, service bindings, remote lease races and recovery remain untested. Wrangler's dry run proves bundling/configuration compatibility, not those live properties. Exact diffs work locally; the Worker currently has no production `/api/diff` route and the Artifacts adapter's diff path is deliberately unavailable.

## What the competition fixture actually demonstrates

The two repositories are real Git repositories named `checkout-api` and `storefront`. Their contents are JSON configuration and README files. There is no running checkout server or storefront application.

Five concurrent producer loops operate in isolated clones. Their names represent Atlas, Mira, Rowan, CI/reliability and an ordinary Git client. They are simulated producers, not separately running AI agents or a real external CI service.

They produce eight proposals: two request-ID implementations with identical complete trees, one metrics file, two retry alternatives, an API currency-unit change, a client-rounding change, and documentation with unknown provenance.

The first declared decision chooses a retry policy and includes request tracing and metrics in its checked composition. The second declared decision chooses client behavior while preserving the current API contract, or defers the behavior changes and applies documentation. Selecting an outcome can defer a proposal; resolving all components does not mean all proposal code is merged.

The semantic fixture shows a cleanly mergeable but incompatible currency contract: the client sends dollars while the changed API interprets cents, making a $10 input become 10 cents. Its limitation is significant: the API change is already unsafe against the baseline client, and the fixture does not evaluate the client `roundAt` field. It does not demonstrate two individually system-safe changes becoming unsafe only when combined. A stronger adversarial application fixture remains needed for that case.

Applying the first decision advances canonical state. Previously valid evidence becomes stale, and the second decision is rejected until refreshed. Both resulting repositories are cloned and checked with `git fsck` in the verification script.

## Verification and metrics

The test suite contains twenty tests: sixteen local Git/engine acceptance tests and four mocked Artifacts/Worker tests. It covers separate duplicate histories, bounded currency failure, unknown provenance, two resolutions and cloneability, stale heads/evidence, changed constraints, duplicate and out-of-order events, force-push/ABA handling, added candidates, external pushes during prepared persistence, concurrent resolution, recovery after Git advancement, missing identity, forged evidence, merge conflicts, audit chaining, canonical events, untrusted path names, missing Artifacts objects, fail-closed executor behavior, and unauthenticated production API calls.

The browser checks exercise both decisions, the mandatory refresh between them, rationale entry, local exact diffs, and responsive desktop/mobile layouts. The simplified UI also verifies that technical details begin collapsed and workspace metrics remain accessible through disclosure. Browser checks do not prove server invariants or live deployment behavior.

The recorded bounded report contains:

| Metric | Recorded value | Interpretation |
|---|---:|---|
| Proposals / producers / repositories | 8 / 5 / 2 | Scripted fixture sizes |
| Human decisions | 2 | Predefined decision components |
| Compression ratio | 0.25 | 2 / 8 in this fixture; not generic grouping performance |
| Supplied intent traceability | 87.5% | Seven of eight revisions have declared provenance |
| Relationship comparisons / avoided | 4 / 12 | Filtering compared with sixteen potential pairs |
| Analysis duration | 433 ms | One local fixture run, including producer generation |
| Stale decision rejection | 1 | Rejected between the two verification resolutions |
| Previously current evidence made stale | 11 | Historical records remain ineligible after canonical change |
| Stale evidence accepted | 0 | Bounded fixture/tests; no production telemetry claim |
| Incorrect duplicate classifications | 0 | Expected single identical-tree pair; no broad false-positive study |
| Automatic reversals | 0 | No automatic canonical convergence in the fixture |
| Ordinary clone and integrity checks | Passed | Both resulting repositories clone and pass Git integrity checks |

The zero counters are initialized instrumentation plus fixture assertions. They should not be presented as mature production safety statistics. The 0.25 ratio demonstrates the UI and deterministic coordination flow for constructed choices; it does not establish automatic compression across arbitrary repository work.

## Remaining work against the implementation phases

Phase 1 has local Git behavior and Cloudflare integration code, with live Artifacts/executor verification outstanding. Phase 2 provides the core immutable records, with production storage/indexing enforcement outstanding. Phase 3 provides exact-state evidence and staleness for fixture-owned checks, with a general runner outstanding. Phase 4 provides exact-tree identity and real compositions, with broader deterministic indexes and generic convergence grouping outstanding. Phase 5 provides the single-repository basis/CAS/journal model, with live remote lease and organizational identity verification outstanding. Phase 6 provides a functioning decision-focused interface, now simplified; production exact diffs remain missing. Phase 7 has only ingestion context snapshots, without retrieval, ambiguity handling, questions or a semantic analyzer. Phase 8 has a scripted adversarial fixture rather than the full required application demonstration.

The next work should strengthen the actual application fixture and emergent semantic interaction, verify the complete Cloudflare Git/event/executor path, and add authenticated multi-user identity. The minimal interface should remain focused on the question, its alternatives, the evidence relevant to that choice and the recorded outcome.
