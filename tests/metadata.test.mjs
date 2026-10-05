import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProducerMetadata } from '../core/metadata.mjs';
import { Engine, emptyState } from '../core/engine.mjs';
import { LocalGit, git } from '../server/git.mjs';

test('the initial v0 state schema rejects unversioned or nonzero metadata before mutation or Git access', () => {
  const adapterReads = [];
  let saves = 0;
  const adapter = new Proxy(
    {},
    {
      get(_target, property) {
        adapterReads.push(property);
        throw new Error('Invalid metadata must not reach the Git adapter');
      },
    },
  );
  assert.equal(emptyState().version, 0);
  for (const version of [undefined, 1, -1, '0', null]) {
    const state = emptyState();
    if (version === undefined) delete state.version;
    else state.version = version;
    const before = structuredClone(state);
    assert.throws(
      () =>
        new Engine(state, adapter, async () => {
          saves++;
        }),
      (error) => error.code === 'UNSUPPORTED_STATE_VERSION' && error.status === 503,
    );
    assert.deepEqual(state, before);
  }
  assert.deepEqual(adapterReads, []);
  assert.equal(saves, 0);
});

test('absent producer metadata preserves the adapter result with one exact immutable read', async () => {
  const repo = { id: 'application' };
  for (const missing of [null, undefined]) {
    const reads = [];
    const git = {
      async file(observedRepo, commit, filename) {
        reads.push({ repo: observedRepo, commit, filename });
        return missing;
      },
    };
    assert.equal(
      await readProducerMetadata(git, repo, 'immutable-commit', 'proposal.json'),
      missing,
    );
    assert.deepEqual(reads, [
      { repo, commit: 'immutable-commit', filename: '.klocgit/proposal.json' },
    ]);
  }
});

test('raw producer metadata remains unchanged for the caller to validate', async () => {
  for (const filename of ['proposal.json', 'context.json']) {
    for (const current of ['', '{', 'x'.repeat(32769)]) {
      const reads = [];
      const git = {
        async file(_repo, _commit, path) {
          reads.push(path);
          return current;
        },
      };
      assert.equal(await readProducerMetadata(git, {}, 'immutable-commit', filename), current);
      assert.deepEqual(reads, [`.klocgit/${filename}`]);
    }
  }
});

test('an immutable producer metadata read failure propagates without another read', async () => {
  const unavailable = new Error('Immutable Git read unavailable');
  const reads = [];
  const git = {
    async file(_repo, _commit, path) {
      reads.push(path);
      throw unavailable;
    },
  };
  await assert.rejects(
    () => readProducerMetadata(git, {}, 'immutable-commit', 'context.json'),
    (error) => error === unavailable,
  );
  assert.deepEqual(reads, ['.klocgit/context.json']);
});

test('real Git distinguishes absent metadata from oversized reads and unavailable commits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  await mkdir(path.join(work, '.klocgit'), { recursive: true });
  const originalProposal = JSON.stringify({ title: 'Original proposal' });
  await writeFile(path.join(work, '.klocgit/proposal.json'), originalProposal);
  await writeFile(path.join(work, '.klocgit/context.json'), 'x'.repeat(4 * 1024 * 1024 + 1024));
  await git(work, ['init', '--quiet', '-b', 'main']);
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Metadata read fixture']);
  const commit = await git(work, ['rev-parse', 'HEAD']);
  const updatedProposal = JSON.stringify({ title: 'Updated proposal' });
  await writeFile(path.join(work, '.klocgit/proposal.json'), updatedProposal);
  await writeFile(path.join(work, '.klocgit/context.json'), '{}');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Update producer metadata']);
  const updatedCommit = await git(work, ['rev-parse', 'HEAD']);
  const adapter = new LocalGit(root);
  const repo = { id: 'metadata' };
  await mkdir(path.join(root, 'repositories'));
  await git(root, ['clone', '--quiet', '--bare', work, adapter.dir(repo)]);

  assert.equal(
    await readProducerMetadata(adapter, repo, commit, 'proposal.json'),
    originalProposal,
  );
  assert.equal(
    await readProducerMetadata(adapter, repo, updatedCommit, 'proposal.json'),
    updatedProposal,
  );
  assert.equal(await readProducerMetadata(adapter, repo, updatedCommit, 'context.json'), '{}');
  assert.equal(await readProducerMetadata(adapter, repo, commit, 'missing.json'), null);
  assert.equal(await adapter.file(repo, commit, 'missing.json'), null);
  await assert.rejects(
    () => readProducerMetadata(adapter, repo, commit, 'context.json'),
    (error) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  );
  await assert.rejects(() => readProducerMetadata(adapter, repo, '0'.repeat(40), 'context.json'));
});
