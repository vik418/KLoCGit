import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalGit, git } from '../../server/git.mjs';
import { ArtifactsGit } from '../../worker/artifacts.mjs';
import { ArtifactsGitStore } from '../../adapters/cloudflare/git-store.mjs';
import { GitStore } from '../../core/v1/git-store.mjs';
import { gitStoreContract } from '../support/git-store-contract.mjs';

/** Real Git objects behind the documented binding shape; not live Artifacts proof. */
async function gitBindingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'klocgit-artifacts-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = new LocalGit(root);
  const repo_id = 'artifacts-repository';
  const ref = 'refs/heads/main';
  const repository = { id: repo_id, canonical_ref: ref };
  const directory = local.dir(repository);
  await mkdir(directory, { recursive: true });
  await git(directory, ['init', '--bare', '--quiet']);
  const requests = [];
  let disposed = 0;
  let loseReply = false;
  const readCommit = async (oid) => {
    let value;
    try {
      value = await git(directory, ['show', '-s', '--format=%H%n%T%n%P', oid]);
    } catch {
      return null;
    }
    const [hash, treeHash, parents = ''] = value.split('\n');
    return { hash, treeHash, parents: parents ? parents.split(' ') : [] };
  };
  const env = {
    VALIDATION_CONFIG_HASH: 'trusted-validation-configuration',
    GIT_BRIDGE_TOKEN: 'private-test-service-token',
    ARTIFACTS: {
      get: async (id) => {
        assert.equal(id, repo_id);
        return {
          log: async ({ ref: requestedRef, limit }) => {
            assert.equal(limit, 1);
            try {
              const value = await local.readRef(repository, requestedRef);
              return [await readCommit(value.commit)];
            } catch (error) {
              if (error.code === 'REF_NOT_FOUND') return [];
              throw error;
            }
          },
          readCommit,
          readTree: async (oid) => {
            let output;
            try {
              output = await git(directory, ['ls-tree', '-z', oid], undefined, { raw: true });
            } catch {
              return null;
            }
            const types = {
              '040000': 'tree',
              100644: 'blob',
              100755: 'exec',
              120000: 'symlink',
              160000: 'gitlink',
            };
            return output
              .split('\0')
              .filter(Boolean)
              .map((line) => {
                const separator = line.indexOf('\t');
                const [mode, , hash] = line.slice(0, separator).split(' ');
                return {
                  name: line.slice(separator + 1),
                  mode: mode === '040000' ? '40000' : mode,
                  hash,
                  type: types[mode],
                };
              });
          },
          [Symbol.dispose]: () => {
            disposed += 1;
          },
        };
      },
    },
    GIT_EXECUTOR: {
      fetch: async (request) => {
        assert.equal(request.headers.get('Authorization'), 'Bearer ' + env.GIT_BRIDGE_TOKEN);
        const input = await request.json();
        requests.push(input);
        if (new URL(request.url).pathname === '/read-ref')
          return Response.json(await local.readRef(repository, input.ref));
        assert.equal(new URL(request.url).pathname, '/cas');
        const updated = await local.cas(
          { ...repository, canonical_ref: input.ref },
          input.expected,
          input.commit,
        );
        if (loseReply) throw new Error('Private transport detail');
        return Response.json({ updated });
      },
    },
  };
  const adapter = new ArtifactsGit(env);
  let provider;
  const workspaceSource = {
    fetch: async (identity, filter) => ({ identity, filter }),
  };
  provider = new ArtifactsGitStore({ adapter, repository, workspaceSource });
  const store = new GitStore({ repo_id, provider });
  const create = async (message, parents = [], contents = message) => {
    const blob = await git(directory, ['hash-object', '-w', '--stdin'], contents);
    const tree = await git(directory, ['mktree'], `100644 blob ${blob}\tfile.txt\n`);
    const oid = await git(directory, [
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      message,
    ]);
    return provider.snapshot(oid);
  };
  return {
    repo_id,
    ref,
    provider,
    store,
    create,
    readCommit,
    directory,
    env,
    requests,
    advance: (oid) => git(directory, ['update-ref', ref, oid]),
    disposed: () => disposed,
    loseReply: () => {
      loseReply = true;
    },
  };
}

test('Artifacts reads and trusted Git transport satisfy the shared GitStore contract', async (t) => {
  const fixture = await gitBindingFixture(t);
  const initial = await fixture.create('initial');
  const next = await fixture.create('next', [initial.commit_oid]);
  const external = await fixture.create('external', [next.commit_oid]);
  await fixture.advance(initial.commit_oid);
  await gitStoreContract({ ...fixture, initial, next, external });
  assert.deepEqual(
    fixture.requests.map((request) => request.idempotency_key),
    ['first-promotion', 'raced-promotion'],
  );
  assert.ok(fixture.disposed() > 0);
});

test('branch updates, force pushes, rebases and external pushes preserve immutable observations', async (t) => {
  const fixture = await gitBindingFixture(t);
  const initial = await fixture.create('initial');
  const update = await fixture.create('branch update', [initial.commit_oid]);
  const force = await fixture.create('replacement history');
  const rebased = await fixture.create(
    'rebased implementation',
    [force.commit_oid],
    'branch update',
  );
  const external = await fixture.create('external push', [rebased.commit_oid]);
  const observations = [];
  for (const state of [initial, update, force, rebased, external]) {
    await fixture.advance(state.commit_oid);
    const head = await fixture.store.observe_ref(fixture.repo_id, fixture.ref);
    const snapshot = await fixture.provider.snapshot(head);
    assert.deepEqual(snapshot, state);
    observations.push(snapshot);
  }
  assert.equal(new Set(observations.map((value) => value.commit_oid)).size, 5);
  assert.deepEqual(observations[1].parent_oids, [initial.commit_oid]);
  assert.deepEqual(observations[2].parent_oids, []);
  assert.deepEqual(observations[3].parent_oids, [force.commit_oid]);
  assert.deepEqual(await fixture.provider.snapshot(update.commit_oid), observations[1]);
  assert.ok(observations.every((value) => Object.isFrozen(value.parent_oids)));
});

test('native tree classifications retain exact Git modes and entry order', async (t) => {
  const fixture = await gitBindingFixture(t);
  const commit = await fixture.create('submodule target');
  const blob = await git(fixture.directory, ['hash-object', '-w', '--stdin'], 'content');
  const emptyTree = await git(fixture.directory, ['mktree'], '');
  const tree = await git(
    fixture.directory,
    ['mktree'],
    [
      `040000 tree ${emptyTree}\tdirectory`,
      `100755 blob ${blob}\texecutable`,
      `100644 blob ${blob}\tfile`,
      `120000 blob ${blob}\tlink`,
      `160000 commit ${commit.commit_oid}\tsubmodule`,
    ].join('\n') + '\n',
  );
  const result = await fixture.store.read_tree(tree);
  assert.deepEqual(
    result.entries.map(({ name, mode, kind }) => ({ name, mode, kind })),
    [
      { name: 'directory', mode: '040000', kind: 'tree' },
      { name: 'executable', mode: '100755', kind: 'blob' },
      { name: 'file', mode: '100644', kind: 'blob' },
      { name: 'link', mode: '120000', kind: 'blob' },
      { name: 'submodule', mode: '160000', kind: 'commit' },
    ],
  );
});

test('annotated tags preserve their object OID instead of the peeled commit', async (t) => {
  const fixture = await gitBindingFixture(t);
  const commit = await fixture.create('tagged commit');
  await git(fixture.directory, ['tag', '-a', 'release', commit.commit_oid, '-m', 'release']);
  const tag = await git(fixture.directory, ['rev-parse', 'refs/tags/release']);
  assert.notEqual(tag, commit.commit_oid);
  assert.equal(await fixture.store.observe_ref(fixture.repo_id, 'refs/tags/release'), tag);
});

test('missing immutable objects are explicit, capabilities are disposed and diagnostics are bounded', async (t) => {
  const fixture = await gitBindingFixture(t);
  await assert.rejects(fixture.provider.snapshot('f'.repeat(40)), { code: 'NOT_FOUND' });
  await assert.rejects(fixture.store.read_tree('f'.repeat(40)), { code: 'NOT_FOUND' });
  await assert.rejects(fixture.store.observe_ref(fixture.repo_id, fixture.ref), {
    code: 'NOT_FOUND',
  });
  assert.equal(fixture.disposed(), 3);
  fixture.env.ARTIFACTS.get = async () => {
    throw Object.assign(new Error('secret=private-token'), { code: 'INTERNAL_ERROR' });
  };
  await assert.rejects(
    fixture.provider.snapshot('f'.repeat(40)),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && !error.message.includes('private-token'),
  );
});

test('a lost CAS reply remains UNKNOWN even if Git changed; the adapter never retries', async (t) => {
  const fixture = await gitBindingFixture(t);
  const initial = await fixture.create('initial');
  const next = await fixture.create('accepted candidate', [initial.commit_oid]);
  await fixture.advance(initial.commit_oid);
  fixture.loseReply();
  await assert.rejects(
    fixture.store.compare_and_swap_ref(fixture.ref, initial.commit_oid, next.commit_oid, {
      idempotency_key: 'promotion',
    }),
    { code: 'OUTCOME_UNKNOWN' },
  );
  assert.equal(await fixture.store.observe_ref(fixture.repo_id, fixture.ref), next.commit_oid);
  assert.equal(fixture.requests.length, 1);
});

test('malformed CAS acknowledgements cannot be treated as lease rejection', async (t) => {
  const fixture = await gitBindingFixture(t);
  const initial = await fixture.create('initial');
  const next = await fixture.create('next', [initial.commit_oid]);
  fixture.env.GIT_EXECUTOR.fetch = async () => Response.json({});
  await assert.rejects(
    fixture.store.compare_and_swap_ref(fixture.ref, initial.commit_oid, next.commit_oid, {
      idempotency_key: 'promotion',
    }),
    { code: 'OUTCOME_UNKNOWN' },
  );
});

test('native commit and workspace substitution cannot change immutable fetch identity', async (t) => {
  const fixture = await gitBindingFixture(t);
  const initial = await fixture.create('initial');
  const other = await fixture.create('different implementation');
  fixture.provider.workspaceSource.fetch = async (identity) => ({
    identity: { ...identity, tree_oid: other.tree_oid },
  });
  await assert.rejects(
    fixture.store.fetch(
      { schema_version: 1, repo_id: fixture.repo_id, commit_oid: initial.commit_oid },
      {},
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  fixture.env.ARTIFACTS.get = async () => ({
    readCommit: async () => fixture.readCommit(other.commit_oid),
    [Symbol.dispose]() {},
  });
  await assert.rejects(fixture.provider.snapshot(initial.commit_oid), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('unsupported Git object formats are explicit before provider calls', async (t) => {
  const fixture = await gitBindingFixture(t);
  await assert.rejects(fixture.provider.snapshot('a'.repeat(64)), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  await assert.rejects(fixture.store.read_tree('a'.repeat(64)), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
  assert.equal(fixture.disposed(), 0);
});

test('explicit executor precondition rejection is distinct from an ambiguous write', async (t) => {
  const fixture = await gitBindingFixture(t);
  const initial = await fixture.create('initial');
  const next = await fixture.create('next', [initial.commit_oid]);
  for (const [providerCode, code] of [
    ['CONFIG_STALE', 'STALE_BASIS'],
    ['SOURCE_WRITE_FORBIDDEN', 'FORBIDDEN'],
    ['VALIDATION_PROFILE_MISMATCH', 'POLICY_REJECTED'],
  ]) {
    fixture.env.GIT_EXECUTOR.fetch = async () =>
      Response.json({ error: providerCode, message: 'private-provider-detail' }, { status: 409 });
    await assert.rejects(
      fixture.store.compare_and_swap_ref(fixture.ref, initial.commit_oid, next.commit_oid, {
        idempotency_key: 'promotion',
      }),
      (error) => error.code === code && !error.message.includes('private-provider-detail'),
    );
  }
});
