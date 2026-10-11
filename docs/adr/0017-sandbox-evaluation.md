# Sandbox evaluation

Status: accepted.

Registered evaluators run in the trusted controller. Candidate code runs in a separate Linux PID, user, filesystem and network namespace. Only selected verified Git blobs, a digest-pinned runtime and runtime libraries are mounted. The child receives no inherited environment or canonical credential.

The controller evaluates bounded process output and records exact-state Evidence. Producer verdicts cannot replace registered checks. Workspace identity must match the Candidate's repository, commit and tree. Missing isolation support and exhausted budgets fail explicitly.

External resources require a registered, scoped broker request, content digest verification and audit records. Broker failures grant no access. Payload retention is assigned when Evidence is created.

Six native tests cover isolation, host credentials/files/network, readonly inputs, resource budgets, broker integrity, substituted workspaces and producer verdicts. These establish the local adapter's behavior; Cloudflare execution and capacity remain release checks.
