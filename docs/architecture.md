# Architecture

Git stores code and remains usable independently of KLoCGit. KLoCGit stores coordination metadata: intent, proposal revisions, relationships, validation evidence, decisions and audit history.

```text
Git push → immutable revision → relationship analysis → candidate composition
                                                         ↓
Canonical Git ← reviewed decision + Git CAS ← exact validation evidence
```

## Code boundaries

| Directory   | Responsibility                                                                 |
| ----------- | ------------------------------------------------------------------------------ |
| `core/`     | Domain records, context, analysis, decisions, MR policy and queue state        |
| `server/`   | Local HTTP server, shared workflow API, Git adapters and trusted executor      |
| `worker/`   | Cloudflare API/event handlers, workspace Durable Object and Container gateway  |
| `src/`      | React interface; it presents server state and submits versioned requests       |
| `fixtures/` | Sample application, policy repository and platform-owned validation supervisor |
| `scripts/`  | Local workspace setup and Cloudflare helpers                                   |
| `tests/`    | Domain, HTTP, real Git and isolated application regression tests               |

The local server and Cloudflare Worker use the same engine. Local state is a JSON workspace file; Cloudflare state is held by a Durable Object. The Git adapter performs code reads, creates candidate commits and updates refs.

## Immutable inputs

A proposal is a logical work history. Each new source commit produces a ProposalRevision with exact base/head commits, tree hash, context version and affected paths. Rebase and force-push create revisions rather than rewriting old analysis.

Context, relationships, compositions, evidence and decisions reference immutable inputs. IDs hash canonically serialized data. Mutable source pointers, lifecycle status and evidence eligibility are separate from historical records.

Two identical Git trees can share an Implementation reference while retaining separate intents and provenance. Unknown provenance is accepted. Git events are deduplicated and checked against authoritative refs; delivery timestamps do not establish order. Canonical pushes update observations instead of creating proposals. New internal candidates are retained under `refs/klocgit/candidates/`; legacy `refs/converge/candidates/` remains readable for recovery. Both reserved namespaces are excluded from producer ingestion.

## Context and relationship analysis

Context items distinguish declared, retrieved, observed and inferred information. Advisory constraints cannot cause automatic rejection. An unresolved assumption stays unresolved even when it has a plausible explanation.

The context compiler currently supports the explicit `retry-response-v1` task. It retrieves policy from another repository at a pinned commit and asks a material retry question. An answer or explicit assumption creates a snapshot that can be bound to a producer commit. Unrelated ordinary Git work remains available while that task waits.

Relationship analysis uses exact tree identity, affected paths, declared choices and configured validation footprints to select comparisons. Declared alternatives and observed interactions form decision groups. A clean textual merge is only a candidate: the resulting tree must be validated. Missing relationships do not establish compatibility, and semantic hints cannot authorize a merge.

## Evidence

Trusted validation runs on an exact candidate tree with pinned configuration, constraints and dependency heads. The application runner counts effects received by a platform-owned simulated provider, rather than trusting candidate logs or producer tests.

Evidence establishes only its listed checks. Passing finite tests does not establish global correctness. External CI reports are recorded as declarations and cannot impersonate platform-owned checks.

A changed head, constraint or validation configuration makes old evidence ineligible without deleting its result. Reruns append new results; a newer failed, pending or cancelled run cannot be bypassed by selecting an earlier pass for the same inputs. MR checks and application require current evidence for the actual selected composition.

## Canonical updates

Every application requires an authenticated decision and checks both:

1. The reviewed decision basis, including revisions, relationships, contexts, MR/dependency policy and evidence.
2. The expected canonical Git head.

The coordinator serializes its own operations, records the decision and a prepared operation, then performs Git compare-and-set against the old object ID. Local Git uses `update-ref` with the expected old ID; the remote executor uses an explicit `--force-with-lease`. This protects against ordinary clients pushing outside the coordinator.

A stale basis or head returns `409 DECISION_STALE`. Refresh rebuilds candidates and exposes current inputs for renewed review. Queue tickets pin an already reviewed composition and stop when it becomes stale; they do not silently adopt a rebuilt candidate.

An uncertain Git result blocks subsequent writes. Recovery reads the authoritative ref and recognizes only the exact prepared target. It never repeats an uncertain canonical update to guess its outcome. Candidate objects are retained in Git before remote preparation, so recovery does not depend on ephemeral Container storage.

One canonical operation advances one repository. Other repository heads can be validation dependencies, but they are not locked against external pushes. Multi-repository application would need an explicit release and recovery protocol.

## Security and current limits

Repositories, producer metadata and candidate code are untrusted. Candidate execution uses private namespaces, a read-only tree/runtime, a scrubbed environment and resource limits. If isolation is unavailable, validation fails closed. Credentials remain outside candidate code and provenance. See [security policy](../SECURITY.md).

The application currently has one configured owner, not organizational login or RBAC. MR targets are restricted to the registered canonical ref. General retargeting, reviewer assignment/CODEOWNERS, general CI execution and GitHub/GitLab connectors are not implemented. Relationship filtering still scans workspace metadata and is not a production-scale index.

Record immutability and hash-linked audit history are application-managed. Storage does not independently enforce append-only retention or anchor audit hashes externally. Applied and deferred revision outcomes are recorded; general rejected/superseded workflows are not implemented.

Cloudflare adapters and deployment configuration are present. New executor, Queue and Artifacts resource names use `klocgit`; the application Worker retains its existing `clocgit` name and canonical Durable Object identity. A source rename does not migrate populated account resources. Their live event, lease, restart and sandbox behavior must be checked in the target account; local tests and dry runs do not establish those properties. See the [deployment runbook](cloudflare.md).
