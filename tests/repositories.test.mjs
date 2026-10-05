import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { LocalGit, git } from '../server/git.mjs';
import { ArtifactsGit } from '../worker/artifacts.mjs';
import { DomainError } from '../core/hash.mjs';
import {
  repositoryImportSource,
  repositoryRef,
} from '../core/repository-input.mjs';
import {
  publicImportAddress,
  publicImportCommand,
  resolveImportSource,
} from '../server/repositories.mjs';

const oid = (digit) => digit.repeat(40);
const ref = 'refs/heads/main';

function artifactsFixture() {
  const repositories = new Map();
  const calls = [];
  const binding = {
    async create(id, opts) {
      calls.push({ operation: 'create', id, opts });
      if (repositories.has(id)) throw { code: 'ALREADY_EXISTS' };
      const value = {
        name: id, description: opts.description, defaultBranch: opts.setDefaultBranch ?? 'main',
        remote: 'https://test.artifacts.cloudflare.net/git/test/' + id + '.git',
        commit: null, tree: null,
      };
      repositories.set(id, value);
      if (binding.loseCreateReply) throw new Error('secret token from provider diagnostics');
      return { ...value, token: 'initial-secret' };
    },
    async import(input) {
      calls.push({ operation: 'import', input });
      await binding.create(input.target.name, {
        description: input.target.opts.description,
        setDefaultBranch: input.source.branch,
      });
      const value = repositories.get(input.target.name);
      value.pending = 'IMPORT_IN_PROGRESS';
      return { ...value, token: 'import-secret' };
    },
    async get(id) {
      const value = repositories.get(id);
      if (!value) throw { code: 'NOT_FOUND' };
      if (value.pending) throw { code: value.pending };
      return {
        async info() { return { ...value, token: 'metadata-secret' }; },
        async log(input) { return input.ref === 'refs/heads/' + value.defaultBranch && value.commit ? [{ hash: value.commit }] : []; },
        async readCommit(hash) {
          return hash === value.commit && !value.missingCommit
            ? { hash, treeHash: value.tree, message: 'Observed ordinary Git commit' } : null;
        },
        async fork(target, opts) {
          calls.push({ operation: 'fork', source: id, target, opts });
          binding.beforeFork?.(value);
          if (repositories.has(target)) throw { code: 'ALREADY_EXISTS' };
          const result = {
            ...value,
            name: target,
            description: opts.description,
            remote: 'https://test.artifacts.cloudflare.net/git/test/' + target + '.git',
          };
          repositories.set(target, result);
          return { ...result, token: 'fork-secret' };
        },
        [Symbol.dispose]() { calls.push({ operation: 'dispose', id }); },
      };
    },
  };
  const adapter = new ArtifactsGit({ ARTIFACTS: binding });
  return { adapter, binding, repositories, calls };
}

test('public import rejects private endpoints, URL credentials and forge web/API paths', () => {
  for (const url of [
    'http://github.com/team/app',
    'https://user:secret@github.com/team/app',
    'https://github.com/team/app?token=secret',
    'https://github.com/team/app#secret',
    'https://github.com:8443/team/app',
    'https://127.1/team/app',
    'https://2130706433/team/app',
    'https://[::1]/team/app',
    'https://localhost/team/app',
    'https://github.com./team/app',
    'https://github.com/team/app/tree/main',
    'https://github.com/team/%2e%2e/app',
    'https://github.com/team/app/',
    'https://gitlab.com/team/app/-/repository',
  ])
    assert.throws(() => repositoryImportSource({ url }));
  assert.throws(() => repositoryImportSource({
    url: 'https://github.com/team/app', token: 'never journal this',
  }));
  assert.throws(() => repositoryImportSource({
    url: 'https://github.com/team/app', depth: 1001,
  }));
  assert.throws(() => repositoryImportSource({
    url: 'https://private.example/team/app',
  }, ['private.example']));
  assert.deepEqual(repositoryImportSource({
    url: 'https://gitlab.com/team/subgroup/app.git', branch: 'feature/retry', depth: 30,
  }), {
    url: 'https://gitlab.com/team/subgroup/app.git', branch: 'feature/retry', depth: 30,
  });
  for (const value of ['refs/heads/a/', 'refs/heads/a..b', 'refs/heads/a.lock', 'refs/heads/.a', 'refs/heads/a//b'])
    assert.throws(() => repositoryRef(value));
});

test('Artifacts create observes an empty repository without manufacturing a commit or exposing tokens', async () => {
  const f = artifactsFixture();
  const result = await f.adapter.repositoryCreate({
    id: 'app', ref, description: 'Ordinary software', operation_id: 'op-create',
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.commit, null);
  assert.equal(result.tree, null);
  assert.equal(result.operation_id, 'op-create');
  assert.ok(!JSON.stringify(result).includes('secret'));
  Object.assign(f.repositories.get('app'), { commit: oid('a'), tree: oid('b') });
  const ready = await f.adapter.repositoryInfo({ id: 'app', ref });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.commit, oid('a'));
  assert.equal(ready.tree, oid('b'));
  assert.ok(f.calls.filter((call) => call.operation === 'dispose').length >= 2);
});

test('Artifacts absence and failed reads remain distinct from an empty repository', async () => {
  const f = artifactsFixture();
  await assert.rejects(f.adapter.repositoryInfo({ id: 'absent', ref }), { code: 'REPO_NOT_FOUND', status: 404 });
  await f.adapter.repositoryCreate({ id: 'app', ref, operation_id: 'op-create' });
  Object.assign(f.repositories.get('app'), {
    commit: oid('a'), tree: oid('b'), missingCommit: true,
  });
  await assert.rejects(f.adapter.repositoryInfo({ id: 'app', ref }), { code: 'MISSING_COMMIT' });
  f.binding.get = async () => { throw new Error('provider private credentials'); };
  await assert.rejects(f.adapter.repositoryInfo({ id: 'app', ref }), (error) =>
    error.code === 'ARTIFACTS_UNAVAILABLE' && !error.message.includes('credentials'));
});

test('Artifacts lost creation acknowledgement leaves one marked repository for read-only reconciliation', async () => {
  const f = artifactsFixture();
  f.binding.loseCreateReply = true;
  await assert.rejects(f.adapter.repositoryCreate({
    id: 'app', ref, operation_id: 'op-lost',
  }), { code: 'ARTIFACTS_UNAVAILABLE' });
  const inspected = await f.adapter.repositoryInfo({ id: 'app', ref });
  assert.equal(inspected.operation_id, 'op-lost');
  assert.equal(f.calls.filter((call) => call.operation === 'create').length, 1);
  f.binding.loseCreateReply = false;
  await assert.rejects(f.adapter.repositoryCreate({
    id: 'app', ref, operation_id: 'different-op',
  }), { code: 'REPO_EXISTS' });
  assert.equal((await f.adapter.repositoryInfo({ id: 'app', ref })).operation_id, 'op-lost');
});

test('Artifacts import uses the documented public-source shape and preserves asynchronous readiness', async () => {
  const f = artifactsFixture();
  const result = await f.adapter.repositoryImport({
    id: 'app', ref, description: 'Imported application', operation_id: 'op-import',
    source: { url: 'https://github.com/team/app', branch: 'main', depth: 25 },
  });
  assert.equal(result.status, 'importing');
  assert.equal(result.commit, null);
  assert.equal(result.tree, null);
  assert.ok(result.remote.startsWith('https:'));
  assert.ok(!JSON.stringify(result).includes('secret'));
  const imported = f.calls.find((call) => call.operation === 'import').input;
  assert.deepEqual(imported.source, {
    url: 'https://github.com/team/app', branch: 'main', depth: 25,
  });
  assert.equal(imported.target.name, 'app');
  assert.ok(imported.target.opts.description.endsWith('[klocgit-operation:op-import]'));
  Object.assign(f.repositories.get('app'), { pending: null, commit: oid('a'), tree: oid('b') });
  const ready = await f.adapter.repositoryInfo({ id: 'app', ref });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.operation_id, 'op-import');
  await assert.rejects(f.adapter.repositoryImport({
    id: 'wrong-branch', ref, operation_id: 'op-wrong',
    source: { url: 'https://github.com/team/app', branch: 'other' },
  }), { code: 'IMPORT_REF_MISMATCH' });
});

test('Artifacts fork detects a source move instead of claiming the cached baseline', async () => {
  const f = artifactsFixture();
  await f.adapter.repositoryCreate({ id: 'app', ref, operation_id: 'op-create' });
  Object.assign(f.repositories.get('app'), { commit: oid('a'), tree: oid('b') });
  const source = { repo_id: 'app', ref, commit: oid('a'), tree: oid('b') };
  const result = await f.adapter.repositoryFork({
    id: 'future', source, operation_id: 'op-fork',
  });
  assert.equal(result.commit, source.commit);
  assert.equal(result.tree, source.tree);
  assert.equal(result.operation_id, 'op-fork');
  assert.ok(!JSON.stringify(result).includes('secret'));
  f.binding.beforeFork = (value) => { value.commit = oid('c'); value.tree = oid('d'); };
  await assert.rejects(f.adapter.repositoryFork({
    id: 'raced-future', source, operation_id: 'op-raced',
  }), { code: 'FORK_BASELINE_CHANGED' });
  // Failed semantic registration does not erase ordinary Git work.
  assert.ok(f.repositories.has('raced-future'));
  assert.equal((await f.adapter.repositoryInfo({ id: 'raced-future', ref })).commit, oid('c'));
});

test('Artifacts empty sources cannot be forked as a ready future', async () => {
  const f = artifactsFixture();
  await f.adapter.repositoryCreate({ id: 'app', ref, operation_id: 'op-create' });
  await assert.rejects(f.adapter.repositoryFork({
    id: 'future', source: { repo_id: 'app', ref, commit: oid('a'), tree: oid('b') },
    operation_id: 'op-fork',
  }), { code: 'REPO_NOT_READY' });
  assert.equal(f.calls.filter((call) => call.operation === 'fork').length, 0);
});

async function localFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-repositories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new LocalGit(root, options);
  return { root, adapter };
}

async function initialPush(f, id = 'app') {
  const result = await f.adapter.repositoryCreate({ id, ref, operation_id: 'op-' + id });
  const work = path.join(f.root, id + '-client');
  await git(f.root, ['clone', '--quiet', result.remote, work]);
  await writeFile(path.join(work, 'README.md'), 'Ordinary application\n');
  await git(work, ['add', 'README.md']);
  await git(work, ['commit', '--quiet', '-m', 'Initial application']);
  await git(work, ['push', '--quiet', result.remote, 'HEAD:' + ref]);
  return { work, observed: await f.adapter.repositoryInfo({ id, ref }) };
}

test('local create supports an ordinary Git clone, initial push and later clone without coordination metadata', async (t) => {
  const f = await localFixture(t);
  const empty = await f.adapter.repositoryCreate({ id: 'empty', ref, operation_id: 'op-empty' });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.commit, null);
  assert.equal(empty.tree, null);
  assert.equal(empty.operation_id, 'op-empty');
  await assert.rejects(f.adapter.repositoryInfo({ id: 'absent', ref }), { code: 'REPO_NOT_FOUND' });
  const { observed } = await initialPush(f);
  assert.equal(observed.status, 'ready');
  assert.match(observed.commit, /^[a-f0-9]{40}$/);
  assert.match(observed.tree, /^[a-f0-9]{40}$/);
  const exported = path.join(f.root, 'ordinary-clone');
  await git(f.root, ['clone', '--quiet', observed.remote, exported]);
  assert.equal(await readFile(path.join(exported, 'README.md'), 'utf8'), 'Ordinary application\n');
  assert.equal(await git(exported, ['rev-parse', 'HEAD']), observed.commit);
});

test('local fork fetches the immutable baseline even when the source ref advances during transfer', async (t) => {
  const f = await localFixture(t);
  const { observed } = await initialPush(f);
  const source = { repo_id: 'app', ref, commit: observed.commit, tree: observed.tree };
  const original = f.adapter.runRepositoryGit.bind(f.adapter);
  let moved = false;
  f.adapter.runRepositoryGit = async (cwd, args) => {
    if (!moved && args[0] === 'fetch') {
      moved = true;
      const directory = f.adapter.dir({ id: 'app' });
      const next = await git(directory, ['commit-tree', observed.tree, '-p', observed.commit, '-m', 'External source advance']);
      await git(directory, ['update-ref', ref, next, observed.commit]);
    }
    return original(cwd, args);
  };
  const future = await f.adapter.repositoryFork({
    id: 'future', source, operation_id: 'op-future',
  });
  assert.equal(moved, true);
  assert.equal(future.commit, observed.commit);
  assert.equal(future.tree, observed.tree);
  assert.equal(future.operation_id, 'op-future');
  assert.notEqual((await f.adapter.repositoryInfo({ id: 'app', ref })).commit, future.commit);
  const clone = path.join(f.root, 'future-client');
  await git(f.root, ['clone', '--quiet', future.remote, clone]);
  assert.equal(await git(clone, ['rev-parse', 'HEAD']), observed.commit);
});

test('local storage absence, incomplete initialization and symlink targets are not empty repositories', async (t) => {
  const f = await localFixture(t);
  await assert.rejects(f.adapter.repositoryInfo({ id: 'absent', ref }), { code: 'REPO_NOT_FOUND' });
  await mkdir(f.adapter.dir({ id: 'incomplete' }), { recursive: true });
  await assert.rejects(f.adapter.repositoryInfo({ id: 'incomplete', ref }), { code: 'REPO_UNAVAILABLE' });
  await symlink(f.adapter.dir({ id: 'incomplete' }), f.adapter.dir({ id: 'symlink' }));
  await assert.rejects(f.adapter.repositoryInfo({ id: 'symlink', ref }), { code: 'REPO_UNAVAILABLE' });
});

test('local duplicate create never overwrites an existing operation or Git head', async (t) => {
  const f = await localFixture(t);
  const { observed } = await initialPush(f);
  await assert.rejects(f.adapter.repositoryCreate({
    id: 'app', ref, operation_id: 'op-other',
  }), { code: 'REPO_EXISTS' });
  const current = await f.adapter.repositoryInfo({ id: 'app', ref });
  assert.equal(current.commit, observed.commit);
  assert.equal(current.operation_id, 'op-app');
});

test('DNS public-address checks reject mixed private answers and pin the accepted answer', async () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '2002:7f00:1::1', '255.255.255.255',
  ]) assert.equal(publicImportAddress(address), false, address);
  const source = repositoryImportSource({ url: 'https://github.com/team/app' });
  await assert.rejects(resolveImportSource(source, async () => [
    { address: '140.82.112.3', family: 4 },
    { address: 'fd00::1', family: 6 },
  ]), { code: 'IMPORT_SOURCE_NOT_PUBLIC' });
  const accepted = await resolveImportSource(source, async () => [
    { address: '140.82.112.3', family: 4 },
  ]);
  assert.equal(accepted, '140.82.112.3');
  const command = publicImportCommand(source, accepted);
  assert.ok(command.args.includes('http.curloptResolve=github.com:443:140.82.112.3'));
  assert.ok(command.args.includes('http.followRedirects=false'));
  assert.ok(command.args.includes('protocol.allow=never'));
  assert.ok(command.args.includes('protocol.https.allow=always'));
  assert.ok(command.args.includes('credential.helper='));
  assert.ok(command.args.includes('--fsize=134217728'));
  assert.ok(command.args.includes('--cpu=30'));
  assert.ok(command.args.includes('--as=805306368'));
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_ASKPASS', 'HTTPS_PROXY', 'HOME', 'GIT_BRIDGE_TOKEN', 'GITHUB_TOKEN'])
    assert.equal(command.env[key], undefined, key);
});

test('local import materializes real Git objects without trusting a producer-supplied command or source credential', async (t) => {
  const f = await localFixture(t);
  const { observed } = await initialPush(f);
  let transfer;
  f.adapter.repositoryOptions = {
    resolveImportHost: async () => [{ address: '140.82.112.3', family: 4 }],
    fetchPublicRepository: async (target, source, address) => {
      transfer = { source, address };
      // Only the HTTPS boundary is substituted; object transfer uses actual Git.
      await git(target, ['fetch', '--quiet', f.adapter.dir({ id: 'app' }), ref]);
    },
  };
  const imported = await f.adapter.repositoryImport({
    id: 'imported', ref, operation_id: 'op-imported',
    source: { url: 'https://github.com/team/app', branch: 'main', depth: 10 },
  });
  assert.equal(imported.commit, observed.commit);
  assert.equal(imported.tree, observed.tree);
  assert.equal(imported.operation_id, 'op-imported');
  assert.equal(transfer.address, '140.82.112.3');
  assert.deepEqual(transfer.source, {
    url: 'https://github.com/team/app', branch: 'main', depth: 10,
  });
  const clone = path.join(f.root, 'imported-client');
  await git(f.root, ['clone', '--quiet', imported.remote, clone]);
  assert.equal(await git(clone, ['rev-parse', 'HEAD']), observed.commit);
});

test('local import rejects mixed private DNS before creating repository storage', async (t) => {
  const f = await localFixture(t, {
    resolveImportHost: async () => [
      { address: '140.82.112.3', family: 4 }, { address: '10.0.0.1', family: 4 },
    ],
    fetchPublicRepository: async () => { throw new Error('must not execute'); },
  });
  await assert.rejects(f.adapter.repositoryImport({
    id: 'unsafe', ref, operation_id: 'op-unsafe',
    source: { url: 'https://github.com/team/app' },
  }), { code: 'IMPORT_SOURCE_NOT_PUBLIC' });
  await assert.rejects(f.adapter.repositoryInfo({ id: 'unsafe', ref }), { code: 'REPO_NOT_FOUND' });
});

test('failed local import preserves inspectable ownership rather than retrying or fabricating ready state', async (t) => {
  const f = await localFixture(t, {
    resolveImportHost: async () => [{ address: '140.82.112.3', family: 4 }],
    fetchPublicRepository: async () => { throw new DomainError('IMPORT_FETCH_FAILED', 'Transport stopped', 422); },
  });
  await assert.rejects(f.adapter.repositoryImport({
    id: 'pending', ref, operation_id: 'op-pending',
    source: { url: 'https://github.com/team/app' },
  }), { code: 'IMPORT_FETCH_FAILED' });
  const inspected = await f.adapter.repositoryInfo({ id: 'pending', ref });
  assert.equal(inspected.operation_id, 'op-pending');
  assert.equal(inspected.status, 'empty');
  assert.equal(inspected.commit, null);
});

test('actual Git public-import transport refuses redirects and inherited credentials', async (t) => {
  const f = await localFixture(t);
  await f.adapter.repositoryCreate({ id: 'target', ref, operation_id: 'op-target' });
  const keyPath = path.join(f.root, 'test-key.pem');
  const certificatePath = path.join(f.root, 'test-certificate.pem');
  const execute = promisify(execFile);
  await execute('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certificatePath, '-subj', '/CN=github.com',
    '-addext', 'subjectAltName=DNS:github.com',
  ], { timeout: 10000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin' } });
  let privateRequests = 0;
  const privateServer = http.createServer((request, response) => {
    privateRequests++;
    response.end('must not reach private endpoint');
  });
  await new Promise((resolve) => privateServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => privateServer.close(resolve)));
  const authorization = [];
  let publicRequests = 0;
  const forge = https.createServer({
    key: await readFile(keyPath), cert: await readFile(certificatePath),
  }, (request, response) => {
    publicRequests++;
    authorization.push(request.headers.authorization);
    response.writeHead(302, {
      Location: 'http://127.0.0.1:' + privateServer.address().port + '/private',
    });
    response.end();
  });
  await new Promise((resolve) => forge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => forge.close(resolve)));
  const port = forge.address().port;
  const transport = publicImportCommand(repositoryImportSource({
    url: 'https://github.com/team/app',
  }), '140.82.112.3');
  // Substitute only the network destination and CA for this local TLS fixture.
  // Redirect policy, protocol gates, limits and credential-free env are real.
  const args = transport.args.map((argument) => {
    if (argument.startsWith('http.curloptResolve='))
      return 'http.curloptResolve=github.com:' + port + ':127.0.0.1';
    if (argument === 'https://github.com/team/app')
      return 'https://github.com:' + port + '/team/app';
    return argument;
  });
  const prior = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
  process.env.GIT_CONFIG_VALUE_0 = 'Authorization: Bearer inherited-canonical-secret';
  t.after(() => {
    for (const [variable, value] of [
      ['GIT_CONFIG_COUNT', prior.count],
      ['GIT_CONFIG_KEY_0', prior.key],
      ['GIT_CONFIG_VALUE_0', prior.value],
    ]) {
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
  });
  await assert.rejects(execute(transport.command, args, {
    cwd: f.adapter.dir({ id: 'target' }),
    env: { ...transport.env, GIT_SSL_CAINFO: certificatePath },
    timeout: 10000, maxBuffer: 65536,
  }));
  assert.equal(publicRequests, 1);
  assert.deepEqual(authorization, [undefined]);
  assert.equal(privateRequests, 0);
});
