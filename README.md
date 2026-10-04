# ClocGit — decisions above Git

A deterministic prototype of the decision-centric Git platform. Git owns code; ClocGit owns coordination, immutable versions, decisions and bounded evidence. The default interface presents decisions with alternatives and progressively revealed evidence. Native merge requests, conventional review and an exact-composition merge queue are available under Work.

Source repository: [vik418/ClocGit](https://github.com/vik418/ClocGit).

## Run locally

```sh
git clone https://github.com/vik418/ClocGit.git
cd ClocGit
npm install
npm run dev
```

Open <http://localhost:43187>. Set `PORT` to use another local port, for example `PORT=43188 npm run dev`. A fresh workspace uses `.demo-v2/` and starts with two ordinary Git repositories: the runnable payment HTTP application `checkout-api` and its versioned constraint repository `payment-policy`.

Behavioral validation requires Linux, Node 22 or later, Git, bubblewrap, util-linux and private namespace support; see the [runner requirements](fixtures/README.md).

Startup retrieves the policy at an immutable commit and asks whether the client should retry a failed response after the service may already have accepted the request. The actual user answer remains pending until submitted. No coordinated demo producer starts before an answer or an explicitly recorded assumption. Acceptance tests use a named test actor; their answer is not the user's answer. Ordinary untagged Git work can still be ingested while this task waits.

Answer the question, then start the five simulated concurrent producers. They make eight real Git proposals. The retry-enabled acceptance scenario yields two review decisions from declared retry-timing choices and an observed interaction. Its review compression ratio is 2/8 = 0.25; counting the earlier clarification gives three human inputs in total. Components and alternatives are derived from immutable relationships rather than a scripted list of decision IDs. A different context answer can change the resulting work and decision count.

## Implemented

- Standard Git ingestion, unknown provenance, content-addressed revisions, separate histories and exact-tree implementation reuse.
- A small context compiler for one explicit task schema, cross-repository immutable retrieval, answer/assumption records and Git artifact/trailer binding.
- Connected decision groups from unresolved alternative/conflict edges; bounded candidate enumeration; independent work included in explicitly reviewed compositions. Unknown executable work remains conventional review.
- Actual Git candidate trees and a platform-owned HTTP effects validator. Evidence pins the candidate tree, policy version, configuration and canonical heads; changed inputs make historical evidence ineligible.
- Reviewed-basis checks, actual Git old-OID CAS, serialized coordination, a prepared-operation journal, conservative recovery and hash-chained audit history.
- Native merge requests with draft/ready/close/reopen, revision-bound reviews, batch review, file/line threads, declared CI reports, required platform checks and pinned dependencies.
- Explicit single/batch compositions for MR and standalone Git work, an immutable reviewed merge queue that stops for stale inputs, and validated inverse candidates reviewed before revert CAS.
- A minimal decision interface with alternatives, rationale, evidence, proposals, exact diffs and activity available through progressive detail.
- Cloudflare Artifacts/Worker/Queue/Durable Object integration code, an authenticated Container executor, remote Git leases and a live verification harness. Account integration remains unverified.

## The real semantic interaction

The trusted validator runs the candidate HTTP application in isolation and counts effects received by an external simulated provider. A platform proxy loses one response only after the payment service processes it.

| Exact candidate | Charges | Confirmations | Trusted check |
|---|---:|---:|---|
| Baseline | 1 | 1 | Pass |
| A: retry with the same order identity | 1 | 1 | Pass |
| B: confirm before replay detection | 1 | 1 | Pass |
| A+B: clean Git composition | 1 | 2 | Fail |

The host application suite passes these finite scenarios. This establishes the demonstrated interaction, not correctness across all inputs or failures. Payments and email are simulated; producer tests, application ledgers and stdout cannot supply the trusted counts.

Other cases cover exact duplicate tracing implementations, independent metrics, declared fixed/exponential timing alternatives, unknown-provenance documentation and evidence becoming stale after canonical advancement. Producers are concurrent Git-generating loops, not autonomous AI agents or external CI.

## Verification and cloneability

```sh
npm test
npm run build
npm run check:worker
node scripts/verify-demo.mjs
```

Tests cover application behavior/isolation, context/provenance, generic graph derivation, Git CAS/versioning/recovery and mocked Cloudflare boundaries. Wrangler's dry run proves bundling, not live service behavior. Read the generated report's scope and status before treating metrics as observed results.

The focused native workflow integration suite uses real Git without running candidate application code:

```sh
node --test tests/workflow-integration.test.mjs
```

It covers lifecycle and exact reviews, source pushes that arrive before their events, trusted checks, dependency ordering, stale queue tickets, batch requirements, ordinary non-MR work, external merges/force pushes/deletions, reviewed inverse code and MR/queue recovery.

After local resolution:

```sh
git clone .demo-v2/repositories/checkout-api.git checkout-api-result
git clone .demo-v2/repositories/payment-policy.git payment-policy-result
cd checkout-api-result
node app.mjs
```

The application prints its loopback port. Stopping ClocGit leaves ordinary Git clone/fetch/push available. Replay recreates only the disposable `.demo-v2/` fixture.

## Deployment and detailed briefing

No live Cloudflare resources were created or deployed. Account preflight is blocked by missing authentication. The executor image and gateway bundle build, but the default local Docker sandbox denies its namespace probe; Cloudflare Container support for required isolation remains unverified. The executor fails closed when isolated validation cannot start.

Read the [native workflow guide and coverage matrix](docs/workflows.md), [detailed implementation briefing](docs/implementation-briefing.md), [Cloudflare setup](docs/cloudflare.md), [live verification runbook](docs/live-cloudflare.md) and [application fixture](fixtures/README.md).

The footer's **Capabilities** view and authenticated `GET /api/capabilities` expose the same scoped registry as [capabilities.md](docs/capabilities.md). Supported claims cite automated tests; partial, experimental and unsupported workflows keep their limits visible. Run `node scripts/check-capabilities.mjs` to verify references and generated documentation. The [full product roadmap](docs/product-roadmap.md) plans all nineteen domains in dependency order without claiming they are all delivered.

The selected integration is native Artifacts; GitHub and GitLab connectors are not built. The application uses one configured owner. Its default policy requires no separate MR approval; the explicit reviewed Decision still authorizes every canonical change. Positive approval requirements and self-approval are configurable, while organizational multi-user identity is deferred. This prototype does not discover arbitrary unknown semantics, prove global correctness, offer atomic multi-repository updates or provide a production CI fleet. Ordinary Git ingestion does not require an agent-specific workflow.
