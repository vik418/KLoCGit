import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {
  StructuralExtractor,
  TypeScriptStructuralParser,
} from '../../adapters/analysis/structural.mjs';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { Extractor, verifyEffectSet } from '../../core/v1/extractors.mjs';

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
const next = revision('b');

function project(subject, files, complete = true) {
  return {
    schema_version: 1,
    repo_id: subject.repo_id,
    commit_oid: subject.commit_oid,
    tree_oid: subject.tree_oid,
    complete,
    files: Object.entries(files).map(([path, contents]) => ({ path, contents })),
  };
}

function fixture(before, after, options = {}) {
  const projects = new Map([
    [base.id, project(base, before, options.baseComplete ?? true)],
    [next.id, project(next, after, options.revisionComplete ?? true)],
  ]);
  const language = options.language ?? 'typescript';
  const toolchain_version = options.toolchain_version ?? '6.0.3';
  const plugin = new StructuralExtractor({
    loadProject: options.loadProject ?? ((subject) => projects.get(subject.id)),
    parser: options.parser,
    language,
    toolchain_version,
  });
  const extractor = new Extractor({ plugin, language, toolchain_version });
  return { plugin, extractor, run: () => extractor.analyze(base, next) };
}

function tokens(syntax) {
  if (syntax === null) return [];
  if (Array.isArray(syntax)) return syntax.flatMap(tokens);
  return syntax.children ? syntax.children.flatMap(tokens) : [syntax.text];
}

const named = (result, kind, name) =>
  result.effects.filter((item) => item.kind === kind && item.attributes.name === name);

test('registered structural capabilities pin the maintained compiler version and six-field schema', async () => {
  assert.equal(ts.version, '6.0.3');
  const { extractor } = fixture({}, {});
  assert.equal(extractor.id, 'structural-parser');
  assert.equal(extractor.version, '1.0.0');
  for (const language of ['typescript', 'javascript']) {
    assert.deepEqual(await extractor.capabilities(language, '6.0.3'), {
      schema_version: 1,
      language,
      toolchain_version: '6.0.3',
      supported_versions: ['6.0.3'],
      capability: 'STRUCTURAL',
      status: 'COMPLETE',
    });
    for (const version of ['5.9.3', '6.0.2', '6.1.0', 'latest'])
      assert.equal((await extractor.capabilities(language, version)).status, 'UNSUPPORTED');
  }
  assert.equal((await extractor.capabilities('python', '6.0.3')).status, 'UNSUPPORTED');
});

test('unsupported language/toolchain never loads source or silently changes tier', async () => {
  for (const options of [{ language: 'python' }, { toolchain_version: '6.0.2' }]) {
    const result = await fixture(
      {},
      {},
      {
        ...options,
        loadProject: () => assert.fail('unsupported analysis must not hydrate source'),
      },
    ).run();
    assert.equal(result.status, 'UNSUPPORTED');
    assert.equal(result.capability, 'STRUCTURAL');
    assert.deepEqual(result.effects, []);
  }
  const wrongCompiler = new TypeScriptStructuralParser({ compiler: { ...ts, version: '6.0.2' } });
  assert.equal((await fixture({}, {}, { parser: wrongCompiler }).run()).status, 'FAILED');
});

test('whitespace and ordinary comments do not change parsed syntax effects', async () => {
  const result = await fixture(
    { 'src/value.ts': 'export function value(a: number, b: string): number { return a + 1; }' },
    {
      'src/value.ts':
        '\n // explanatory comment\nexport   function value ( a : number , b : string ) : number\n{\nreturn a+1 ;\n}\n',
    },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.security_effects, []);
  assert.deepEqual(await verifyEffectSet(result), result);
});

test('declaration signature changes retain parameter order and distinguish body changes', async () => {
  const result = await fixture(
    { 'a.ts': 'export function convert(first: string, second: number): string { return first; }' },
    { 'a.ts': 'export function convert(second: number, first: string): string { return first; }' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  const signatures = named(result, 'signature', 'convert');
  assert.equal(signatures.length, 1);
  const before = tokens(signatures[0].attributes.before);
  const after = tokens(signatures[0].attributes.after);
  assert.ok(before.indexOf('first') < before.indexOf('second'));
  assert.ok(after.indexOf('second') < after.indexOf('first'));
  assert.equal(named(result, 'body', 'convert').length, 0);
  assert.ok(result.effects.some((item) => item.kind === 'file-structure'));
});

test('function and class method implementations change without changing their signatures', async () => {
  const result = await fixture(
    { 'a.ts': 'class Counter { read(n: number): number { return n + 1; } }' },
    { 'a.ts': 'class Counter { read(n: number): number { return n + 2; } }' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(named(result, 'body', 'read').length, 1);
  assert.equal(named(result, 'body', 'Counter').length, 1);
  assert.equal(named(result, 'signature', 'read').length, 0);
  assert.equal(named(result, 'signature', 'Counter').length, 0);
});

test('added, removed and renamed declarations report actual syntax observations', async () => {
  const result = await fixture(
    { 'a.ts': 'export function oldName(): number { return helper(); }' },
    { 'a.ts': 'export function newName(): number { return 2; }\nexport const added = true;' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(named(result, 'declaration', 'oldName')[0].operation, 'removed');
  assert.equal(named(result, 'declaration', 'newName')[0].operation, 'added');
  assert.equal(named(result, 'declaration', 'added')[0].operation, 'added');
  const reference = result.effects.find(
    (item) => item.kind === 'reference' && item.references.includes('identifier:helper'),
  );
  assert.equal(reference.operation, 'removed');
  assert.equal(reference.attributes.reference_resolution, 'unresolved');
});

test('whole-file removals include declarations and dependency references', async () => {
  const result = await fixture(
    { 'removed.ts': 'import { read } from "storage"; export function load() { return read(); }' },
    {},
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.ok(result.effects.every((item) => item.operation === 'removed'));
  assert.equal(named(result, 'declaration', 'load').length, 1);
  assert.ok(
    result.effects.some(
      (item) => item.kind === 'reference' && item.references.includes('module:storage'),
    ),
  );
});

test('static imports, reexports, import types and dynamic/CommonJS calls expose unresolved module observations', async () => {
  const sources = {
    'a.ts': [
      'import { value } from "static";',
      'export { value } from "reexport";',
      'type T = import("types").Shape;',
      'import old = require("equals");',
      'const lazy = import("dynamic");',
      'function require(name: string) { return name; }',
      'const shadowed = require("shadowed");',
    ].join('\n'),
  };
  const result = await fixture({}, sources).run();
  assert.equal(result.status, 'COMPLETE');
  for (const name of ['static', 'reexport', 'types', 'equals', 'dynamic', 'shadowed']) {
    const observation = result.effects.find((item) => item.references.includes('module:' + name));
    assert.ok(observation, name);
    assert.equal(observation.kind, 'reference');
    assert.equal(observation.attributes.reference_resolution, 'unresolved');
  }
});

test('interface members, enums, declaration overloads and namespace signatures remain structured', async () => {
  const source = [
    'export interface Shape { readonly first: number; second?: string; call(x: number): string; }',
    'export enum Mode { First = 1, Second = 2 }',
    'declare function overloaded(value: string): number;',
    'declare function overloaded(value: number): string;',
    'namespace Nested { export type Value = [number, string]; }',
  ].join('\n');
  const result = await fixture({}, { 'types.ts': source }).run();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(named(result, 'declaration', 'overloaded').length, 2);
  assert.equal(
    named(result, 'declaration', 'Second')[0].attributes.declaration_kind,
    'enum-member',
  );
  const shape = named(result, 'declaration', 'Shape')[0].attributes.after;
  assert.ok(tokens(shape.signature).indexOf('first') < tokens(shape.signature).indexOf('second'));
  assert.equal(named(result, 'declaration', 'Value')[0].attributes.declaration_kind, 'type-alias');
});

test('quoted empty names and deep declaration scopes remain valid syntax projections', async () => {
  const namespaces = Array.from({ length: 12 }, (_, index) => 'namespace N' + index + ' {').join(
    '',
  );
  const source = namespaces + 'export class Named { ""(): number { return 1; } }' + '}'.repeat(12);
  const result = await fixture({}, { 'a.ts': source + '\nimport "";' }).run();
  assert.equal(result.status, 'COMPLETE');
  const method = named(result, 'declaration', '')[0];
  assert.equal(method.attributes.declaration_kind, 'method');
  assert.ok(method.target.length < 500);
  assert.ok(result.effects.some((item) => item.references.includes('module:')));
});

test('moving declarations preserves their order rather than treating the file as a set', async () => {
  const first = 'export const first = 1;';
  const second = 'export const second = 2;';
  const result = await fixture({ 'a.ts': first + second }, { 'a.ts': second + first }).run();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(
    result.effects.map((item) => item.kind),
    ['file-structure'],
  );
  const order = result.effects[0].attributes.declaration_order;
  assert.deepEqual(order.before, [...order.after].reverse());
  assert.notEqual(
    result.effects[0].attributes.before_digest,
    result.effects[0].attributes.after_digest,
  );
});

test('unmodeled executable statements still produce file structure effects', async () => {
  const result = await fixture(
    { 'a.ts': 'if (ready) { start(); }' },
    { 'a.ts': 'if (ready) { start(); stop(); }' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.ok(result.effects.some((item) => item.kind === 'file-structure'));
  assert.ok(result.effects.some((item) => item.references.includes('identifier:stop')));
});

test('mixed or omitted files remain partial and retain supported observations', async () => {
  const result = await fixture(
    { 'a.ts': 'export const count = 1;', 'outside.py': 'count = 1' },
    { 'a.ts': 'export const count = 2;', 'outside.py': 'count = 2' },
  ).run();
  assert.equal(result.status, 'PARTIAL');
  assert.equal(named(result, 'body', 'count').length, 1);
  assert.ok(
    result.effects.some(
      (item) => item.kind === 'analysis-gap' && item.attributes.reason === 'unsupported-path',
    ),
  );
  const omitted = await fixture(
    { 'a.ts': 'export const count = 1;' },
    { 'a.ts': 'export const count = 1;' },
    { revisionComplete: false },
  ).run();
  assert.equal(omitted.status, 'PARTIAL');
  assert.ok(omitted.effects.some((item) => item.attributes.reason === 'partial-project'));
});

test('an omitted side of a partial snapshot cannot prove addition or removal', async () => {
  for (const [before, after, options, phase] of [
    [{}, { 'a.ts': 'export const present = 1;' }, { baseComplete: false }, 'revision'],
    [{ 'a.ts': 'export const present = 1;' }, {}, { revisionComplete: false }, 'base'],
  ]) {
    const result = await fixture(before, after, options).run();
    assert.equal(result.status, 'PARTIAL');
    assert.ok(!result.effects.some((item) => ['added', 'removed'].includes(item.operation)));
    const observed = result.effects.find((item) => item.operation === 'observed');
    assert.equal(observed.kind, 'file-structure');
    assert.equal(observed.attributes.phase, phase);
  }
});

test('syntax errors and TS-only syntax in JavaScript fail explicitly', async () => {
  for (const [path, source, language] of [
    ['a.ts', 'export function broken( {', 'typescript'],
    ['a.js', 'const typed: number = 1;', 'javascript'],
    ['a.tsx', 'export const bad = <Widget>;', 'typescript'],
  ]) {
    const result = await fixture({}, { [path]: source }, { language }).run();
    assert.equal(result.status, 'FAILED');
    assert.equal(result.capability, 'STRUCTURAL');
    assert.deepEqual(result.effects, []);
  }
});

test('TypeScript/JavaScript syntax fixtures include JSX, TSX and module extensions', async () => {
  for (const [path, source, language] of [
    ['a.tsx', 'export const view = <Widget value={1} />;', 'typescript'],
    ['a.mts', 'export const version = 1;', 'typescript'],
    ['a.cts', 'export = { version: 1 };', 'typescript'],
    ['a.jsx', 'export const view = <Widget value={1} />;', 'javascript'],
    ['a.mjs', 'export const version = 1;', 'javascript'],
    ['a.cjs', 'module.exports = { version: 1 };', 'javascript'],
  ]) {
    assert.equal(
      (await fixture({}, { [path]: source }, { language }).run()).status,
      'COMPLETE',
      path,
    );
  }
});

test('JavaScript JSDoc type syntax participates in structural signature observations', async () => {
  const result = await fixture(
    { 'a.js': '/** @param {number} input */ export function run(input) { return input; }' },
    { 'a.js': '/** @param {string} input */ export function run(input) { return input; }' },
    { language: 'javascript' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(named(result, 'signature', 'run').length, 1);
  assert.equal(named(result, 'body', 'run').length, 0);
});

test('semantic invalidity and unresolved names stay bounded structural claims', async () => {
  const result = await fixture(
    {},
    { 'a.ts': 'export const amount: number = "wrong type"; nonexistent(amount);' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.capability, 'STRUCTURAL');
  assert.ok(result.effects.every((item) => item.attributes.analysis_scope === 'syntax-only'));
  assert.ok(result.effects.some((item) => item.references.includes('identifier:nonexistent')));
  assert.ok(
    result.effects
      .filter((item) => item.kind === 'reference')
      .every((item) => item.attributes.reference_resolution === 'unresolved'),
  );
  assert.deepEqual(result.security_effects, []);
});

test('untrusted source is parsed in memory without executing imports or statements', async () => {
  const marker = '__klocgitStructuralExecutionProbe';
  assert.equal(globalThis[marker], undefined);
  const result = await fixture(
    {},
    {
      'a.js':
        'import "./does-not-exist.mjs"; globalThis.__klocgitStructuralExecutionProbe = true; process.exit(1);',
    },
    { language: 'javascript' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(globalThis[marker], undefined);
});

function abstractParser(options = {}) {
  return {
    id: 'fixture-json-parser',
    version: '1.2.3',
    capabilities: (language, toolchain_version) => ({
      schema_version: 1,
      language,
      toolchain_version,
      supported_versions: ['fixture-version'],
      capability: 'STRUCTURAL',
      status: 'COMPLETE',
      ...options.metadata,
    }),
    supportsPath: () => true,
    parse: ({ contents }) => ({
      schema_version: 1,
      status: 'COMPLETE',
      declarations: [
        { id: 'value', kind: 'variable', name: 'value', signature: ['value'], body: [contents] },
      ],
      references: [],
      structure: { ordered: [contents] },
    }),
    ...options.methods,
  };
}

test('JSON parser abstraction is independent of compiler SDK nodes', async () => {
  const result = await fixture(
    { 'fixture.custom': 'before' },
    { 'fixture.custom': 'after' },
    { parser: abstractParser(), language: 'fixture', toolchain_version: 'fixture-version' },
  ).run();
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(named(result, 'body', 'value')[0].attributes.after, ['after']);
  assert.equal(
    result.effects.find((item) => item.kind === 'file-structure').attributes.parser_id,
    'fixture-json-parser',
  );
});

test('partial parser projections cannot turn omitted declarations into removals', async () => {
  const parser = abstractParser();
  const completeParse = parser.parse;
  parser.parse = (input) => {
    const parsed = completeParse(input);
    return input.contents === 'after' ? { ...parsed, status: 'PARTIAL', declarations: [] } : parsed;
  };
  const result = await fixture(
    { 'a.custom': 'before' },
    { 'a.custom': 'after' },
    { parser, language: 'fixture', toolchain_version: 'fixture-version' },
  ).run();
  assert.equal(result.status, 'PARTIAL');
  assert.ok(!result.effects.some((item) => item.operation === 'removed'));
  assert.ok(
    result.effects.some((item) => item.kind === 'declaration' && item.operation === 'observed'),
  );
  assert.ok(result.effects.some((item) => item.attributes.reason === 'partial-parser'));
});

test('parser failures, malformed projections, wrong tier and source substitutions fail closed', async () => {
  const broken = [
    abstractParser({ metadata: { capability: 'SEMANTIC' } }),
    abstractParser({
      methods: {
        parse: () => {
          throw new Error('private source diagnostic');
        },
      },
    }),
    abstractParser({ methods: { parse: () => ({ schema_version: 1, status: 'COMPLETE' }) } }),
    abstractParser({ methods: { supportsPath: () => 'yes' } }),
  ];
  for (const parser of broken) {
    const result = await fixture(
      {},
      { 'a.custom': 'after' },
      {
        parser,
        language: 'fixture',
        toolchain_version: 'fixture-version',
      },
    ).run();
    assert.equal(result.status, 'FAILED');
    assert.deepEqual(result.effects, []);
    assert.ok(!JSON.stringify(result).includes('private source diagnostic'));
  }
  const substituted = await fixture(
    {},
    {},
    {
      loadProject: (subject) => ({ ...project(subject, {}), tree_oid: 'c'.repeat(40) }),
    },
  ).run();
  assert.equal(substituted.status, 'FAILED');
});

test('parser metadata and per-file unavailable statuses remain explicit', async () => {
  const partial = await fixture(
    {},
    { 'a.custom': 'after' },
    {
      parser: abstractParser({ metadata: { status: 'PARTIAL' } }),
      language: 'fixture',
      toolchain_version: 'fixture-version',
    },
  ).run();
  assert.equal(partial.status, 'PARTIAL');
  for (const status of ['UNSUPPORTED', 'FAILED']) {
    const parser = abstractParser({
      methods: {
        parse: () => ({
          schema_version: 1,
          status,
          declarations: [],
          references: [],
          structure: null,
        }),
      },
    });
    const result = await fixture(
      { 'a.custom': 'before' },
      { 'a.custom': 'after' },
      {
        parser,
        language: 'fixture',
        toolchain_version: 'fixture-version',
      },
    ).run();
    assert.equal(result.status, status === 'FAILED' ? 'FAILED' : 'PARTIAL');
    if (status === 'UNSUPPORTED')
      assert.equal(result.effects.filter((item) => item.kind === 'analysis-gap').length, 2);
  }
});

test('file enumeration and repeated runs produce the same verified effect identity', async () => {
  const f = fixture(
    { 'b.ts': 'export const b = 1;', 'a.ts': 'export const a = 1;' },
    { 'a.ts': 'export const a = 2;', 'b.ts': 'export const b = 2;' },
  );
  const first = await f.run();
  assert.equal(first.status, 'COMPLETE');
  const reversed = await fixture(
    { 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 1;' },
    { 'b.ts': 'export const b = 2;', 'a.ts': 'export const a = 2;' },
  ).run();
  assert.deepEqual(await f.run(), first);
  assert.deepEqual(reversed, first);
  assert.deepEqual(await verifyEffectSet(first), first);
});
