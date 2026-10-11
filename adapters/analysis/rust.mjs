/**
 * Pinned stable-rustc semantic observations, not a complete Rust semantic index.
 *
 * `--emit=mir` is stable; its human-readable format is not. The trusted Rust
 * helper accepts only the exact 1.90.0 compiler identity. Every successful
 * analysis remains PARTIAL: type/layout/export effects, macro expansion origins,
 * conditional configurations, dependencies and exhaustive reference resolution
 * are unavailable. Policy-required semantic analysis therefore stays blocked.
 */
import { createHash } from 'node:crypto';
import { copyJsonData } from '../../core/v1/domain.mjs';
import { encodeCanonical } from '../../core/v1/encoding.mjs';
import { analysisProject, extractorCapabilities } from '../../core/v1/extractors.mjs';

export const RUST_TOOLCHAIN_VERSIONS = Object.freeze(['1.90.0']);
export const RUST_SEMANTIC_COVERAGE = Object.freeze({
  schema_version: 1,
  compiler_identity: 'rustc 1.90.0 (1159e78c4 2025-09-14)',
  supported_editions: Object.freeze(['2021', '2024']),
  capability: 'SEMANTIC',
  status: 'PARTIAL',
  fixture_corpus: 'tests/fixtures/rust-semantic',
  observations: Object.freeze([
    'compiler-checked typed MIR functions',
    'ordered MIR body changes',
    'literal direct callee observations',
    'conservative exact source/configuration changes',
  ]),
  limits: Object.freeze([
    'single directly compiled std-only lib crate; no Cargo execution',
    'no dependency resolution, build scripts, proc macros, or feature matrix',
    'no exhaustive type/layout/export/unsafe/reference model',
    'MIR textual presentation pinned to the exact compiler identity',
    'source span identities are conservative, not stable symbol identities',
    'no global equivalence, correctness, or disjointness claim',
  ]),
});

const result = (status, effects = [], security_effects = []) => ({
  capability: 'SEMANTIC',
  status,
  effects,
  security_effects,
});
const digest = (domain, value) =>
  `sha256:${domain}:v1:${createHash('sha256')
    .update(`klocgit:v1:${domain}\0`)
    .update(encodeCanonical({ schema_version: 1, value }))
    .digest('hex')}`;
const orderedFiles = (files) =>
  [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
const effect = (kind, target, operation, attributes, references = []) => ({
  schema_version: 1,
  kind,
  target,
  operation,
  attributes,
  references,
});
const relativePath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.startsWith('-') &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  path.split('/').every((part) => part && part !== '.' && part !== '..');

function validateCompilerResult(value, version) {
  value = copyJsonData(value);
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'functions,schema_version,status,toolchain_version' ||
    value.schema_version !== 1 ||
    value.toolchain_version !== version ||
    !['COMPILED', 'FAILED', 'UNSUPPORTED'].includes(value.status) ||
    !Array.isArray(value.functions) ||
    (value.status !== 'COMPILED' && value.functions.length)
  )
    throw new Error('invalid compiler evidence');
  const names = new Set();
  for (const fact of value.functions) {
    if (
      !fact ||
      Object.keys(fact).sort().join(',') !== 'body,name,references,signature' ||
      !['name', 'signature', 'body'].every((key) => typeof fact[key] === 'string') ||
      !fact.name ||
      !fact.signature.startsWith(`fn ${fact.name}(`) ||
      names.has(fact.name) ||
      !Array.isArray(fact.references) ||
      !fact.references.every((reference) => typeof reference === 'string' && reference)
    )
      throw new Error('invalid typed MIR fact');
    names.add(fact.name);
    fact.references = [...new Set(fact.references)].sort();
  }
  return value;
}

function unsupportedConfiguration(project, entryPoint, edition) {
  if (!project.complete || !project.files.some((file) => file.path === entryPoint)) return true;
  for (const file of project.files) {
    if (file.path.endsWith('/Cargo.toml') || file.path === 'Cargo.toml') {
      // Conservatively reject even empty dependency tables, workspaces, alternate
      // targets, features, build hooks and patched dependencies. Parsing Cargo
      // configuration is a separate capability, not approximated by rustc here.
      if (
        /^\s*\[(?:[^\]]*dependencies|workspace|features|patch|replace|bin|example|test|bench)/m.test(
          file.contents,
        ) ||
        /^\s*(?:build|proc-macro|rust-version|path)\s*=/m.test(file.contents)
      )
        return true;
      const manifestEdition = /^\s*edition\s*=\s*['"]([^'"]+)['"]/m.exec(file.contents)?.[1];
      if (manifestEdition && manifestEdition !== edition) return true;
    }
    if (file.path.endsWith('/build.rs') || file.path === 'build.rs') return true;
  }
  return false;
}

function sourceEffects(base, revision, checked, entryPoint, edition) {
  const before = orderedFiles(base.files);
  const after = orderedFiles(revision.files);
  const effects = [];
  if (digest('rust-project-source', before) !== digest('rust-project-source', after)) {
    effects.push(
      effect('rust-crate', `rust:${entryPoint}`, 'modified', {
        compiler_checked: checked,
        compiler_version: '1.90.0',
        edition,
        source_digest: digest('rust-project-source', after),
        previous_source_digest: digest('rust-project-source', before),
        sources: after.map((file) => file.path),
        coverage: 'bounded-typed-mir-partial',
      }),
    );
  }
  const security = [];
  const oldFiles = new Map(before.map((file) => [file.path, file.contents]));
  const newFiles = new Map(after.map((file) => [file.path, file.contents]));
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    if (
      oldFiles.get(path) !== newFiles.get(path) &&
      /(?:^|\/)(?:Cargo\.(?:toml|lock)|build\.rs|\.cargo(?:\/.*)?)$/.test(path)
    ) {
      security.push(
        effect(
          'rust-build-configuration',
          path,
          !oldFiles.has(path) ? 'added' : !newFiles.has(path) ? 'deleted' : 'modified',
          { execution: 'disabled', coverage: 'configuration-source-change' },
        ),
      );
    }
  }
  return { effects, security };
}

function functionEffects(before, after, entryPoint) {
  const oldFunctions = new Map(before.map((fact) => [fact.name, fact]));
  const newFunctions = new Map(after.map((fact) => [fact.name, fact]));
  const effects = [];
  for (const name of [...new Set([...oldFunctions.keys(), ...newFunctions.keys()])].sort()) {
    const previous = oldFunctions.get(name);
    const current = newFunctions.get(name);
    const previousDigest = previous ? digest('rust-mir-function', previous) : null;
    const currentDigest = current ? digest('rust-mir-function', current) : null;
    if (previousDigest === currentDigest) continue;
    effects.push(
      effect(
        'rust-function',
        `rust:${entryPoint}#${name}`,
        !previous ? 'added' : !current ? 'deleted' : 'modified',
        {
          compiler_version: '1.90.0',
          signature: (current ?? previous).signature,
          previous_mir_digest: previousDigest,
          mir_digest: currentDigest,
          coverage: 'typed-mir-function-literal-callees',
        },
        [...new Set((current ?? previous).references)].sort(),
      ),
    );
  }
  return effects;
}

/**
 * `runner(request)` is a trusted narrow sandbox adapter, never repository code.
 * It must independently enforce isolation, budgets and pinned helper/toolchain
 * integrity before invoking the helper. This plugin does not launch a local
 * process or treat request fields as proof that isolation exists.
 */
export class RustSemanticPlugin {
  constructor({
    loadProject,
    runner,
    toolchainVersion = '1.90.0',
    entryPoint = 'src/lib.rs',
    edition = '2021',
  } = {}) {
    this.id = 'rust-semantic';
    this.version = '1.0.0';
    this.capability = 'SEMANTIC';
    this.loadProject = loadProject;
    this.runner = runner;
    this.toolchainVersion = toolchainVersion;
    this.entryPoint = entryPoint;
    this.edition = edition;
  }

  capabilities(language, toolchain_version) {
    return extractorCapabilities({
      schema_version: 1,
      language,
      toolchain_version,
      supported_versions: [...RUST_TOOLCHAIN_VERSIONS],
      capability: this.capability,
      status:
        language === 'rust' && RUST_TOOLCHAIN_VERSIONS.includes(toolchain_version)
          ? 'PARTIAL'
          : 'UNSUPPORTED',
    });
  }

  async analyze(base, revision) {
    if (
      !RUST_TOOLCHAIN_VERSIONS.includes(this.toolchainVersion) ||
      !RUST_SEMANTIC_COVERAGE.supported_editions.includes(this.edition)
    )
      return result('UNSUPPORTED');
    if (
      typeof this.loadProject !== 'function' ||
      typeof this.runner !== 'function' ||
      !relativePath(this.entryPoint)
    )
      return result('FAILED');
    try {
      const baseline = analysisProject(await this.loadProject(base), base);
      const observed = analysisProject(await this.loadProject(revision), revision);
      const configured =
        !unsupportedConfiguration(baseline, this.entryPoint, this.edition) &&
        !unsupportedConfiguration(observed, this.entryPoint, this.edition);
      if (!configured) {
        const source = sourceEffects(baseline, observed, false, this.entryPoint, this.edition);
        return result('PARTIAL', source.effects, source.security);
      }
      const run = async (project) =>
        validateCompilerResult(
          await this.runner({
            schema_version: 1,
            tool: 'rust-mir-v1',
            toolchain_version: this.toolchainVersion,
            compiler_identity: RUST_SEMANTIC_COVERAGE.compiler_identity,
            entry_point: this.entryPoint,
            edition: this.edition,
            project,
            environment: {},
            isolation: {
              network: 'deny',
              credentials: 'none',
              filesystem: 'subject-readonly',
              build_scripts: false,
              proc_macros: false,
            },
          }),
          this.toolchainVersion,
        );
      // Independent exact states are submitted separately; no executable or
      // command arguments are supplied by source files or Cargo configuration.
      const previous = await run(baseline);
      if (previous.status !== 'COMPILED') return result(previous.status);
      const current = await run(observed);
      if (current.status !== 'COMPILED') return result(current.status);
      const source = sourceEffects(baseline, observed, true, this.entryPoint, this.edition);
      return result(
        'PARTIAL',
        [
          ...source.effects,
          ...functionEffects(previous.functions, current.functions, this.entryPoint),
        ],
        source.security,
      );
    } catch {
      return result('FAILED');
    }
  }
}

export const createRustSemanticPlugin = (options) => new RustSemanticPlugin(options);
