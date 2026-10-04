# Cloudflare setup

The implementation targets Cloudflare Artifacts, Workers, Queues, a workspace Durable Object and a separate trusted Git executor Container. The live account path remains blocked by absent authentication. See [live deployment and verification](./live-cloudflare.md) and its [machine-readable preflight evidence](./evidence/cloudflare-preflight.json).

ClocGit uses the existing `converge` deployment namespace and candidate/provenance identifiers shown in the runbook. Renaming those identifiers requires a separate migration.

The checked-in application config binds Artifacts, the native-event/analysis Queue, the workspace coordinator, browser assets and `GIT_EXECUTOR`. The executor's separate config defines its authenticated gateway and named Container. Before deployment, configure owner identity, separate ingress/service credentials, scoped repository credentials and the exact validation hash. No values belong in Git or provenance.

Create and seed `payment-policy` and `checkout-api` with ordinary Git, register their trusted validation profiles in that order, and configure repository-level native `cf.artifacts.repo.pushed` subscriptions. Register producer forks and subscribe to their push events too. The live harness provisions native subscriptions through the documented REST API because Wrangler's current subscription CLI does not expose Artifacts namespace/repository filters.

Ingestion resolves authoritative refs and immutable commits/trees. Missing provenance remains valid. Native events enqueue expensive analysis separately; `POST /api/analysis` derives decision components from the actual revisions, relationships and evidence. There is no owner endpoint for scripted decision groups.

The explicit context flow uses `POST /api/tasks`, `POST /api/tasks/:id/answer` or `/assume`, and immutable context snapshots. `GET /api/tasks` lists preparations. Proposal context is verified against Git artifacts and parsed commit trailers. Registered validation profiles and context dependencies must match the trusted executor manifest; producer claims cannot select validation.

Resolve with `POST /api/decisions/:id/resolve`, submitting the shown alternative, basis hash, expected canonical head and rationale. Stale submissions return `409 DECISION_STALE`. Refresh using `POST /api/decisions/:id/refresh`; inspect exact diffs through `GET /api/diff?revision=<ID>`. `POST /api/recover` compares uncertain prepared operations to authoritative Git heads.

The executor retains candidate refs remotely before preparation, validates exact Git trees inside the private sandbox and uses standard Git's explicit `--force-with-lease` against the captured old head. An unavailable sandbox, stale configuration, mismatched profile or uncertain transport result prevents automatic advancement. Native event delivery, Container isolation, Artifact candidate-ref support, authenticated lease races and recovery require the actual account run; local tests and bundle dry runs do not establish them.
