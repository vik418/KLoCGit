import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { analysisProject } from '../../core/v1/extractors.mjs';
import { MemoryWorkspaceCache, WorkspaceSource, gitObjectOid } from '../../core/v1/workspace.mjs';
import {
  LocalGitObjectProvider,
  LocalWorkspaceSource,
} from '../../adapters/local/workspace-source.mjs';
import { LocalGitStore } from '../../adapters/local/git-store.mjs';

async function fixture(t, files, initOptions = []) {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-workspace-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const repository = { id: 'source', canonical_ref: 'refs/heads/main' };
  const directory = adapter.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet', ...initOptions]);
  const entries = [];
  for (const file of files) {
    const oid =
      file.kind === 'commit'
        ? file.oid
        : await git(directory, ['hash-object', '-w', '--stdin'], file.bytes ?? file.contents);
    entries.push({ path: file.path, mode: file.mode ?? '100644', kind: file.kind ?? 'blob', oid });
  }
  async function makeTree(prefix) {
    const direct = entries.filter((entry) => entry.path.startsWith(prefix));
    const names = [
      ...new Set(direct.map((entry) => entry.path.slice(prefix.length).split('/')[0])),
    ];
    const lines = [];
    for (const name of names) {
      const entry = direct.find((item) => item.path === prefix + name);
      if (entry) lines.push(`${entry.mode} ${entry.kind} ${entry.oid}\t${name}`);
      else lines.push(`040000 tree ${await makeTree(prefix + name + '/')}\t${name}`);
    }
    return git(directory, ['mktree', '-z'], lines.join('\0') + (lines.length ? '\0' : ''));
  }
  const tree_oid = await makeTree('');
  const commit_oid = await git(directory, ['commit-tree', tree_oid, '-m', 'exact source']);
  await git(directory, ['update-ref', repository.canonical_ref, commit_oid]);
  const revision = FutureRevision({
    schema_version: 1,
    id: 'klocgit:future-revision:v1:sha256:' + 'a'.repeat(64),
    system_id: 'system',
    repo_id: repository.id,
    ref: repository.canonical_ref,
    commit_oid,
    tree_oid,
    parent_oids: [],
    producer: { declared: 'untrusted' },
    observed_at: '2026-10-10T00:00:00Z',
  });
  const cache = new MemoryWorkspaceCache();
  const source = new LocalWorkspaceSource({ adapter, repository, cache });
  return { root, adapter, repository, directory, revision, cache, source, entries };
}

test('real Git targeted hydration transfers exact selected bytes without a clone or source writes', async (t) => {
  const contents = '\nexport const value = 1;\n\n';
  const f = await fixture(t, [
    { path: 'src/main.js', contents, mode: '100755' },
    { path: 'src/[literal].js', contents: 'literal path\n' },
    { path: 'large/unrelated.txt', contents: 'x'.repeat(2 * 1024 * 1024) },
    { path: 'link', contents: 'src/main.js', mode: '120000' },
  ]);
  const before = await Promise.all([
    git(f.directory, ['show-ref']),
    git(f.directory, ['count-objects', '-v']),
  ]);
  const store = new GitStore({
    repo_id: f.repository.id,
    provider: new LocalGitStore({
      adapter: f.adapter,
      repository: f.repository,
      workspaceSource: f.source,
    }),
  });
  const workspace = await store.fetch(f.revision, { blobs: 'none' });
  assert.equal(workspace.metrics().blob_bytes_transferred, 0);
  assert.ok(workspace.metrics().metadata_bytes_transferred > 0);
  assert.deepEqual(
    workspace.listFiles(),
    [...f.entries].sort((a, b) => (a.path < b.path ? -1 : 1)),
  );
  assert.ok(Object.isFrozen(workspace) && Object.isFrozen(workspace.identity));
  assert.throws(() => {
    workspace.identity = { repo_id: 'substituted' };
  }, TypeError);
  const hydrated = await workspace.hydrate(['src/main.js']);
  assert.equal(hydrated.complete, true);
  const file = await workspace.readFile('src/main.js');
  assert.equal(file.contents, contents);
  assert.equal(file.blob_oid, f.entries[0].oid);
  assert.equal(file.mode, '100755');
  assert.equal(file.repo_id, f.revision.repo_id);
  assert.equal(file.commit_oid, f.revision.commit_oid);
  assert.equal(file.tree_oid, f.revision.tree_oid);
  assert.deepEqual(file.bytes, new TextEncoder().encode(contents));
  assert.equal(workspace.metrics().blob_bytes_transferred, Buffer.byteLength(contents));
  assert.ok(workspace.metrics().bytes_transferred < 2 * 1024 * 1024);
  file.bytes[0] = 65;
  assert.equal((await workspace.readFile('src/main.js')).bytes[0], 10);
  assert.equal((await workspace.readFile('src/[literal].js')).contents, 'literal path\n');
  assert.equal((await workspace.readFile('link')).contents, 'src/main.js');
  assert.deepEqual(
    await Promise.all([git(f.directory, ['show-ref']), git(f.directory, ['count-objects', '-v'])]),
    before,
  );
});

test('UTF-8 source preserves its BOM and complete byte-for-byte text', async (t) => {
  const contents = '\ufeffexport const value = 1;\n';
  const f = await fixture(t, [{ path: 'source.js', contents }]);
  const workspace = await f.source.fetch(f.revision);
  const file = await workspace.readFile('source.js');
  assert.equal(file.contents, contents);
  assert.deepEqual(file.bytes, new TextEncoder().encode(file.contents));
  assert.equal((await workspace.loadProject()).files[0].contents, contents);
});

test('warm cache and total cache loss preserve exact snapshots with observable transfer bytes', async (t) => {
  const f = await fixture(t, [
    { path: 'a.txt', contents: 'a\n' },
    { path: 'b.txt', contents: 'b\n' },
  ]);
  const cold = await f.source.fetch(f.revision, { paths: ['a.txt'] });
  const coldBytes = cold.metrics().bytes_transferred;
  assert.equal(cold.metrics().blob_bytes_transferred, 2);
  const hint = cold.cacheHint();
  assert.equal(hint.schema_version, 1);
  const warm = await f.source.fetch(f.revision, { paths: ['a.txt'], cache_hint: hint });
  assert.equal(warm.metrics().bytes_transferred, 0);
  assert.ok(warm.metrics().cache_hits >= 3);
  assert.deepEqual(
    await warm.loadProject(f.revision, ['a.txt']),
    await cold.loadProject(f.revision, ['a.txt']),
  );
  f.cache.clear();
  const restored = await f.source.fetch(f.revision, { paths: ['a.txt'], cache_hint: hint });
  assert.equal(restored.metrics().bytes_transferred, coldBytes);
  assert.deepEqual(await restored.readFile('a.txt'), await cold.readFile('a.txt'));
  // A hint from another revision cannot change the requested source or certify a hit.
  f.cache.clear();
  const hinted = await f.source.fetch(f.revision, {
    paths: ['a.txt'],
    cache_hint: { ...hint, commit_oid: 'b'.repeat(40), object_oids: [] },
  });
  assert.equal(hinted.metrics().bytes_transferred, coldBytes);
  assert.deepEqual(hinted.identity, cold.identity);
});

test('loadProject supplies exact text snapshots and targeted projects remain partial', async (t) => {
  const f = await fixture(t, [
    { path: 'a.js', contents: '\nconst a = 1;\n' },
    { path: 'b.js', contents: 'const b = 2;\n' },
  ]);
  const partial = analysisProject(
    await f.source.loadProject(f.revision, { paths: ['a.js'] }),
    f.revision,
  );
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.files, [{ path: 'a.js', contents: '\nconst a = 1;\n' }]);
  const full = analysisProject(await f.source.loadProject(f.revision), f.revision);
  assert.equal(full.complete, true);
  assert.deepEqual(full.files, [
    { path: 'a.js', contents: '\nconst a = 1;\n' },
    { path: 'b.js', contents: 'const b = 2;\n' },
  ]);
  const workspace = await f.source.fetch(f.revision);
  await assert.rejects(workspace.loadProject({ ...f.revision, tree_oid: 'b'.repeat(40) }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('identity, object kind, and provider blob substitution are rejected', async (t) => {
  const f = await fixture(t, [{ path: 'a.js', contents: 'original\n' }]);
  await assert.rejects(f.source.fetch({ ...f.revision, repo_id: 'other' }), { code: 'FORBIDDEN' });
  await assert.rejects(f.source.fetch({ ...f.revision, tree_oid: 'b'.repeat(40) }), {
    code: 'INTEGRITY_MISMATCH',
  });
  await assert.rejects(f.source.fetch({ ...f.revision, parent_oids: ['b'.repeat(40)] }), {
    code: 'INTEGRITY_MISMATCH',
  });
  const provider = new LocalGitObjectProvider(f);
  await assert.rejects(
    provider.readObject({ repo_id: f.repository.id, oid: f.revision.commit_oid, kind: 'blob' }),
    { code: 'INTEGRITY_MISMATCH' },
  );
  const substituted = new WorkspaceSource({
    repo_id: f.repository.id,
    provider: {
      readObject: async (request) =>
        request.kind === 'blob'
          ? {
              status: 'AVAILABLE',
              bytes: new TextEncoder().encode('substitution\n'),
              bytes_transferred: 13,
            }
          : provider.readObject(request),
    },
  });
  const workspace = await substituted.fetch(f.revision);
  await assert.rejects(workspace.readFile('a.js'), { code: 'INTEGRITY_MISMATCH' });
});

test('corrupt or failing cache cannot supply substituted content or prevent a verified read', async (t) => {
  const f = await fixture(t, [{ path: 'a.txt', contents: 'exact\n' }]);
  for (const cache of [
    { get: async () => new TextEncoder().encode('forged'), put: async () => {} },
    {
      get: async () => {
        throw new Error('cache lost');
      },
      put: async () => {
        throw new Error('cache unavailable');
      },
    },
  ]) {
    const source = new LocalWorkspaceSource({ ...f, cache });
    const workspace = await source.fetch(f.revision, { paths: ['a.txt'] });
    assert.equal((await workspace.readFile('a.txt')).contents, 'exact\n');
    assert.equal(workspace.metrics().cache_hits, 0);
    assert.ok(workspace.metrics().bytes_transferred > 0);
  }
});

test('missing local blobs, failed reads, binary bytes, and submodules are explicit', async (t) => {
  const f = await fixture(t, [
    { path: 'missing.txt', contents: 'missing\n' },
    { path: 'binary.bin', bytes: Buffer.from([0, 255, 10]) },
    { path: 'invalid-utf8.txt', bytes: Buffer.from([255, 10]) },
    { path: 'submodule', kind: 'commit', mode: '160000', oid: 'c'.repeat(40) },
  ]);
  const missingOid = f.entries[0].oid;
  await unlink(join(f.directory, 'objects', missingOid.slice(0, 2), missingOid.slice(2)));
  const workspace = await f.source.fetch(f.revision);
  assert.equal((await workspace.readFile('absent.txt')).status, 'MISSING');
  assert.equal((await workspace.readFile('missing.txt')).status, 'MISSING');
  assert.equal((await workspace.hydrate(['missing.txt'])).complete, false);
  for (const path of ['binary.bin', 'invalid-utf8.txt']) {
    const file = await workspace.readFile(path);
    assert.equal(file.status, 'UNSUPPORTED');
    assert.equal(file.contents, null);
    assert.ok(file.bytes instanceof Uint8Array);
  }
  assert.equal((await workspace.readFile('submodule')).status, 'UNSUPPORTED');
  assert.equal((await workspace.loadProject(f.revision)).complete, false);
  const failed = new WorkspaceSource({
    repo_id: f.repository.id,
    provider: {
      readObject: async (request) =>
        request.kind === 'blob'
          ? Promise.reject(new Error('credential-bearing private diagnostic'))
          : f.source.provider.readObject(request),
    },
  });
  const unavailable = await failed.fetch(f.revision);
  assert.equal((await unavailable.readFile('missing.txt')).status, 'UNAVAILABLE');
  assert.equal((await unavailable.loadProject(f.revision)).complete, false);
  assert.ok(!JSON.stringify(await unavailable.readFile('missing.txt')).includes('credential'));
});

test('missing subtree cannot become a complete or falsely absent snapshot', async (t) => {
  const f = await fixture(t, [{ path: 'nested/a.txt', contents: 'a' }]);
  const subtree = await git(f.directory, ['rev-parse', f.revision.tree_oid + ':nested']);
  await unlink(join(f.directory, 'objects', subtree.slice(0, 2), subtree.slice(2)));
  const workspace = await f.source.fetch(f.revision);
  assert.equal(workspace.status().metadata_complete, false);
  assert.deepEqual(workspace.status().unavailable_trees, [
    { tree_oid: subtree, path: 'nested/', status: 'MISSING' },
  ]);
  assert.equal((await workspace.readFile('nested/a.txt')).status, 'UNAVAILABLE');
  assert.equal((await workspace.loadProject(f.revision)).complete, false);
});

test('replacement refs and a moved source ref do not substitute immutable commit contents', async (t) => {
  const f = await fixture(t, [{ path: 'a.txt', contents: 'original\n' }]);
  const replacementBlob = await git(f.directory, ['hash-object', '-w', '--stdin'], 'replacement\n');
  const replacementTree = await git(
    f.directory,
    ['mktree'],
    `100644 blob ${replacementBlob}\ta.txt\n`,
  );
  const replacementCommit = await git(f.directory, [
    'commit-tree',
    replacementTree,
    '-m',
    'replacement',
  ]);
  await git(f.directory, ['replace', f.revision.commit_oid, replacementCommit]);
  await git(f.directory, ['update-ref', f.repository.canonical_ref, replacementCommit]);
  const workspace = await f.source.fetch(f.revision, { paths: ['a.txt'] });
  assert.equal((await workspace.readFile('a.txt')).contents, 'original\n');
  assert.equal(workspace.identity.tree_oid, f.revision.tree_oid);
});

test('actual blobless Git repositories never lazy-fetch unavailable blobs into the source', async (t) => {
  const f = await fixture(t, [{ path: 'a.txt', contents: 'not fetched\n' }]);
  await git(f.directory, ['config', 'uploadpack.allowFilter', 'true']);
  await git(f.directory, ['symbolic-ref', 'HEAD', f.repository.canonical_ref]);
  const repository = { id: 'partial', canonical_ref: f.repository.canonical_ref };
  const partialDirectory = f.adapter.dir(repository);
  await git(f.root, [
    'clone',
    '--bare',
    '--quiet',
    '--filter=blob:none',
    'file://' + f.directory,
    partialDirectory,
  ]);
  const revision = { ...f.revision, repo_id: repository.id };
  const before = await git(partialDirectory, ['count-objects', '-v']);
  const source = new LocalWorkspaceSource({ adapter: f.adapter, repository });
  const workspace = await source.fetch(revision);
  assert.equal(workspace.metrics().blob_bytes_transferred, 0);
  assert.equal((await workspace.readFile('a.txt')).status, 'MISSING');
  assert.equal((await workspace.loadProject(revision)).complete, false);
  assert.equal(await git(partialDirectory, ['count-objects', '-v']), before);
});

test('SHA-256 Git object identities are supported without weakening exact-state verification', async (t) => {
  const f = await fixture(t, [{ path: 'a.txt', contents: 'sha256\n' }], ['--object-format=sha256']);
  assert.equal(f.revision.commit_oid.length, 64);
  const workspace = await f.source.fetch(f.revision, { paths: ['a.txt'] });
  assert.equal((await workspace.readFile('a.txt')).contents, 'sha256\n');
  assert.equal(
    await gitObjectOid('blob', new TextEncoder().encode('sha256\n'), 64),
    f.entries[0].oid,
  );
});

test('paths and filters reject command-like traversal and unsupported requests', async (t) => {
  const f = await fixture(t, [{ path: 'a.txt', contents: 'a' }]);
  for (const filter of [
    { paths: ['../a.txt'] },
    { paths: ['/a.txt'] },
    { paths: ['a.txt', 'a.txt'] },
    { blobs: 'unexpected' },
    { unknown: true },
  ])
    await assert.rejects(f.source.fetch(f.revision, filter), { code: 'INVALID_ARGUMENT' });
  const workspace = await f.source.fetch(f.revision);
  await assert.rejects(workspace.readFile('a/../b'), { code: 'INVALID_ARGUMENT' });
});
