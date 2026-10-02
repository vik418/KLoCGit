# Cloudflare setup

The application targets Cloudflare Workers, Artifacts, Queues and a Durable Object. Artifacts currently requires a Workers Paid account. Wrangler 4.147.0 was used for the successful bundle dry run.

## Deploy the API and browser

1. Authenticate Wrangler to the intended Cloudflare account using its configured environment credentials.
2. Create the `converge` Artifacts namespace and `converge-git-events` Queue in that account. Configure an Artifacts push-event subscription to deliver `cf.artifacts.repo.pushed` to this Queue. Use Cloudflare's documented namespace/repository filters. The configuration does not invent a conventional webhook endpoint.
3. Provision `AUTH_TOKEN` and `ACTOR_ID` for one owner identity, and a separate `INGEST_TOKEN` for trusted direct ingress. Use `wrangler secret put` for secret values. The browser can accept the owner credential; it stays in page memory. Producer actor claims never become authenticated decision actors.
4. Build and deploy:

```sh
npm run build
npx wrangler deploy
```

The Durable Object is the serialization and persistence boundary. Static browser assets are served by the same Worker. API calls require a configured credential; Queue messages enter through the runtime binding.

The simple credential model identifies one service/owner. Replace it with independently verified organizational identity before a multi-user production rollout. Never use the same credential for all Git producers.

## Repositories and forks

Authenticated API operations:

```text
POST /api/repositories {"name":"checkout-api","create":true}
```

This creates an empty Artifacts repository and returns its remote, with `needs_initial_commit:true`. Provision a scoped Git write token through Artifacts, push the initial `main` commit using a normal Git client, then register:

```text
POST /api/repositories {"name":"checkout-api"}
POST /api/repositories/fork {"source":"checkout-api","name":"atlas-checkout"}
```

Forks are mapped to the canonical repository for ingestion. Tokens returned internally by create/fork are not stored in provenance or exposed through the UI. Provision producer-specific Git tokens through Artifacts' credential facilities; this prototype intentionally does not distribute secrets through a generic metadata endpoint.

Ingestion independently resolves the currently observed producer ref and reads immutable commits and trees. Native events have no assumed monotonic sequence; timestamps never determine ref freshness. Event-input hashing makes repeats idempotent. Unregistered namespace repositories are ignored until explicitly registered.

## Trusted canonical Git executor

Artifacts exposes immutable reads through its Worker binding. The verified API does not expose a documented ref-write/CAS method. Actual writes use the standard Git smart HTTP protocol.

`server/bridge.mjs` implements the trusted execution service. Run it in a container/service with durable local Git storage and expose it through an authenticated Worker service binding named `GIT_EXECUTOR`. The Node process binds to loopback; a service adapter or container gateway must route the binding to it. That infrastructure is not provisioned by this repository.

Create a private manifest outside the source tree:

```json
{
  "cacheDirectory": "/var/lib/converge/git",
  "repositories": {
    "checkout-api": {"remote":"<remote returned by Artifacts>","tokenEnv":"CHECKOUT_GIT_TOKEN"},
    "storefront": {"remote":"<remote returned by Artifacts>","tokenEnv":"STOREFRONT_GIT_TOKEN"},
    "atlas-checkout": {"remote":"<fork remote returned by Artifacts>","tokenEnv":"ATLAS_READ_TOKEN"}
  }
}
```

Configure scoped Git tokens in those environment variables, `GIT_BRIDGE_TOKEN`, and `GIT_EXECUTOR_MANIFEST` pointing to the manifest. Start with `node server/bridge.mjs`. Its startup output includes only the validation configuration hash. Set the exact same hash as the Worker secret `VALIDATION_CONFIG_HASH`. Add a Wrangler service binding for the gateway:

```json
{"services":[{"binding":"GIT_EXECUTOR","service":"your-authenticated-executor-gateway"}]}
```

The executor constructs candidates with Git, runs only platform-owned checks, retains candidate object refs, and pushes:

```text
git push --force-with-lease=refs/heads/main:<reviewed-head> <remote> <candidate>:refs/heads/main
```

The Git old-OID check protects against external clients that bypass the Durable Object. A metadata CAS alone is insufficient. Worker canonical operations fail closed when the executor or exact configuration is missing. No live Artifacts lease operation has been tested here.

## Creating a review decision

Directly ingested work stays in conventional review unless an authenticated owner supplies a decision component. Submit `POST /api/decisions` with `title`, `summary`, `intent`, immutable `revision_ids`, and at least two `alternatives`. Each alternative has `title`, `description`, `tradeoff`, `repo`, and `revision_ids`. The engine constructs and validates real single-repository candidate trees through the executor.

Resolve using `POST /api/decisions/:id/resolve` with `alternative_id`, the shown `basis_hash`, `expected_canonical_head`, and `rationale`. A stale request returns HTTP 409 and requires `POST /api/decisions/:id/refresh` plus renewed review.

## Integration verification still required

Verify real Artifacts token scope, fork object reachability, native Queue event delivery, external-client lease races, service binding authentication, durable storage and recovery, and deployment access controls in the intended account. A bundle dry run does not prove those live integrations.
