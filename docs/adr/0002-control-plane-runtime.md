# ADR 0002: Control-plane runtime

Status: Accepted for D001.

## Decision

Retain JavaScript ES modules for the control plane. Cloudflare Workers runs
the API, ingestion and coordinator adapters. Node.js 24 runs local tooling,
tests and the existing local server; it is not the production Worker runtime.

Keep provider dependencies behind adapters. Validate untrusted and persisted
values at runtime. This decision does not select the composition/analysis
implementation language (D002), CBOR tooling (D006), or product SLOs (D010).

## Evidence

At `ecaf33a2`:

- `worker/index.mjs` already implements Worker request/queue handlers and
  the Durable Object coordinator.
- `.nvmrc` and `package.json` select Node.js 24 for local execution.
- [CI run 37961313641](https://github.com/vik418/KLoCGit/actions/runs/37961313641)
  passed 487 tests, browser checks, formatting, lint, builds and both
  Worker/executor dry runs.
- Domain dependency tests enforce separation from static Cloudflare imports.
- Locked dependencies and one verification command provide an existing
  reproducible development path.

These checks establish current integration compatibility. They do not
establish v1 correctness, live deployment behavior or performance.

## Alternatives

- TypeScript: emits JavaScript for the same runtime and adds static checking.
  The repository has TypeScript tooling, but control-plane type checking is
  not configured. It remains an incremental tooling option; a migration is
  not required to resolve D001.
- Go/Rust compiled to WebAssembly: would require a new integration with the
  Worker handlers and provider bindings. This repository has no control-plane
  parity or startup measurements supporting that change.
- Python: would require porting the existing handlers, adapters and shared
  domain integration. This repository has no equivalent integration evidence.

The alternatives may improve specific workloads. No comparative latency,
startup, dependency-maintenance or operating-cost result is currently available.

## Consequences

Retaining the working integration avoids a control-plane rewrite before its
domain contracts are implemented. Runtime validation and state-machine tests
remain necessary; JavaScript does not provide static enforcement.

Measure startup, latency and coordinator saturation in the ordered validation
tasks. Reopen D001 if measured runtime behavior prevents meeting established
requirements, or a representative alternative demonstrates sufficient benefit
to justify migration.

No frozen architecture assumption was falsified by this decision.
