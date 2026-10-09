# ADR 0001: Repository engineering contract

Status: Accepted for T000.

## Context

The v0 repository already separates domain code in `core/` from Node and Worker integrations. It has unit, real-Git integration and browser checks. T000 requires an enforceable boundary and a clean-checkout verification command.

## Decision

- `core/`: provider-independent domain package. Cloudflare SDKs and imports from API, runtime, UI or fixture modules are prohibited by ESLint.
- `adapters/`: environment and provider integrations. Local startup configuration lives in `adapters/local/`.
- `api/`: HTTP contracts. Existing v0 handlers remain in `server/` and `worker/` until their ordered interface tasks require migration.
- `server/`: existing local runtime, Git transport and evaluator adapters.
- `worker/`: Cloudflare entrypoints and existing provider adapters.
- `tests/`: unit, integration and browser acceptance coverage.
- `benchmarks/`: M12 workloads and measurement results.
- `docs/adr/`: implementation decisions and their evidence.

`npm run verify` installs locked dependencies, runs formatting, lint, unit/integration tests, builds, Worker dry runs and browser smoke tests. CI uses this same command after installing host prerequisites. A failing step stops verification.

Startup settings are validated before workspace or executor initialization. Port zero remains valid because the browser harness requests an OS-assigned port. Configuration errors identify settings without echoing supplied values.

## Evidence

- Main `16a7c4e` has 20 domain modules with no provider imports.
- Existing CI covers real Git workflows and the isolated checkout application.
- `tests/browser-native.smoke.mjs` explicitly uses `PORT=0`.
- `tests/runtime-config.test.mjs` checks rejected startup settings leave no workspace and do not open the executor manifest.
- `tests/domain-boundary.test.mjs` exercises the configured boundary on domain modules and prohibited imports/re-exports.

## Consequences

Existing v0 behavior is preserved; it is not marked as v1 compliant. D001-D010 remain open. This repository contract does not select CBOR tooling, an authorization provider, a new analysis language or a deployment protocol.

No frozen architecture assumption was falsified in T000.
