import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localConfiguration, executorAddress } from '../adapters/local/config.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));

test('local configuration preserves documented defaults and the supplied actor', () => {
  assert.deepEqual(localConfiguration({ LOCAL_ACTOR_ID: 'developer' }, project), {
    root: path.join(project, '.klocgit-workspace'),
    actor: 'developer',
    ownerToken: undefined,
    host: '127.0.0.1',
    port: 43187,
  });
  assert.deepEqual(executorAddress({}), { host: '127.0.0.1', port: 8788 });
});

test('explicit roots and credentials remain local adapter configuration', () => {
  const config = localConfiguration(
    {
      LOCAL_ACTOR_ID: 'developer',
      LOCAL_OWNER_TOKEN: 'private-test-credential',
      KLOCGIT_ROOT: 'custom-workspace',
      HOST: 'localhost',
      PORT: '43189',
    },
    project,
  );
  assert.equal(config.root, path.resolve('custom-workspace'));
  assert.equal(config.ownerToken, 'private-test-credential');
  assert.equal(config.port, 43189);
  assert.equal(config.host, 'localhost');
  assert.equal(Object.isFrozen(config), true);
});

test('zero remains an intentional OS-assigned port and boundary ports are accepted', () => {
  for (const port of ['0', '1', '65535']) {
    assert.equal(
      localConfiguration({ LOCAL_ACTOR_ID: 'developer', PORT: port }, project).port,
      Number(port),
    );
    assert.equal(executorAddress({ GIT_EXECUTOR_PORT: port }).port, Number(port));
  }
});

test('malformed ports fail without including the supplied value or credentials', () => {
  for (const port of ['', ' ', 'NaN', '-1', '65536', '1.5', '1e3', 'secret-port', null]) {
    for (const load of [
      () => localConfiguration({ LOCAL_ACTOR_ID: 'developer', PORT: port }, project),
      () => executorAddress({ GIT_EXECUTOR_PORT: port }),
    ]) {
      assert.throws(load, (error) => {
        assert.equal(error.code, 'INVALID_CONFIGURATION');
        assert.equal(error.status, 503);
        assert.ok(!error.message.includes('secret-port'));
        return true;
      });
    }
  }
});

test('absent and blank development identity retain the existing failure code', () => {
  for (const actor of [undefined, '', ' ', null]) {
    assert.throws(() => localConfiguration({ LOCAL_ACTOR_ID: actor }, project), {
      code: 'ACTOR_NOT_CONFIGURED',
      status: 503,
    });
  }
});

test('explicit blank hosts and workspace paths are not replaced with defaults', () => {
  for (const value of ['', ' ', null]) {
    assert.throws(
      () => localConfiguration({ LOCAL_ACTOR_ID: 'developer', HOST: value }, project),
      { code: 'INVALID_CONFIGURATION' },
    );
    assert.throws(
      () => localConfiguration({ LOCAL_ACTOR_ID: 'developer', KLOCGIT_ROOT: value }, project),
      { code: 'INVALID_CONFIGURATION' },
    );
    assert.throws(() => executorAddress({ GIT_EXECUTOR_HOST: value }), {
      code: 'INVALID_CONFIGURATION',
    });
  }
});

test('invalid local startup cannot create workspace files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'klocgit-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'must-not-exist');
  await assert.rejects(
    exec(process.execPath, ['server/local.mjs'], {
      cwd: project,
      env: {
        ...process.env,
        LOCAL_ACTOR_ID: 'config-test',
        LOCAL_OWNER_TOKEN: 'private-startup-test-credential',
        KLOCGIT_ROOT: root,
        PORT: 'invalid-port',
      },
      timeout: 10000,
    }),
    (error) => {
      assert.match(error.stderr, /INVALID_CONFIGURATION/);
      assert.ok(!error.stderr.includes('private-startup-test-credential'));
      return true;
    },
  );
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('invalid executor port is rejected before attempting manifest access', async () => {
  await assert.rejects(
    exec(process.execPath, ['server/bridge.mjs'], {
      cwd: project,
      env: {
        ...process.env,
        GIT_EXECUTOR_MANIFEST: path.join(tmpdir(), 'missing-klocgit-manifest.json'),
        GIT_BRIDGE_TOKEN: 'private-bridge-test-credential',
        GIT_EXECUTOR_PORT: 'invalid-port',
      },
      timeout: 10000,
    }),
    (error) => {
      assert.match(error.stderr, /INVALID_CONFIGURATION/);
      assert.doesNotMatch(error.stderr, /ENOENT/);
      assert.ok(!error.stderr.includes('private-bridge-test-credential'));
      return true;
    },
  );
});
