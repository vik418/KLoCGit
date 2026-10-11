import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import {
  TypeScriptSemanticPlugin,
  TYPESCRIPT_SUPPORTED_VERSIONS,
} from '../../adapters/analysis/typescript.mjs';
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
const future = revision('b');
const config = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    allowJs: true,
    checkJs: true,
    jsx: 'preserve',
  },
};

function project(subject, input, complete = true) {
  const contents = { 'tsconfig.json': JSON.stringify(config), ...input };
  return {
    schema_version: 1,
    repo_id: subject.repo_id,
    commit_oid: subject.commit_oid,
    tree_oid: subject.tree_oid,
    complete,
    files: Object.entries(contents).map(([path, contents]) => ({ path, contents })),
  };
}

function fixture(before, after = before, options = {}) {
  const loadProject = (subject) =>
    project(subject, subject.id === base.id ? before : after, options.complete ?? true);
  const plugin = new TypeScriptSemanticPlugin({ loadProject, ...options });
  const extractor = new Extractor({
    plugin,
    language: options.language ?? 'typescript',
    toolchain_version: options.toolchain_version ?? ts.version,
  });
  return { plugin, extractor, loadProject };
}

const exported = (effectSet, target) =>
  effectSet.effects.find((effect) => effect.kind === 'semantic-export' && effect.target === target);
const scope = (effectSet) =>
  effectSet.effects.find((effect) => effect.kind === 'semantic-scope').attributes;

test('version matrix publishes the tested installed compiler exactly', async () => {
  assert.equal(ts.version, '6.0.3');
  assert.deepEqual(TYPESCRIPT_SUPPORTED_VERSIONS, ['6.0.3']);
  const { plugin } = fixture({ 'entry.ts': 'export const value=1;' });
  for (const language of ['typescript', 'javascript']) {
    for (const version of ['6.0.3', '6.0', '6.0.2', '5.9.3', '7.0.0', 'latest']) {
      const metadata = plugin.capabilities(language, version);
      assert.equal(metadata.capability, 'SEMANTIC');
      assert.deepEqual(metadata.supported_versions, ['6.0.3']);
      assert.equal(metadata.status, version === '6.0.3' ? 'COMPLETE' : 'UNSUPPORTED');
    }
  }
  assert.equal(plugin.capabilities('python', ts.version).status, 'UNSUPPORTED');
  let loaded = false;
  const unsupported = new TypeScriptSemanticPlugin({
    loadProject: () => {
      loaded = true;
      throw new Error('must not load unsupported source');
    },
    toolchain_version: '5.9.3',
  });
  assert.equal((await unsupported.analyze(base, future)).status, 'UNSUPPORTED');
  const extractor = new Extractor({
    plugin: unsupported,
    language: 'typescript',
    toolchain_version: '5.9.3',
  });
  assert.equal((await extractor.analyze(base, future)).status, 'UNSUPPORTED');
  assert.equal(loaded, false);
});

test('typechecker propagates changed inferred types into unchanged importing modules', async () => {
  const before = {
    'model.ts':
      'export interface User { id: string; } export function read():User{return {id:"a"};}',
    'consumer.ts': 'import {read as load} from "./model.js"; export const value = load().id;',
    'alias.ts': 'export {read as load} from "./model.js";',
  };
  const after = {
    ...before,
    'model.ts': 'export interface User { id: number; } export function read():User{return {id:1};}',
  };
  const result = await fixture(before, after).extractor.analyze(base, future);
  assert.equal(result.status, 'COMPLETE');
  const value = exported(result, 'consumer.ts#export:value');
  assert.equal(value.attributes.before.value.type, 'string');
  assert.equal(value.attributes.after.value.type, 'number');
  assert.ok(
    !result.effects.some(
      (effect) => effect.kind === 'semantic-source' && effect.target === 'consumer.ts',
    ),
  );
  const user = exported(result, 'model.ts#export:User');
  assert.equal(
    user.attributes.before.declared.members.find((member) => member.name === 'id').type,
    'string',
  );
  assert.equal(
    user.attributes.after.declared.members.find((member) => member.name === 'id').type,
    'number',
  );
  const references = result.effects.find(
    (effect) => effect.kind === 'semantic-reference' && effect.target === 'consumer.ts',
  );
  assert.ok(references.references.some((reference) => reference.startsWith('model.ts#read:')));
  assert.ok(references.attributes.after.calls.some((call) => call.return_type.endsWith('User')));
  assert.deepEqual(await verifyEffectSet(result), result);
});

test('generic instantiation and overload selection are compiler observations', async () => {
  const program = (literal) => `
    export function identity<T>(value:T):T {return value;}
    export function select(value:string):string;
    export function select(value:number):number;
    export function select(value:string|number):string|number{return value;}
    export const result=identity(select(${literal}));
  `;
  const result = await fixture(
    { 'generic.ts': program('"x"') },
    { 'generic.ts': program('7') },
  ).extractor.analyze(base, future);
  assert.equal(result.status, 'COMPLETE');
  const effect = exported(result, 'generic.ts#export:result');
  assert.equal(effect.attributes.before.value.type, 'string');
  assert.equal(effect.attributes.after.value.type, 'number');
  const calls = result.effects.find((effect) => effect.kind === 'semantic-reference').attributes;
  assert.ok(calls.before.calls.some((call) => call.signature.includes('(value: string): string')));
  assert.ok(calls.after.calls.some((call) => call.signature.includes('(value: number): number')));
});

test('interfaces, classes, mapped/conditional types, enums, JSX and module extensions compile in the fixture corpus', async () => {
  const files = {
    'types.ts': `
      export interface Model { readonly id: string; optional?: number; }
      export type Mutable<T> = { -readonly [K in keyof T]-?: T[K] };
      export type Value<T> = T extends {id: infer I} ? I : never;
      export const model = {id:'ready'} satisfies Model;
      export enum State { Ready, Complete }
      export class Box<T> { constructor(public value:T){} get():T{return this.value;} }
    `,
    'view.tsx': `declare global { namespace JSX { interface IntrinsicElements { button:{disabled?:boolean}; } } }
      export const view = <button disabled={false}/>;`,
    'esm.mts': 'export const named = 1n;',
    'common.cts': 'export const named = /valid/;',
  };
  const result = await fixture({}, files).extractor.analyze(base, future);
  // The empty baseline has no language scope; use an actual baseline project.
  assert.equal(result.status, 'PARTIAL');
  const complete = await fixture({ 'old.ts': 'export const old = 1;' }, files).extractor.analyze(
    base,
    future,
  );
  assert.equal(complete.status, 'COMPLETE');
  const model = exported(complete, 'types.ts#export:Model').attributes.after.declared;
  assert.equal(model.members.find((member) => member.name === 'id').readonly_declaration, true);
  assert.equal(model.members.find((member) => member.name === 'optional').optional, true);
  const box = exported(complete, 'types.ts#export:Box').attributes.after;
  assert.ok(box.value.constructs.some((signature) => signature.includes('Box<T>')));
  assert.ok(
    box.declared.members.some((member) => member.name === 'get' && member.type.includes('T')),
  );
  assert.ok(exported(complete, 'old.ts#export:old').operation === 'removed');
  assert.deepEqual(scope(complete).after.source_files, [
    'common.cts',
    'esm.mts',
    'types.ts',
    'view.tsx',
  ]);
});

test('JavaScript JSDoc and optional-chain inference use the same semantic compiler tier', async () => {
  const before = {
    'value.js':
      '/** @param {{id:number}|null} value */ export function read(value){return value?.id ?? 0;} export const output=read({id:1});',
  };
  const after = {
    'value.js':
      '/** @param {{id:string}|null} value */ export function read(value){return value?.id ?? "";} export const output=read({id:"a"});',
  };
  const result = await fixture(before, after, { language: 'javascript' }).extractor.analyze(
    base,
    future,
  );
  assert.equal(result.capability, 'SEMANTIC');
  assert.equal(result.status, 'COMPLETE');
  const output = exported(result, 'value.js#export:output');
  assert.equal(output.attributes.before.value.type, 'number');
  assert.equal(output.attributes.after.value.type, 'string');
});

test('re-export aliases retain resolved declarations and added/removed export identities', async () => {
  const before = {
    'implementation.ts': 'export function source(){return 1;}',
    'api.ts': 'export {source as load} from "./implementation.js";',
  };
  const after = { ...before, 'api.ts': 'export {source as fetch} from "./implementation.js";' };
  const result = await fixture(before, after).extractor.analyze(base, future);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(exported(result, 'api.ts#export:load').operation, 'removed');
  const added = exported(result, 'api.ts#export:fetch');
  assert.equal(added.operation, 'added');
  assert.ok(
    added.references.some((reference) => reference.startsWith('implementation.ts#source:')),
  );
});

test('comments, whitespace, file ordering and repeated compiler runs yield deterministic normalized effects', async () => {
  const before = { 'b.ts': 'export const text="hello";', 'a.ts': 'export const count=1;' };
  const after = {
    'a.ts': ' // comment\nexport const count = 1;\n',
    'b.ts': 'export const text = "hello"; // comment\n',
  };
  const f = fixture(before, after);
  const first = await f.extractor.analyze(base, future);
  const second = await f.extractor.analyze(base, future);
  assert.equal(first.status, 'COMPLETE');
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.effects.map((effect) => effect.kind),
    ['semantic-scope'],
  );
  const reversed = new TypeScriptSemanticPlugin({
    loadProject: (subject) => ({
      ...f.loadProject(subject),
      files: [...f.loadProject(subject).files].reverse(),
    }),
  });
  const extractor = new Extractor({
    plugin: reversed,
    language: 'typescript',
    toolchain_version: ts.version,
  });
  assert.deepEqual(await extractor.analyze(base, future), first);
});

test('compiler-normalized source fingerprints retain implementation changes with unchanged exported types', async () => {
  const result = await fixture(
    { 'logic.ts': 'export function value():number{return 1;}' },
    { 'logic.ts': 'export function value():number{return 2;}' },
  ).extractor.analyze(base, future);
  assert.equal(result.status, 'COMPLETE');
  assert.ok(
    result.effects.some(
      (effect) => effect.kind === 'semantic-source' && effect.target === 'logic.ts',
    ),
  );
  assert.equal(exported(result, 'logic.ts#export:value'), undefined);
  assert.equal(scope(result).after.compiler_version, ts.version);
  assert.equal(scope(result).scope, 'provided-project-files-and-trusted-compiler-libraries');
  assert.deepEqual(result.security_effects, []);
});

test('root compiler configuration and in-memory extends/includes constrain compiler scope', async () => {
  const files = {
    'tsconfig.json': JSON.stringify({ extends: './config/base.json', include: ['source/**/*.ts'] }),
    'config/base.json': JSON.stringify({
      compilerOptions: { ...config.compilerOptions, strict: false, checkJs: false },
    }),
    'source/entry.ts': 'export function permitted(value){return value;}',
    'ignored/broken.ts': 'export const invalid:number="wrong";',
  };
  const result = await fixture(files).extractor.analyze(base, future);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(scope(result).after.source_files, ['source/entry.ts']);
  assert.deepEqual(scope(result).after.diagnostics, []);
  const compilerDefaults = await fixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { lib: ['ES2022'], module: 'ESNext', moduleResolution: 'Bundler' },
    }),
    'entry.ts': 'export function nativeDefault(value:number){return value;}',
  }).extractor.analyze(base, future);
  assert.equal(compilerDefaults.status, 'COMPLETE');
  assert.equal(scope(compilerDefaults).after.compiler_options.strict, null);
  const implicitParameter = await fixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { lib: ['ES2022'], module: 'ESNext', moduleResolution: 'Bundler' },
    }),
    'entry.ts': 'export function nativeDefault(value){return value;}',
  }).extractor.analyze(base, future);
  assert.equal(implicitParameter.status, 'PARTIAL');
  assert.ok(scope(implicitParameter).after.diagnostics.some(({ code }) => code === 7006));
});

test('hydrated declaration dependencies resolve without importing or executing project modules', async () => {
  const files = {
    'entry.ts': 'import {typed} from "dep"; export const value=typed("x");',
    'node_modules/dep/package.json': '{"name":"dep","types":"index.d.ts"}',
    'node_modules/dep/index.d.ts': 'export declare function typed(value:string):number;',
    'node_modules/dep/index.js': 'throw new Error("untrusted module must never run");',
  };
  const result = await fixture({ 'baseline.ts': 'export const old=1;' }, files).extractor.analyze(
    base,
    future,
  );
  assert.equal(result.status, 'COMPLETE');
  assert.equal(exported(result, 'entry.ts#export:value').attributes.after.value.type, 'number');
});

test('partial hydration and missing static/dynamic dependencies remain PARTIAL', async () => {
  for (const [files, options, limitation] of [
    [{ 'entry.ts': 'export const value=1;' }, { complete: false }, 'partial-hydration'],
    [
      { 'entry.ts': 'import {value} from "missing-dependency"; export {value};' },
      {},
      'unresolved-module-dependency',
    ],
    [
      { 'entry.ts': 'export async function load(name:string){return import(name);}' },
      {},
      'dynamic-module-dependency',
    ],
    [
      { 'entry.ts': 'export async function load(){return import("missing-dependency");}' },
      {},
      'unresolved-module-dependency',
    ],
    [
      {
        'entry.js': 'export {value} from "missing-dependency";',
        'tsconfig.json': JSON.stringify({
          compilerOptions: { ...config.compilerOptions, checkJs: false },
        }),
      },
      { language: 'javascript' },
      'unresolved-module-dependency',
    ],
    [
      {
        'entry.js':
          'const dependency=require("missing-dependency"); export const value=dependency.value;',
        'tsconfig.json': JSON.stringify({
          compilerOptions: { ...config.compilerOptions, checkJs: false },
        }),
      },
      { language: 'javascript' },
      'unresolved-module-dependency',
    ],
    [
      {
        'entry.js': 'export function load(name){return require(name);}',
        'tsconfig.json': JSON.stringify({
          compilerOptions: { ...config.compilerOptions, checkJs: false },
        }),
      },
      { language: 'javascript' },
      'dynamic-module-dependency',
    ],
  ]) {
    const result = await fixture(files, files, options).extractor.analyze(base, future);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.capability, 'SEMANTIC');
    assert.ok(scope(result).after.limitations.includes(limitation));
  }
});

test('syntax, type, configuration, and project-reference failures report incomplete compiler scope', async () => {
  for (const files of [
    { 'entry.ts': 'export const broken = ;' },
    { 'entry.ts': 'export const incorrect:number="string";' },
    { 'entry.ts': 'export const value=1;', 'tsconfig.json': '{invalid JSON' },
    {
      'entry.ts': 'export const value=1;',
      'tsconfig.json': JSON.stringify({ extends: './missing.json', ...config }),
    },
    {
      'entry.ts': 'export const value=1;',
      'tsconfig.json': JSON.stringify({ ...config, references: [{ path: './missing-project' }] }),
    },
    {},
  ]) {
    const result = await fixture(files).extractor.analyze(base, future);
    assert.equal(result.status, 'PARTIAL');
    assert.ok(scope(result).after.limitations.length > 0);
  }
});

test('unhydrated on-disk modules cannot satisfy dependencies through compiler host fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-typescript-source-'));
  try {
    const filename = join(directory, 'disk-only.ts');
    await writeFile(filename, 'export const value = 7;');
    const files = {
      'entry.ts': `import {value} from ${JSON.stringify(filename)}; export {value};`,
    };
    const result = await fixture(files).extractor.analyze(base, future);
    assert.equal(result.status, 'PARTIAL');
    assert.ok(scope(result).after.limitations.includes('unresolved-module-dependency'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('loader, source identity and malformed project failures return FAILED at the declared semantic tier', async () => {
  for (const loadProject of [
    () => {
      throw new Error('private source failure');
    },
    (subject) => ({
      ...project(subject, { 'entry.ts': 'export const value=1;' }),
      tree_oid: 'c'.repeat(40),
    }),
    (subject) => ({
      ...project(subject, { 'entry.ts': 'export const value=1;' }),
      files: [{ path: '../escape.ts', contents: '' }],
    }),
    () => null,
  ]) {
    const plugin = new TypeScriptSemanticPlugin({ loadProject });
    const result = await plugin.analyze(base, future);
    assert.deepEqual(result, {
      capability: 'SEMANTIC',
      status: 'FAILED',
      effects: [],
      security_effects: [],
    });
    assert.ok(!JSON.stringify(result).includes('private source failure'));
  }
  assert.throws(() => new TypeScriptSemanticPlugin(), { code: 'INVALID_ARGUMENT' });
});
