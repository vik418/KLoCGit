# Benchmarks

T120-T125 supply the workloads and experiments defined in [VALIDATION.md](../VALIDATION.md).

Record the input workload, repository/toolchain versions, evaluation budget, cold/warm conditions, run command and raw measurements with each result. Report missed seeded interactions alongside reduction and cost.

## Local measurements

| Workload    | Result                                                     | Scope                                                                                        |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Coordinator | [Raw measurements](results/coordination-local.json)        | Local workerd, 512 requests at concurrency 1/4/16/64, one/eight scopes.                      |
| Reduction   | [Raw measurements](results/candidate-reduction-local.json) | Synthetic Git-format objects and declared effects; actual reducer and SQLite event consumer. |
| Extractors  | [Raw measurements](results/extractors-local.json)          | Actual pinned compilers; curated change-localization and status fixtures.                    |
| Workspaces  | [Raw measurements](results/workspaces-local.json)          | Native ArtifactFS over local Git transport; full-fetch comparison and local composition.     |

Evidence reuse: [raw measurements](results/evidence-reuse-local.json) use signed, independently observed CI results and actual sandbox composition checks.

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

Run workspace measurements with the pinned ArtifactFS build:

```sh
KLOCGIT_ARTIFACT_FS_BINARY=/path/to/artifact-fs node benchmarks/workspaces.mjs 1,16,64 262144
```

The binary fixture size varies from 0.25 to 16 MiB. Cold means fresh adapter/application caches; the OS cache is uncontrolled. Native head hydration and generic historical Git composition are measured separately. Byte counters describe delivered object payloads and private disk files, not network framing or background prefetch. Disk measurement avoids symlinks and mounted hydration trees. Full-fetch startup wins on the smallest fixture; partial hydration reduces bytes and latency on the larger ones. The measured ArtifactFS build is from upstream revision `2b87a48691ef4ae82d391b7bbe4976c06c7fadf7`.

Run evidence reuse measurements:

```sh
node benchmarks/evidence-reuse.mjs 10
```

The fixture loses a request's response. One Future adds retrying; another adds charging before the response is lost. Each passes the registered at-most-one-charge check alone; their clean textual composition fails it. A trusted host recipe observes actual process output and ignores the producer's passing verdict. Signing stays outside execution. Initial CI evaluation cost is recorded separately from additional scheduler work. Failed exact-state Evidence can be reused as an observation; it cannot authorize a choice. These are local measurements, not live external CI or billing results.

Run the ranking baseline on actual local Git and sandbox execution:

```sh
node benchmarks/ranking-local.mjs 2 4 5000
```

Arguments are evaluation budget, repetitions and ranking timeout in milliseconds. A trusted module exporting `createRanker()` can be supplied as the fourth argument. The bundled `scripts/configured-ranker.mjs` requires `KLOCGIT_RANKER_URL`, `KLOCGIT_RANKER_TOKEN`, `KLOCGIT_RANKER_TIMEOUT_MS` and `KLOCGIT_RANKER_MAX_BYTES`. The service receives `{schema_version: 1, candidate_specs, evidence_summary}` and returns `{schema_version: 1, priorities}` containing every CandidateSpec ID exactly once.

Both arms use the same seven local compositions and evaluation budget. Run order alternates across repetitions. Source snapshots come from verified Git objects; risk labels stay outside ranking input. Deterministic work starts immediately, and late priorities affect only remaining work. Reports retain failed runs, priority stability, observed risk recall and execution time. Source refs and objects must remain unchanged. Missing or failed ranking services produce UNMEASURED results. These checks establish the experiment protocol; no live model benefit is recorded.

The Ranking experiment workflow runs the baseline on relevant pull requests. Its manual `with_ranker` option uses repository variables for the URL, timeout and response limit, and a repository secret for the token. It retains the raw report as a workflow artifact. Pull-request runs never receive ranking credentials. A baseline run does not satisfy the model comparison gate.
