import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '../core/hash.mjs';
import {
  repositoryDescription,
  repositoryId,
  repositoryImportSource,
  repositoryObjectId,
  repositoryOperationId,
  repositoryRef,
  RepositoryPreflightError,
  verifyForkState,
} from '../core/repository-input.mjs';

const importByteLimit = 128 * 1024 * 1024;
const markerName = 'klocgit-operation';

function directory(adapter, id) {
  return adapter.dir({ id: repositoryId(id) });
}

async function inspectDirectory(adapter, id) {
  const target = directory(adapter, id);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new DomainError(
        'REPO_UNAVAILABLE',
        'Repository storage must be an ordinary directory',
        503,
      );
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new DomainError('REPO_NOT_FOUND', 'Local repository does not exist', 404);
    throw error;
  }
  try {
    if ((await adapter.runRepositoryGit(target, ['rev-parse', '--is-bare-repository'])) !== 'true')
      throw new Error();
  } catch {
    throw new DomainError(
      'REPO_UNAVAILABLE',
      'Repository initialization requires reconciliation',
      503,
    );
  }
  return target;
}

async function initializeRepository(adapter, input) {
  const id = repositoryId(input.id);
  const ref = repositoryRef(input.ref);
  repositoryDescription(input.description);
  const operationId = repositoryOperationId(input.operation_id);
  const target = directory(adapter, id);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new DomainError('REPO_EXISTS', 'Local repository already exists', 409);
    throw error;
  }
  // Ownership precedes initialization. A crash leaves inspectable storage, and
  // recovery cannot adopt another same-name repository as this operation's work.
  await writeFile(path.join(target, markerName), operationId + '\n', { flag: 'wx', mode: 0o600 });
  await adapter.runRepositoryGit(target, [
    'init',
    '--bare',
    '--quiet',
    '--initial-branch=' + ref.slice(11),
  ]);
  return { id, ref, target };
}

export async function localRepositoryInfo(adapter, input) {
  const id = repositoryId(input.id);
  const ref = repositoryRef(input.ref);
  const target = await inspectDirectory(adapter, id);
  let operationId = null;
  try {
    const marker = await lstat(path.join(target, markerName));
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 161)
      throw new DomainError(
        'REPO_UNAVAILABLE',
        'Repository ownership requires reconciliation',
        503,
      );
    operationId = repositoryOperationId(
      (await readFile(path.join(target, markerName), 'utf8')).trim(),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let commit = null;
  try {
    // --quiet gives exit 1 for absence; plain --verify may report exit 128.
    await adapter.runRepositoryGit(target, ['show-ref', '--verify', '--quiet', ref]);
    commit = repositoryObjectId(
      await adapter.runRepositoryGit(target, ['rev-parse', '--verify', ref + '^{commit}']),
    );
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  const tree = commit
    ? repositoryObjectId(await adapter.runRepositoryGit(target, ['rev-parse', commit + '^{tree}']))
    : null;
  return {
    id,
    provider: 'local-git',
    remote: target,
    ref,
    operation_id: operationId,
    status: commit ? 'ready' : 'empty',
    commit,
    tree,
  };
}

export async function localRepositoryCreate(adapter, input) {
  const { id, ref } = await initializeRepository(adapter, input);
  return localRepositoryInfo(adapter, { id, ref });
}

/**
 * Reject non-public DNS answers, including private AAAA mixed with public A.
 * HTTPS then pins an approved address rather than resolving the host again.
 *
 * @param {string} address Numeric IP address returned by the resolver.
 * @returns {boolean} Whether this address is permitted for a public import.
 */
export function publicImportAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const first = parseInt(address.split(':')[0], 16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !/^2001:(?:0*:|0*db8:)/i.test(address) &&
      !/^2002:/i.test(address)
    );
  }
  return false;
}

export async function resolveImportSource(source, resolver = lookup) {
  const host = new URL(source.url).hostname;
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      resolver(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS timeout')), 5000);
      }),
    ]);
  } catch {
    throw new DomainError(
      'IMPORT_DNS_UNAVAILABLE',
      'Public import host could not be resolved',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
  if (
    !Array.isArray(answers) ||
    !answers.length ||
    answers.some((answer) => !publicImportAddress(answer.address))
  )
    throw new DomainError(
      'IMPORT_SOURCE_NOT_PUBLIC',
      'Import DNS must resolve only to public addresses',
      422,
    );
  return answers[0].address;
}

export function publicImportCommand(source, address) {
  if (!publicImportAddress(address))
    throw new DomainError(
      'IMPORT_SOURCE_NOT_PUBLIC',
      'Import transport requires a public IP address',
      422,
    );
  const host = new URL(source.url).hostname;
  const pinned = isIP(address) === 6 ? '[' + address + ']' : address;
  return {
    command: '/usr/bin/prlimit',
    args: [
      '--fsize=' + importByteLimit,
      '--cpu=30',
      '--as=805306368',
      '--nofile=128',
      '--',
      '/usr/bin/git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'init.templateDir=',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'credential.helper=',
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.curloptResolve=' + host + ':443:' + pinned,
      '-c',
      'http.lowSpeedLimit=1024',
      '-c',
      'http.lowSpeedTime=15',
      '-c',
      'fetch.fsckObjects=true',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=' + source.depth,
      source.url,
      source.branch ?? 'HEAD',
    ],
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

/**
 * Fetch without inherited credentials, redirects, checkout, hooks or additional
 * protocols. Limits cover elapsed time, CPU, address space and each output file;
 * a later scan bounds the total bytes accepted into canonical coordination.
 *
 * @param {string} target Bare destination repository.
 * @param {object} source Validated public source URL, branch and depth.
 * @param {string} address Public DNS answer pinned for this transport.
 * @returns {Promise<void>} Requested Git objects are present in FETCH_HEAD.
 * @throws {DomainError} The bounded TLS transport did not complete.
 */
export async function fetchPublicRepository(target, source, address) {
  const transport = publicImportCommand(source, address);
  let timer;
  let child;
  const stop = () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  };
  try {
    await new Promise((resolve, reject) => {
      // Git starts HTTPS helpers. A separate process group lets the elapsed-time
      // budget terminate the whole transport, not only its parent Git process.
      child = execFile(
        transport.command,
        transport.args,
        {
          cwd: target,
          env: transport.env,
          detached: true,
          maxBuffer: 1024 * 1024,
        },
        (error) => {
          if (error) {
            stop();
            reject(error);
          } else resolve();
        },
      );
      timer = setTimeout(stop, 60000);
    });
  } catch {
    throw new DomainError(
      'IMPORT_FETCH_FAILED',
      'Public import failed within the configured transport limits',
      422,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function checkRepositorySize(target) {
  let bytes = 0;
  let files = 0;
  const pending = [target];
  while (pending.length) {
    const parent = pending.pop();
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (++files > 100000)
        throw new DomainError(
          'IMPORT_SIZE_LIMIT',
          'Imported repository contains too many entries',
          422,
        );
      const name = path.join(parent, entry.name);
      if (entry.isSymbolicLink())
        throw new DomainError(
          'IMPORT_STORAGE_UNSAFE',
          'Imported object storage contains a symlink',
          422,
        );
      if (entry.isDirectory()) pending.push(name);
      else {
        bytes += (await lstat(name)).size;
        if (bytes > importByteLimit)
          throw new DomainError(
            'IMPORT_SIZE_LIMIT',
            'Imported repository exceeds the accepted byte limit',
            422,
          );
      }
    }
  }
}

export async function localRepositoryImport(adapter, input) {
  const source = repositoryImportSource(input.source, adapter.repositoryOptions.importHosts);
  const ref = repositoryRef(input.ref);
  if (source.branch && source.branch !== ref.slice(11))
    throw new DomainError(
      'IMPORT_REF_MISMATCH',
      'Import branch must match the requested repository ref',
      422,
    );
  source.branch = ref.slice(11);
  let address;
  try {
    address = await resolveImportSource(source, adapter.repositoryOptions.resolveImportHost);
  } catch (error) {
    // DNS validation precedes directory creation and starts no Git transport.
    throw new RepositoryPreflightError(error);
  }
  const { id, target } = await initializeRepository(adapter, { ...input, ref });
  const fetcher = adapter.repositoryOptions.fetchPublicRepository ?? fetchPublicRepository;
  await fetcher(target, source, address);
  await checkRepositorySize(target);
  const commit = repositoryObjectId(
    await adapter.runRepositoryGit(target, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']),
  );
  await adapter.runRepositoryGit(target, ['update-ref', ref, commit, '0'.repeat(40)]);
  return localRepositoryInfo(adapter, { id, ref });
}

export async function localRepositoryFork(adapter, input) {
  const source = input.source;
  const sourceId = repositoryId(source?.repo_id);
  const ref = repositoryRef(source?.ref);
  repositoryObjectId(source?.commit);
  repositoryObjectId(source?.tree);
  const observed = await localRepositoryInfo(adapter, { id: sourceId, ref });
  if (observed.status !== 'ready')
    throw new DomainError('REPO_NOT_READY', 'Forking requires an observed initial commit', 409);
  verifyForkState(observed, source);
  const sourceDirectory = directory(adapter, sourceId);
  const { id, target } = await initializeRepository(adapter, { ...input, ref });
  // Fetch the immutable commit, not a moving source ref, even if an ordinary Git
  // writer advances the source after inspection but before object transfer.
  await adapter.runRepositoryGit(target, [
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-recurse-submodules',
    sourceDirectory,
    source.commit,
  ]);
  await adapter.runRepositoryGit(target, ['update-ref', ref, source.commit, '0'.repeat(40)]);
  return verifyForkState(await localRepositoryInfo(adapter, { id, ref }), source);
}
