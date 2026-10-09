# CODEX

## Mission

Implement KLoCGit v1 exactly against the frozen architecture in ARCHITECTURE.md and the ordered backlog in TASKS.md.

KLoCGit is a software-state convergence system. Git stores source state. KLoCGit owns convergence, evaluation, decisions, and promotion metadata. External CD owns deployment execution and recovery.

## Non-negotiable rules

- Do not redesign the architecture unless a validation result falsifies an explicit assumption.
- Do not invent product requirements, provider limits, or security guarantees.
- Keep authoritative state separate from rebuildable projections, caches, indexes, and model outputs.
- AI/model output is INFERRED. It never authorizes canonical mutation or irreversibly removes a materially distinct implementation.
- Canonical Git mutation requires compare-and-swap against the expected ref OID.
- A PARTIAL analysis may be reviewable but cannot make a Decision resolvable when required capabilities are incomplete.
- Ephemeral Candidate materialization stays local to the executor. Do not write speculative Candidate trees to the durable GitStore.
- Reuse external CI Evidence only when it matches the exact subject state and satisfies policy. Novel composed Candidates require exact-state evaluation.
- Queue/event payloads must be bounded. Large payloads use claim-check references with digest verification.
- External CD owns rollout, rollback, health checks, retries, and compensation. KLoCGit submits desired state/constraints and verifies observations/attestations.
- Deployment timeout means UNKNOWN, not FAILED. Reconcile observed state before concluding outcome.
- Forward-port only when conservatively safe. Uncertain interaction becomes STALE.
- Immutable does not mean immortal. Apply retention classes.
- No canonical credentials or production secrets inside untrusted execution.
- Never silently downgrade a required semantic capability. Required PARTIAL, FAILED, or UNSUPPORTED blocks resolution.

## Engineering discipline

For every task:

1. Read its dependencies and acceptance criteria.
2. Write/update tests before marking it complete.
3. Keep provider-specific code behind the declared interfaces.
4. Record assumptions in code or ADRs where they affect correctness.
5. If implementation evidence conflicts with the architecture, stop that task and record:
   - assumption falsified
   - evidence
   - affected invariant/interface
   - smallest architecture decision that must reopen
6. Do not broaden scope to deployment orchestration, a new forge UI, custom CI, or general-purpose static analysis.

## Required repository hygiene

- Domain types must not import Cloudflare-specific SDK types.
- Provider adapters may depend on Cloudflare SDKs.
- Every persisted schema and event has schema_version.
- Every irreversible operation has an idempotency key.
- Every content digest is algorithm-tagged and domain-separated.
- Set-like fields have canonical ordering before deterministic serialization.
- Logs are structured and contain trace IDs, object IDs, state transitions, and failure class. Never log secrets.

## Definition of done

v1 is done only when the completion criteria in VALIDATION.md pass. Passing unit tests alone is not sufficient.
