import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { Extractor, verifyEffectSet } from '../../core/v1/extractors.mjs';
import { buildDecisionBasis, makeResolvable, makeReviewable } from '../../core/v1/decisions.mjs';
import { createRustSemanticPlugin, RUST_SEMANTIC_COVERAGE } from '../../adapters/analysis/rust.mjs';
import {
  cleanupRustCompiler,
  fixture,
  fixtureCompilerRunner,
  prepareRustCompiler,
} from '../support/rust-compiler.mjs';

const revision = (character) =>
  FutureRevision({
    schema_version: 1,
    id: `klocgit:future-revision:v1:sha256:${character.repeat(64)}`,
    system_id: 'rust-system',
    repo_id: 'rust-repository',
    ref: 'refs/heads/main',
    commit_oid: character.repeat(40),
    tree_oid: character.repeat(40),
    parent_oids: [],
    producer: null,
    observed_at: '2026-10-10T00:00:00Z',
  });
const base = revision('a');
const head = revision('b');
const project = (subject, files, complete = true) => ({
  schema_version: 1,
  repo_id: subject.repo_id,
  commit_oid: subject.commit_oid,
  tree_oid: subject.tree_oid,
  complete,
  files,
});
const source = (contents) => [{ path: 'src/lib.rs', contents }];
function pluginFor(beforeFiles, afterFiles, changes = {}) {
  return createRustSemanticPlugin({
    loadProject: (subject) => project(subject, subject.id === base.id ? beforeFiles : afterFiles),
    runner: fixtureCompilerRunner,
    ...changes,
  });
}
const extractorFor = (plugin, version = '1.90.0') =>
  new Extractor({ plugin, language: 'rust', toolchain_version: version });

before(prepareRustCompiler);
after(cleanupRustCompiler);

test('Rust capability version matrix publishes exact bounded semantic support', async () => {
  const plugin = createRustSemanticPlugin();
  for (const [language, version, expected] of [
    ['rust', '1.90.0', 'PARTIAL'],
    ['rust', '1.89.0', 'UNSUPPORTED'],
    ['rust', '1.91.0', 'UNSUPPORTED'],
    ['rust', 'nightly', 'UNSUPPORTED'],
    ['Rust', '1.90.0', 'UNSUPPORTED'],
    ['go', '1.90.0', 'UNSUPPORTED'],
  ]) {
    const capability = await plugin.capabilities(language, version);
    assert.equal(capability.status, expected);
    assert.equal(capability.capability, 'SEMANTIC');
    assert.deepEqual(capability.supported_versions, ['1.90.0']);
    assert.equal(Object.keys(capability).length, 6);
  }
  assert.equal(RUST_SEMANTIC_COVERAGE.status, 'PARTIAL');
  assert.ok(RUST_SEMANTIC_COVERAGE.limits.some((limit) => limit.includes('type/layout/export')));
});

test('real compiler resolves typed signatures, changes, addition/deletion and literal calls', async () => {
  const plugin = pluginFor(source(await fixture('base.rs')), source(await fixture('revision.rs')));
  const output = await extractorFor(plugin).analyze(base, head);
  assert.equal(output.status, 'PARTIAL');
  assert.equal(output.capability, 'SEMANTIC');
  assert.equal(output.extractor_id, 'rust-semantic');
  assert.equal(output.future_revision_id, head.id);
  await verifyEffectSet(output);
  const functions = output.effects.filter((effect) => effect.kind === 'rust-function');
  assert.equal(functions.length, 4);
  assert.equal(functions.find((effect) => effect.target.endsWith('#added')).operation, 'added');
  assert.equal(functions.find((effect) => effect.target.endsWith('#removed')).operation, 'deleted');
  const combine = functions.find((effect) => effect.target.endsWith('#combine'));
  assert.equal(combine.operation, 'modified');
  assert.equal(combine.attributes.signature, 'fn combine(_1: i64, _2: i64) -> i64');
  assert.ok(
    functions
      .find((effect) => effect.target.endsWith('#measure'))
      .references.some((reference) => reference.includes('chars')),
  );
  assert.equal(
    output.effects.find((effect) => effect.kind === 'rust-crate').attributes.compiler_checked,
    true,
  );
});

test('real compiler edition matrix supports 2021 and 2024, rejects earlier editions explicitly', async () => {
  for (const edition of ['2021', '2024']) {
    const output = await extractorFor(
      pluginFor(source(''), source(await fixture('base.rs')), { edition }),
    ).analyze(base, head);
    assert.equal(output.status, 'PARTIAL');
    assert.ok(output.effects.some((effect) => effect.kind === 'rust-function'));
  }
  let calls = 0;
  const unsupported = pluginFor(source(''), source(''), {
    edition: '2018',
    runner: () => {
      calls += 1;
    },
  });
  assert.equal((await unsupported.analyze(base, head)).status, 'UNSUPPORTED');
  assert.equal(calls, 0);
});

test('semantic fixtures cover modules, generics, closures, impls and dynamic dispatch without completeness claims', async () => {
  for (const files of [
    source(await fixture('advanced.rs')),
    [
      { path: 'src/lib.rs', contents: await fixture('module-root.rs') },
      { path: 'src/nested.rs', contents: await fixture('nested.rs') },
    ],
  ]) {
    const output = await extractorFor(pluginFor(source(''), files)).analyze(base, head);
    assert.equal(output.status, 'PARTIAL');
    assert.ok(output.effects.some((effect) => effect.kind === 'rust-function'));
    assert.ok(!JSON.stringify(output).includes('klocgit-rust-subject-'));
  }
});

test('real type and syntax failures preserve declared semantic tier and hide compiler diagnostics', async () => {
  for (const name of ['type-error.rs', 'syntax-error.rs']) {
    const output = await extractorFor(pluginFor(source(''), source(await fixture(name)))).analyze(
      base,
      head,
    );
    assert.equal(output.status, 'FAILED');
    assert.equal(output.capability, 'SEMANTIC');
    assert.deepEqual(output.effects, []);
    assert.ok(!JSON.stringify(output).includes('compiler must reject'));
  }
});

test('struct-only compiler output demonstrates missing type/layout/export coverage', async () => {
  const output = await extractorFor(
    pluginFor(source(''), source(await fixture('layout-only.rs'))),
  ).analyze(base, head);
  assert.equal(output.status, 'PARTIAL');
  assert.equal(output.effects.filter((effect) => effect.kind === 'rust-function').length, 0);
  assert.equal(output.effects[0].kind, 'rust-crate');
  assert.equal(output.effects[0].attributes.compiler_checked, true);
});

test('partial hydration and Cargo dependency/build/proc-macro configurations do not execute', async () => {
  for (const extra of [
    { path: 'Cargo.toml', contents: '[dependencies]\nexternal = "1"\n' },
    { path: 'Cargo.toml', contents: '[lib]\nproc-macro = true\n' },
    { path: 'Cargo.toml', contents: '[features]\ndanger = []\n' },
    { path: 'build.rs', contents: 'fn main() { panic!("MUST NOT RUN"); }' },
  ]) {
    let calls = 0;
    const plugin = pluginFor(source(''), [...source(await fixture('base.rs')), extra], {
      runner: () => {
        calls += 1;
        throw new Error('must not run');
      },
    });
    const output = await extractorFor(plugin).analyze(base, head);
    assert.equal(output.status, 'PARTIAL');
    assert.equal(calls, 0);
    assert.equal(output.effects[0].attributes.compiler_checked, false);
    assert.ok(output.security_effects.some((effect) => effect.target === extra.path));
  }
  let calls = 0;
  const partial = pluginFor(source(''), source(await fixture('base.rs')), {
    loadProject: (subject) => project(subject, source(''), false),
    runner: () => {
      calls += 1;
    },
  });
  assert.equal((await partial.analyze(base, head)).status, 'PARTIAL');
  assert.equal(calls, 0);
});

test('compiler environment macros receive no inherited canonical credential', async () => {
  const files = source(await fixture('environment.rs'));
  const request = {
    schema_version: 1,
    tool: 'rust-mir-v1',
    toolchain_version: '1.90.0',
    compiler_identity: RUST_SEMANTIC_COVERAGE.compiler_identity,
    entry_point: 'src/lib.rs',
    edition: '2021',
    project: project(head, files),
    environment: {},
    isolation: {
      network: 'deny',
      credentials: 'none',
      filesystem: 'subject-readonly',
      build_scripts: false,
      proc_macros: false,
    },
  };
  process.env.KLOCGIT_CANONICAL_SECRET = 'fixture-canary';
  try {
    const response = await fixtureCompilerRunner(request);
    assert.equal(response.status, 'COMPILED');
    assert.ok(!JSON.stringify(response).includes('fixture-canary'));
    const required = await fixtureCompilerRunner({
      ...request,
      project: project(head, source(await fixture('required-environment.rs'))),
    });
    // env! must fail at compilation when the cleared child environment lacks
    // the canary, even though the parent process supplied it.
    assert.equal(required.status, 'FAILED');
    assert.ok(!JSON.stringify(required).includes('fixture-canary'));
  } finally {
    delete process.env.KLOCGIT_CANONICAL_SECRET;
  }
});

test('unknown compiler versions, bad source identities and malformed runner evidence remain explicit', async () => {
  const files = source(await fixture('base.rs'));
  let calls = 0;
  const unsupported = pluginFor(files, files, {
    toolchainVersion: '1.89.0',
    runner: () => {
      calls += 1;
    },
  });
  assert.equal(
    (await extractorFor(unsupported, '1.89.0').analyze(base, head)).status,
    'UNSUPPORTED',
  );
  assert.equal(calls, 0);
  const substituted = pluginFor(files, files, { loadProject: () => project(base, files) });
  assert.equal((await substituted.analyze(base, head)).status, 'FAILED');
  for (const runner of [
    undefined,
    async () => {
      throw new Error('private timeout');
    },
    async () => ({
      schema_version: 1,
      toolchain_version: '1.91.0',
      status: 'COMPILED',
      functions: [],
    }),
    async () => ({
      schema_version: 1,
      toolchain_version: '1.90.0',
      status: 'COMPILED',
      functions: [{ name: 'fake', signature: 'untyped', body: '', references: [] }],
    }),
    async () => ({
      schema_version: 1,
      toolchain_version: '1.90.0',
      status: 'COMPILED',
      functions: [],
      diagnostics: 'private',
    }),
  ]) {
    const output = await pluginFor(files, files, { runner }).analyze(base, head);
    assert.equal(output.status, 'FAILED');
    assert.deepEqual(output.effects, []);
    assert.ok(!JSON.stringify(output).includes('private'));
  }
  for (const status of ['FAILED', 'UNSUPPORTED']) {
    const runner = async () => ({
      schema_version: 1,
      toolchain_version: '1.90.0',
      status,
      functions: [],
    });
    assert.equal((await pluginFor(files, files, { runner }).analyze(base, head)).status, status);
  }
});

test('effects and digest are deterministic across workspace locations and source ordering', async () => {
  const beforeFiles = source('');
  const afterFiles = [
    { path: 'src/lib.rs', contents: await fixture('module-root.rs') },
    { path: 'src/nested.rs', contents: await fixture('nested.rs') },
  ];
  const first = await extractorFor(pluginFor(beforeFiles, afterFiles)).analyze(base, head);
  const other = await extractorFor(
    pluginFor([...beforeFiles].reverse(), [...afterFiles].reverse()),
  ).analyze(base, head);
  assert.equal(first.status, 'PARTIAL');
  assert.equal(other.status, 'PARTIAL');
  assert.deepEqual(first, other);
});

test('required partial Rust compiler analysis cannot make a Decision resolvable', async () => {
  const output = await extractorFor(
    pluginFor(source(''), source(await fixture('base.rs'))),
  ).analyze(base, head);
  assert.equal(output.status, 'PARTIAL');
  const digest = (domain) => `sha256:${domain}:v1:${'a'.repeat(64)}`;
  const basis = await buildDecisionBasis({
    schema_version: 1,
    candidate_digests: [digest('object-candidate')],
    evidence_digests: [],
    material_effect_digest: digest('material-effect'),
    policy_digest: digest('policy'),
    canonical_ref_oids: { 'rust-repository': { 'refs/heads/main': base.commit_oid } },
    required_analysis_status: { 'rust-semantic': output.status },
  });
  const decision = await makeReviewable(
    {
      schema_version: 1,
      id: `klocgit:decision:v1:sha256:${'a'.repeat(64)}`,
      state: 'DISCOVERED',
      basis: null,
      resolution: null,
    },
    basis,
  );
  await assert.rejects(
    makeResolvable(decision, basis, {
      policyEvaluator: { required_analysis: () => ['rust-semantic'], can_resolve: () => true },
      subject: {},
      effects: [output],
    }),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
});
