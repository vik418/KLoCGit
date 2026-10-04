import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {git, LocalGit} from '../server/git.mjs';
import {RemoteGit} from '../server/remote-git.mjs';
import {ArtifactsGit} from '../worker/artifacts.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'decision-revert-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const work = path.join(root, 'work'); await mkdir(work);
  await git(work, ['init', '--quiet', '-b', 'main']);
  await writeFile(path.join(work, 'settings.txt'), 'mode=baseline\n');
  await writeFile(path.join(work, 'notes.md'), 'Original notes.\n');
  await git(work, ['add', '.']); await git(work, ['commit', '--quiet', '-m', 'Baseline']);
  const base = await git(work, ['rev-parse', 'HEAD']);
  const adapter = new LocalGit(root), repo = {id: 'application', canonical_ref: 'refs/heads/main'};
  await mkdir(path.dirname(adapter.dir(repo)), {recursive: true});
  await git(root, ['clone', '--quiet', '--bare', work, adapter.dir(repo)]);
  await git(work, ['remote', 'add', 'origin', adapter.dir(repo)]);
  return {root, work, base, adapter, repo};
}
async function commitFile(f, name, value, message, {publish = true} = {}) {
  await writeFile(path.join(f.work, name), value); await git(f.work, ['add', '.']);
  await git(f.work, ['commit', '--quiet', '-m', message]);
  const head = await git(f.work, ['rev-parse', 'HEAD']);
  if (publish) await git(f.work, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  return head;
}

test('inverse candidate reverts selected code on the current head, preserves later unrelated work and never advances canonical', async t => {
  const f = await fixture(t);
  const selected = await commitFile(f, 'settings.txt', 'mode=selected\n', 'Selected implementation');
  const later = await commitFile(f, 'notes.md', 'Original notes.\nLater independent work.\n', 'Later independent edit');
  const result = await f.adapter.revert(f.repo, later, selected);
  assert.equal(await f.adapter.file(f.repo, result.commit, 'settings.txt'), 'mode=baseline');
  assert.match(await f.adapter.file(f.repo, result.commit, 'notes.md'), /Later independent work/);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), later);
  assert.equal(await git(f.adapter.dir(f.repo), ['rev-parse', `${result.commit}^`]), later);
  assert.equal(await git(f.adapter.dir(f.repo), ['rev-parse', result.retention_ref]), result.commit);
  assert.equal(result.baseTree, await git(f.adapter.dir(f.repo), ['rev-parse', `${later}^{tree}`]));
  assert.equal(result.target_commit, selected); assert.equal(result.mainline, null);
  await assert.rejects(() => f.adapter.revert(f.repo, later, selected, 1), error => error.code === 'REVERT_MAINLINE_INVALID');
  await git(f.adapter.dir(f.repo), ['fsck', '--full']);
});

test('inverse overlap conflict escalates without canonical movement or retaining a partial candidate', async t => {
  const f = await fixture(t);
  const selected = await commitFile(f, 'settings.txt', 'mode=selected\n', 'Selected implementation');
  const later = await commitFile(f, 'settings.txt', 'mode=later-overlapping\n', 'Later incompatible edit');
  await assert.rejects(() => f.adapter.revert(f.repo, later, selected), error => error.code === 'COMPOSITION_CONFLICT' && error.status === 422);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), later);
  assert.equal(await git(f.adapter.dir(f.repo), ['for-each-ref', '--format=%(refname)', 'refs/converge/candidates']), '');
  await git(f.adapter.dir(f.repo), ['fsck', '--full']);
});

test('merge revert requires an explicit real parent and mainline one preserves independent canonical work', async t => {
  const f = await fixture(t);
  await git(f.work, ['checkout', '--quiet', '-b', 'feature', f.base]);
  await commitFile(f, 'settings.txt', 'mode=feature\n', 'Feature', {publish: false});
  await git(f.work, ['checkout', '--quiet', 'main']);
  await commitFile(f, 'notes.md', 'Original notes.\nCanonical independent work.\n', 'Canonical edit', {publish: false});
  await git(f.work, ['merge', '--quiet', '--no-ff', 'feature', '-m', 'Reviewed Git merge']);
  const target = await git(f.work, ['rev-parse', 'HEAD']); await git(f.work, ['push', '--quiet', 'origin', 'main']);
  await assert.rejects(() => f.adapter.revert(f.repo, target, target), error => error.code === 'REVERT_MAINLINE_REQUIRED');
  await assert.rejects(() => f.adapter.revert(f.repo, target, target, 3), error => error.code === 'REVERT_MAINLINE_REQUIRED');
  const result = await f.adapter.revert(f.repo, target, target, 1);
  assert.equal(result.mainline, 1);
  assert.equal(await f.adapter.file(f.repo, result.commit, 'settings.txt'), 'mode=baseline');
  assert.match(await f.adapter.file(f.repo, result.commit, 'notes.md'), /Canonical independent work/);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), target);
});

test('inverse construction cannot execute producer repository hooks, external diffs, filters or inherited Git configuration', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.work, '.gitattributes'), 'settings.txt merge=untrusted filter=untrusted diff=untrusted\n');
  const target = await commitFile(f, 'settings.txt', 'mode=selected\n', 'Selected change with untrusted attributes');
  const current = await commitFile(f, 'notes.md', 'Original notes.\nLater safe work.\n', 'Later safe work');
  const marker = path.join(f.root, 'untrusted-git-command-ran');
  const executable = path.join(f.root, 'untrusted-git-command');
  await writeFile(executable, `#!/bin/sh\n/usr/bin/touch '${marker}'\n/bin/cat\n`, {mode: 0o755});
  const config = path.join(f.root, 'untrusted-global-config');
  await writeFile(config, `[core]\n hooksPath = ${path.dirname(executable)}\n[diff]\n external = ${executable}\n[merge "untrusted"]\n driver = ${executable}\n[filter "untrusted"]\n smudge = ${executable}\n clean = ${executable}\n`);
  await mkdir(path.join(f.adapter.dir(f.repo), 'hooks'), {recursive: true});
  await writeFile(path.join(f.adapter.dir(f.repo), 'hooks/reference-transaction'), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, {mode: 0o755});
  const previous = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;});
  const result = await f.adapter.revert(f.repo, current, target);
  assert.equal(await f.adapter.file(f.repo, result.commit, 'settings.txt'), 'mode=baseline');
  assert.match(await f.adapter.diff(f.repo, current, result.commit), /mode=baseline/);
  await assert.rejects(() => readFile(marker), error => error.code === 'ENOENT');
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), current);
});

test('true stacked fork histories compose once, preserve every proposal trailer, and remain Git ancestors', async t => {
  const f = await fixture(t), source = {id: 'producer-fork', canonical_repo: f.repo.id};
  await git(f.root, ['clone', '--quiet', '--bare', f.adapter.dir(f.repo), f.adapter.dir(source)]);
  await git(f.work, ['remote', 'add', 'fork', f.adapter.dir(source)]);
  await git(f.work, ['checkout', '--quiet', '-b', 'stack-a', f.base]);
  const a = await commitFile(f, 'settings.txt', 'mode=stack-a\n', 'Stack A', {publish: false});
  await git(f.work, ['checkout', '--quiet', '-b', 'stack-b']);
  const b = await commitFile(f, 'stack.txt', 'Stack B depends on A.\n', 'Stack B', {publish: false});
  await git(f.work, ['push', '--quiet', 'fork', 'stack-a', 'stack-b']);
  await git(f.work, ['checkout', '--quiet', 'main']);
  const canonical = await commitFile(f, 'notes.md', 'Original notes.\nLater canonical work.\n', 'Independent canonical edit');
  assert.equal(await f.adapter.mergeBase(source, b, canonical), f.base);
  assert.equal(await f.adapter.isAncestor(source, a, b), true);
  assert.equal(await f.adapter.isAncestor(source, b, a), false);
  const revisions = await Promise.all([['revision-a', a], ['revision-b', b]].map(async ([id, head_commit]) => ({
    id, source_repo: source.id, head_commit, base_commit: f.base,
    tree_hash: await git(f.adapter.dir(source), ['rev-parse', `${head_commit}^{tree}`])
  })));
  const result = await f.adapter.compose(f.repo, canonical, revisions);
  assert.deepEqual(result.source_heads, [b]);
  assert.equal(await f.adapter.file(f.repo, result.commit, 'settings.txt'), 'mode=stack-a');
  assert.match(await f.adapter.file(f.repo, result.commit, 'stack.txt'), /depends on A/);
  assert.match(await f.adapter.file(f.repo, result.commit, 'notes.md'), /Later canonical work/);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), canonical);
  assert.equal(await f.adapter.isAncestor(f.repo, a, result.commit), true);
  assert.equal(await f.adapter.isAncestor(f.repo, b, result.commit), true);
  assert.equal(await f.adapter.mergeBase(f.repo, b, result.commit), b);
  const message = await f.adapter.message(f.repo, result.commit);
  assert.match(message, /Proposal-Revision: revision-a/); assert.match(message, /Proposal-Revision: revision-b/);
  assert.equal((await git(f.adapter.dir(f.repo), ['rev-list', '--parents', '-n', '1', result.commit])).split(/\s+/).length, 3);
});

test('remote revert retains an authoritative immutable candidate ref before returning and survives a fresh executor cache', async t => {
  const f = await fixture(t);
  const target = await commitFile(f, 'settings.txt', 'mode=selected\n', 'Selected implementation');
  const current = await commitFile(f, 'notes.md', 'Original notes.\nRemote later work.\n', 'Independent later work');
  // The production adapter's operations are unchanged; only authenticated HTTPS
  // transport is replaced with a local Git remote for this retention experiment.
  class LocalTransport extends RemoteGit {
    entry(id) {return this.manifest.repositories[id];}
    async remote(id, args) {return git(this.dir({id}), args);}
  }
  const manifest = {repositories: {[f.repo.id]: {remote: f.adapter.dir(f.repo)}}};
  const remote = new LocalTransport(path.join(f.root, 'executor-one'), manifest);
  const result = await remote.revert(f.repo, current, target);
  assert.equal(await git(f.adapter.dir(f.repo), ['rev-parse', result.retention_ref]), result.commit);
  assert.equal(await f.adapter.ref(f.repo, f.repo.canonical_ref), current);
  const recovered = new LocalTransport(path.join(f.root, 'executor-two'), manifest);
  await recovered.ensureCommit(f.repo.id, result.commit);
  assert.equal(await recovered.file(f.repo, result.commit, 'settings.txt'), 'mode=baseline');
  assert.match(await recovered.file(f.repo, result.commit, 'notes.md'), /Remote later work/);
});

test('Artifacts delegates immutable ancestry, base and inverse candidates with the repository validation descriptor', async () => {
  const calls = [], ancestor = 'a'.repeat(40), descendant = 'b'.repeat(40), candidate = 'c'.repeat(40);
  const adapter = new ArtifactsGit({VALIDATION_CONFIG_HASH: 'validation-v1', GIT_BRIDGE_TOKEN: 'scoped-test-service',
    GIT_EXECUTOR: {async fetch(request) {
      const input = await request.json(); calls.push({operation: new URL(request.url).pathname, input});
      const result = calls.at(-1).operation === '/is-ancestor' ? {isAncestor: true} : calls.at(-1).operation === '/merge-base' ? {base: ancestor} : {tree: candidate, commit: candidate, baseTree: descendant, retention_ref: `refs/converge/candidates/${candidate}`};
      return Response.json(result);
    }}});
  const repo = {id: 'application', canonical_repo: 'canonical', validation_profile: 'checkout-effects-v2', context_repo: 'payment-policy'};
  assert.equal(await adapter.isAncestor(repo, ancestor, descendant), true);
  assert.equal(await adapter.mergeBase(repo, descendant, ancestor), ancestor);
  assert.equal((await adapter.revert(repo, descendant, ancestor, 1)).commit, candidate);
  assert.deepEqual(calls.map(call => call.operation), ['/is-ancestor', '/merge-base', '/revert']);
  for (const {input} of calls) {
    assert.equal(input.validation_profile, repo.validation_profile); assert.equal(input.context_repo, repo.context_repo);
    assert.equal(input.canonical_repo, 'canonical'); assert.equal(input.configHash, 'validation-v1');
  }
  assert.equal(calls[2].input.mainline, 1);
  await assert.rejects(() => adapter.revert(repo, 'main', ancestor), error => error.code === 'INVALID_COMMIT');
});
