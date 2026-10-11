import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { Engine, emptyState } from '../../core/engine.mjs';
import { SourceBrowser, sourceCommitFromBytes } from '../../core/v1/source-browser.mjs';
import { localSourceBrowser } from '../../adapters/local/source-browser.mjs';
import { artifactsSourceBrowser } from '../../adapters/cloudflare/source-browser.mjs';
import { handleSourceRequest } from '../../api/source.mjs';
import { handleLocalRequest } from '../../server/local-api.mjs';
import { handleCoordinatorRequest } from '../../worker/routes.mjs';

async function fixture(t, format = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const repository = { id: 'example-source', canonical_ref: 'refs/heads/trunk', status: 'ready' };
  const directory = adapter.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet', '--object-format=' + format]);
  const text = '<script>alert("untrusted")</script>\n  source text\n\n';
  const blob = await git(directory, ['hash-object', '-w', '--stdin'], text);
  const binary = await git(directory, ['hash-object', '-w', '--stdin'], 'before\0after');
  const symlink = await git(directory, ['hash-object', '-w', '--stdin'], '/etc/passwd');
  const nested = await git(directory, ['mktree'], '100644 blob ' + blob + '\tread me.txt\n');
  const empty = await git(directory, ['mktree'], '');
  const baseline = await git(directory, ['commit-tree', empty, '-m', 'baseline']);
  const tree = await git(
    directory,
    ['mktree'],
    [
      '100644 blob ' + binary + '\tdata.bin',
      '120000 blob ' + symlink + '\tlink',
      '040000 tree ' + nested + '\tsrc',
      '160000 commit ' + baseline + '\tvendor',
    ].join('\n') + '\n',
  );
  const head = await git(directory, [
    'commit-tree',
    tree,
    '-p',
    baseline,
    '-m',
    'Add sources\n\nKeep the rationale.',
  ]);
  await git(directory, ['update-ref', repository.canonical_ref, head]);
  await git(directory, ['update-ref', 'refs/tags/first', baseline]);
  const browser = localSourceBrowser(adapter, repository);
  return {
    root,
    adapter,
    repository,
    directory,
    browser,
    head,
    tree,
    nested,
    blob,
    baseline,
    text,
  };
}

test('source navigation verifies exact trees, counts entries and preserves file bytes', async (t) => {
  const f = await fixture(t);
  const beforeRefs = await git(f.directory, ['show-ref']);
  const beforeObjects = await git(f.directory, ['count-objects', '-v']);
  const snapshot = await f.browser.snapshot({ ref: f.repository.canonical_ref });
  assert.equal(snapshot.commit_oid, f.head);
  assert.equal(snapshot.tree_oid, f.tree);
  const first = await f.browser.directory({ commit_oid: f.head, limit: 2 });
  assert.equal(first.entry_count, 4);
  assert.equal(first.entries[0].name, 'src');
  const second = await f.browser.directory({
    commit_oid: f.head,
    limit: 2,
    offset: first.next_offset,
  });
  assert.equal(second.next_offset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.oid)).size, 4);
  const folder = await f.browser.directory({ commit_oid: f.head, path: 'src' });
  assert.equal(folder.tree_oid, f.nested);
  assert.equal(folder.entries[0].path, 'src/read me.txt');
  const file = await f.browser.file({ commit_oid: f.head, path: folder.entries[0].path });
  assert.equal(file.blob_oid, f.blob);
  assert.equal(file.text, f.text);
  assert.equal(file.size_bytes, Buffer.byteLength(f.text));
  const summary = await f.browser.summary({ commit_oid: f.head });
  assert.deepEqual(
    {
      files: summary.files,
      directories: summary.directories,
      submodules: summary.submodules,
      complete: summary.complete,
    },
    { files: 3, directories: 1, submodules: 1, complete: true },
  );
  assert.equal(await git(f.directory, ['show-ref']), beforeRefs);
  assert.equal(await git(f.directory, ['count-objects', '-v']), beforeObjects);
});

test('binary, symlink and gitlink browsing cannot follow host files or execute repository content', async (t) => {
  const f = await fixture(t);
  const binary = await f.browser.file({ commit_oid: f.head, path: 'data.bin' });
  assert.equal(binary.content_kind, 'BINARY');
  assert.equal(binary.text, null);
  const link = await f.browser.file({ commit_oid: f.head, path: 'link' });
  assert.equal(link.content_kind, 'SYMLINK');
  assert.equal(link.text, '/etc/passwd');
  await assert.rejects(f.browser.file({ commit_oid: f.head, path: 'vendor' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
});

test('pinned navigation survives branch changes and exposes first-parent history with merge parents', async (t) => {
  const f = await fixture(t);
  await git(f.directory, ['update-ref', f.repository.canonical_ref, f.baseline]);
  assert.equal((await f.browser.directory({ commit_oid: f.head })).entry_count, 4);
  assert.equal((await f.browser.directory({ ref: f.repository.canonical_ref })).entry_count, 0);
  const branch = await git(f.directory, [
    'commit-tree',
    f.tree,
    '-p',
    f.baseline,
    '-m',
    'other branch',
  ]);
  const merge = await git(f.directory, [
    'commit-tree',
    f.tree,
    '-p',
    f.head,
    '-p',
    branch,
    '-m',
    'merge',
  ]);
  const history = await f.browser.history({ commit_oid: merge, limit: 1 });
  assert.equal(history.mode, 'FIRST_PARENT');
  assert.deepEqual(history.commits[0].parent_oids, [f.head, branch]);
  assert.equal(history.next_offset, 1);
  const next = await f.browser.history({
    commit_oid: merge,
    offset: history.next_offset,
    limit: 2,
  });
  assert.deepEqual(
    next.commits.map((commit) => commit.commit_oid),
    [f.head, f.baseline],
  );
  assert.equal(next.next_offset, null);
  assert.match(next.commits[0].message, /Keep the rationale\./);
  assert.match(next.commits[0].author, /klocgit/);
  assert.equal(next.commits[0].signature, 'ABSENT');
});

test('ref pages preserve branch and tag identity', async (t) => {
  const f = await fixture(t);
  const first = await f.browser.refs({ limit: 1 });
  const second = await f.browser.refs({ limit: 1, cursor: first.next_cursor });
  assert.equal(first.refs[0].commit, f.head);
  assert.equal(first.has_more, true);
  assert.equal(second.refs[0].kind, 'tag');
  assert.equal(second.refs[0].commit, f.baseline);
  assert.equal(second.has_more, false);
});

test('invalid traversal, symbolic revisions and unbounded pages are rejected', async (t) => {
  const f = await fixture(t);
  for (const path of ['../secret', '/secret', 'src//file', 'src/./file', 'src\\file', 'x\0y'])
    await assert.rejects(f.browser.file({ commit_oid: f.head, path }), {
      code: 'INVALID_ARGUMENT',
    });
  for (const input of [
    {},
    { commit_oid: 'HEAD' },
    { commit_oid: f.head, ref: f.repository.canonical_ref },
  ])
    await assert.rejects(f.browser.directory(input), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.browser.directory({ commit_oid: f.head, limit: 201 }), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(f.browser.refs({ limit: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.browser.file({ commit_oid: f.head, path: 'missing' }), {
    code: 'NOT_FOUND',
  });
});

test('SHA-256 repositories use their exact Git object algorithm', async (t) => {
  const f = await fixture(t, 'sha256');
  assert.equal(f.head.length, 64);
  assert.equal(
    (await f.browser.file({ commit_oid: f.head, path: 'src/read me.txt' })).text,
    f.text,
  );
});

test('bounded summaries and history report incompleteness instead of claiming complete coverage', async (t) => {
  const f = await fixture(t);
  const browser = localSourceBrowser(f.adapter, f.repository, {
    summary_trees: 1,
    history_commits: 1,
    file_bytes: 3,
  });
  assert.equal((await browser.summary({ commit_oid: f.head })).complete, false);
  assert.equal((await browser.history({ commit_oid: f.head })).truncated, true);
  await assert.rejects(browser.file({ commit_oid: f.head, path: 'src/read me.txt' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
});

test('provider substitution is rejected before source text is exposed', async (t) => {
  const f = await fixture(t);
  const provider = f.browser.provider;
  const wrongTree = new SourceBrowser({
    repo_id: f.repository.id,
    provider: {
      ...provider,
      readTree: async (oid) =>
        (await provider.readTree(oid)).map((entry) => ({
          ...entry,
          name: entry.name + '-substituted',
        })),
    },
  });
  await assert.rejects(wrongTree.directory({ commit_oid: f.head }), { code: 'INTEGRITY_MISMATCH' });
  const wrongBlob = new SourceBrowser({
    repo_id: f.repository.id,
    provider: { ...provider, readBlob: async () => new TextEncoder().encode('substituted') },
  });
  await assert.rejects(wrongBlob.file({ commit_oid: f.head, path: 'src/read me.txt' }), {
    code: 'INTEGRITY_MISMATCH',
  });
  const wrongCommit = new SourceBrowser({
    repo_id: f.repository.id,
    provider: {
      ...provider,
      readCommit: async (oid) => ({ ...(await provider.readCommit(oid)), repo_id: 'other' }),
    },
  });
  await assert.rejects(wrongCommit.snapshot({ commit_oid: f.head }), {
    code: 'INTEGRITY_MISMATCH',
  });
  await assert.rejects(sourceCommitFromBytes(f.repository.id, f.head, new Uint8Array()), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('Artifacts binding contract reads exact files and disposes every capability', async (t) => {
  const f = await fixture(t);
  let opens = 0;
  let closes = 0;
  const adapter = {
    withRepo: async (_, operation) => {
      opens += 1;
      try {
        return await operation({
          readCommit: async (oid) => {
            const commit = await f.browser.commit(oid);
            return {
              hash: commit.commit_oid,
              treeHash: commit.tree_oid,
              parents: commit.parent_oids,
              message: commit.message,
            };
          },
          readTree: async (oid) =>
            (await f.browser.provider.readTree(oid)).map((entry) => ({
              name: entry.name,
              mode: entry.mode,
              hash: entry.oid,
              type: { '040000': 'tree', 100644: 'blob', 120000: 'symlink', 160000: 'gitlink' }[
                entry.mode
              ],
            })),
          readFile: async ({ ref, path }) => {
            const snapshot = await f.browser.snapshot({ commit_oid: ref });
            const entry = await f.browser.locate(snapshot, path);
            return new Blob([
              await f.browser.provider.readBlob({ snapshot, path, oid: entry.oid, limit: 1048576 }),
            ]);
          },
        });
      } finally {
        closes += 1;
      }
    },
    ref: (_, ref) => f.adapter.ref(f.repository, ref),
    listRefs: (_, input) => f.adapter.listRefs(f.repository, input),
  };
  const browser = artifactsSourceBrowser(adapter, f.repository);
  const file = await browser.file({ ref: f.repository.canonical_ref, path: 'src/read me.txt' });
  assert.equal(file.text, f.text);
  assert.equal(file.snapshot.author, null, 'Unsupported binding metadata must remain unknown');
  assert.ok(opens > 0);
  assert.equal(opens, closes);
});

test('source HTTP routes authorize before provider reads and preserve errors on both transports', async (t) => {
  const f = await fixture(t);
  const state = emptyState();
  state.workspace.owner_id = 'owner';
  const engine = new Engine(state, f.adapter, async () => {});
  engine.state.nativeRepositories.push(f.repository);
  const owner = { actor_id: 'owner', kind: 'human', auth_method: 'owner-token' };
  const stranger = { actor_id: 'stranger', kind: 'human', auth_method: 'oidc' };
  const url = new URL('https://example.test/api/source/repositories/' + f.repository.id + '/tree');
  const original = f.adapter.sourceBrowser;
  let calls = 0;
  f.adapter.sourceBrowser = function (...args) {
    calls += 1;
    return original.apply(this, args);
  };
  for (const dispatch of [
    (input) => handleSourceRequest(engine, input),
    (input) => handleLocalRequest(engine, input, {}),
    (input) => handleCoordinatorRequest(engine, { ACTOR_ID: 'owner' }, input),
  ]) {
    const denied = await dispatch({ method: 'GET', url, principal: stranger });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'FORBIDDEN');
    assert.equal(calls, 0);
  }
  for (const dispatch of [
    (input) => handleLocalRequest(engine, input, {}),
    (input) => handleCoordinatorRequest(engine, { ACTOR_ID: 'owner' }, input),
  ]) {
    const allowed = await dispatch({ method: 'GET', url, principal: owner });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.equal((await allowed.json()).snapshot.commit_oid, f.head);
    const bad = new URL(url);
    bad.searchParams.append('path', '../secret');
    assert.equal((await dispatch({ method: 'GET', url: bad, principal: owner })).status, 400);
    const write = await dispatch({ method: 'POST', url, principal: owner });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get('allow'), 'GET');
  }
});
