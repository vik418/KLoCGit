# Benchmarks

T120-T125 supply the workloads and experiments defined in [VALIDATION.md](../VALIDATION.md).

Record the input workload, repository/toolchain versions, evaluation budget, cold/warm conditions, run command and raw measurements with each result. Report missed seeded interactions alongside reduction and cost.

## Local measurements

| Workload    | Result                                                     | Scope                                                                                        |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Coordinator | [Raw measurements](results/coordination-local.json)        | Local workerd, 512 requests at concurrency 1/4/16/64, one/eight scopes.                      |
| Reduction   | [Raw measurements](results/candidate-reduction-local.json) | Synthetic Git-format objects and declared effects; actual reducer and SQLite event consumer. |

Run the reduction benchmark:

```sh
node benchmarks/candidate-reduction.mjs 10,100,1000,10000 v1-metadata-2026-10-11 64
```

The seed, budget, runtime and event limits are recorded in the report. Shared documentation effects create dense hubs; seeded security effects must remain indexed. Unknown producer metadata, duplicate delivery and unseen older events exercise ingestion. No Candidate is materialized or behaviorally evaluated in this workload. Deferred implementations remain unresolved. These measurements do not establish live-provider throughput or semantic accuracy.
