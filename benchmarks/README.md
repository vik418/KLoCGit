# Benchmarks

T120-T125 supply the workloads and experiments defined in [VALIDATION.md](../VALIDATION.md).

Record the input workload, repository/toolchain versions, evaluation budget, cold/warm conditions, run command and raw measurements with each result. Report missed seeded interactions alongside reduction and cost.

## Local measurements

| Workload    | Result                                                     | Scope                                                                                        |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Coordinator | [Raw measurements](results/coordination-local.json)        | Local workerd, 512 requests at concurrency 1/4/16/64, one/eight scopes.                      |
| Reduction   | [Raw measurements](results/candidate-reduction-local.json) | Synthetic Git-format objects and declared effects; actual reducer and SQLite event consumer. |
| Extractors  | [Raw measurements](results/extractors-local.json)          | Actual pinned compilers; curated change-localization and status fixtures.                    |

Run the reduction benchmark:

```sh
node benchmarks/candidate-reduction.mjs 10,100,1000,10000 v1-metadata-2026-10-11 64
```

The seed, budget, runtime and event limits are recorded in the report. Shared documentation effects create dense hubs; seeded security effects must remain indexed. Unknown producer metadata, duplicate delivery and unseen older events exercise ingestion. No Candidate is materialized or behaviorally evaluated in this workload. Deferred implementations remain unresolved. These measurements do not establish live-provider throughput or semantic accuracy.

Run the compiler benchmark with the toolchains used by compatibility CI:

```sh
node benchmarks/extractors.mjs typescript,javascript,python,go,rust 3
```

[Fixture labels](extractor-corpus.json) are separate from compiler output. Precision/recall describe the listed source/symbol change projections; they do not score all semantic effects. Go's conservative raw-source fingerprints count formatting as a symbol change. Its COMPLETE status covers static bindings, including an observed interface reference, rather than runtime dispatch resolution. Successful Rust analysis stays PARTIAL. Wall time includes helper processes; reported control-plane CPU excludes their CPU. Release-update lag requires longitudinal observations and remains unmeasured.
