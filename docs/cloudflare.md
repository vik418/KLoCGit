# Cloudflare deployment

KLoCGit deploys as an application Worker (`clocgit`) and a private Git executor Worker (`klocgit-git-executor`) with a Container. Artifacts stores ordinary Git repositories in the `klocgit` namespace; the `klocgit-git-events` Queue carries push events and analysis jobs; a workspace Durable Object serializes coordination. The application Worker keeps its existing `clocgit` resource name so its Workers Builds connection and canonical coordination state remain attached to the same Worker.

## Existing deployments and repository rename

These names are defaults for new infrastructure. Changing the repository files does not provision, rename or migrate Cloudflare account resources. Existing `converge` repositories, `converge-git-events` messages and subscriptions, and the `converge-git-executor` service remain where they are. If they contain work, keep their namespace, Queue and service names in the deployment configuration until a migration is planned; do not point existing canonical metadata at empty repositories. Keep the application Worker name `clocgit`, its Durable Object class/migration and `WORKSPACE_ID=northstar` unchanged.

After the GitHub repository rename, confirm Workers Builds is connected to `vik418/KLoCGit`; select the renamed repository if the dashboard connection does not follow automatically. For a new `klocgit` deployment, create the matching repositories, Queue and push subscriptions below, then deploy `klocgit-git-executor` before the application. Legacy `refs/converge/candidates/*` remain available for reads and recovery; new retained candidates use `refs/klocgit/candidates/*`.

## Prerequisites

Use Node 24, Git, and a running Docker engine. The Cloudflare account needs Workers Paid and access to Artifacts, Queues, Durable Objects, and Containers. A Dashboard GitHub build alone does not provision repositories, credentials, or the executor.

From the repository root:

```sh
npm ci
npx wrangler login
npx wrangler whoami
```

Select the same account for both Worker deployments. Wrangler's OAuth login authenticates Wrangler commands. The REST provisioning helper separately requires `CLOUDFLARE_API_TOKEN`, with account permissions for Artifacts, Queues, event subscriptions, and the Workers subdomain read it performs.

In the examples below, `/outside` means a private directory outside this repository. Choose a real directory and restrict its permissions. Keep tokens out of Git, provenance, remotes, and command-line arguments.

## Create repositories and native event subscriptions

Save this non-secret deployment manifest as `/outside/live-manifest.json`:

```json
{
  "account_id": "<ACCOUNT_ID>",
  "namespace": "klocgit",
  "queue": "klocgit-git-events",
  "repositories": [{ "name": "checkout-api" }, { "name": "payment-policy" }]
}
```

Supply the REST token through your credential manager or environment, then run:

```sh
node scripts/cloudflare-live.mjs preflight
node scripts/cloudflare-live.mjs provision-events /outside/live-manifest.json
```

The helper creates missing repositories, the Queue, and repository-scoped `cf.artifacts.repo.pushed` subscriptions. It records public remotes and resource IDs in `.demo/live-cloudflare-report.json`; it discards tokens returned by repository creation. It does not seed repositories or establish event delivery.

Issue a separate executor Git token for each repository:

```sh
npx wrangler artifacts repos issue-token checkout-api \
  --namespace klocgit --scope write --ttl 2592000 --json \
  > /outside/checkout-executor-token.json
npx wrangler artifacts repos issue-token payment-policy \
  --namespace klocgit --scope write --ttl 2592000 --json \
  > /outside/policy-executor-token.json
```

Issue producer tokens separately. Executor repositories need write access when composing candidates: retention pushes `refs/klocgit/candidates/*` before any canonical update. Read access suffices only for a repository used strictly as a dependency.

Copy the contents of `fixtures/checkout-api/` and `fixtures/payment-policy/` into two separate ordinary Git repositories. For each, create and commit `main`, add the returned Artifacts remote, and push `main` using its scoped producer token. Authenticate Git through an environment-supplied `http.extraHeader` or a credential helper; do not embed tokens in remote URLs. Both repositories must have an initial commit before registration.

## Configure the executor and application

The executor needs three secret bindings: `GIT_BRIDGE_TOKEN`, `GIT_EXECUTOR_MANIFEST_JSON`, and `GIT_REPOSITORY_TOKENS_JSON`.

Use the remotes returned by Artifacts in this executor manifest:

```json
{
  "repositories": {
    "checkout-api": {
      "remote": "<CHECKOUT_ARTIFACTS_REMOTE>",
      "tokenEnv": "CHECKOUT_EXECUTOR_GIT_TOKEN",
      "validation_profile": "checkout-effects-v2",
      "context_repo": "payment-policy",
      "dependencies": ["payment-policy"]
    },
    "payment-policy": {
      "remote": "<POLICY_ARTIFACTS_REMOTE>",
      "tokenEnv": "PAYMENT_POLICY_EXECUTOR_GIT_TOKEN",
      "validation_profile": "context-document-v1"
    }
  }
}
```

The token map contains the corresponding executor token values:

```json
{
  "CHECKOUT_EXECUTOR_GIT_TOKEN": "<CHECKOUT_EXECUTOR_TOKEN>",
  "PAYMENT_POLICY_EXECUTOR_GIT_TOKEN": "<POLICY_EXECUTOR_TOKEN>"
}
```

Prepare `/outside/executor-secrets.json` as a JSON object whose three binding values are strings. Serialize the manifest and token map with `JSON.stringify()`; nested objects are not secret-binding values. For example, the structure is:

```json
{
  "GIT_BRIDGE_TOKEN": "<SEPARATE_SERVICE_CREDENTIAL>",
  "GIT_EXECUTOR_MANIFEST_JSON": "{\"repositories\":{...}}",
  "GIT_REPOSITORY_TOKENS_JSON": "{\"CHECKOUT_EXECUTOR_GIT_TOKEN\":\"...\",\"PAYMENT_POLICY_EXECUTOR_GIT_TOKEN\":\"...\"}"
}
```

Replace the illustrative ellipses with the complete serialized objects. Configure all intended repositories before the Container starts. Adding a producer fork requires its own subscription, manifest entry with the approved profile/context, scoped token, and platform fork registration.

Compute the trusted validation hash from the exact source being deployed:

```sh
node --input-type=module -e \
  "import {applicationValidationConfigHash} from './server/runner.mjs'; console.log(await applicationValidationConfigHash());"
```

Prepare `/outside/application-secrets.json`:

```json
{
  "AUTH_TOKEN": "<OWNER_CREDENTIAL>",
  "ACTOR_ID": "<OWNER_ID_FOR_AUDIT_RECORDS>",
  "INGEST_TOKEN": "<SEPARATE_INGRESS_CREDENTIAL>",
  "GIT_BRIDGE_TOKEN": "<SAME_SERVICE_CREDENTIAL_AS_EXECUTOR>",
  "VALIDATION_CONFIG_HASH": "<SOURCE_HASH_FROM_COMMAND_ABOVE>"
}
```

The current owner credential maps to one configured actor identity. Recompute the validation hash and update both deployments when trusted runner or supervisor source changes.

## Deploy and register

Deploy the private executor first; the application service binding names it:

```sh
npx wrangler deploy --config wrangler.executor.jsonc \
  --secrets-file /outside/executor-secrets.json
npm run build
npx wrangler deploy --config wrangler.jsonc \
  --secrets-file /outside/application-secrets.json
```

The executor has `workers_dev:false`. Its authenticated `/health` and `/profile` endpoints are private service operations, not browsable public URLs. Changing secrets does not prove a running Container received new values: its environment is populated on startup. Token rotation and manifest changes require a verified Container restart or rollout.

At the deployed application URL, send authenticated `POST /api/repositories` requests using `Authorization: Bearer <AUTH_TOKEN>`. Register policy first, then checkout:

```json
{ "name": "payment-policy", "validation_profile": "context-document-v1" }
```

```json
{
  "name": "checkout-api",
  "validation_profile": "checkout-effects-v2",
  "context_repo": "payment-policy"
}
```

Registration checks the executor profile and requires existing canonical Git heads. Open the application and enter the owner credential. A new deployment starts empty; local demo producers do not run automatically.

After bootstrap, configure Workers Builds under **Settings → Build**:

- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Branch control:** production branch `main`; disable **Enable Preview Builds**.

The separate Preview command defaults to `npx wrangler preview`, which requires a `previews` block that this repository does not configure. Use GitHub CI for branch checks. Full branch previews need isolated repositories and Durable Object storage: preview service bindings call the bound service's production deployment, and Queue consumers cannot target a preview. Do not copy the production executor or Queue bindings into a preview config. See [preview limitations](https://developers.cloudflare.com/workers/previews/limitations/).

Optionally create the checkout context task with authenticated `POST /api/tasks`, then answer its question in the UI:

```json
{
  "schema": "retry-response-v1",
  "statement": "Recover checkout when a processed payment response is lost.",
  "target_repo": "checkout-api",
  "scope": ["client/retry.mjs"],
  "context_source": {
    "repo": "payment-policy",
    "ref": "refs/heads/main",
    "path": "checkout-policy.json"
  }
}
```

## First verification and operating limits

Push a fresh noncanonical branch after registration and confirm its exact commit appears in Work. Events received before registration are ignored. Unknown provenance is valid. Native events enqueue analysis; retained candidate refs are excluded from producer ingestion. Open an MR for the ingested work, or use authenticated `POST /api/analysis` to derive decision components.

Canonical updates use an explicit Git `--force-with-lease` against the reviewed old head plus a decision-basis check. A stale resolution returns `409 DECISION_STALE`; refresh the decision before resolving again. Use authenticated `POST /api/recover` to reconcile uncertain prepared updates against authoritative Git.

Live event delivery, Artifacts candidate-ref retention, Git lease races, Container recovery, and private namespace sandbox support require verification in the target account. A build or Worker dry run establishes bundling only. If the sandbox cannot start, checkout validation remains unavailable and canonical advancement stays blocked; do not replace it with unsandboxed execution. See [architecture](architecture.md) and [native workflows](workflows.md) for the model and API behavior.

`node scripts/cloudflare-live.mjs verify /outside/live-manifest.json` is an optional invasive acceptance test for disposable repositories. It pushes branches, advances canonical state, resolves decisions, and injects a lost-response/restart fault. It requires a deployed URL, repository Git credentials, two generated open decision components, and a separate private fault-control route/token with `LIVE_TEST_ENABLED=true`. The default private executor cannot receive those external control calls. This helper is not an initial smoke test.

Cloudflare references: [Artifacts binding](https://developers.cloudflare.com/artifacts/api/workers-binding/), [Git authentication](https://developers.cloudflare.com/artifacts/guides/authentication/), [event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/), and [Containers](https://developers.cloudflare.com/containers/).
