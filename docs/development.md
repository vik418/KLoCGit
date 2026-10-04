# Development

## Requirements

Use Node.js 24 and the lockfile with `npm ci`. Git is required for workspace creation and integration tests. The Node Git adapters currently invoke `/usr/bin/git`; use Linux or WSL for a consistent development environment.

Executable application tests additionally require bubblewrap, util-linux (`prlimit` and `unshare`) and permission to create private namespaces. On Debian or Ubuntu:

```sh
sudo apt-get install git bubblewrap util-linux
```

A quick namespace diagnostic is:

```sh
unshare --user --map-root-user --net true
```

This probes only part of the runner setup. The application test checks the complete configured sandbox. A host or container can deny namespaces even when the packages are installed; do not remove isolation to make a test pass.

## Local workspace

`npm run dev` starts the API and Vite interface at <http://localhost:43187>. Environment settings:

| Variable            | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `HOST`              | Bind address; default `127.0.0.1`                 |
| `PORT`              | HTTP port; default `43187`                        |
| `DECISION_GIT_ROOT` | Workspace directory; default `.demo-v2/`          |
| `LOCAL_ACTOR_ID`    | Local owner identity; default `demo-owner`        |
| `LOCAL_OWNER_TOKEN` | Optional Bearer credential for local API requests |

The server binds localhost by default. To expose it to another machine or a container network, explicitly set `HOST=0.0.0.0` and configure `LOCAL_OWNER_TOKEN` through your environment. Keep that endpoint on a trusted network. This is a development server, not an organizational authentication service.

The workspace contains `state.json`, bare Git repositories, baseline copies and producer clones. The UI reset action recreates the sample workspace and deletes its previous contents. Use only a disposable directory for `DECISION_GIT_ROOT`.

With the server stopped, `npm run demo:reset` recreates the default `.demo-v2/` workspace. It deletes the previous sample data and does not reset a custom `DECISION_GIT_ROOT`.

Stop the server before backing up or restoring the whole workspace. Coordination metadata and Git repositories should be saved together. If metadata is missing but repositories remain, startup stops rather than overwriting the repositories.

## Tests and checks

Use the repository formatter and linter:

```sh
npm run format
npm run lint
```

`format` writes formatting changes; `format:check` checks them without writing. `lint:fix` applies available lint fixes. Review those edits before committing.

Run the full suite on a Linux host that supports the sandbox:

```sh
npm test
```

For a change to MR lifecycle, queue policy, source versions or recovery, the real Git workflow tests provide a useful focused run without executing candidate application code:

```sh
node --test tests/workflow-integration.test.mjs
```

For runner or fixture changes:

```sh
node --test tests/application.test.mjs
```

Other tests are grouped by the module they exercise: context, components, evidence safety, ingress, MRs, queue, reverts and Cloudflare adapters. Use Node's `--test-name-pattern` when narrowing an individual regression. Tests create temporary repositories and remove them after use; keep tests independent of the interactive `.demo-v2/` workspace.

[The capability registry](../core/capabilities.mjs) records current support and its limits, with links to the relevant test suites. Update it when changing a supported workflow. These links identify coverage; they are not records of tests having passed.

Check browser and Worker builds:

```sh
npm run build
npm run check:worker
npm run check:executor
```

`npm run check` runs formatting checks, lint, tests, the browser build and both Worker dry runs. The dry runs do not deploy resources or test remote Git. Live checks are described in [Cloudflare deployment](cloudflare.md).

## Common failures

- **Git cannot be started:** check `/usr/bin/git` and use Linux/WSL for the Node adapters.
- **`validation-unavailable`:** check bubblewrap, `prlimit`, namespaces and the complete application test. Failed validation cannot authorize an application.
- **`DECISION_STALE` or `MR_STALE`:** fetch current state, prepare or refresh, then review again. Do not retry the old authorization with a new head.
- **`RECOVERY_REQUIRED`:** call the recovery route and inspect the prepared operation and authoritative Git ref. Avoid manual metadata edits that guess whether Git changed.
- **`WORKSPACE_METADATA_MISSING`:** restore the workspace metadata alongside its repositories. Do not reset a workspace containing code you need to preserve.

See [contribution guidelines](../CONTRIBUTING.md) for change and review expectations.
