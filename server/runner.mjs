import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {hash, DomainError} from '../core/hash.mjs';

const exec = promisify(execFile);
const supervisor = fileURLToPath(new URL('../fixtures/trusted/supervisor.mjs', import.meta.url));
const cleanGitEnvironment = {LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'};
const MAX_FILES = 128, MAX_BLOB_BYTES = 1024 * 1024, MAX_TREE_BYTES = 4 * 1024 * 1024;
const limitations = ['Validation was unavailable; no positive behavioral claim is established.'];

async function git(repository, args, binary = false) {
  return (await exec('/usr/bin/git', ['--no-pager', '-C', repository, ...args], {
    env: cleanGitEnvironment, encoding: binary ? 'buffer' : 'utf8', maxBuffer: MAX_TREE_BYTES, timeout: 3000
  })).stdout;
}

export async function applicationValidationConfigHash() {
  return hash({runner: 'sandboxed-checkout-http-v1', sources: await Promise.all([
    readFile(fileURLToPath(import.meta.url), 'utf8'), readFile(supervisor, 'utf8')
  ]), limits: {files: MAX_FILES, blobBytes: MAX_BLOB_BYTES, treeBytes: MAX_TREE_BYTES, timeoutMs: 8000,
    cpuSeconds: 5, addressSpaceBytes: 2147483648, openFiles: 128, outputBytes: 65536},
  isolation: 'bubblewrap-private-network-readonly-tree-node-permissions'});
}

/** Extract immutable blobs without Git hooks, archives, symlinks or repo scripts. */
export async function materializeGitTree(repository, commit, destination) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new DomainError('INVALID_COMMIT', 'A full immutable commit or tree hash is required');
  const tree = (await git(repository, ['rev-parse', '--verify', `${commit}^{tree}`])).trim();
  const entries = (await git(repository, ['ls-tree', '-rz', tree], true)).toString('utf8').split('\0').filter(Boolean);
  if (entries.length > MAX_FILES) throw new DomainError('VALIDATION_TREE_LIMIT', 'Candidate exceeds the 128-file validation limit', 422);
  await mkdir(destination, {recursive: true});
  let totalBytes = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new DomainError('UNSAFE_TREE_ENTRY', 'Symlinks, submodules and special tree entries are not executed', 422);
    const [, , object, filename] = match;
    const parts = filename.split('/');
    if (path.isAbsolute(filename) || filename.includes('\\') || parts.some(part => !part || part === '.' || part === '..')) {
      throw new DomainError('UNSAFE_TREE_PATH', 'Candidate tree contains an unsafe path', 422);
    }
    const size = Number((await git(repository, ['cat-file', '-s', object])).trim());
    if (!Number.isSafeInteger(size) || size > MAX_BLOB_BYTES || (totalBytes += size) > MAX_TREE_BYTES) {
      throw new DomainError('VALIDATION_TREE_LIMIT', 'Candidate exceeds the bounded validation byte limit', 422);
    }
    const target = path.join(destination, filename);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, await git(repository, ['cat-file', 'blob', object], true), {mode: 0o400, flag: 'wx'});
  }
  return {tree, files: entries.length, bytes: totalBytes};
}

async function sandbox(candidateDirectory) {
  const runtimeNode = await realpath(process.execPath);
  // The entire HTTP test runs inside its own loopback-only network namespace.
  // It cannot connect to the host or Internet, and sees no host credential paths.
  const arguments_ = [
    '--as=2147483648', '--cpu=5', '--nofile=128', '--fsize=1048576', '--', '/usr/bin/bwrap',
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--uid', '0', '--gid', '0', '--clearenv',
    '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--dir', '/runtime', '--ro-bind', runtimeNode, '/runtime/node',
    '--ro-bind', candidateDirectory, '/candidate', '--dir', '/trusted',
    '--ro-bind', supervisor, '/trusted/supervisor.mjs', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--chdir', '/candidate', '--', '/runtime/node',
    '--max-old-space-size=64', '--max-semi-space-size=4', '/trusted/supervisor.mjs'
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/prlimit', arguments_, {env: {LANG: 'C.UTF-8', TZ: 'UTC'}, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', outputBytes = 0, completed = false;
    function stop() {try {process.kill(-child.pid, 'SIGKILL');} catch {}}
    const timer = setTimeout(() => {stop(); finish(new Error('Sandbox exceeded the 8-second wall-time limit'));}, 8000);
    function finish(error, result) {
      if (completed) return;
      completed = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    child.on('error', error => finish(error));
    function capture(chunk, stream) {
      outputBytes += chunk.length;
      if (outputBytes > 65536) {stop(); finish(new Error('Sandbox exceeded the 64 KiB output limit')); return;}
      if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    }
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    child.on('close', code => {
      if (code !== 0) return finish(new Error(`Sandbox unavailable or failed (exit ${code}): ${stderr.slice(0, 300)}`));
      try {
        const result = JSON.parse(stdout.trim());
        if (typeof result.passed !== 'boolean' || !Array.isArray(result.checks)) throw new Error('Missing trusted validation fields');
        finish(null, result);
      } catch {finish(new Error('Trusted sandbox did not return a valid result'));}
    });
  });
}

export class ApplicationRunner {
  constructor({repositoryPath, policyRepositoryPath = null, policyCommit = null}) {
    this.repositoryPath = repositoryPath; this.policyRepositoryPath = policyRepositoryPath;
    this.policyCommit = policyCommit; this.configHash = '';
  }
  async init() {this.configHash = await applicationValidationConfigHash(); return this;}
  async validate(commit, {policyCommit = this.policyCommit} = {}) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'decision-http-validation-'));
    try {
      const candidate = path.join(temporary, 'candidate');
      const facts = await materializeGitTree(this.repositoryPath, commit, candidate);
      let policy = null;
      if (this.policyRepositoryPath && policyCommit) {
        const policyFacts = await materializeGitTree(this.policyRepositoryPath, policyCommit, path.join(temporary, 'policy'));
        const contract = JSON.parse(await readFile(path.join(temporary, 'policy/checkout-policy.json'), 'utf8'));
        if (contract.check_ref !== 'platform:lost-response-exactly-once-v1' || contract.maxChargesPerOrder !== 1 || contract.maxConfirmationsPerOrder !== 1) {
          throw new DomainError('POLICY_NOT_SUPPORTED', 'Pinned policy does not match the finite platform-owned validation suite', 422);
        }
        policy = {commit: policyCommit, tree: policyFacts.tree, file: 'checkout-policy.json', id: contract.id, version: contract.version};
      }
      const result = await sandbox(candidate);
      return {...result, config_hash: this.configHash || await applicationValidationConfigHash(), tree_hash: facts.tree,
        policy, isolation: {network: 'private-loopback-only', filesystem: 'readonly-candidate-and-runtime', environment: 'scrubbed',
          producerTestsExecuted: false, wallTimeLimitMs: 8000, candidateHeapLimitMb: 64}};
    } catch (error) {
      return {passed: false, status: 'validation-unavailable', checks: [{name: 'Trusted isolated validation is available', passed: false,
        detail: String(error.message).slice(0, 500)}], scope: ['client/retry.mjs', 'server/charge.mjs'],
        config_hash: this.configHash || await applicationValidationConfigHash(), limitations};
    } finally {await rm(temporary, {recursive: true, force: true});}
  }
}
export async function createApplicationRunner(options) {return new ApplicationRunner(options).init();}
