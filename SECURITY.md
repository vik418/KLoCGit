# Security

KLoCGit is under development. There is no published support schedule; fixes target the current source tree.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** option when available. Otherwise contact the repository owner privately before opening a public issue. Include affected code, reproduction steps and impact, with credentials and private repository content removed. If a secret was exposed, revoke it rather than attaching it to the report.

## Running the application

The local server binds localhost by default and has one configured owner. If you set `HOST=0.0.0.0` for access from other machines or containers, configure `LOCAL_OWNER_TOKEN` and keep the endpoint on a trusted network. Do not use that setup as a multi-user authorization boundary.

Cloudflare deployments use separate owner, ingress and executor credentials. Scope repository tokens to the operations their producer or executor needs. Keep secrets out of Git, coordination metadata, URLs and logs; use the secret mechanisms in the [deployment runbook](docs/cloudflare.md). Rotate exposed tokens and verify the executor restarted with the replacement credentials.

Treat repository contents, producer metadata and generated code as untrusted. Candidate execution must retain namespace isolation, a read-only tree/runtime, a scrubbed environment and resource limits. If isolation fails, validation must fail. Never fix a validation failure by running candidate code directly with service credentials.

Do not rely on producer-supplied tests or a declared CI result as the sole authorization to update canonical Git. Canonical writes require an authenticated actor, current trusted evidence, the reviewed basis and a Git old-head check.

Do not repeat a Git write after an uncertain response. Preserve the prepared operation and use recovery to observe the authoritative ref. See [architecture](docs/architecture.md) for the trust and persistence boundaries.

The Container fault-control routes are disabled by default. Enable them only in a disposable acceptance deployment with separate credentials and private routing.
