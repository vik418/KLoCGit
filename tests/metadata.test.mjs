import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProducerMetadata } from '../core/metadata.mjs';
import { LocalGit, git } from '../server/git.mjs';

test('legacy metadata is read only when the current file is absent at the exact commit', async () => {
  const repo = { id: 'application' };
  for (const missing of [null, undefined]) {
    const reads = [];
    const git = {
      async file(observedRepo, commit, filename) {
        reads.push({ repo: observedRepo, commit, filename });
        return filename.startsWith('.klocgit/') ? missing : '{"title":"Existing work"}';
      },
    };
    assert.equal(
      await readProducerMetadata(git, repo, 'immutable-commit', 'proposal.json'),
      '{"title":"Existing work"}',
    );
    assert.deepEqual(reads, [
      { repo, commit: 'immutable-commit', filename: '.klocgit/proposal.json' },
      { repo, commit: 'immutable-commit', filename: '.converge/proposal.json' },
    ]);
  }
});

test('empty, malformed and oversized current metadata cannot be masked by legacy files', async () => {
  for (const filename of ['proposal.json', 'context.json']) {
    for (const current of ['', '{', 'x'.repeat(32769)]) {
      const reads = [];
      const git = {
        async file(_repo, _commit, path) {
          reads.push(path);
          return path.startsWith('.klocgit/') ? current : '{"legacy":"valid"}';
        },
      };
      assert.equal(await readProducerMetadata(git, {}, 'immutable-commit', filename), current);
      assert.deepEqual(reads, [`.klocgit/${filename}`]);
    }
  }
});

test('a current-file read failure propagates without trying the legacy file', async () => {
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
  await mkdir(path.join(work, '.converge'));
  const legacyProposal = JSON.stringify({ title: 'Historical proposal' });
  await writeFile(path.join(work, '.converge/proposal.json'), legacyProposal);
  await writeFile(path.join(work, '.converge/context.json'), JSON.stringify({ task_id: 'legacy' }));
  await writeFile(path.join(work, '.klocgit/context.json'), 'x'.repeat(4 * 1024 * 1024 + 1024));
  await git(work, ['init', '--quiet', '-b', 'main']);
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Metadata read fixture']);
  const commit = await git(work, ['rev-parse', 'HEAD']);
  const adapter = new LocalGit(root);
  const repo = { id: 'metadata' };
  await mkdir(path.join(root, 'repositories'));
  await git(root, ['clone', '--quiet', '--bare', work, adapter.dir(repo)]);

  assert.equal(await readProducerMetadata(adapter, repo, commit, 'proposal.json'), legacyProposal);
  assert.equal(await adapter.file(repo, commit, 'missing.json'), null);
  await assert.rejects(
    () => readProducerMetadata(adapter, repo, commit, 'context.json'),
    (error) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  );
  await assert.rejects(() => adapter.file(repo, '0'.repeat(40), '.klocgit/context.json'));
});
