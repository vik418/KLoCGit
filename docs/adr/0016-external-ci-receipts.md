# External CI receipts

Status: accepted.

External CI observations use domain-separated deterministic CBOR and detached Ed25519 signatures. An authoritative registry binds each evaluator key to a version, repository mappings and independently controlled configuration digests. Producer tests cannot grant themselves trusted evaluator status.

The adapter authenticates the caller, verifies scope/signature/recipe grants and rereads every exact Git commit/tree before creating Evidence. Passing, failed, cancelled and pending observations remain separate immutable records. Current policy decides eligibility.

A signature authenticates the publisher's observation; it does not prove test quality or semantic correctness. Publisher keys stay outside untrusted code execution. CI providers translate their authenticated run observations into this protocol; live publisher integration is required before release.

Seven real-Git/Ed25519 tests cover isolated reuse, composed-state rejection, forgery, scope, unsupported recipes, failed/cancelled observations and ref movement. Receipt replay produces the same Evidence identity; authoritative consumers persist it idempotently.
