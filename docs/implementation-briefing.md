# Implementation briefing — native workflows

ClocGit is a deterministic coordination prototype above ordinary Git. It turns immutable changes and bounded evidence into reviewable choices, then applies a chosen tree only while the reviewed basis and target Git head match. The running application demonstration derives components from relationships and adds a cross-repository context question. Native merge requests, conventional single/batch review, dependency guards, an exact-composition queue and reviewed reverts now use the same foundation.

This briefing distinguishes implemented mechanisms, observed local results and deployment work that has not run. The previous configuration-only demo is not evidence for the new HTTP application or a completed Cloudflare rollout.

## Why the interface is minimal

The main view presents the workspace, work/decision counts, a pending material context question when needed and the decisions themselves. Each decision gives its question, alternatives, tradeoffs, scope and evidence/staleness status. A user can choose an outcome and record a rationale without starting from raw code.

Evidence, revisions, diffs, activity, repository heads and operation details are available through progressive detail. The earlier sidebar, dashboard tiles, redundant convergence diagram and producer avatar stack were removed. Navigation stays small and the layout supports desktop/mobile widths.

Minimal presentation does not remove version checks. A changed basis requires refreshed candidates and renewed review. Evidence remains tied to exact inputs and Git still enforces the expected old head.

## Source map

| Source | Responsibility |
|---|---|
| `core/hash.mjs` | Canonical serialization, SHA-256 identities, immutable record creation, errors |
| `core/engine.mjs` | Ingestion, context binding, evidence, interaction analysis, compositions, basis, CAS, dispositions, recovery |
| `core/components.mjs` | Generic relationship components and bounded maximal consistent candidate enumeration |
| `core/context.mjs` | Explicit task schema, immutable retrieval, question, answer/assumption, snapshot, authorization |
| `core/merge-requests.mjs` | Native MR lifecycle, reviews/threads/reported checks, policy, dependency DAG, version guards, observed Git reconciliation |
| `core/merge-queue.mjs` | Immutable reviewed tickets, dependency eligibility, stale-stop behavior, request receipts and operation reconciliation |
| `server/git.mjs` | Ordinary Git, retained candidate commits, validation dispatch, local CAS |
| `server/runner.mjs` | Safe immutable materialization and bounded isolated execution |
| `fixtures/trusted/supervisor.mjs` | Trusted external effects, lost-response proxy, finite observations/checks |
| `fixtures/checkout-api/` | Runnable Node payment HTTP application and retrying client |
| `fixtures/payment-policy/` | Versioned exactly-once policy and prior confirmation decision |
| `scripts/workspace.mjs`, `scripts/demo.mjs` | Unanswered baseline preparation and concurrent ordinary Git producers |
| `server/local.mjs` | Local API, explicit demo identity, serialization, JSON persistence, Vite |
| `server/workflow-api.mjs` | Shared local/Worker workflow routing; actor and trusted-evidence fields remain server controlled |
| `server/bridge.mjs`, `server/remote-git.mjs` | Authenticated executor API, retained remote candidates and lease-protected push |
| `worker/artifacts.mjs`, `worker/index.mjs` | Artifacts reads, Worker APIs, Durable Object, ingress/analysis queues |
| `worker/executor.mjs`, `Dockerfile.executor` | Container gateway, service authentication, bounded runner image, optional fault controls |
| `scripts/cloudflare-live.mjs` | Preflight, event provisioning, bounded live acceptance harness |
| `src/main.jsx`, `src/style.css` | Minimal decisions and progressive review detail |

## Local startup and the actual user question

`npm run dev` serves the browser/API at `http://localhost:5173`. The v2 fixture lives in `.demo-v2/`; saves write a temporary JSON file and rename it. An in-process queue serializes mutations. Local calls use `demo-owner`, a demonstration identity rather than organizational authentication.

Fresh startup creates ordinary `checkout-api` and `payment-policy` repositories and prepares the task “Recover checkout when a processed payment response is lost.” Before authorizing its producer, the compiler resolves the policy ref to a full commit and reads `checkout-policy.json` at that immutable version. The source captures repository, path, commit and content hash.

The policy requires at most one charge and one confirmation per order, including after a processed response is lost. It permits both retry answers and contains no prior answer for this parameter. The compiler therefore asks exactly one material question:

> Should the client retry a failed response after the service may already have accepted the request?

The answer changes retry behavior and the possibility of repeated effects. The actual interactive answer remains pending until the user submits it. Fresh startup starts zero coordinated producers. Named test actors supply acceptance-test answers; they do not answer on behalf of the user.

An answer is declared information with actor, time, task, question and scope. The captured policy is retrieved information. An explicit unresolved assumption is a declared item whose truth remains unresolved with a required rationale and a visible human-review obligation. Elapsed time never counts as an answer. A producer can proceed under that explicit assumption without converting uncertainty into fact.

The compiler implements only `retry-response-v1`, an explicit schema and boolean parameter. A supplied task answer, a retrieved existing decision with a decision ID, or a checkable constraint allowing one value can eliminate the question. Advice cannot force an answer or reject another permitted choice. Unsupported task prose does not cause invented questions. Broad issue/specification retrieval and semantic ambiguity analysis remain future work.

Ordinary Git clients can still push while this task waits. Missing or unbound context is recorded rather than rejecting ingestion. The pause applies only to the producer following this explicitly prepared task.

The local API exposes task listing and task answer/assumption operations, `/api/demo/start`, `/api/analysis` and `/api/recover`, alongside workspace, event, diff and decision endpoints. Replay resets the disposable demo; it does not operate on arbitrary repositories.

## Context carried into code and revisions

Resolution creates an immutable ContextSnapshot containing retrieved constraints, declared answer or unresolved assumption, captured sources, parameter value and references. A separate authorization binds the snapshot and whether human review remains necessary.

The task producer commits `.converge/context.json` and task/context/authorization/answer Git trailers. Ingestion parses actual trailing records, checks their exact identifiers against stored authorization, verifies the target repository and checks source freshness. A matching revision uses that exact snapshot and answer reference. Forged, missing or mismatched context remains unknown or invalid; naming an unanswered task cannot make it authoritative.

Composed-tree validation also checks observed behavior against the bound answer: the trusted lost-response transport must observe two attempts for retry or one for no retry. Carrying a correct provenance reference alone cannot make code that contradicts the selected answer eligible for application.

The artifact carries coordination references and bounded source/parameter information, not secrets or private prompts. This is task provenance for the demonstration, not a mandatory protocol for every agent or Git client.

## Immutable records and ordinary Git ingress

Logical proposals and immutable revisions are separate. A proposal identifies canonical repository, producer repository and branch. A revision binds observed base/head commits, complete tree, affected paths, context version, provenance and optional declared choice. Repository/tree implementation identity lets exact duplicates share implementation while preserving separate intent and producer histories.

IDs hash canonical serialized inputs and newly created records are deep-frozen. Mutable statuses, active ref pointers and evidence eligibility are separate. Persistence remains one workspace aggregate rather than independently enforced immutable database tables. Reloaded JSON is ordinary JavaScript data. Audit records reference previous hashes, without a signed external audit anchor.

Ingress re-reads the authoritative Git ref. A delivered head different from that ref is out of order; timestamps are not version counters. Event hashing makes duplicates idempotent. Rebase/force-push creates a new revision. An A→B→A return can restore the active pointer while keeping B's history. Canonical branch events observe Git movement instead of inventing proposals.

Approved forks participate in identity and map back to their canonical repository. Unknown provenance is valid. Producer claims stay declared metadata and Git commit/tree/path facts stay observed. Scope uses the observed unique Git merge base when available, retaining an explicitly labeled baseline fallback when ancestry cannot be established. Source deletion withdraws active work without deleting history. Canonical branch deletion makes platform transitions unavailable while ordinary Git can restore the branch.

## Native collaboration workflows

The default screen remains decision focused. Work adds native merge requests, standalone conventional proposals and the merge queue. A single or batch selection prepares an actual immutable candidate; every included MR must satisfy current approvals, requested-change state, platform checks and dependencies before application. An ordinary proposal without an MR uses the same preparation and reviewed CAS, even while an unrelated task question remains unanswered.

MR lifecycle supports editing, draft/ready, close/reopen and preserved merged histories. Draft and closed requests are excluded from automatic convergence analysis. Reviews, discussions with verified file/line locations, declared CI reports and dependency declarations retain exact revision references. Batch review preflights all version/source pins. New source revisions stale historical approvals; authoritative source checks reject unnotified pushes and deletions before application.

Reported check success is declared information and never trusted proof. Policy requires platform-owned checks on the actual composition, with configurable approval count and self-approval. The default requires no separate MR approvals; explicitly reviewing and applying a Decision remains the human authorization gate. Integration tests configure one required approval to verify that additional policy. The current local/Worker application has one configured owner and does not provide organizational multi-user identity; the author/reviewer domain model does not establish a production authorization service.

Dependencies pin MR revisions and reject cycles. Historical merged status does not satisfy an absent prerequisite: current canonical ancestry is checked, and recorded reverts block dependent application. Queue tickets retain the precise composition, evidence, decision/MR/dependency basis and expected Git head already reviewed. Processing advances at most one eligible entry; canonical movement or changed review inputs moves later entries to needs-review instead of silently rebuilding them. Recovery reconciles exact prepared outcomes and MR/queue state without repeating Git CAS.

Revert preparation constructs the actual inverse against current canonical code, retains it, validates it and presents the changed code before any write. Later unrelated work is preserved where Git can compose the inverse. External merge reverts require an explicit valid mainline; a platform decision uses its recorded canonical parent. A batch revert undoes the selected composition, and the applied revert records its original decision/commit relationship.

Native Artifacts is the selected integration. GitHub/GitLab connector alternatives were audited and are not implemented. See [workflows.md](workflows.md) for API fields, identity limits and the native-versus-live coverage matrix.

## Generic relationship and decision derivation

Complete-tree identity establishes implementation equivalence only. Path overlap without evidence creates `unknown`. Versioned producer metadata may declare a `decision_key` and `choice`; different choices create a declared alternative edge. This is a producer claim that outcomes compete, not inferred architecture or a platform-selected preference.

Interaction analysis filters pairs by platform suite footprint. The baseline and each singleton candidate require current passing trusted evidence on the same captured canonical base. The engine constructs a real pair tree and runs the same check. If individually passing changes compose cleanly but fail together, it records the exact revision heads/trees, composed tree, individual evidence, configuration, pinned heads and finite result as observed interaction evidence.

The component algorithm connects active revisions through unresolved alternative/conflict edges. It has no hard-coded retry-policy or semantic-demo decision IDs. Equivalence, compatibility hints, dependencies and unknown overlaps do not connect unrelated decisions. Branch names and ingestion order do not define the groups.

Bounded maximal consistent subsets enumerate options that avoid the component's blocking edges. Same-tree aliases preserve histories while sharing implementation search identity. Budget overflow yields explicit conventional review rather than an incomplete option list presented as complete. Missing, forged or stale failure evidence remains an unresolved claim requiring judgment.

Independent validated work stays outside the graph and can accompany alternatives in an explicitly reviewed, freshly checked composition. Unknown executable work stays conventional review. Unknown documentation remains visible for explicit review. Independence or high confidence never authorizes an automatic canonical write.

This is generic graph derivation from declared/observed relationships. It does not discover arbitrary unknown semantics or establish global compatibility from absent edges. Path/suite filtering saves expensive comparisons while still scanning arrays; production subsystem, symbol and dependency indexes remain unfinished.

## The running HTTP application and A/B/A+B

The v2 baseline contains executable code. `node app.mjs` starts a loopback service. `/checkout` uses the retry client and `/charge` deduplicates payment by idempotency key; health, metrics and demonstration state are available. Payments and confirmations are simulated effects, with no real money or email.

A modifies `client/retry.mjs` to retry using the same order identity. B modifies the disjoint `server/charge.mjs` to send confirmation before replay detection. The trusted proxy loses one response only after payment and external effects have completed.

| Exact version | Attempts | Provider charges | Provider confirmations | Check |
|---|---:|---:|---:|---|
| Baseline | 1 | 1 | 1 | Pass |
| A alone | 2 | 1 | 1 | Pass |
| B alone | 1 | 1 | 1 | Pass |
| Clean Git composition A+B | 2 | 1 | 2 | Fail |

Baseline can return 502 after processing a payment. The finite contract concerns one charge and one confirmation; it does not require successful transport recovery. A recovers without repeated effects. B alone confirms once. Together the retried request sends another confirmation before the duplicate-payment return path.

This replaces the old unit-configuration conflict with an interaction arising only in the combined individually passing changes. A fresh host run of `node --test tests/application.test.mjs` passed all four application tests: A/B/A+B, fabricated ledger/test-output claims, secret/filesystem/network restrictions and symlink rejection. Those finite simulated-provider observations do not establish global correctness.

## Trusted evidence and isolation

The runner materializes exact ordinary Git blobs without hooks or producer scripts. It rejects symlinks, submodules, unsafe paths and oversized trees. Execution uses a read-only candidate/runtime, scrubbed environment and private loopback network namespace. Node permissions restrict outside filesystem access, child processes, native addons and workers. Outer CPU, memory, descriptors, output and wall time are bounded.

A platform-owned supervisor runs the candidate separately from its trusted provider/proxy. It counts actual provider HTTP effects. Candidate `/state`, tests, passing stdout and provenance cannot supply these counts. Candidate output is separated from the supervisor result channel. The suite checks normal checkout, one lost processed response, requested payment amount and retained order keys.

Evidence binds exact subject/tree, trusted configuration, policy commit/tree, result, source, time, constraints and canonical dependency heads. Historical evidence stays unchanged. A changed pinned head, new/changed constraint or configuration makes it ineligible. Resolution requires fresh passing trusted evidence for the exact selected composition/tree.

Unavailable isolation returns `validation-unavailable` and `passed:false`; there is no unsandboxed fallback. The host application suite passed. Separately, default local Docker security denied the bubblewrap namespace probe. Cloudflare Container namespace support is unverified. A successful image build does not establish that deployed isolated validation can run.

There is no general CI fleet, arbitrary constraint-language interpreter or security scanner. The platform owns the demonstrated suite and pinned policy schema. These limits do not constitute a full hostile-code isolation audit or proof across all failures.

## Reviewed basis, Git CAS and recovery

Candidates start from the observed canonical head in a temporary clone. Selected patches use Git's three-way support; identical implementations are applied once while their history IDs remain in the composition. Candidate commits/trees are retained under refs. A textual conflict stops composition rather than falling back to a passing baseline.

The basis covers graph identity, selected/current revisions, relevant relationships, active constraints, offered alternatives, evidence identities/eligibility, assumptions, context versions and repository heads. Added work or changed reviewed inputs can stale an open decision.

Resolution re-observes heads, recalculates the basis and checks both submitted basis and expected head. Mismatch returns `409 DECISION_STALE`. Refresh derives the current graph and builds new candidates/evidence; changed membership requires presenting the new choices.

Before writing Git, the engine persists an immutable decision with selected/deferred revisions, context references, rationale, actor and reviewed inputs. A separate prepared operation pins exact old head and target commit. Local Git uses `update-ref <ref> <new> <old>`. Remote Git uses explicit `--force-with-lease=<ref>:<expected>`. Capturing the old head before asynchronous persistence protects against an external client's racing push.

Success records dispositions and audit receipt. An uncertain executor result blocks later transitions. Recovery observes authoritative Git, recognizes only the exact prepared target and never pushes again to guess the outcome. Ambiguity remains recovery-required. The Container gateway forwards a canonical operation once and does not retry a lost response.

One operation advances one repository. Dependency heads are reviewed inputs, but another repository can change after observation. There is no atomic multi-repository transaction. Production releases need immutable dependency pins or an explicitly recoverable protocol.

## The eight-proposal scenario and compression

Five concurrent ordinary Git-producing loops represent Atlas, Mira, Rowan, CI/reliability and a Git client. These simulate producers; they are not live coding agents or external CI. Their isolated clones produce eight application proposals: two identical tracing histories, metrics, fixed/exponential timing alternatives, context-bound retry, confirmation-before-replay, and unknown-provenance documentation.

For the explicitly retry-enabled test answer, relationships yield a timing choice and observed duplicate-confirmation interaction. Independent work accompanies reviewed compositions. A decision can apply selected code and defer competing code; resolving every group does not mean merging every proposal. A no-retry answer can change the interaction and downstream decision count.

The user's context clarification is an additional human input. The retry-enabled acceptance path has two downstream review choices plus one earlier clarification: three human inputs when both stages are counted. Its 2/8 = 0.25 ratio measures review compression only. End-to-end human interaction counts must include the clarification and any conventional review; the interface exposes recorded context answers and pending clarifications separately.

After canonical advancement, earlier evidence and another open basis can become stale. The latter requires refresh. Clone/integrity checks verify ordinary Git results. Read the generated report's recorded scope/status; historical v1 values such as 433 ms and twelve avoided comparisons are not v2 measurements.

The current [local report](demo-report.json), regenerated on 2026-10-03 after native workflow integration, records these bounded outcomes:

| Observation | Recorded result | Scope |
|---|---:|---|
| Proposals / producers / repositories | 8 / 5 / 2 | Constructed running-application scenario |
| Generated review decisions | 2 | Declared timing alternatives and one observed interaction |
| Review compression | 0.25 | Two downstream reviews; one context clarification is additional |
| Applied/deferred revision histories | 8 | Every fixture proposal has an explicit disposition |
| Rejected stale CAS attempt | 1 | Old reviewed basis submitted after canonical advancement |
| Historical evidence made stale | 26 | Remains ineligible rather than being rewritten |
| Relationship comparisons / avoided | 2 / 26 | Metadata filtering versus 28 possible pairs |
| Supplied producer-intent traceability | 87.5% | Seven histories declared provenance; documentation remains unknown |
| Analysis latency | 2,615 ms | Final refresh analysis in this run, not a production or initial-ingress benchmark |
| Invalid pair / selected canonical effects | 1 charge, 2 confirmations / 1 charge, 1 confirmation | Actual trusted-provider lost-response observations |
| Ordinary Git result | Clone and fsck pass | Both repositories remain usable independently |
| Selected context binding | Answer reference retained | Named verification actor; not the actual user's answer |

Saved browser captures show the [pending context question](evidence/context-before-code.png) and [derived decisions](evidence/derived-decisions.png). The latter uses an isolated acceptance fixture; the actual user task is still unanswered.

The report's zero reversals, stale-evidence acceptance and duplicate errors are bounded fixture results. The duplicate-error check verifies the expected exact-tree pair, not a broad semantic false-positive study.

## Cloudflare implementation and live status

The production path is browser → authenticated Worker → workspace Durable Object. Native Artifacts events enter through a Queue; expensive analysis is scheduled separately. The adapter provides immutable reads, and repositories/approved forks can be created/registered. Empty repositories are seeded with standard Git. Exact diffs use the trusted executor.

The separately deployed Container gateway starts the Node bridge with private manifest/credential bindings. Trusted configuration selects scoped repository credentials, and registered validation profiles/context dependencies must match the executor manifest. Producer claims cannot select the validation profile. Canonical writes use normal Git smart HTTP and explicit leases. Candidate retention must survive ephemeral Container disk; remote candidate-ref acceptance remains a live verification item.

Identity currently represents one configured owner and separate trusted ingress. Organizational multi-user identity and granular authorization are unfinished. Producers need separate scoped Git credentials. Secrets stay out of provenance and browser output.

Preflight on 2026-10-02 and again on 2026-10-03 found no configured account authentication; Wrangler was unauthenticated. No account resources were created, no live deployment was attempted and native delivery, remote races and recovery remain unverified. Both Worker bundles pass, and the final executor image builds and passes syntax checks as its configured non-root user; neither proves Container isolation or account behavior.

The live harness provides concrete experiments: provision native subscriptions; push an untagged branch; observe its exact head through native ingress; derive reviews from real workspace state; reject an external push's stale basis; race identical resolutions; withhold one successful CAS reply; restart the Container; reconcile the prepared target; fetch and check ordinary Git. Opt-in fault controls use a distinct credential. These experiments are authored but unrun against Cloudflare. A hard coordinator-process-kill experiment is also outside that harness.

See [live-cloudflare.md](live-cloudflare.md) for the failed preflight and prerequisites. Missing authentication is a deployment dependency, not a new approval requirement. Unverified Container sandbox support is a technical dependency; validation fails closed.

## Verification, metrics and remaining work

The follow-up build adds a nineteen-domain product roadmap and a single capability registry shared by the authenticated API, secondary product view and generated documentation. Its 45 records explicitly mark supported, partial, experimental and unsupported paths. Each supported record and each of the twelve local workflow acceptance cases names automated test witnesses. Registry checks reject unsupported status drift, nonexistent witnesses and documentation drift. The actual registry dialog passed authenticated read-only desktop/mobile checks; see [the browser report](evidence/capabilities-browser.json).

The final combined suite passes 202 tests. New direct witnesses exercise registered fork MR updates, failed/pending/cancelled trusted runs, stacked changes updated beneath dependents, target movement during validation, an actual external branch merge racing CAS, and a native MR crash after Git advances but before final persistence. Batch tests verify separate dispositions with one decision and one Git update. Required checks now use the latest current trusted proof rather than reviving an older pass; standalone composition authorization also pins the latest subject proof. [The capability registry](capabilities.md) states the precise scopes. No live Cloudflare behavior is established by these local results.

`npm test` runs application, context, graph, Git acceptance, native MR/queue/revert, shared workflow API, mocked Artifacts and gateway tests. The added `tests/workflow-integration.test.mjs` runs real Git lifecycle, unnotified source races, trusted-versus-declared checks, batch policy, dependency ordering/stale tickets, standalone review, external ancestor/force-push/deletion history, reviewed inverse code and reload recovery. Its lightweight policy checks do not execute candidate application code; the HTTP effects suite separately covers that boundary. `npm run build` builds the browser. `npm run check:worker` bundles the application Worker; the executor's separate command is in the live runbook. `node scripts/verify-demo.mjs` generates bounded local evidence under a named test actor. Earlier desktop and 390-pixel browser checks covered the decision interface; expanded workflow browser checks are separate from server invariants and live hosting.

Compression counts required convergence decisions divided by proposals, including conventional review instead of hiding unknown work. Supplied-intent traceability counts declared provenance, not independently verified intent. Exact-tree checks establish implementation equality, not semantic equivalence. Latency/comparisons are local measurements. Zero fixture stale acceptance, reversals or duplicate errors are not production safety statistics.

Remaining work includes live Artifacts/Queue/Container verification, organizational identity, independent immutable/audit storage enforcement, production indexes, a broader evidence scheduler, more context/policy schemas and robust dependency releases. Probabilistic hints are absent; if added later, they must remain human-reviewed hints rather than authority for irreversible convergence.

Against the original implementation order:

| Phase | Current implementation | Remaining boundary |
|---|---|---|
| 1: Git/Artifacts/workspaces | Ordinary repositories, isolated producers, approved forks, native ingress/analysis code | Live account/token/event/executor verification |
| 2: Proposals/revisions | Content-addressed revisions, contexts and shared implementations with separate histories | Independently enforced immutable storage and production indexing |
| 3: Evidence/staleness | Real isolated HTTP checks, exact tree/policy/configuration, stale eligibility | General evidence scheduler and broader trusted profiles |
| 4: Relationships/compositions | Tree identity, declared choices, observed exact-pair failure, generic groups and real candidates | Scalable symbol/dependency indexes and unknown-semantic interpretation |
| 5: Decisions/CAS | Reviewed basis, actual Git CAS, dispositions, prepared journal, conservative recovery, exact reviewed queue and validated inverses | Live remote failure experiments and stronger dependency release protocol |
| 6: Decision UI | Context/decision view, native MRs and reviews, single/batch conventional preparation, queue and revert review | Organizational multi-user identity and broader production usability |
| 7: Context/intelligence | One deterministic cross-repository schema, material question, explicit assumptions and code binding | General retrieval/ambiguity compiler; optional semantic hints remain absent |
| 8: Adversarial demo | Running HTTP application, exact duplicates, compatible metrics, declared alternatives, emergent A+B failure, unknown provenance and stale evidence | Live Cloudflare rendition and evidence beyond finite simulated scenarios |

The [architecture document](architecture.md) maps I1–I6 explicitly, including the application-managed storage limit, lack of cross-repository atomicity and ordinary Git failure floor.

The interface should continue to center the question, alternatives, relevant evidence and recorded outcome as those foundations grow.
