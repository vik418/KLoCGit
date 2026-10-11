# External deployment contract

Status: accepted. Resolves D007.

Argo CD and GitHub Actions receive an exact SystemRevision and its provider-neutral ReleaseConstraints. Registered adapters translate those records. Unsupported constraints reject submission; they are never ignored.

Submission includes an authenticated tenant/system scope and idempotency key. The control plane persists an attempt before calling the provider. An ambiguous attempt is reconciled rather than automatically dispatched again. Provider observations remain separate from verified deployed state.

Argo CD owns application synchronization. GitHub Actions owns its configured deployment workflow. KLoCGit does not implement rollout, rollback or compensation. A successful provider run alone does not verify the deployed repository OIDs.

Contracts are tested against provider HTTP responses. Live runs remain part of release validation.
