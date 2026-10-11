import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { ArtifactFSWorkspaceSource } from '../../adapters/cloudflare/artifact-fs-workspace.mjs';
import { MemoryWorkspaceCache } from '../../core/v1/workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-artifact-fs-'));
  const adapter = new LocalGit(root),
    repository = { id: 'repository', canonical_ref: 'refs/heads/main' };
  const directory = adapter.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet', '--initial-branch=main']);
  await git(directory, ['config', 'uploadpack.allowFilter', 'true']);
  const text = '\ufeffexport const value = 1;\n';
  const contents = await git(directory, ['hash-object', '-w', '--stdin'], text);
  const large = await git(
    directory,
    ['hash-object', '-w', '--stdin'],
    Buffer.alloc(2 * 1024 * 1024, 1),
  );
  const link = await git(directory, ['hash-object', '-w', '--stdin'], 'main.js');
  const tree = await git(
    directory,
    ['mktree', '-z'],
    `100644 blob ${contents}\tmain.js\0` +
      `100644 blob ${large}\tunrelated.bin\0` +
      `120000 blob ${link}\tlink\0`,
  );
  const commit = await git(directory, ['commit-tree', tree, '-m', 'Exact source']);
  await git(directory, ['update-ref', repository.canonical_ref, commit]);
  const revision = {
    schema_version: 1,
    repo_id: repository.id,
    commit_oid: commit,
    tree_oid: tree,
    parent_oids: [],
  };
  const cache = new MemoryWorkspaceCache();
  const config = {
    binary: process.env.KLOCGIT_ARTIFACT_FS_BINARY || '/tmp/klocgit-artifactfs/bin/artifact-fs',
    root: join(root, 'hydration'),
    repository: { id: repository.id, remote: 'file://' + directory, ref: repository.canonical_ref },
    prepare_timeout_ms: 10000,
    mount_timeout_ms: 5000,
    max_object_bytes: 4 * 1024 * 1024,
    cache,
  };
  const sources = [];
  const createSource = () => {
    const source = new ArtifactFSWorkspaceSource(config);
    sources.push(source);
    return source;
  };
  t.after(async () => {
    for (const source of sources) await source.close();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, repository, directory, revision, cache, createSource, config, text };
}

test('native ArtifactFS hydrates exact selected objects and exposes cold/warm payload counters', async (t) => {
  const f = await fixture(t),
    source = f.createSource();
  const refs = await git(f.directory, ['show-ref']);
  const cold = await source.fetch(f.revision, { blobs: 'none' });
  assert.equal(cold.metrics().blob_bytes_transferred, 0);
  assert.equal(cold.acquisitionMetrics().initial_blob_count, 0);
  assert.equal(cold.acquisitionMetrics().initial_blob_payload_bytes, 0);
  assert.ok(cold.acquisitionMetrics().initial_metadata_payload_bytes > 0);
  assert.equal(cold.listFiles().length, 3);
  assert.equal(cold.status().metadata_complete, true);
  const read = await cold.readFile('main.js');
  assert.equal(read.contents, f.text);
  assert.equal(read.blob_oid, cold.listFiles().find(({ path }) => path === 'main.js').oid);
  assert.equal(cold.metrics().blob_bytes_transferred, Buffer.byteLength(f.text));
  assert.ok(cold.metrics().bytes_transferred < 2 * 1024 * 1024);
  assert.equal((await cold.readFile('link')).contents, 'main.js');
  const warm = await source.fetch(f.revision, { blobs: 'selected', paths: ['main.js'] });
  assert.equal((await warm.readFile('main.js')).contents, f.text);
  assert.equal(warm.metrics().bytes_transferred, 0);
  assert.ok(warm.metrics().cache_hits > 0);
  f.cache.clear();
  const withoutCache = await source.fetch(f.revision, { blobs: 'selected', paths: ['main.js'] });
  assert.equal((await withoutCache.readFile('main.js')).contents, f.text);
  assert.ok(withoutCache.metrics().bytes_transferred > 0);
  assert.equal(await git(f.directory, ['show-ref']), refs);
});

test('native verified acquisition rejects a moved source and cannot silently inspect its replacement', async (t) => {
  const f = await fixture(t),
    source = f.createSource();
  const original = await source.fetch(f.revision);
  const next = await git(f.directory, [
    'commit-tree',
    f.revision.tree_oid,
    '-p',
    f.revision.commit_oid,
    '-m',
    'Next source',
  ]);
  await git(f.directory, ['update-ref', f.repository.canonical_ref, next]);
  assert.deepEqual((await source.fetch(f.revision)).identity, original.identity);
  const uncached = f.createSource();
  await assert.rejects(uncached.fetch(f.revision), { code: 'PROVIDER_UNAVAILABLE' });
  const updated = await uncached.fetch({
    ...f.revision,
    commit_oid: next,
    parent_oids: [f.revision.commit_oid],
  });
  assert.equal(updated.identity.commit_oid, next);
  assert.equal((await updated.readFile('main.js')).contents, f.text);
});

test('repository identity, ref and closed-source boundaries reject access before hydration', async (t) => {
  const f = await fixture(t),
    source = f.createSource();
  await assert.rejects(source.fetch({ ...f.revision, repo_id: 'other' }), { code: 'FORBIDDEN' });
  await assert.rejects(source.fetch({ ...f.revision, ref: 'refs/heads/other' }), {
    code: 'FORBIDDEN',
  });
  assert.throws(
    () =>
      new ArtifactFSWorkspaceSource({
        ...f.config,
        repository: { ...f.config.repository, remote: 'https://user:secret@example.test/repo.git' },
      }),
    { code: 'INVALID_ARGUMENT' },
  );
  const bad = { ...f.revision };
  Object.defineProperty(bad, 'commit_oid', {
    enumerable: true,
    get() {
      assert.fail('Getter must not run');
    },
  });
  await assert.rejects(source.fetch(bad), { code: 'INVALID_ARGUMENT' });
  await source.close();
  await assert.rejects(source.fetch(f.revision), { code: 'PROVIDER_UNAVAILABLE' });
});

test('concurrent native acquisitions share an immutable source and retain separate read metrics', async (t) => {
  const f = await fixture(t),
    source = f.createSource();
  const [first, second] = await Promise.all([source.fetch(f.revision), source.fetch(f.revision)]);
  assert.deepEqual(first.identity, second.identity);
  assert.equal((await first.readFile('main.js')).contents, f.text);
  assert.equal(second.metrics().blob_bytes_transferred, 0);
  assert.equal((await second.readFile('main.js')).contents, f.text);
});
