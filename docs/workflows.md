# Native Git collaboration workflows

ClocGit implements review metadata above native Git repositories. The default screen remains decision focused. **Work** provides merge requests, conventional proposal review and the merge queue; each route leads back to an exact, validated decision before canonical Git changes.

The selected integration is native Cloudflare Artifacts. GitHub and GitLab connectors were considered as alternative ingress/review surfaces; neither is implemented. Native merge requests are ClocGit records, not mirrored GitHub PRs or GitLab MRs.

The [capability registry](capabilities.md) is the claim boundary for individual workflows and the exact twelve-case local acceptance gate. The secondary product dialog and authenticated `GET /api/capabilities` use that same source. Broader planning is in [the nineteen-domain roadmap](product-roadmap.md).

## Scope and identity

Local requests use one configured owner identity, `demo-owner` by default. `LOCAL_ACTOR_ID` selects that identity and `LOCAL_OWNER_TOKEN` can authenticate local API callers. The Worker uses its configured owner credential and `ACTOR_ID`; ingress has separate service authentication. Client-supplied actor fields cannot impersonate another reviewer.

The domain model records authors and reviewer identities, but the running application has no organizational membership service, multi-user login, reviewer invitation or repository role administration. The default policy requires no separate MR approvals (`minApprovals: 0`) and allows self-approval when a positive approval requirement is configured. The explicitly reviewed Decision remains the human authorization gate for every canonical change. Configurable approval rules are implemented; a production multi-user identity boundary is deferred. Integration tests explicitly configure one required approval to exercise that additional gate.

An unanswered task clarification blocks only producers following that task. Ordinary Git pushes, native MRs and independent conventional review remain available. The lightweight integration tests use the `payment-policy` repository's `context-document-v1` validator while leaving the application task unanswered.

## Merge request lifecycle

Open an MR from an existing branch in the canonical repository or a registered producer fork. Its source ref resolves to an observed immutable commit and ProposalRevision. Opening, editing, draft/ready, closing and reopening change coordination metadata without advancing canonical Git.

Every metadata write supplies the displayed `expected_version` or event ID. Reviews, comments and reported checks also supply `expected_revision_id`. Append-only events retain the prior versions. An optional `request_id` replays the original receipt; reusing it with a different actor or payload is rejected.

Draft and closed requests stay out of automatic convergence analysis. A ready, open request can join derived decisions or be explicitly selected for a conventional review. A merged request retains its history. Source force-push/rebase creates a new revision, makes old reviews/comments/checks historical and requires any policy-mandated approvals on the new revision. Source deletion withdraws active work while preserving its revision and discussion history.

Canonical Git movement from an ordinary client is observed independently. An MR is recognized as externally merged only when its exact source commit is an ancestor of the observed canonical head. Matching trees, patches or squash messages alone do not establish a merge. A later canonical force-push does not erase the historical merge event.

## Reviews, comments and checks

Reviews support approval, requested changes, non-approval comments and authorized dismissal. Approval counts distinct current reviewers and applies the configured self-approval policy. Batch review preflights every supplied version and source revision before appending reviews; batch application separately requires the policy of every included MR.

Discussion threads can attach to a path and line verified in the pinned commit, receive replies, and be resolved or reopened. Historical threads remain attached to their original revision. Thread resolution is visible coordination metadata; unresolved threads are not currently an additional canonical-write gate.

Reported CI states are `declared`, even when their names resemble platform checks. A reported `passed` result cannot supply trusted verification. Platform checks run against an actual candidate composition using the configured trusted validation profile. Evidence binds its exact tree, configuration, constraints and dependency heads, and states only what the finite checks establish.

Required checks use the latest current trusted proof for each exact subject/tree/configuration lineage. A failed, pending, running or cancelled result cannot revive an older passing proof, even if it contains a residual `passed: true` field. A fresh pass creates new evidence and changes the reviewed basis. Selected composition checks stay scoped to that actual composed tree rather than treating individual-tree results as substitutes. General asynchronous check scheduling/cancellation remains future work.

Repository policy supports minimum approvals, self-approval and named required platform checks. A requested change, missing approval, missing trusted check, draft/closed/deleted source, changed source head or unsatisfied dependency blocks application. Changes to the reviewed MR, policy, evidence or dependency basis require renewed decision review.

## Explicit and batch application

Select one or more immutable revisions in one repository and prepare a review. The coordinator builds an actual Git candidate, retains its commit, runs platform validation and returns the composition plus reviewed basis. No canonical write occurs while preparing it.

The same path supports native MRs, batch compositions and standalone ordinary Git proposals without an MR. Unknown provenance remains visible. Passing checks do not authorize automatic application: the owner still reviews the selected composition and rationale. Current review counts include actionable unanalysed work, count an explicitly prepared selection once, retain unrelated conventional work, exclude draft/closed requests and stop counting settled selected revisions.

Applying submits the selected alternative, basis hash and expected canonical head. The coordinator rechecks current source heads and MR requirements, persists an immutable decision and prepared operation, then executes true Git old-OID CAS. A stale basis or head returns `409 DECISION_STALE`; a moved/deleted source or MR metadata can return `MR_STALE` or `MR_BLOCKED`. Refresh exposes the changed composition and inputs before another apply attempt.

One operation advances one repository. Cross-repository dependencies must be satisfied separately; no multi-repository transaction is claimed.

## Dependencies and merge queue

Dependency declarations form a DAG and pin the referenced MR revisions. Cycles are rejected. A changed dependency revision requires redeclaration and review. Dependencies must be merged first, or be included in the same checked composition when they target the same repository. Historical merged status alone cannot satisfy a prerequisite: its exact source commit must still be an ancestor of current canonical Git and its applied composition must not have a recorded revert. Canonical force-push removal or a reviewed revert blocks the dependent work without erasing either history.

A queue ticket captures an already reviewed composition, exact evidence IDs, decision basis, MR/dependency basis, selected revisions and expected Git head. The queue never chooses a different alternative or refreshes a candidate automatically. It processes at most one eligible ticket per invocation, skipping blocked predecessors only when their dependencies make another entry eligible.

After the first canonical advance, remaining tickets may become stale. They move to `needs_review`; the owner prepares and inspects fresh candidates and enqueues new tickets. This behavior preserves the reviewed code even though it reduces automatic queue throughput. Tickets can also be blocked, cancelled or require recovery. Request receipts prevent duplicate processing from repeating a Git write.

## Reviewed reverts and recovery

A revert prepares the actual inverse of an applied decision or specified ancestor commit against the current canonical head. It retains a candidate, preserves unrelated later work when Git can compose the inverse, and runs current validation before presenting the diff. Preparing an inverse never updates canonical Git. Textual conflicts escalate to conventional review.

An external merge commit requires an explicit valid `mainline` parent. Reverting a platform-applied composition defaults to its recorded canonical first parent. A batch revert reverses the entire selected composition, so the interface describes that scope. Application uses the same reviewed-basis/head CAS as other decisions and records the original decision/commit relationship. It also marks affected historical MRs by their original decision or exact external merge commit, so those recorded reverts cannot authorize dependent work merely through retained ancestry.

If a Git result becomes uncertain, further transitions remain blocked. Recovery reads the authoritative ref and recognizes only the exact prepared target; it does not repeat CAS to guess the outcome. Restoring dispositions, MR outcomes and queue status is idempotent. Original request receipts remain historical; fetch current MR/queue state after recovery to see the reconciled outcome.

## Shared API

Local and Worker APIs use the same workflow dispatcher inside their serialized workspace boundary. Actor identity comes from the authenticated server context.

| Route | Operation and required pins |
|---|---|
| `GET/POST /api/merge-requests` | List or open from `repo`, `source_ref`, optional registered `source_repo`, title and draft flag |
| `GET /api/merge-requests/:id` | Current view plus immutable history and review/check state |
| `POST /api/merge-requests/:id/transition` | Edit, draft, ready, close, reopen; `expected_version` |
| `POST /api/merge-requests/:id/reviews` | Review/dismiss; `expected_version`, `expected_revision_id` |
| `POST /api/merge-requests/reviews/batch` | `items[]` containing MR IDs, actions and each item's exact version/revision pins |
| `POST /api/merge-requests/:id/comments` | Comment/reply/resolve/reopen thread; version/revision pins |
| `POST /api/merge-requests/:id/checks` | Record a declared check; version/revision pins |
| `POST /api/merge-requests/:id/dependencies` | Set `dependency_ids`; `expected_version` |
| `POST /api/merge-requests/:id/validate` | Explicit platform validation of the displayed revision |
| `POST /api/merge-requests/:id/prepare` | Prepare its exact revision for decision review |
| `GET/POST /api/repositories/:id/policy` | Read/update owner-managed review policy; updates pin `expected_version` |
| `POST /api/reviews/prepare` | Prepare `revision_ids[]` in one repository, including conventional work |
| `POST /api/reverts/prepare` | Prepare `decision_id` or `repo` + `target_commit`, optional explicit `mainline` |
| `POST /api/decisions/:id/resolve` | Apply `alternative_id`, `basis_hash`, `expected_canonical_head`, rationale |
| `POST /api/decisions/:id/refresh` | Prepare current inputs for renewed human review |
| `GET/POST /api/merge-queue` | List/enqueue; enqueue requires `request_id` and exact decision/head pins |
| `POST /api/merge-queue/process` | Examine and process at most one exact ticket; use a unique `request_id` |
| `POST /api/merge-queue/:id/cancel` | Cancel a queued, blocked or needs-review ticket |
| `POST /api/recover` | Reconcile uncertain operations, dispositions and queue outcomes |

## Coverage and deployment status

Run the focused ordinary-Git workflow suite:

```sh
node --test tests/workflow-integration.test.mjs
```

It uses real local bare repositories, branches, merge commits, force pushes, deletion, retained candidates, old-OID CAS and reload recovery. Most checks validate only the policy-document schema. The existing application suite separately observes HTTP effects in isolation; the lightweight workflow suite does not claim to verify general code behavior.

| Capability | Native implementation and observed verification | Remaining boundary |
|---|---|---|
| Lifecycle and versioned discussions | Local real-Git lifecycle/thread integration; domain and shared API tests | Organizational authorization and notifications |
| Exact revision reviews and batch policy | Real source push stales approval; all-MR batch application; shared API batch reviews | Multi-user production identity |
| Trusted versus declared checks | Real platform schema validation; producer CI reports cannot authorize application | General CI fleet and broader trusted profiles |
| Dependencies and queue | DAG guards, topological progress, force-push/reverted prerequisite rejection, immutable tickets, stale-stop and request replay tests | Cross-repository release protocol; no automatic refresh |
| Conventional work | Real Git proposal without MR/context authorization prepares and applies; result clones and fscks | Arbitrary repository profiles require configured trusted checks |
| External Git lifecycle | Exact ancestor recognition, force-push and source-deletion history tests | Native live event delivery unverified |
| Reviewed inverse and recovery | Real inverse before CAS, raced-head rejection, lost-successful-reply reload, MR/queue idempotence | Live remote restart/failure experiments |
| Artifacts + Worker + Queue + Durable Object | Native integration code, mocked adapters and dry-run bundling | Live Cloudflare account credentials; resources/events/executor remain unverified |
| GitHub / GitLab | Connector alternatives audited; neither selected nor built | Separate future integration scope |

The recorded Cloudflare preflight found missing account authentication. This work does not reclassify dry runs or local tests as a live deployment. Cloudflare Container support for the isolation needed by application checks also remains unverified. See [the live runbook](live-cloudflare.md) for prerequisites and the existing evidence scope.
