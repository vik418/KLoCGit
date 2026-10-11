/** Tests compile trusted helper code and pass producer files exclusively as JSON. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const helperDirectory = fileURLToPath(new URL('../../../adapters/analysis/go/', import.meta.url));
const runners = new Map();

export async function goTestRunner(version) {
  if (!runners.has(version)) {
    runners.set(version, build(version));
  }
  return runners.get(version);
}

async function build(version) {
  const compiler =
    process.env[`KLOCGIT_GO_${version.replaceAll('.', '_')}`] ??
    join(
      process.env.KLOCGIT_GO_TOOLCHAIN_ROOT ?? '/tmp/klocgit-go-toolchain',
      `go${version}`,
      'go/bin/go',
    );
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-go-test-'));
  const env = {
    PATH: `${dirname(compiler)}:/usr/bin:/bin`,
    GOROOT: dirname(dirname(compiler)),
    GOCACHE: join(directory, 'cache'),
    GOPATH: join(directory, 'empty-dependency-cache'),
    GOENV: 'off',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    GOOS: 'linux',
    GOARCH: 'amd64',
    CGO_ENABLED: '0',
  };
  try {
    const described = await execute(compiler, ['version'], { env, timeout: 10_000 });
    assert.match(
      described.stdout,
      new RegExp(`^go version go${version.replaceAll('.', '\\.')} linux/amd64\\s*$`),
    );
    const binary = join(directory, 'go-semantic');
    await execute(compiler, ['build', '-trimpath', '-o', binary, '.'], {
      cwd: helperDirectory,
      env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      run: async (request) => {
        // execFile's stdin is supplied explicitly: no producer path becomes an
        // executable, argument, environment variable or host filesystem file.
        const child = execFile(binary, [], { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        const completed = new Promise((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(`Trusted Go helper failed (${code}): ${stderr}`));
            else {
              try {
                resolve(JSON.parse(stdout));
              } catch (error) {
                reject(error);
              }
            }
          });
        });
        child.stdin.end(JSON.stringify(request));
        return completed;
      },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `Go ${version} corpus requires its pinned official compiler. Set KLOCGIT_GO_TOOLCHAIN_ROOT or KLOCGIT_GO_${version.replaceAll('.', '_')}.`,
      { cause: error },
    );
  }
}
