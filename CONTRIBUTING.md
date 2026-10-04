# Contributing

Read the [architecture](docs/architecture.md) and [development guide](docs/development.md), then make a focused change on a branch. Include the problem, resulting behavior and relevant checks in the pull request. Raise an issue before adding a broad feature or a new infrastructure dependency.

## Design rules

- Keep Git operations in the adapters and domain policy in `core/`; the browser must not decide authorization or evidence trust.
- Preserve immutable revision, context, relationship and evidence references. Changed inputs create new records or explicitly invalidate eligibility.
- Require both the reviewed basis and expected Git head for canonical changes. Preserve the prepared-operation journal and recovery behavior.
- Keep producer declarations separate from observed Git facts and trusted checks. Passing finite tests establish only their listed assertions.
- Keep ordinary Git usable when coordination fails. Do not delete or recreate repositories to repair metadata.
- Treat producer code and metadata as untrusted. Do not add an unsandboxed execution fallback or put secrets in provenance.

## Testing and review

Add regression coverage for changed behavior, especially stale sources, concurrent writes, policy changes and failure/recovery paths. Use actual temporary Git repositories when testing ref semantics. Avoid tests that only repeat the implementation or rely on sample decision counts as a product guarantee.

Run focused tests while developing, apply `npm run format`, then run `npm run check`. Report any checks that require unavailable infrastructure. A successful Worker dry run is a bundle check, not deployment verification.

Keep documentation short and update it when an interface or deployment requirement changes. Commit source and necessary fixtures, not local workspace state, build output, screenshots or test reports. Keep configuration examples free of credentials.

Use existing naming and formatting conventions. Separate mechanical refactors from behavior changes when that makes review easier. New dependencies should solve a concrete problem and have a clear maintenance cost.
