import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../server/git.mjs';
import { RemoteGit } from '../server/remote-git.mjs';

// Exercise real Git while replacing only the authenticated Artifacts transport.
class LocalTransport extends RemoteGit {
  constructor(root, manifest) {
    super(root, manifest);
    this.calls = [];
  }

  entry(id) {
    return this.manifest.repositories[id];
  }

  async remote(id, args) {
    this.calls.push([...args]);
    if (args[0] === 'fetch') {
      assert.equal(
        /^[a-f0-9]{40}$/.test(args.at(-1)),
        false,
        'Retained candidates must recover from their advertised refs without raw-SHA fetching',
      );
    }
    return git(this.dir({ id }), args);
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');
  await mkdir(work);
  await git(work, ['init', '--quiet', '-b', 'main']);
  await writeFile(path.join(work, 'app.txt'), 'baseline\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Baseline']);
  const base = await git(work, ['rev-parse', 'HEAD']);
  const baseTree = await git(work, ['rev-parse', `${base}^{tree}`]);
  await git(root, ['clone', '--quiet', '--bare', work, origin]);

  // Seed a retained candidate whose only advertised ref is outside branch heads.
  const retainedBody = [
    `tree ${baseTree}`,
    `parent ${base}`,
    'author klocgit <klocgit@localhost> 1700000000 +0000',
    'committer klocgit <klocgit@localhost> 1700000000 +0000',
    '',
    'klocgit: immutable reviewed candidate',
    '',
    'Proposal-Revision: retained-revision',
    'Decision-Context: retained-context',
    '',
  ].join('\n');
  const retainedCommit = await git(
    origin,
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    retainedBody,
  );
  const retainedRef = `refs/klocgit/candidates/${retainedCommit}`;
  await git(origin, ['update-ref', retainedRef, retainedCommit]);

  await git(work, ['checkout', '--quiet', '-b', 'producer']);
  await writeFile(path.join(work, 'app.txt'), 'producer change\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Producer implementation']);
  const sourceHead = await git(work, ['rev-parse', 'HEAD']);
  const sourceTree = await git(work, ['rev-parse', `${sourceHead}^{tree}`]);
  await git(work, ['push', '--quiet', origin, 'HEAD:refs/heads/producer']);
  const repo = { id: 'app', canonical_ref: 'refs/heads/main' };
  const manifest = { repositories: { app: { remote: origin } } };
  const revision = {
    id: 'new-revision',
    repo: repo.id,
    head_commit: sourceHead,
    base_commit: base,
    tree_hash: sourceTree,
    context_task_id: 'new-task',
    context_version: 'new-context',
    context_answer_ref: 'new-answer',
  };
  return {
    root,
    origin,
    base,
    repo,
    manifest,
    revision,
    retainedCommit,
    retainedRef,
    retainedBody,
  };
}

test('klocgit retains candidates outside branch heads and cold-cache recovery preserves their exact Git objects', async (t) => {
  const f = await fixture(t);
  const firstCache = path.join(f.root, 'executor-one');
  const first = new LocalTransport(firstCache, f.manifest);
  const candidate = await first.compose(f.repo, f.base, [f.revision]);
  assert.equal(candidate.retention_ref, `refs/klocgit/candidates/${candidate.commit}`);
  assert.equal(await git(f.origin, ['rev-parse', candidate.retention_ref]), candidate.commit);
  assert.equal(await git(f.origin, ['rev-parse', f.retainedRef]), f.retainedCommit);
  assert.deepEqual(
    (
      await git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/klocgit/candidates/'])
    ).split('\n'),
    [f.retainedRef, candidate.retention_ref].sort(),
  );
  assert.equal(
    await git(f.origin, ['show', '-s', '--format=%an|%ae|%cn|%ce', candidate.commit]),
    'klocgit|klocgit@localhost|klocgit|klocgit@localhost',
  );
  const message = await first.message(f.repo, candidate.commit);
  assert.match(message, /^klocgit: immutable reviewed candidate/);
  assert.match(message, /Proposal-Revision: new-revision/);
  assert.match(message, /Decision-Task: new-task/);
  assert.match(message, /Decision-Context: new-context/);
  assert.match(message, /Decision-Answer: new-answer/);
  const retentionPushes = first.calls.filter((args) => args[0] === 'push');
  assert.equal(retentionPushes.length, 1);
  assert.equal(retentionPushes[0].at(-1), `${candidate.commit}:${candidate.retention_ref}`);

  await rm(firstCache, { recursive: true, force: true });
  const recovered = new LocalTransport(path.join(f.root, 'executor-two'), f.manifest);
  await recovered.ensureCommit(f.repo.id, f.retainedCommit);
  await recovered.ensureCommit(f.repo.id, candidate.commit);
  const fetches = recovered.calls.filter((args) => args[0] === 'fetch');
  assert.ok(fetches.length > 0);
  for (const args of fetches) {
    assert.ok(
      args.includes('+refs/klocgit/candidates/*:refs/klocgit/candidates/*'),
      'Cold-cache fetches must include retained candidate objects',
    );
  }
  assert.equal(await git(recovered.dir(f.repo), ['rev-parse', f.retainedRef]), f.retainedCommit);
  assert.equal(
    await git(recovered.dir(f.repo), ['rev-parse', candidate.retention_ref]),
    candidate.commit,
  );
  assert.equal(
    await git(recovered.dir(f.repo), ['cat-file', '-p', f.retainedCommit], undefined, {
      raw: true,
    }),
    f.retainedBody,
    'Retained author, message, trailers and commit bytes remain unchanged',
  );
  assert.equal(
    await git(recovered.dir(f.repo), ['rev-parse', `${candidate.commit}^{tree}`]),
    candidate.tree,
  );
  assert.equal(await git(f.origin, ['rev-parse', 'refs/heads/main']), f.base);
  await git(recovered.dir(f.repo), ['fsck', '--full']);
});
