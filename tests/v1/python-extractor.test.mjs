import assert from 'node:assert/strict';
import { readFile, mkdtemp, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { Extractor, verifyEffectSet } from '../../core/v1/extractors.mjs';
import {
  createPythonSemanticExtractor,
  PYTHON_ANALYSIS_PROTOCOL,
  PYTHON_SEMANTIC_SCOPE,
  PYTHON_SUPPORTED_VERSIONS,
} from '../../adapters/analysis/python.mjs';
import { pythonAnalysisRunner } from '../support/python-analysis-runner.mjs';

const corpus = JSON.parse(
  await readFile(new URL('./python-extractor.corpus.json', import.meta.url), 'utf8'),
);
const revision = (character) =>
  FutureRevision({
    schema_version: 1,
    id: 'klocgit:future-revision:v1:sha256:' + character.repeat(64),
    system_id: 'group',
    repo_id: 'repo',
    ref: 'refs/heads/main',
    commit_oid: character.repeat(40),
    tree_oid: character.repeat(40),
    parent_oids: [],
    producer: null,
    observed_at: '2026-10-10T00:00:00Z',
  });
const base = revision('a');
const future = revision('b');
const files = (entries) =>
  Object.entries(typeof entries === 'string' ? { 'module.py': entries } : entries).map(
    ([path, contents]) => ({ path, contents }),
  );
const project = (subject, entries, complete = true) => ({
  schema_version: 1,
  repo_id: subject.repo_id,
  commit_oid: subject.commit_oid,
  tree_oid: subject.tree_oid,
  complete,
  files: files(entries),
});

function fixture(before = {}, after = {}, options = {}) {
  const toolchainVersion = options.toolchainVersion ?? '3.12.14';
  const plugin = createPythonSemanticExtractor({
    toolchainVersion,
    loadProject: (subject) =>
      subject.id === base.id
        ? project(subject, before, options.baseComplete ?? true)
        : project(subject, after, options.complete ?? true),
    analyzeRunner: pythonAnalysisRunner,
    ...options.plugin,
  });
  return {
    plugin,
    extractor: new Extractor({
      plugin,
      language: options.language ?? 'python',
      toolchain_version: toolchainVersion,
    }),
  };
}
const analyze = (before, after, options) =>
  fixture(before, after, options).extractor.analyze(base, future);
const reasons = (result) =>
  result.effects
    .filter((effect) => effect.kind === 'python-uncertainty')
    .map((effect) => effect.attributes.reason);
const afterAttributes = (effect) => effect.attributes.after ?? effect.attributes;

test('Python publishes exact compiler versions and bounded semantic claims', async () => {
  assert.deepEqual(PYTHON_SUPPORTED_VERSIONS, ['3.12.14']);
  assert.equal(PYTHON_SEMANTIC_SCOPE.compiler, 'cpython-compile-and-symtable');
  assert.ok(PYTHON_SEMANTIC_SCOPE.excludes.includes('behavioral-equivalence'));
  const { extractor } = fixture();
  assert.deepEqual(await extractor.capabilities('python', '3.12.14'), {
    schema_version: 1,
    language: 'python',
    toolchain_version: '3.12.14',
    supported_versions: ['3.12.14'],
    capability: 'SEMANTIC',
    status: 'COMPLETE',
  });
});

for (const version of ['3.11.15', '3.12', '3.12.13', '3.13.0', '3.14.0']) {
  test('Python version matrix refuses unverified compiler ' + version, async () => {
    let runs = 0;
    const { plugin, extractor } = fixture({}, 'value = 42\n', {
      toolchainVersion: version,
      plugin: {
        analyzeRunner: () => {
          runs += 1;
          throw new Error('must not run');
        },
      },
    });
    assert.equal((await extractor.capabilities('python', version)).status, 'UNSUPPORTED');
    assert.equal((await extractor.analyze(base, future)).status, 'UNSUPPORTED');
    assert.equal((await plugin.analyze(base, future)).status, 'UNSUPPORTED');
    assert.equal(runs, 0);
  });
}

for (const entry of corpus) {
  test('Python 3.12.14 corpus: ' + entry.name, async () => {
    const result = await analyze({}, entry.source);
    assert.equal(result.status, entry.status);
    assert.equal(result.capability, 'SEMANTIC');
    assert.equal(result.extractor_id, 'python-semantic');
    if (entry.reason) assert.ok(reasons(result).includes(entry.reason), JSON.stringify(result));
    await verifyEffectSet(result);
  });
}

test('Python compiler closure and nonlocal references bind the owning lexical scope', async () => {
  const result = await analyze({}, corpus.find((entry) => entry.name.includes('nonlocal')).source);
  const symbol = result.effects.find(
    (effect) => effect.target === 'module.py#module/outer/inner:value',
  );
  assert.equal(afterAttributes(symbol).flags.nonlocal, true);
  assert.equal(afterAttributes(symbol).flags.free, true);
  assert.equal(afterAttributes(symbol).binding_target, 'module.py#module/outer:value');
  assert.deepEqual(symbol.references, ['module.py#module/outer:value']);
});

test('Python import aliases resolve hydrated packages and project function call references', async () => {
  const result = await analyze(
    {},
    {
      'pkg/__init__.py': '',
      'pkg/values.py': 'def answer():\n    return 42\n',
      'pkg/main.py': 'from .values import answer as selected\nresult = selected()\n',
    },
  );
  assert.equal(result.status, 'COMPLETE');
  const call = result.effects.find((effect) => effect.kind === 'python-call');
  assert.equal(afterAttributes(call).resolved, true);
  assert.equal(afterAttributes(call).callable, 'pkg/values.py#module:answer');
  assert.deepEqual(call.references, ['pkg/values.py#module:answer']);
});

test('Python module aliases resolve hydrated functions without importing modules', async () => {
  const result = await analyze(
    {},
    {
      'values.py': 'def answer():\n    return 42\n',
      'main.py': 'import values as module\nresult = module.answer()\n',
    },
  );
  assert.equal(result.status, 'COMPLETE');
  assert.equal(
    afterAttributes(result.effects.find((effect) => effect.kind === 'python-call')).callable,
    'values.py#module:answer',
  );
});

test('Python parameter shadowing cannot inherit security claims from a module import', async () => {
  const result = await analyze(
    {},
    'import subprocess as worker\ndef invoke(worker):\n    return worker.run()\n',
  );
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.security_effects.length, 0);
  assert.ok(reasons(result).includes('unresolved-call'));
});

test('Python observed security calls follow static import aliases and builtin shadowing', async () => {
  const external = await analyze({}, 'import subprocess as worker\nworker.run(["command"])\n');
  assert.equal(external.status, 'PARTIAL');
  assert.equal(external.security_effects.length, 1);
  assert.equal(external.security_effects[0].attributes.callable, 'subprocess.run');
  assert.equal(external.security_effects[0].attributes.claim, 'observed-static-call');
  const shadowed = await analyze({}, 'def eval(value):\n    return value\nanswer = eval(42)\n');
  assert.equal(shadowed.status, 'COMPLETE');
  assert.equal(shadowed.security_effects.length, 0);
});

test('Python source changes produce added modified removed normalized compiler observations', async () => {
  const result = await analyze(
    { 'values.py': 'def old():\n    return 1\n', 'removed.py': 'value = 1\n' },
    { 'values.py': 'def new():\n    return 2\n', 'added.py': 'value = 3\n' },
  );
  assert.equal(result.status, 'COMPLETE');
  assert.ok(
    result.effects.some(
      (effect) => effect.target === 'removed.py' && effect.operation === 'removed',
    ),
  );
  assert.ok(
    result.effects.some((effect) => effect.target === 'added.py' && effect.operation === 'added'),
  );
  assert.ok(
    result.effects.some(
      (effect) => effect.target === 'values.py' && effect.operation === 'modified',
    ),
  );
  assert.ok(
    result.effects.every(
      (effect) =>
        Object.keys(effect).sort().join() ===
        'attributes,kind,operation,references,schema_version,target',
    ),
  );
});

test('Python effects ignore comments and location shifts but preserve semantic expression ordering', async () => {
  const before = 'def answer():\n    return (1, 2)\n';
  const cosmetic = await analyze(before, '# comment\n\n' + before);
  assert.equal(cosmetic.status, 'COMPLETE');
  assert.deepEqual(cosmetic.effects, []);
  const changed = await analyze(before, 'def answer():\n    return (2, 1)\n');
  assert.ok(changed.effects.some((effect) => effect.kind === 'python-declaration'));
  const ordered = await analyze({}, { 'a.py': before, 'b.py': 'value = 42\n' });
  const reordered = await analyze({}, { 'b.py': 'value = 42\n', 'a.py': before });
  assert.deepEqual(ordered, reordered);
});

test('Python incomplete hydration and missing import symbols remain partial', async () => {
  for (const options of [{ complete: false }, { baseComplete: false }]) {
    const result = await analyze({}, 'value = 42\n', options);
    assert.equal(result.status, 'PARTIAL');
    assert.ok(reasons(result).includes('incomplete-hydration'));
  }
  const missing = await analyze(
    {},
    {
      'values.py': 'known = 1\n',
      'main.py': 'from values import missing\nmissing()\n',
    },
  );
  assert.equal(missing.status, 'PARTIAL');
  assert.ok(reasons(missing).includes('unresolved-import-symbol'));
});

test('Python import cycles and callable rebinding remain partial', async () => {
  const cycles = await analyze({}, { 'a.py': 'import b\n', 'b.py': 'import a\n' });
  assert.equal(cycles.status, 'PARTIAL');
  assert.ok(reasons(cycles).includes('cyclic-import'));
  const rebound = await analyze(
    {},
    'def selected():\n    return 42\nselected = unknown\nselected()\n',
  );
  assert.equal(rebound.status, 'PARTIAL');
  assert.ok(reasons(rebound).includes('rebound-name'));
  assert.ok(reasons(rebound).includes('unresolved-call'));
});

test('Python imported values and modules do not become resolved callable definitions', async () => {
  for (const source of ['from values import number\nnumber()\n', 'import values\nvalues()\n']) {
    const result = await analyze({}, { 'values.py': 'number = 42\n', 'main.py': source });
    assert.equal(result.status, 'PARTIAL');
    assert.ok(reasons(result).includes('unresolved-call'));
  }
});

test('Python global writes retain compiler ownership and do not become builtin security calls', async () => {
  const result = await analyze(
    {},
    'def replace():\n    global eval\n    eval = 42\n    return eval()\n',
  );
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.security_effects.length, 0);
  const symbol = result.effects.find((effect) => effect.target === 'module.py#module/replace:eval');
  assert.equal(afterAttributes(symbol).flags.global, true);
  assert.equal(afterAttributes(symbol).binding_target, 'module.py#module:eval');
});

test('Python builtin keyword protocols and unpacking unknown values remain partial', async () => {
  const keywords = await analyze({}, 'def write(value):\n    return print(file=value)\n');
  assert.equal(keywords.status, 'PARTIAL');
  assert.ok(reasons(keywords).includes('dynamic-builtin-dispatch'));
  const unpack = await analyze(
    {},
    'def unpack(value):\n    first, second = value\n    return first\n',
  );
  assert.equal(unpack.status, 'PARTIAL');
  assert.ok(reasons(unpack).includes('dynamic-unpacking'));
});

test('Python analysis never executes top-level producer actions or imports project code', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'klocgit-python-noexec-'));
  const marker = path.join(directory, 'executed');
  try {
    const result = await analyze(
      {},
      {
        'danger.py': `open(${JSON.stringify(marker)}, "w").write("executed")\nraise RuntimeError("producer exception")\n`,
        'main.py': 'import danger\n',
      },
    );
    assert.equal(result.status, 'PARTIAL');
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Python wrapper checks exact source identity before its narrowly injected runner', async () => {
  let runs = 0;
  const result = await analyze(
    {},
    {},
    {
      plugin: {
        loadProject: (subject) => ({ ...project(subject, {}), tree_oid: 'c'.repeat(40) }),
        analyzeRunner: () => {
          runs += 1;
        },
      },
    },
  );
  assert.equal(result.status, 'FAILED');
  assert.equal(runs, 0);
  let seen;
  const observed = await analyze({}, 'value = 42\n', {
    plugin: {
      analyzeRunner: (request) => {
        seen = request;
        return pythonAnalysisRunner(request);
      },
    },
  });
  assert.equal(observed.status, 'COMPLETE');
  assert.deepEqual(Object.keys(seen).sort(), [
    'base',
    'protocol',
    'revision',
    'schema_version',
    'toolchain_version',
  ]);
  assert.equal(seen.protocol, PYTHON_ANALYSIS_PROTOCOL);
  assert.equal(seen.base.commit_oid, base.commit_oid);
  assert.equal(seen.revision.tree_oid, future.tree_oid);
});

test('Python runner failures malformed replies and wrong runtime never silently reduce tier', async () => {
  const complete = {
    capability: 'SEMANTIC',
    status: 'COMPLETE',
    effects: [],
    security_effects: [],
  };
  const envelope = (result = complete) => ({
    schema_version: 1,
    protocol: PYTHON_ANALYSIS_PROTOCOL,
    toolchain_version: '3.12.14',
    result,
  });
  for (const analyzeRunner of [
    () => {
      throw new Error('private credential diagnostic');
    },
    () => 'malformed',
    () => ({ ...envelope(), unexpected: true }),
    () => envelope({ ...complete, capability: 'STRUCTURAL' }),
    () => envelope({ ...complete, effects: [{ bad: true }] }),
  ]) {
    const result = await analyze({}, {}, { plugin: { analyzeRunner } });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.capability, 'SEMANTIC');
    assert.ok(!JSON.stringify(result).includes('private credential'));
  }
  const wrongRuntime = await analyze(
    {},
    {},
    { plugin: { analyzeRunner: () => ({ ...envelope(), toolchain_version: '3.12.13' }) } },
  );
  assert.equal(wrongRuntime.status, 'UNSUPPORTED');
  const missing = await analyze(
    {},
    {},
    { complete: false, plugin: { analyzeRunner: () => envelope() } },
  );
  assert.equal(missing.status, 'PARTIAL');
});
