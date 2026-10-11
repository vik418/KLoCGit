import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createGoSemanticExtractor, GO_SUPPORTED_VERSIONS } from '../../adapters/analysis/go.mjs';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { Extractor, verifyEffectSet } from '../../core/v1/extractors.mjs';
import { goTestRunner } from './support/go-runner.mjs';

const revision = (character) =>
  FutureRevision({
    schema_version: 1,
    id: 'klocgit:future-revision:v1:sha256:' + character.repeat(64),
    system_id: 'system',
    repo_id: 'repo',
    ref: 'refs/heads/main',
    commit_oid: character.repeat(40),
    tree_oid: character.repeat(40),
    parent_oids: [],
    producer: null,
    observed_at: '2026-10-10T00:00:00Z',
  });
const base = revision('a');
const observed = revision('b');
const project = (subject, contents = '', files = [], complete = true) => ({
  schema_version: 1,
  repo_id: subject.repo_id,
  commit_oid: subject.commit_oid,
  tree_oid: subject.tree_oid,
  complete,
  files: [
    { path: 'go.mod', contents: 'module example.test/project\n\ngo 1.26\n' },
    ...(contents ? [{ path: 'main.go', contents }] : []),
    ...files,
  ],
});
const emptyResponse = (status = 'COMPLETE', version = '1.27.2') => ({
  schema_version: 1,
  toolchain_version: version,
  capability: 'SEMANTIC',
  status,
  effects: [],
  security_effects: [],
});
function extractor(version, before, next, runner) {
  return new Extractor({
    plugin: createGoSemanticExtractor({
      toolchain_version: version,
      loadProject: (subject) => (subject.id === base.id ? before : next),
      runner,
    }),
    language: 'go',
    toolchain_version: version,
  });
}

test('Go capabilities publish exact compiler versions and reject other languages/versions', () => {
  const plugin = createGoSemanticExtractor({
    toolchain_version: '1.27.2',
    loadProject: () => {},
    runner: () => {},
  });
  for (const version of ['1.26.9', '1.27.2', '1.27.0', '1.28.0', 'go1.27.2', 'devel']) {
    const configured = createGoSemanticExtractor({
      toolchain_version: version,
      loadProject: () => {},
      runner: () => {},
    });
    const metadata = configured.capabilities('go', version);
    assert.deepEqual(
      Object.keys(metadata).sort(),
      [
        'schema_version',
        'language',
        'toolchain_version',
        'supported_versions',
        'capability',
        'status',
      ].sort(),
    );
    assert.deepEqual(metadata.supported_versions, ['1.26.9', '1.27.2']);
    assert.equal(
      metadata.status,
      GO_SUPPORTED_VERSIONS.includes(version) ? 'COMPLETE' : 'UNSUPPORTED',
    );
    assert.equal(metadata.capability, 'SEMANTIC');
  }
  assert.equal(plugin.capabilities('javascript', '1.27.2').status, 'UNSUPPORTED');
  assert.equal(plugin.capabilities('go', '1.26.9').status, 'UNSUPPORTED');
});

test('Go unsupported versions never load source or invoke the runner', async () => {
  let called = false;
  const plugin = createGoSemanticExtractor({
    toolchain_version: '1.25.0',
    loadProject: () => {
      called = true;
    },
    runner: () => {
      called = true;
    },
  });
  const result = await new Extractor({
    plugin,
    language: 'go',
    toolchain_version: '1.25.0',
  }).analyze(base, observed);
  assert.equal(result.status, 'UNSUPPORTED');
  assert.equal(called, false);
});

test('Go rejects substituted source before passing validated data to its narrow runner', async () => {
  let called = false;
  const result = await extractor(
    '1.27.2',
    project(base),
    { ...project(observed), tree_oid: 'c'.repeat(40) },
    () => {
      called = true;
    },
  ).analyze(base, observed);
  assert.equal(result.status, 'FAILED');
  assert.equal(called, false);
  let request;
  const valid = await extractor('1.27.2', project(base), project(observed), (value) => {
    request = value;
    return emptyResponse();
  }).analyze(base, observed);
  assert.equal(valid.status, 'COMPLETE');
  assert.deepEqual(Object.keys(request).sort(), [
    'base',
    'revision',
    'schema_version',
    'toolchain_version',
  ]);
  assert.equal(request.revision.tree_oid, observed.tree_oid);
});

test('Go partial hydration and malformed/failed runner output stay explicit SEMANTIC statuses', async () => {
  assert.equal(
    (
      await extractor('1.27.2', project(base), project(observed, '', [], false), () =>
        emptyResponse(),
      ).analyze(base, observed)
    ).status,
    'PARTIAL',
  );
  for (const response of [
    { ...emptyResponse(), toolchain_version: '1.26.9' },
    { ...emptyResponse(), capability: 'STRUCTURAL' },
    { ...emptyResponse(), status: 'green' },
    { ...emptyResponse(), extra: true },
    { ...emptyResponse(), effects: [{ kind: 'syntax' }] },
  ]) {
    const result = await extractor(
      '1.27.2',
      project(base),
      project(observed),
      () => response,
    ).analyze(base, observed);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.capability, 'SEMANTIC');
  }
  const failed = await extractor('1.27.2', project(base), project(observed), () => {
    throw new Error('private runner detail');
  }).analyze(base, observed);
  assert.equal(failed.status, 'FAILED');
  assert.ok(!JSON.stringify(failed).includes('private runner detail'));
});

const runners = [];
after(async () => {
  await Promise.all(runners.map((runner) => runner.close()));
});
const selectedVersion = process.env.KLOCGIT_GO_TEST_VERSION;
if (selectedVersion && !GO_SUPPORTED_VERSIONS.includes(selectedVersion))
  throw new Error('The requested Go fixture compiler is unsupported.');
for (const version of selectedVersion ? [selectedVersion] : GO_SUPPORTED_VERSIONS) {
  test(`Go ${version} actual compiler semantic/syntax corpus`, async () => {
    const runner = await goTestRunner(version);
    runners.push(runner);
    const analyze = (source, files = [], before = project(base), complete = true) =>
      extractor(version, before, project(observed, source, files, complete), runner.run).analyze(
        base,
        observed,
      );
    const result = await analyze(
      `package main
import alias "example.test/project/model"
func Identity[T any](v T) T { return v }
var Value = Identity(alias.Make())
func Read() int { return Value.Count }
func Shadow() int { Identity := func(v string) int { return len(v) }; return Identity("x") }
func init() { panic("producer must never execute") }
//go:generate producer-command-must-never-run
`,
      [
        {
          path: 'model/model.go',
          contents:
            'package model\ntype Counter struct { Count int }\nfunc Make() Counter { return Counter{Count: 7} }',
        },
      ],
    );
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.capability, 'SEMANTIC');
    const value = result.effects.find((effect) => effect.target === 'example.test/project.Value');
    assert.equal(value.attributes.after.type, 'example.test/project/model.Counter');
    assert.ok(value.references.includes('example.test/project/model.Make'));
    assert.ok(
      value.attributes.after.generic_instances.includes(
        'func(v example.test/project/model.Counter) example.test/project/model.Counter',
      ),
    );
    const read = result.effects.find((effect) => effect.target === 'example.test/project.Read');
    assert.ok(read.references.includes('example.test/project/model.Counter.Count'));
    assert.ok(
      !result.effects
        .find((effect) => effect.target === 'example.test/project.Shadow')
        .references.includes('example.test/project.Identity'),
    );
    assert.deepEqual(await verifyEffectSet(result), result);
    for (const effect of [...result.effects, ...result.security_effects]) {
      assert.match(effect.kind, /^[a-z][a-z0-9-]*$/);
      assert.match(effect.operation, /^[a-z][a-z0-9-]*$/);
      assert.equal(effect.attributes.static_bounds.runtime_behavior, 'not-evaluated');
    }
    const security = await analyze(
      'package main\nimport cmd "os/exec"\nfunc Run() *cmd.Cmd { return cmd.Command("echo") }',
    );
    assert.equal(security.status, 'COMPLETE');
    assert.ok(
      security.security_effects.some(
        (effect) =>
          effect.references.includes('os/exec.Command') &&
          effect.attributes.categories.includes('process'),
      ),
    );
    const modifiedBase = project(
      base,
      'package main\nvar Removed = 1\nfunc Value() int { return 1 }',
    );
    const delta = await analyze('package main\nfunc Value() int { return 2 }', [], modifiedBase);
    assert.equal(
      delta.effects.find((effect) => effect.target === 'example.test/project.Removed').operation,
      'removed',
    );
    assert.equal(
      delta.effects.find((effect) => effect.target === 'example.test/project.Value').operation,
      'modified',
    );
    assert.deepEqual(
      await analyze('package main\nfunc Value() int { return 2 }', [], modifiedBase),
      delta,
    );
    const unchanged = project(base, 'package main\nvar Value = 1');
    assert.deepEqual((await analyze('package main\nvar Value = 1', [], unchanged)).effects, []);
    for (const [source, status] of [
      ['package main\nfunc Broken( {', 'FAILED'],
      ['package main\nvar Value int = "invalid"', 'FAILED'],
      ['package main\nvar Value = Missing', 'FAILED'],
      ['package main\nimport dep "example.invalid/dependency"\nvar Value = dep.Value', 'PARTIAL'],
      ['package main\nimport "C"\nvar Value = C.int(0)', 'PARTIAL'],
      ['//go:build optional\npackage main\nvar Value = 1', 'PARTIAL'],
    ])
      assert.equal((await analyze(source)).status, status, source);
    assert.equal(
      (await analyze('package main\nvar Value = 1', [], project(base), false)).status,
      'PARTIAL',
    );
    assert.equal(
      (await analyze('package main', [{ path: 'main_test.go', contents: 'package main' }])).status,
      'PARTIAL',
    );
    const newer = project(observed, 'package main');
    newer.files[0].contents = 'module example.test/project\ngo 1.28\n';
    assert.equal(
      (await extractor(version, project(base), newer, runner.run).analyze(base, observed)).status,
      'UNSUPPORTED',
    );
  });
}
