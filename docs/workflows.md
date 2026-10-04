# Collaboration workflows

The default interface shows decisions. **Work** contains native merge requests, standalone proposals and the merge queue. Each application leads to a reviewed Git composition; preparing or discussing work never advances canonical Git.

## Merge requests

Open an MR from a branch in the canonical repository or a registered producer fork. It tracks an immutable ProposalRevision while retaining its own title, discussion and lifecycle history. Editing, draft/ready, close and reopen modify coordination metadata. Draft and closed MRs stay out of automatic convergence analysis.

Metadata writes pin `expected_version` or an event ID. Reviews, comments and reported checks also pin `expected_revision_id`. A source push or rebase makes old approvals and checks historical. The coordinator rechecks authoritative source refs before application, including pushes whose events have not arrived yet. Source deletion preserves history but withdraws the work.

An external merge is recognized only when the exact source commit is an ancestor of canonical Git. Matching trees, patch text or commit messages do not establish that result.

## Reviews and validation

Reviews support approval, requested changes, comments and authorized dismissal. File/line threads are checked against their pinned source commit. Thread resolution is recorded but is not currently a separate application gate.

Repository policy controls minimum approvals, self-approval and required platform checks. The default has no separate MR approval requirement; an explicit reviewed decision still authorizes the Git update. Every included MR must satisfy its current policy, source and dependency requirements.

Reported CI results remain declarations. Run platform validation on the actual selected composition to satisfy required checks. New source revisions, changed policy and newer applicable validation results can change the review basis.

## Single and batch application

Select immutable revisions in one repository and prepare a review. This works for one MR, several MRs or ordinary Git proposals without an MR. The coordinator composes actual Git code, retains its commit and runs configured checks. Unknown provenance remains visible.

Applying submits the displayed alternative, `basis_hash`, `expected_canonical_head` and rationale. A stale head or basis requires renewed review. One application updates one repository; selecting several repositories does not create a distributed transaction.

## Dependencies and queue

MR dependencies form a DAG and pin referenced revisions. Cycles are rejected. A changed prerequisite requires redeclaration. A prerequisite must still exist in canonical ancestry and must not have a recorded revert; historical merged status alone is insufficient. Dependencies in the same repository may be selected together in one checked composition.

A queue ticket retains the exact reviewed composition, evidence, source/MR/dependency basis and expected Git head. Processing applies at most one eligible ticket per invocation. Blocked prerequisites can allow another eligible ticket to proceed. A moved input changes the ticket to `needs_review`; prepare and review a fresh candidate before enqueueing another ticket.

Queue request IDs identify immutable requests. Replaying a request cannot authorize another Git write or a different payload. Cancellation changes queue metadata, not code.

## Reverts and recovery

A revert prepares the inverse of an applied decision or ancestor commit against the current canonical head. Review its diff and current validation before applying it through the same basis/head checks. Unrelated later changes are preserved where Git can compose the inverse; textual conflicts require review.

An external merge commit requires an explicit `mainline` parent. Reverting a batch decision reverses the whole selected composition. The new decision records its relationship to the original, and dependencies cannot rely on a recorded reverted prerequisite.

If a Git response is lost, recovery observes the exact prepared target and reconciles decision, MR and queue status. It does not replay the Git update. See [architecture](architecture.md) for the write protocol.

## API entry points

Local and Worker routes use the same workflow dispatcher. Actor identity comes from the authenticated server context, never a client-supplied actor field.

| Route                                       | Purpose                                                         |
| ------------------------------------------- | --------------------------------------------------------------- |
| `GET/POST /api/merge-requests`              | List/open requests; source repository/ref and registered target |
| `GET /api/merge-requests/:id`               | Current view and retained history                               |
| `POST /api/merge-requests/:id/transition`   | Edit, draft, ready, close or reopen                             |
| `POST /api/merge-requests/:id/reviews`      | Review or dismiss, with exact version/revision pins             |
| `POST /api/merge-requests/reviews/batch`    | Preflight and review several pinned MRs                         |
| `POST /api/merge-requests/:id/comments`     | Comment, reply, resolve or reopen a thread                      |
| `POST /api/merge-requests/:id/checks`       | Record a declared CI result                                     |
| `POST /api/merge-requests/:id/dependencies` | Update pinned dependency declarations                           |
| `POST /api/merge-requests/:id/validate`     | Run configured platform checks                                  |
| `POST /api/merge-requests/:id/prepare`      | Prepare one MR for decision review                              |
| `GET/POST /api/repositories/:id/policy`     | Read/update versioned review rules                              |
| `POST /api/reviews/prepare`                 | Prepare a single or batch composition                           |
| `POST /api/reverts/prepare`                 | Prepare an inverse candidate                                    |
| `POST /api/decisions/:id/refresh`           | Refresh candidates for renewed review                           |
| `POST /api/decisions/:id/resolve`           | Apply the reviewed alternative with basis/head pins             |
| `GET/POST /api/merge-queue`                 | Inspect/enqueue exact reviewed tickets                          |
| `POST /api/merge-queue/process`             | Process one eligible ticket                                     |
| `POST /api/merge-queue/:id/cancel`          | Cancel a waiting ticket                                         |
| `POST /api/recover`                         | Reconcile uncertain prepared operations                         |

Use the UI for normal work and inspect `server/workflow-api.mjs` for request validation. [Development](development.md) lists the focused real Git regression suite.
