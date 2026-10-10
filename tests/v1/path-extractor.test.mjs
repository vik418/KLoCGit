import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git } from '../../server/git.mjs';
import { LocalGitStore } from '../../adapters/local/git-store.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { createGitPathExtractor, securityPathRoles } from '../../adapters/analysis/path.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-paths-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ['init', '--quiet']);
  const repository = { id: 'repo', canonical_ref: 'refs/heads/main' };
  const provider = new LocalGitStore({
    adapter: { dir: () => directory, readRef: async () => {}, cas: async () => {} },
    repository,
    workspaceSource: { fetch: async () => {} },
  });
  const store = new GitStore({ repo_id: 'repo', provider });
  const commit = async (files) => {
    for (const [path, contents] of Object.entries(files)) {
      if (contents === null) await rm(join(directory, path), { force: true });
      else {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), contents);
      }
    }
    await git(directory, ['add', '-A']);
    const tree = await git(directory, ['write-tree']);
    const oid = await git(directory, ['commit-tree', tree, '-m', 'change']);
    return FutureRevision({
      ...(await provider.snapshot(oid)),
      id: 'klocgit:future-revision:v1:sha256:' + oid.padEnd(64, '0'),
      system_id: 'group',
      ref: repository.canonical_ref,
      producer: null,
      observed_at: '2026-10-10T00:00:00Z',
    });
  };
  const loads = [];
  const loadProject = async (revision, { paths }) => {
    loads.push(paths);
    return {
      schema_version: 1,
      repo_id: revision.repo_id,
      commit_oid: revision.commit_oid,
      tree_oid: revision.tree_oid,
      complete: false,
      files: await Promise.all(
        paths.map(async (path) => ({
          path,
          contents: await git(directory, ['show', `${revision.commit_oid}:${path}`]),
        })),
      ),
    };
  };
  const options = { gitStore: store, loadProject, max_entries: 1000 };
  return { directory, commit, loads, options, extractor: createGitPathExtractor(options) };
}

test('path analysis observes additions, removals and exact blob changes from Git', async (t) => {
  const f = await fixture(t);
  const base = await f.commit({ 'src/old.js': 'old', 'src/change.js': 'one', 'keep.txt': 'same' });
  const next = await f.commit({ 'src/old.js': null, 'src/change.js': 'two', 'new.txt': 'new' });
  const result = await f.extractor.analyze(base, next);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(
    new Map(result.effects.map((effect) => [effect.target, effect.operation])),
    new Map([
      ['src/old.js', 'removed'],
      ['src/change.js', 'modified'],
      ['new.txt', 'added'],
    ]),
  );
  assert.ok(result.effects.every((effect) => effect.attributes.basis === 'OBSERVED'));
  assert.ok(
    result.effects.find((effect) => effect.target === 'src/change.js').attributes.before.oid,
  );
  assert.equal(f.loads.length, 0, 'ordinary paths do not require blob hydration');
});

test('manifest dependencies stay declared and hydration targets only changed manifests', async (t) => {
  const f = await fixture(t);
  const base = await f.commit({
    'app/package.json': JSON.stringify({ dependencies: { lib: '1' } }),
    'other/large.txt': 'unrelated'.repeat(1000),
  });
  const next = await f.commit({
    'app/package.json': JSON.stringify({ dependencies: { lib: '2', newlib: '1' } }),
  });
  const result = await f.extractor.analyze(base, next);
  assert.equal(result.status, 'COMPLETE');
  const changes = result.effects.filter((effect) => effect.kind === 'manifest-dependency');
  assert.equal(changes.length, 2);
  assert.ok(changes.every((effect) => effect.attributes.basis === 'DECLARED'));
  assert.deepEqual(f.loads, [['app/package.json'], ['app/package.json']]);
  assert.ok(result.security_effects.some((effect) => effect.attributes.role === 'dependency'));
});

test('security path conventions remain inferred and cover protected reduction surfaces', () => {
  const surfaces = {
    dependency: 'package.json',
    build: 'Dockerfile',
    ci: '.github/workflows/test.yml',
    auth: 'src/auth/session.js',
    iam: 'infra/iam/roles.json',
    schema: 'api/schema/data.json',
    migration: 'db/migrations/001.sql',
    secret: 'config/.env.local',
  };
  for (const [role, path] of Object.entries(surfaces))
    assert.ok(securityPathRoles(path).includes(role));
  assert.deepEqual(securityPathRoles('docs/how-to-login.md'), []);
});

test('unavailable or malformed manifest observations remain PARTIAL', async (t) => {
  const f = await fixture(t);
  const base = await f.commit({ 'package.json': '{"dependencies":{}}' });
  const next = await f.commit({ 'package.json': '{broken' });
  assert.equal((await f.extractor.analyze(base, next)).status, 'PARTIAL');
  const unavailable = createGitPathExtractor({
    ...f.options,
    loadProject: async () => {
      throw new Error('private');
    },
  });
  const result = await unavailable.analyze(base, next);
  assert.equal(result.status, 'PARTIAL');
  assert.ok(result.effects.some((effect) => effect.kind === 'git-path'));
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('budget exhaustion never invents missing paths and unchanged trees need no reads', async (t) => {
  const f = await fixture(t);
  const base = await f.commit({ 'src/a': '1', 'src/b': '2' });
  const next = await f.commit({ 'src/a': '2' });
  const bounded = createGitPathExtractor({ ...f.options, max_entries: 1 });
  const result = await bounded.analyze(base, next);
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.effects, []);
  assert.equal((await bounded.analyze(base, base)).status, 'COMPLETE');
});

test('manifest source substitution and Git object failures are explicit', async (t) => {
  const f = await fixture(t);
  const base = await f.commit({ 'package.json': '{}' });
  const next = await f.commit({ 'package.json': '{"name":"changed"}' });
  const substituted = createGitPathExtractor({
    ...f.options,
    loadProject: async (revision) => ({
      schema_version: 1,
      repo_id: 'other',
      commit_oid: revision.commit_oid,
      tree_oid: revision.tree_oid,
      complete: false,
      files: [],
    }),
  });
  assert.equal((await substituted.analyze(base, next)).status, 'PARTIAL');
  const failed = createGitPathExtractor({
    ...f.options,
    gitStore: {
      repo_id: 'repo',
      read_tree: async () => {
        throw new Error('private');
      },
    },
  });
  assert.equal((await failed.analyze(base, next)).status, 'FAILED');
});

test('file and directory replacements retain exact leaf changes', async (t) => {
  const f = await fixture(t);
  const base = await f.commit({ item: 'file' });
  await rm(join(f.directory, 'item'));
  const next = await f.commit({ 'item/child': 'nested' });
  const result = await f.extractor.analyze(base, next);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(
    new Map(result.effects.map((effect) => [effect.target, effect.operation])),
    new Map([
      ['item', 'removed'],
      ['item/child', 'added'],
    ]),
  );
});
