/** Local compiler fixtures measure declared observations, not runtime correctness. */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { FutureRevision } from '../core/v1/domain.mjs';
import { Extractor } from '../core/v1/extractors.mjs';
import { objectId } from '../core/v1/conventions.mjs';
import { digestCanonical } from '../core/v1/encoding.mjs';
import {
  TypeScriptSemanticPlugin,
  TYPESCRIPT_SUPPORTED_VERSIONS,
} from '../adapters/analysis/typescript.mjs';
import {
  createPythonSemanticExtractor,
  PYTHON_SUPPORTED_VERSIONS,
} from '../adapters/analysis/python.mjs';
import { createGoSemanticExtractor, GO_SUPPORTED_VERSIONS } from '../adapters/analysis/go.mjs';
import { createRustSemanticPlugin, RUST_TOOLCHAIN_VERSIONS } from '../adapters/analysis/rust.mjs';
import { pythonAnalysisRunner } from '../tests/support/python-analysis-runner.mjs';
import { goTestRunner } from '../tests/v1/support/go-runner.mjs';
import {
  fixtureCompilerRunner,
  prepareRustCompiler,
  cleanupRustCompiler,
} from '../tests/support/rust-compiler.mjs';
import { treeOid, commitOid } from './support/git-objects.mjs';

const versions = {
  typescript: TYPESCRIPT_SUPPORTED_VERSIONS,
  javascript: TYPESCRIPT_SUPPORTED_VERSIONS,
  python: PYTHON_SUPPORTED_VERSIONS,
  go: GO_SUPPORTED_VERSIONS,
  rust: RUST_TOOLCHAIN_VERSIONS,
};

export function scoreSignals(expected, observed) {
  const truth = new Set(expected),
    found = new Set(observed);
  const true_positive = [...truth].filter((key) => found.has(key)).length;
  const false_positive = [...found].filter((key) => !truth.has(key)).length;
  const false_negative = [...truth].filter((key) => !found.has(key)).length;
  return {
    true_positive,
    false_positive,
    false_negative,
    precision: found.size ? true_positive / found.size : null,
    recall: truth.size ? true_positive / truth.size : null,
  };
}

function signals(language, effects) {
  const kinds = {
    typescript: { 'semantic-source': 'source', 'semantic-export': 'symbol' },
    javascript: { 'semantic-source': 'source', 'semantic-export': 'symbol' },
    python: { 'python-module': 'source' },
    go: { symbol: 'symbol' },
    rust: { 'rust-crate': 'source', 'rust-function': 'symbol' },
  }[language];
  return [
    ...new Set(
      effects
        .filter(({ kind }) => kinds[kind])
        .map(({ kind, target }) => kinds[kind] + ':' + target),
    ),
  ].sort();
}

async function subject(files, message) {
  const tree_oid = await treeOid(files),
    commit_oid = await commitOid(tree_oid, null, message);
  const facts = {
    schema_version: 1,
    system_id: 'benchmark',
    repo_id: 'fixture',
    ref: 'refs/heads/main',
    tree_oid,
    commit_oid,
    parent_oids: [],
  };
  return FutureRevision({
    ...facts,
    id: objectId('future-revision', await digestCanonical('object-future-revision', facts)),
    producer: null,
    observed_at: '2026-10-11T00:00:00Z',
  });
}

async function analyzeFixture(entry, version, runner, repetitions) {
  const configuration =
    entry.language === 'go'
      ? { 'go.mod': 'module example.test/benchmark\n\ngo 1.26\n' }
      : ['typescript', 'javascript'].includes(entry.language)
        ? {
            'tsconfig.json': JSON.stringify({
              compilerOptions: {
                target: 'ES2022',
                lib: ['ES2022'],
                module: 'ESNext',
                moduleResolution: 'Bundler',
                strict: true,
                allowJs: true,
                checkJs: true,
              },
            }),
          }
        : {};
  const before = { ...configuration, ...entry.before },
    after = { ...configuration, ...entry.after };
  const base = await subject(before, entry.id + ':base'),
    revision = await subject(after, entry.id + ':revision');
  const loadProject = (state) => ({
    schema_version: 1,
    repo_id: state.repo_id,
    commit_oid: state.commit_oid,
    tree_oid: state.tree_oid,
    complete: true,
    files: Object.entries(state.id === base.id ? before : after).map(([path, contents]) => ({
      path,
      contents,
    })),
  });
  const plugin = ['typescript', 'javascript'].includes(entry.language)
    ? new TypeScriptSemanticPlugin({ loadProject })
    : entry.language === 'python'
      ? createPythonSemanticExtractor({
          toolchainVersion: version,
          loadProject,
          analyzeRunner: pythonAnalysisRunner,
        })
      : entry.language === 'go'
        ? createGoSemanticExtractor({ toolchain_version: version, loadProject, runner: runner.run })
        : createRustSemanticPlugin({
            toolchainVersion: version,
            loadProject,
            runner: fixtureCompilerRunner,
          });
  const extractor = new Extractor({ plugin, language: entry.language, toolchain_version: version });
  const capability = await extractor.capabilities(entry.language, version);
  const rows = [];
  for (let repeat = 0; repeat < repetitions; repeat++) {
    const start = performance.now(),
      cpu = process.cpuUsage();
    let result,
      crashed = false;
    try {
      result = await extractor.analyze(base, revision);
    } catch {
      crashed = true;
    }
    const cpu_used = process.cpuUsage(cpu);
    const observed = result ? signals(entry.language, result.effects) : [];
    rows.push({
      schema_version: 1,
      fixture: entry.id,
      language: entry.language,
      toolchain_version: version,
      repeat,
      status: result?.status ?? null,
      expected_status: entry.status,
      capability_status: capability.status,
      status_matches: result?.status === entry.status,
      crashed,
      elapsed_ms: performance.now() - start,
      control_plane_cpu_ms: (cpu_used.user + cpu_used.system) / 1000,
      source_bytes: Buffer.byteLength(JSON.stringify({ before, after })),
      observed_signals: observed,
      signal_score: entry.signals === null ? null : scoreSignals(entry.signals, observed),
      effect_digest: result?.digest ?? null,
    });
  }
  // Unchanged state provides a measured comparison; plugins may still compile both inputs.
  const start = performance.now();
  const unchanged = await extractor.analyze(base, base);
  return {
    rows,
    unchanged_status: unchanged.status,
    unchanged_elapsed_ms: performance.now() - start,
  };
}

export async function benchmarkExtractors({
  corpus,
  languages,
  repetitions,
  onProgress = () => {},
}) {
  if (
    !Array.isArray(corpus) ||
    !corpus.length ||
    !Array.isArray(languages) ||
    !languages.length ||
    new Set(languages).size !== languages.length ||
    languages.some((key) => !versions[key]) ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1
  )
    throw new TypeError('Explicit corpus, languages and repetition count are required.');
  const runners = [],
    rows = [],
    summaries = [];
  try {
    for (const language of languages) {
      const fixtures = corpus.filter((entry) => entry.language === language);
      if (!fixtures.length) throw new TypeError('Each language requires fixtures.');
      for (const version of versions[language]) {
        const preparing = performance.now();
        const runner = language === 'go' ? await goTestRunner(version) : null;
        if (runner) runners.push(runner);
        if (language === 'rust') await prepareRustCompiler();
        const preparation_ms = performance.now() - preparing,
          unchanged = [];
        for (const entry of fixtures) {
          const result = await analyzeFixture(entry, version, runner, repetitions);
          rows.push(...result.rows);
          unchanged.push(result.unchanged_elapsed_ms);
          await onProgress({ language, version, fixture: entry.id, rows: result.rows });
        }
        const runs = rows.filter(
          (row) => row.language === language && row.toolchain_version === version,
        );
        const scores = runs.flatMap((row) => (row.signal_score ? [row.signal_score] : []));
        const total = (field) => scores.reduce((sum, row) => sum + row[field], 0);
        const true_positive = total('true_positive'),
          false_positive = total('false_positive'),
          false_negative = total('false_negative');
        const elapsed = runs.map((row) => row.elapsed_ms).sort((a, b) => a - b);
        summaries.push({
          schema_version: 1,
          language,
          toolchain_version: version,
          fixture_count: fixtures.length,
          runs: runs.length,
          preparation_ms,
          true_positive,
          false_positive,
          false_negative,
          precision:
            true_positive + false_positive
              ? true_positive / (true_positive + false_positive)
              : null,
          recall:
            true_positive + false_negative
              ? true_positive / (true_positive + false_negative)
              : null,
          crash_rate: runs.filter((row) => row.crashed).length / runs.length,
          partial_rate: runs.filter((row) => row.status === 'PARTIAL').length / runs.length,
          failed_rate: runs.filter((row) => row.status === 'FAILED').length / runs.length,
          unsupported_rate: runs.filter((row) => row.status === 'UNSUPPORTED').length / runs.length,
          unexpected_statuses: runs.filter((row) => !row.status_matches).length,
          analysis_p50_ms: elapsed[Math.ceil(elapsed.length * 0.5) - 1],
          analysis_p95_ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
          unchanged_mean_ms: unchanged.reduce((sum, value) => sum + value, 0) / unchanged.length,
          repeated_delta_mean_ms: runs.reduce((sum, row) => sum + row.elapsed_ms, 0) / runs.length,
        });
      }
    }
    return {
      schema_version: 1,
      measured_at: new Date().toISOString(),
      hypothesis: 'H2',
      workload: 'curated-local-compiler-fixtures',
      scope:
        'Change-localization projections and explicit analysis status; not semantic completeness or production precision/recall',
      runtime: {
        node: process.version,
        typescript: ts.version,
        platform: process.platform,
        arch: process.arch,
      },
      repetitions,
      declared_versions: versions,
      measured_versions: summaries.map(({ language, toolchain_version }) => ({
        language,
        toolchain_version,
      })),
      cost_scope:
        'Wall time includes helper processes; control-plane CPU excludes child compiler CPU. No provider billing is measured.',
      quality_scope:
        'Signal precision measures the listed change-localization projections. Conservative raw-source fingerprints can produce false positives.',
      release_update_lag: null,
      release_update_lag_reason: 'No longitudinal release observations',
      summaries,
      rows,
    };
  } finally {
    await Promise.all(runners.map((runner) => runner.close()));
    if (languages.includes('rust')) await cleanupRustCompiler();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [languages, repetitions] = process.argv.slice(2);
  const corpus = JSON.parse(
    await readFile(new URL('./extractor-corpus.json', import.meta.url), 'utf8'),
  );
  const report = await benchmarkExtractors({
    corpus,
    languages: languages?.split(','),
    repetitions: Number(repetitions),
    onProgress: ({ language, version, fixture }) =>
      process.stderr.write(
        JSON.stringify({ event: 'extractor.measured', language, version, fixture }) + '\n',
      ),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.summaries.some((row) => row.unexpected_statuses || row.crash_rate))
    process.exitCode = 1;
}
