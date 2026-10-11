# Local candidate materialization

Status: accepted.

Candidates are composed in private, disposable Git object databases. WorkspaceSource supplies verified commit/tree metadata and the blobs needed for changed paths. Unchanged blobs remain lazy. Source repositories receive no writes.

Whole-Future selections use their recorded baseline. Commit selections use an explicit parent and must be reachable from the pinned FutureRevision. A merge commit requires an explicit mainline. Whole-revision dependencies cannot be satisfied by selecting only part of that revision.

Git merges synthetic commits sharing the exact baseline tree. This avoids depending on producer ancestry after rebase or force-push. Textual conflicts fail explicitly. Changed submodules are unsupported until their referenced repository states can be evaluated.

Candidate identity includes exact repository trees, ordered selections, baseline digest, Git version and supplied commit identity. Local directories, timing and hydration counters are excluded. Materialization establishes an exact Git state, not semantic compatibility.

Real-Git tests verify reproducibility, targeted hydration, source immutability, conflicts, commit ancestry, substitution rejection, SHA-256 repositories and multi-repository state. Git must support `merge-tree --write-tree`; unavailable capability fails explicitly.
