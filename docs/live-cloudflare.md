# Live Cloudflare verification

Live Cloudflare acceptance is **blocked and unrun** in this session. On 2026-10-02, the managed runtime reported current readiness with no secrets, runtime variables or outbound identities, and `wrangler whoami` reported unauthenticated. No account resources were created and no production deployment was attempted. [cloudflare-preflight.json](./evidence/cloudflare-preflight.json) records the failed preflight rather than a successful integration report.

Local checks establish only these narrower facts:

- The executor Worker bundles with Wrangler 4.147.0 and `--dry-run --containers-rollout=none`.
- The executor Docker image builds with the platform CA mounted only during networked build steps. Docker Hub initially returned HTTP 429; the official Node image mirror at `mirror.gcr.io/library/node:24-bookworm-slim` succeeded.
- The default local Docker security configuration denies the bubblewrap namespace probe. The executor does not relax that boundary. Cloudflare Container support for the required private namespaces remains unverified; unavailable validation must prevent canonical advancement.

## Credentials and account selection

Connect the intended Cloudflare account through the environment configuration workflow. This is an authentication prerequisite, not another deployment approval. Use configured credentials through Wrangler normally. Do not put secrets in this document, application metadata, Git remotes, shell command arguments or the deployment manifest.

The control-plane harness needs `CLOUDFLARE_API_TOKEN` and an explicit `CLOUDFLARE_ACCOUNT_ID` or manifest `account_id`. The account needs Workers Paid/Artifacts, Workers, Durable Objects, Queues and Containers access. Token visibility does not prove API scope: provisioning first verifies an authenticated account and reads that account's Workers subdomain.

The application Worker needs `AUTH_TOKEN`, `ACTOR_ID`, separate `INGEST_TOKEN`, `GIT_BRIDGE_TOKEN` and the exact trusted `VALIDATION_CONFIG_HASH`. The executor gateway needs `GIT_BRIDGE_TOKEN`, `GIT_EXECUTOR_MANIFEST_JSON` and `GIT_REPOSITORY_TOKENS_JSON`. Its repository token map should give the canonical executor scoped write credentials and dependency/fork repositories scoped read credentials. Producer credentials must be separate. The live external-push experiment uses an independently scoped canonical write credential.

`GIT_EXECUTOR_MANIFEST_JSON` is this descriptor serialized as a secret binding:

```json
{
  "repositories": {
    "checkout-api": {
      "remote": "https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/converge/checkout-api.git",
      "tokenEnv": "CHECKOUT_EXECUTOR_GIT_TOKEN",
      "validation_profile": "checkout-effects-v2",
      "dependencies": ["payment-policy"]
    },
    "payment-policy": {
      "remote": "https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/converge/payment-policy.git",
      "tokenEnv": "PAYMENT_POLICY_READ_TOKEN"
    }
  }
}
```

`GIT_REPOSITORY_TOKENS_JSON` maps those environment variable names to token values. Provision it using secret-management stdin, never a committed file or command-line argument. Tokens minted by Artifacts use the documented repo token scope and expiry. The control-plane API token and repo Git tokens are different credentials.

## Provision and route the services

`scripts/cloudflare-live.mjs` supports three modes:

```sh
node scripts/cloudflare-live.mjs preflight
node scripts/cloudflare-live.mjs provision-events /path/outside/repository/live-manifest.json
node scripts/cloudflare-live.mjs verify /path/outside/repository/live-manifest.json
```

`preflight` prints credential **names**, authentication readiness and a report path. It exits with code 2 when authentication is absent. It does not start interactive login or create resources.

`provision-events` creates missing Artifacts repositories, the named Queue and repository-scoped native push subscriptions, retaining public IDs/remotes in its report. Artifacts creates a missing namespace when its first repository is created. Tokens returned by repo creation are discarded, not logged. The harness does not claim successful native event delivery from a successful control-plane create.

Push events require this subscription source:

```json
{
  "source": {"type":"artifacts.repo","namespace":"converge","repo_name":"checkout-api"},
  "destination": {"type":"queues.queue","queue_id":"<QUEUE_ID>"},
  "events": ["cf.artifacts.repo.pushed"],
  "enabled": true
}
```

Wrangler 4.147.0 accepts `artifacts.repo` as a CLI source but does not expose the required namespace/repository fields; this harness sends the documented REST body. Every registered producer fork also needs a scoped native push subscription. A conventional webhook or direct-ingress call is not evidence of this native path.

Deploy the trusted executor separately using `wrangler.executor.jsonc`, `worker/executor.mjs` and `Dockerfile.executor`. It uses the documented Durable Object Container APIs and one named instance per workspace. No extra SDK dependency is required. The gateway boots the Node bridge with private environment bindings, polls its authenticated health endpoint, and forwards each operation once. It never retries a forwarded canonical CAS after a lost response.

In a managed cloud build, preserve the configured Docker proxy/registry credentials and mount the public CA bundle:

```sh
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock build \
  --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt \
  --build-arg EXECUTOR_BASE_IMAGE=mirror.gcr.io/library/node:24-bookworm-slim \
  -f Dockerfile.executor -t converge-executor:release .
```

Use Cloudflare's registry push command to publish this built image, then set the executor config's `image` to its immutable registry reference. This lets Wrangler deploy the gateway without an automatic build that omits the session CA mount. `.dockerignore` admits only core/server/trusted fixture source into this build context; credentials, repository state, dependencies and browser build output are excluded.

Before account deployment, the gateway source can be bundled independently:

```sh
npx wrangler deploy --config wrangler.executor.jsonc --dry-run --containers-rollout=none
```

That command deliberately does not build or deploy a Container. A successful bundle is not execution evidence.

The supplied application Worker config binds the executor service:

```json
{"services":[{"binding":"GIT_EXECUTOR","service":"converge-git-executor"}]}
```

The supplied config uses one native Queue consumer and an `ANALYSIS_QUEUE` producer for the same Queue; its consumer handles native push and separate analysis messages. Native ingestion schedules analysis before acknowledging its delivery. Successful canonical resolutions also enqueue analysis of remaining work. The Durable Object serializes coordination and canonical decisions. Build the browser, upload secret bindings, then deploy the current application Worker.

Seed both repositories with ordinary Git pushes. Register `payment-policy` first with `validation_profile: "context-document-v1"`, then `checkout-api` with `validation_profile: "checkout-effects-v2"` and `context_repo: "payment-policy"`. Trusted profiles must match the executor manifest: registration checks the authenticated `/profile` RPC, and composition, validation and CAS reject coordinator/manifest mismatches. Producer metadata cannot select a profile. Repositories registered without a profile remain conventional review and do not require an executor for ingestion.

`GET /api/tasks`, `POST /api/tasks`, and `POST /api/tasks/:id/answer` or `/assume` implement the explicit context schema. The Worker decodes exact immutable Artifact blobs; bound commit trailers are parsed by Git through the executor. `POST /api/analysis` derives groups; manual `POST /api/decisions` no longer exists. `GET /api/diff?revision=<ID>` requests the exact immutable Git diff. `POST /api/recover` reconciles prepared operations.

The bridge pushes and independently reads back each `refs/converge/candidates/<COMMIT>` before returning a composition. Thus decision preparation does not rely on ephemeral Container disk as its sole retention boundary. Actual Artifacts support for these candidate refs remains part of live verification.

## The live acceptance manifest

Keep the manifest outside Git. It contains URLs and environment variable **names**, never secret values:

```json
{
  "account_id":"<ACCOUNT_ID>",
  "namespace":"converge",
  "queue":"converge-git-events",
  "url":"https://<DEPLOYED_APPLICATION_URL>",
  "ownerTokenEnv":"AUTH_TOKEN",
  "test_repo":"checkout-api",
  "executorControlUrl":"https://<PRIVATE_LIVE_TEST_GATEWAY_ROUTE>",
  "testTokenEnv":"LIVE_TEST_TOKEN",
  "repositories":[
    {"name":"checkout-api","remote":"https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/converge/checkout-api.git","tokenEnv":"CHECKOUT_EXTERNAL_GIT_TOKEN"},
    {"name":"payment-policy","remote":"https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/converge/payment-policy.git","tokenEnv":"PAYMENT_POLICY_READ_TOKEN"}
  ]
}
```

Populate the deployment with the arbitrary producer branches used in the deterministic acceptance application. The harness derives all review IDs from the actual `/api/workspace` response. It never submits fixture groups through `/api/decisions`.

`verify` performs these actual remote operations:

1. Clone Artifacts, create a new ordinary Git branch without provenance, push a new commit, and poll for that exact immutable head in the Worker. It never uses `/api/events` as an ingestion fallback.
2. Call `/api/analysis` and select a generated review component with a passing composed candidate.
3. Advance `main` with a separate ordinary Git push after capturing the reviewed basis. Submit that old basis and require `409 DECISION_STALE`; verify the authoritative remote remains at the external head.
4. Refresh, race two identical resolution requests, require exactly one success and one 409, and check one applied operation and its exact authoritative remote target.
5. Use the separately authenticated experimental gateway to drop one successful CAS reply, require recovery-required behavior, destroy the Container, call `/api/recover`, and compare the immutable prepared target with the exact authoritative remote head.
6. Fetch the resulting ordinary repository and run `git fsck --full`. Require the recorded stale-evidence acceptance metric to remain zero.

These checks mutate only the named acceptance repositories and do not delete any resources or branches. Recreate a fresh acceptance workspace before repeating them. Their report contains bounded observed evidence; an interrupted/failed run exits 2 and records `blocked`, not `passed`.

## Recovery fault controls

Gateway test controls are disabled by default (`LIVE_TEST_ENABLED=false`) and the gateway has `workers_dev=false`. For an isolated acceptance deployment, set `LIVE_TEST_ENABLED=true`, configure a distinct `LIVE_TEST_TOKEN`, and provide a private route reachable by the harness. Do not reuse the owner or Git bridge credential for fault controls.

The control endpoints are `/control/arm`, `/control/status` and `/control/restart`. Arming is durable and scoped to one repository and reviewed old head. The gateway records a successful real remote CAS receipt before withholding its response. Restart destroys the Container's ephemeral filesystem; the platform must recover by immutable decision metadata and authoritative Git, without replaying the update.

This demonstrates the uncertain executor-outcome and Container-restart window. It does **not** demonstrate a hard coordinator process kill immediately after Git CAS but before metadata receipt; that remains a separate live failure experiment. Without fault controls or two generated open components, the harness fails rather than reporting skipped recovery as passing.

## Documentation checked

- [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/): `readFile({ref,path})` returns `Blob|null`; decode using `await file.text()`.
- [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/): scoped repo tokens and namespace/repository routes.
- [Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/): repository-level native push schema.
- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/): startup environment, port forwarding, monitoring and destruction.
- [Container configuration](https://developers.cloudflare.com/containers/configuration/wrangler/): image/DO binding and instance configuration.

Deploying account resources, native delivery, private sandbox operation, candidate-ref retention, actual remote Git lease races and the complete verification harness all remain unverified until the authenticated live run succeeds.
