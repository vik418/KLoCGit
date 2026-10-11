import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { LocalWorkspaceSource } from '../../adapters/local/workspace-source.mjs';
import { LocalMaterializer } from '../../adapters/local/materializer.mjs';
import { FutureRevision, SystemRevision } from '../../core/v1/domain.mjs';
import { objectId } from '../../core/v1/conventions.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { commitSelection } from '../../core/v1/materialization.mjs';
import { buildCandidateSpec, wholeFutureSelection } from '../../core/v1/reduction.mjs';
import { verifyCandidateContent } from '../../core/v1/promotion.mjs';

const limits = Object.freeze({
  max_objects: 1000,
  max_bytes: 8 * 1024 * 1024,
  max_files: 1000,
  max_history_commits: 100,
  timeout_ms: 30000,
  max_candidates: 16,
});

async function fixture(t, initial, format = 'sha1') {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root);
  const sources = new Map(),
    repositories = new Map();
  async function repository(id, clone) {
    const record = { id, canonical_ref: 'refs/heads/main' };
    const directory = adapter.dir(record);
    if (clone)
      await git(root, [
        'clone',
        '--bare',
        '--quiet',
        adapter.dir(repositories.get(clone)),
        directory,
      ]);
    else {
      await mkdir(directory, { recursive: true });
      await git(directory, ['init', '--bare', '--quiet', '--object-format=' + format]);
    }
    repositories.set(id, record);
    sources.set(id, new LocalWorkspaceSource({ adapter, repository: record }));
    return directory;
  }
  async function commit(repoId, files, parent = null) {
    const directory = adapter.dir(repositories.get(repoId));
    const entries = [];
    for (const [path, value] of Object.entries(files)) {
      const file = typeof value === 'string' ? { contents: value } : value;
      const oid = await git(directory, ['hash-object', '-w', '--stdin'], file.contents);
      entries.push({ path, oid, mode: file.mode ?? '100644' });
    }
    async function tree(prefix) {
      const direct = entries.filter((entry) => entry.path.startsWith(prefix));
      const names = [
        ...new Set(direct.map((entry) => entry.path.slice(prefix.length).split('/')[0])),
      ];
      const lines = [];
      for (const name of names) {
        const entry = direct.find((item) => item.path === prefix + name);
        lines.push(
          entry
            ? `${entry.mode} blob ${entry.oid}\t${name}`
            : `040000 tree ${await tree(prefix + name + '/')}\t${name}`,
        );
      }
      return git(directory, ['mktree', '-z'], lines.join('\0') + (lines.length ? '\0' : ''));
    }
    const tree_oid = await tree('');
    const commit_oid = await git(directory, [
      'commit-tree',
      tree_oid,
      ...(parent ? ['-p', parent] : []),
      '-m',
      'fixture',
    ]);
    await git(directory, ['update-ref', 'refs/heads/main', commit_oid]);
    return {
      schema_version: 1,
      repo_id: repoId,
      commit_oid,
      tree_oid,
      parent_oids: parent ? [parent] : [],
    };
  }
  await repository('canonical');
  const baseline = await commit('canonical', initial);
  const baseBody = {
    schema_version: 1,
    repositories: { canonical: baseline.commit_oid },
    configuration_digests: {},
    accepted_decisions: [],
  };
  const digest = await digestCanonical('object-system-revision', baseBody);
  const base_revision = SystemRevision({
    ...baseBody,
    id: objectId('system-revision', digest),
    digest,
  });
  const context = {
    schema_version: 1,
    base_revision,
    revisions: [],
    bindings: {},
    commit_identity: {
      schema_version: 1,
      name: 'Test author',
      email: 'author@example.test',
      timestamp: 100,
    },
  };
  async function future(repoId, files) {
    await repository(repoId, 'canonical');
    const snapshot = await commit(repoId, files, baseline.commit_oid);
    const futureBody = {
      ...snapshot,
      system_id: 'group',
      ref: 'refs/heads/main',
      producer: null,
      observed_at: '2026-10-11T00:00:00Z',
    };
    const revision = FutureRevision({
      ...futureBody,
      id: objectId('future-revision', await digestCanonical('object-future-revision', futureBody)),
    });
    context.revisions.push(revision);
    context.bindings[revision.id] = {
      schema_version: 1,
      repo_id: 'canonical',
      base_commit_oid: baseline.commit_oid,
      base_tree_oid: baseline.tree_oid,
    };
    return revision;
  }
  async function spec(
    selections = context.revisions.map((revision) =>
      wholeFutureSelection(revision, context.bindings[revision.id]),
    ),
    overrides = {},
  ) {
    return buildCandidateSpec({
      schema_version: 1,
      base_revision: context.base_revision.id,
      selected_future_revisions: context.revisions.map(({ id }) => id),
      selections,
      required_dependencies: [],
      effect_summary_digest: await digestCanonical('effect-summary', []),
      creation_reason: 'Selected work',
      ...overrides,
    });
  }
  const materializer = new LocalMaterializer({
    root: join(root, 'executor'),
    limits,
    resolveSource: (repoId) => {
      assert.ok(sources.has(repoId));
      return sources.get(repoId);
    },
  });
  t.after(() => materializer.close());
  const sourceState = () =>
    Promise.all(
      [...repositories.values()].map(async (record) => ({
        id: record.id,
        refs: await git(adapter.dir(record), ['show-ref']),
        objects: await git(adapter.dir(record), ['count-objects', '-v']),
      })),
    );
  return {
    root,
    adapter,
    sources,
    repositories,
    repository,
    commit,
    future,
    spec,
    context,
    baseline,
    materializer,
    sourceState,
  };
}

test('whole Futures compose reproducibly, hydrate changed files only, and never write to source Git', async (t) => {
  const initial = {
    'src/a.txt': 'a\n',
    'src/b.txt': 'b\n',
    'large.txt': 'x'.repeat(2 * 1024 * 1024),
  };
  const f = await fixture(t, initial);
  await f.future('a', { ...initial, 'src/a.txt': 'new a\n' });
  await f.future('b', {
    ...initial,
    'src/b.txt': 'new b\n',
    link: { contents: 'src/a.txt', mode: '120000' },
  });
  const before = await f.sourceState();
  const spec = await f.spec();
  const candidate = await f.materializer.materialize(spec, f.context);
  assert.ok(
    f.materializer.metrics(candidate.digest).blob_bytes_transferred <
      Buffer.byteLength(initial['large.txt']),
  );
  assert.deepEqual(await verifyCandidateContent(candidate), candidate);
  assert.deepEqual(await f.materializer.materialize(spec, f.context), candidate);
  const workspace = await f.materializer.open(candidate, 'canonical');
  assert.equal((await workspace.readFile('src/a.txt')).contents, 'new a\n');
  assert.equal((await workspace.readFile('src/b.txt')).contents, 'new b\n');
  assert.equal((await workspace.readFile('link')).mode, '120000');
  assert.equal((await workspace.readFile('link')).contents, 'src/a.txt');
  assert.ok(workspace.metrics().blob_bytes_transferred < Buffer.byteLength(initial['large.txt']));
  assert.equal((await workspace.readFile('large.txt')).contents, initial['large.txt']);
  assert.deepEqual(await f.sourceState(), before);
  assert.equal(
    candidate.materialization_record.repo_commit_oids.canonical,
    workspace.identity.commit_oid,
  );
  assert.deepEqual(workspace.identity.parent_oids, [f.baseline.commit_oid]);
});

test('selected commits omit unrelated work and preserve explicit selection provenance', async (t) => {
  const initial = { 'a.txt': 'a\n', 'b.txt': 'b\n' };
  const f = await fixture(t, initial);
  await f.repository('future', 'canonical');
  const first = await f.commit(
    'future',
    { ...initial, 'a.txt': 'selected\n' },
    f.baseline.commit_oid,
  );
  const second = await f.commit(
    'future',
    { ...initial, 'a.txt': 'selected\n', 'b.txt': 'unselected\n' },
    first.commit_oid,
  );
  const body = {
    ...second,
    system_id: 'group',
    ref: 'refs/heads/main',
    producer: null,
    observed_at: '2026-10-11T00:00:00Z',
  };
  const revision = FutureRevision({
    ...body,
    id: objectId('future-revision', await digestCanonical('object-future-revision', body)),
  });
  f.context.revisions.push(revision);
  f.context.bindings[revision.id] = {
    schema_version: 1,
    repo_id: 'canonical',
    base_commit_oid: f.baseline.commit_oid,
    base_tree_oid: f.baseline.tree_oid,
  };
  const selection = commitSelection(
    revision,
    f.context.bindings[revision.id],
    first,
    f.baseline.commit_oid,
  );
  const candidate = await f.materializer.materialize(await f.spec([selection]), f.context);
  const workspace = await f.materializer.open(candidate, 'canonical');
  assert.equal((await workspace.readFile('a.txt')).contents, 'selected\n');
  assert.equal((await workspace.readFile('b.txt')).contents, 'b\n');
  assert.deepEqual(candidate.materialization_record.selections, [selection]);
});

test('textual conflicts are explicit failures and leave every source repository intact', async (t) => {
  const f = await fixture(t, { 'value.txt': 'baseline\n' });
  await f.future('a', { 'value.txt': 'first choice\n' });
  await f.future('b', { 'value.txt': 'second choice\n' });
  const before = await f.sourceState();
  await assert.rejects(f.materializer.materialize(await f.spec(), f.context), { code: 'CONFLICT' });
  assert.deepEqual(await f.sourceState(), before);
});

test('clean textual composition can still violate behavior; materialization provides no correctness verdict', async (t) => {
  const initial = { 'attempts.json': '1', 'side-effect.json': '0' };
  const f = await fixture(t, initial);
  const a = await f.future('retry', { ...initial, 'attempts.json': '2' });
  const b = await f.future('side-effect', { ...initial, 'side-effect.json': '1' });
  async function charges(selections, ids) {
    const candidate = await f.materializer.materialize(
      await f.spec(selections, { selected_future_revisions: ids }),
      f.context,
    );
    const workspace = await f.materializer.open(candidate, 'canonical');
    const attempts = JSON.parse((await workspace.readFile('attempts.json')).contents);
    const effect = JSON.parse((await workspace.readFile('side-effect.json')).contents);
    return effect ? attempts : 0;
  }
  const selections = [a, b].map((revision) =>
    wholeFutureSelection(revision, f.context.bindings[revision.id]),
  );
  assert.ok((await charges([selections[0]], [a.id])) <= 1);
  assert.ok((await charges([selections[1]], [b.id])) <= 1);
  assert.ok((await charges(selections, [a.id, b.id])) > 1);
});

test('plan, baseline, source and commit substitutions are rejected before a Candidate can be returned', async (t) => {
  const f = await fixture(t, { 'a.txt': 'a\n' });
  const revision = await f.future('future', { 'a.txt': 'new\n' });
  const spec = await f.spec();
  await assert.rejects(
    f.materializer.materialize({ ...spec, creation_reason: 'substituted' }, f.context),
    { code: 'INTEGRITY_MISMATCH' },
  );
  await assert.rejects(
    f.materializer.materialize(spec, {
      ...f.context,
      base_revision: {
        ...f.context.base_revision,
        repositories: { canonical: revision.commit_oid },
      },
    }),
    { code: 'INTEGRITY_MISMATCH' },
  );
  const other = await f.commit('future', { 'a.txt': 'not an ancestor\n' });
  const selection = commitSelection(revision, f.context.bindings[revision.id], other, null);
  await assert.rejects(f.materializer.materialize(await f.spec([selection]), f.context), {
    code: 'FORBIDDEN',
  });
  const forged = await f.spec([
    {
      ...wholeFutureSelection(revision, f.context.bindings[revision.id]),
      tree_oid: f.baseline.tree_oid,
    },
  ]);
  await assert.rejects(f.materializer.materialize(forged, f.context), {
    code: 'INTEGRITY_MISMATCH',
  });
  const original = f.sources.get('future');
  f.sources.set('future', {
    fetch: async () =>
      original.fetch({
        ...revision,
        repo_id: 'future',
        commit_oid: other.commit_oid,
        tree_oid: other.tree_oid,
        parent_oids: [],
      }),
  });
  await assert.rejects(f.materializer.materialize(spec, f.context), { code: 'INTEGRITY_MISMATCH' });
});

test('required whole-revision dependencies cannot be satisfied by a partial commit selection', async (t) => {
  const f = await fixture(t, { 'a.txt': 'a\n' });
  const revision = await f.future('future', { 'a.txt': 'new\n' });
  const selection = commitSelection(
    revision,
    f.context.bindings[revision.id],
    (await f.sources.get('future').fetch(revision)).identity,
    f.baseline.commit_oid,
  );
  await assert.rejects(
    f.materializer.materialize(
      await f.spec([selection], { required_dependencies: [revision.id] }),
      f.context,
    ),
    { code: 'INCOMPLETE_ANALYSIS' },
  );
});

test('SHA-256 repositories retain exact object identities during composition', async (t) => {
  const f = await fixture(t, { 'a.txt': 'a\n' }, 'sha256');
  await f.future('future', { 'a.txt': 'new\n' });
  const candidate = await f.materializer.materialize(await f.spec(), f.context);
  const workspace = await f.materializer.open(candidate, 'canonical');
  assert.equal(workspace.identity.commit_oid.length, 64);
  assert.equal((await workspace.readFile('a.txt')).contents, 'new\n');
});

test('composition bounds fail explicitly and local materialization loss is recoverable', async (t) => {
  const f = await fixture(t, { 'a.txt': 'a\n' });
  await f.future('future', { 'a.txt': 'new\n' });
  const small = new LocalMaterializer({
    root: join(f.root, 'bounded'),
    resolveSource: (repo) => f.sources.get(repo),
    limits: { ...limits, max_objects: 1 },
  });
  t.after(() => small.close());
  const spec = await f.spec();
  await assert.rejects(small.materialize(spec, f.context), { code: 'INCOMPLETE_ANALYSIS' });
  const candidate = await f.materializer.materialize(spec, f.context);
  await f.materializer.release(candidate.digest);
  await assert.rejects(f.materializer.open(candidate, 'canonical'), { code: 'NOT_FOUND' });
  assert.deepEqual(await f.materializer.materialize(spec, f.context), candidate);
  await assert.rejects(
    f.materializer.open(
      { ...candidate, repo_tree_oids: { canonical: f.baseline.tree_oid } },
      'canonical',
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
});

test('multi-repository Candidates include unchanged members and exact changed repository states', async (t) => {
  const f = await fixture(t, { 'a.txt': 'baseline\n' });
  await f.repository('second');
  const second = await f.commit('second', { 'b.txt': 'second baseline\n' });
  await f.repository('untouched');
  const untouched = await f.commit('untouched', { 'c.txt': 'kept\n' });
  const body = { ...f.context.base_revision };
  delete body.id;
  delete body.digest;
  const nextBody = {
    ...body,
    repositories: {
      ...body.repositories,
      second: second.commit_oid,
      untouched: untouched.commit_oid,
    },
  };
  const digest = await digestCanonical('object-system-revision', nextBody);
  f.context.base_revision = SystemRevision({
    ...nextBody,
    id: objectId('system-revision', digest),
    digest,
  });
  const a = await f.future('first-work', { 'a.txt': 'first result\n' });
  await f.repository('second-work', 'second');
  const snapshot = await f.commit('second-work', { 'b.txt': 'second result\n' }, second.commit_oid);
  const revisionBody = {
    ...snapshot,
    system_id: 'group',
    ref: 'refs/heads/main',
    producer: null,
    observed_at: '2026-10-11T00:00:00Z',
  };
  const b = FutureRevision({
    ...revisionBody,
    id: objectId('future-revision', await digestCanonical('object-future-revision', revisionBody)),
  });
  f.context.revisions.push(b);
  f.context.bindings[b.id] = {
    schema_version: 1,
    repo_id: 'second',
    base_commit_oid: second.commit_oid,
    base_tree_oid: second.tree_oid,
  };
  const candidate = await f.materializer.materialize(await f.spec(), f.context);
  assert.deepEqual(candidate.repo_tree_oids, {
    canonical: a.tree_oid,
    second: b.tree_oid,
    untouched: untouched.tree_oid,
  });
  assert.equal(candidate.materialization_record.repo_commit_oids.untouched, untouched.commit_oid);
  assert.equal(
    (await (await f.materializer.open(candidate, 'second')).readFile('b.txt')).contents,
    'second result\n',
  );
});

test('ordered commits preserve exact state while duplicate selections and implicit merge mainlines are refused', async (t) => {
  const f = await fixture(t, { 'a.txt': 'baseline\n' });
  const revision = await f.future('work', { 'a.txt': 'first\n' });
  const first = (await f.sources.get('work').fetch(revision)).identity;
  const selection = commitSelection(
    revision,
    f.context.bindings[revision.id],
    first,
    f.baseline.commit_oid,
  );
  await assert.rejects(
    f.materializer.materialize(await f.spec([selection, selection]), f.context),
    { code: 'INVALID_ARGUMENT' },
  );
  assert.throws(
    () =>
      commitSelection(revision, f.context.bindings[revision.id], {
        ...first,
        parent_oids: [f.baseline.commit_oid, revision.commit_oid],
      }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('caller mutation and malicious identity fields cannot replace snapshotted composition inputs', async (t) => {
  const f = await fixture(t, { 'a.txt': 'baseline\n' });
  await f.future('work', { 'a.txt': 'selected\n' });
  const spec = await f.spec();
  const context = structuredClone(f.context);
  const pending = f.materializer.materialize(spec, context);
  context.commit_identity.name = 'substituted';
  context.bindings[context.revisions[0].id].base_tree_oid = context.revisions[0].tree_oid;
  const candidate = await pending;
  assert.equal(
    candidate.materialization_record.commit_identity.name,
    f.context.commit_identity.name,
  );
  await assert.rejects(
    f.materializer.materialize(spec, {
      ...f.context,
      commit_identity: { ...f.context.commit_identity, name: 'name\nparent substituted' },
    }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('candidate cache capacity never evicts active materializations and explicit release permits deterministic retry', async (t) => {
  const initial = { 'a.txt': 'a\n', 'b.txt': 'b\n' };
  const f = await fixture(t, initial);
  const a = await f.future('first', { ...initial, 'a.txt': 'first\n' });
  const b = await f.future('second', { ...initial, 'b.txt': 'second\n' });
  const specs = await Promise.all(
    [a, b].map((revision) =>
      f.spec([wholeFutureSelection(revision, f.context.bindings[revision.id])], {
        selected_future_revisions: [revision.id],
      }),
    ),
  );
  const materializer = new LocalMaterializer({
    root: join(f.root, 'one-candidate'),
    resolveSource: (repo) => f.sources.get(repo),
    limits: { ...limits, max_candidates: 1 },
  });
  t.after(() => materializer.close());
  const first = await materializer.materialize(specs[0], f.context);
  assert.deepEqual(await materializer.materialize(specs[0], f.context), first);
  await assert.rejects(materializer.materialize(specs[1], f.context), { code: 'RATE_LIMITED' });
  assert.equal(
    (await (await materializer.open(first, 'canonical')).readFile('a.txt')).contents,
    'first\n',
  );
  await materializer.release(first.digest);
  const second = await materializer.materialize(specs[1], f.context);
  assert.deepEqual(second, await f.materializer.materialize(specs[1], f.context));
});
