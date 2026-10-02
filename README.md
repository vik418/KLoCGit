# Converge — decision-centric Git collaboration

A deterministic, runnable prototype of the model in the brief. Git owns code. Converge owns immutable coordination inputs, provenance, decisions and bounded evidence.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. The first run creates two ordinary bare Git repositories, five isolated concurrent producers and eight proposals. The local demo explicitly uses a demo identity; it is not production authentication.

The default screen presents two decisions. Review alternatives, evidence and revisions; record a rationale; apply a composed tree. Resolving the first decision changes the basis of the second. Refresh the second decision before applying it. Demo controls replay the fixture, simulate an external Git update, or change a constraint version.

```sh
npm test                  # 19 deterministic acceptance tests
npm run build             # browser production bundle
npm run check:worker      # Cloudflare deployment dry run
node scripts/verify-demo.mjs # regenerate docs/demo-report.json
```

## Implemented

- Standard Git branch ingestion, observed commit/tree/scope facts, unknown provenance, content-addressed revisions and implementation reuse without proposal-history collapse.
- Immutable intent/context/evidence/relationship/decision records. Mutable operation status is separate from the immutable decision. Append-only audit records form a hash chain.
- Progressive scope indexing before comparisons; exact tree identity is the only automatic implementation-equivalence rule. No LLM is required.
- Actual Git candidate compositions with retained candidate refs, platform-owned structural checks, a cross-repository contract fixture, and evidence eligibility derived from pinned heads, constraints and check configuration.
- Decisions that cover selected revisions, current candidate membership, relevant relationships, constraint versions, evidence versions and eligibility, alternatives, assumptions and repository heads.
- A serialized workspace boundary, prepared-operation journal, actual Git ref CAS, stale-basis rejection (`409 DECISION_STALE`), and crash reconciliation against the exact target commit.
- Decision-focused UI, proposal histories and exact diffs, evidence library, work graph and audit activity. A browser WebMCP read tool is registered where supported.
- Cloudflare Worker APIs, Artifacts create/register/fork/read integration, approved producer-fork mapping, native Artifacts push-event Queue consumption, and one Durable Object per workspace.
- An authenticated trusted Git executor bridge using standard Git `--force-with-lease` for remote canonical writes. The Worker refuses canonical advancement if that executor is not configured.

## Six-case adversarial demo

| Case | Concrete fixture | Result |
|---|---|---|
| Duplicate functionality | Atlas and Mira implement identical request-ID trees | One implementation, two histories |
| Independent compatible change | CI adds latency metrics in an independent file | Included in actual retry compositions |
| Competing decisions | Fixed intervals versus exponential backoff | Human retry-policy decision |
| Textually mergeable semantic conflict | API switches to cents; client keeps dollars | Trusted $10 fixture observes a 10-cent charge |
| Missing provenance | Git client supplies documentation without provenance | Ingested as unknown; included for explicit review |
| Stale evidence | Canonical API advances after the first decision | Historical evidence remains immutable and becomes ineligible |

Two decisions resolve all eight candidates by applying selected implementations and deferring competing behavior changes. A resolved decision does not mean every proposal was merged.

The API-cents proposal is deferred because neither offered composition safely migrates the existing client. Cross-repository changes are never represented as atomic. Each resolution advances exactly one repository.

The generated [demo report](docs/demo-report.json) records observed metrics: 0.25 compression, zero stale evidence accepted, 87.5% supplied producer-intent traceability, and indexing comparisons avoided. These are results of the bounded fixture, not global correctness claims.

## Clone the result

After resolving the UI decisions:

```sh
git clone .demo/repositories/checkout-api.git checkout-api-result
git clone .demo/repositories/storefront.git storefront-result
```

These repositories work independently of the coordination server. Stopping Converge leaves ordinary Git clone/fetch/push available. `.demo/` is ignored and contains only disposable demo repositories; replay deletes and recreates that fixture.

## Cloudflare deployment

See [Cloudflare setup](docs/cloudflare.md) and [architecture and limits](docs/architecture.md). No live Cloudflare credentials are configured in this workspace, so no remote resources were created and no public site was deployed. The Worker bundle passes Wrangler's dry run. Live Artifacts authentication, push events and remote Git lease behavior still require integration verification.

This is a deterministic prototype, not a complete GitHub replacement or production rollout. Generic evidence runners, a context retrieval compiler, probabilistic relationship hints, organizational identity integration and high-scale indexing are outside this implementation. Unclassified incoming work remains available for conventional review; arbitrary Git ingestion does not silently create safe convergence decisions.
