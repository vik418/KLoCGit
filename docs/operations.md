# Operations

The operational view reports observed failures, affected objects and trace IDs. It is a rebuildable projection. Confirm current authoritative records before taking action; a healthy projection does not prove system correctness.

| Incident             | Inspect                                                         | Recovery                                                                                                                                               |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider outage      | Provider status, scoped credentials, rate-limit response        | Restore access. Retry reads with configured backoff. Reconcile ambiguous writes before retrying them.                                                  |
| Queue backlog or DLQ | Delivery receipt, subject version, failure class                | Restore consumer capacity or fix the handler. Redeliver the original bounded event. Preserve its identity and idempotency keys.                        |
| Extractor failure    | Capability, supported toolchain, diagnostics                    | Restore the declared toolchain or repair the plugin. Rerun exact-state analysis. Required incomplete analysis continues to block resolution.           |
| Sandbox capacity     | Active workspaces, execution limits, pending checks             | Release completed workspaces or restore capacity. Reuse eligible Evidence; schedule missing checks. Keep credentials and direct network access denied. |
| GitStore error       | Authoritative ref, provider limit/rate error, operation journal | Restore provider access or select a supported GitStore. Reconcile uncertain CAS outcomes. Never change the expected OID to force a retry.              |
| Deployment UNKNOWN   | External run, last observation, exact repository OIDs           | Obtain a verified webhook or observe with configured backoff. External CD performs execution and recovery. Timeout does not establish failure.         |
| Attestation mismatch | Authorized SystemRevision, observation, signer grant            | Reject the proof. Verify observer access and exact deployed OIDs. Preserve the failed verification record; obtain a new proof for current state.       |

After recovery, confirm the exact state, inspect the audit record and rerun the affected check. Record unresolved outcomes explicitly. Retention cleanup must reread pins and storage generations; catalog entries alone never permit deletion.
