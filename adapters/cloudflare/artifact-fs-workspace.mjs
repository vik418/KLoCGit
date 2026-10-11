/** ArtifactFS mounts are private hydration sources, never untrusted work directories. */
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readlink, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { V1Error } from '../../core/v1/conventions.mjs';
import { copyJsonData, gitOid, gitRef } from '../../core/v1/domain.mjs';
import { MemoryWorkspaceCache, WorkspaceSource } from '../../core/v1/workspace.mjs';
import { LocalGitObjectProvider } from '../local/workspace-source.mjs';
import { protectedGitArguments } from '../../server/git.mjs';

const networkVariables = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function command(binary, args, env, timeout, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { env, timeout, cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => (error ? reject(new V1Error('PROVIDER_UNAVAILABLE')) : resolve(stdout)),
    );
  });
}

async function boundedFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new V1Error('UNSUPPORTED_CAPABILITY');
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximum) throw new V1Error('UNSUPPORTED_CAPABILITY');
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    await file.close();
  }
}

class ArtifactFSObjects {
  constructor({ repository, directory, mount, files, maximum }) {
    this.reader = new LocalGitObjectProvider({
      adapter: { dir: () => directory },
      repository,
      max_object_bytes: maximum,
    });
    this.files = files;
    this.mount = mount;
    this.maximum = maximum;
  }

  async readObject(request) {
    const local = await this.reader.readObject(request);
    if (local.status !== 'MISSING' || request.kind !== 'blob') return local;
    const file = this.files.get(request.oid);
    if (!file) return local;
    let bytes;
    try {
      bytes =
        file.mode === '120000'
          ? new Uint8Array(await readlink(join(this.mount, file.path), { encoding: 'buffer' }))
          : await boundedFile(join(this.mount, file.path), this.maximum);
      if (bytes.length > this.maximum) return { status: 'UNAVAILABLE', bytes_transferred: 0 };
    } catch {
      return { status: 'UNAVAILABLE', bytes_transferred: 0 };
    }
    // Counter boundary: exact payload delivered from the mounted source/cache.
    // This excludes setup packfiles, network framing and background prefetch.
    return { status: 'AVAILABLE', bytes, bytes_transferred: bytes.length };
  }
}

export class ArtifactFSWorkspaceSource {
  #entries = new Map();
  #closed = false;

  constructor({
    binary,
    root,
    repository,
    prepare_timeout_ms,
    mount_timeout_ms,
    max_object_bytes,
    cache = new MemoryWorkspaceCache(),
  }) {
    const descriptor = copyJsonData(repository);
    valid(isAbsolute(binary) && isAbsolute(root));
    valid(typeof descriptor.id === 'string' && descriptor.id.trim());
    gitRef(descriptor.ref);
    const remote = new URL(descriptor.remote);
    // Configuration comes from an authorized GitStore, not producer metadata.
    // Credential brokers must supply transport outside the mounted work tree.
    valid(
      ['https:', 'file:'].includes(remote.protocol) &&
        !remote.username &&
        !remote.password &&
        !remote.search &&
        !remote.hash,
    );
    for (const value of [prepare_timeout_ms, mount_timeout_ms, max_object_bytes])
      valid(Number.isSafeInteger(value) && value > 0);
    this.binary = binary;
    this.root = root;
    this.repository = Object.freeze(descriptor);
    this.prepare_timeout_ms = prepare_timeout_ms;
    this.mount_timeout_ms = mount_timeout_ms;
    this.max_object_bytes = max_object_bytes;
    this.cache = cache;
    Object.freeze(this);
  }

  async #prepare(commit_oid) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.root, 'source-'));
    const data = join(directory, 'data'),
      mountRoot = join(directory, 'mounts'),
      gitDirectory = join(directory, 'objects.git');
    await mkdir(mountRoot, { mode: 0o700 });
    const env = {
      ...Object.fromEntries(
        networkVariables.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
      ),
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ARTIFACT_FS_ROOT: data,
    };
    const entry = {
      directory,
      mount: join(mountRoot, 'source'),
      daemon: null,
      env,
      source: null,
      acquisition: null,
    };
    try {
      await command(
        this.binary,
        [
          'add-repo',
          '--name',
          'source',
          '--remote',
          this.repository.remote,
          '--ref',
          this.repository.ref,
          '--require-commit',
          commit_oid,
          '--depth',
          '1',
          '--refresh',
          'never',
          '--mount-root',
          mountRoot,
          '--git-dir',
          gitDirectory,
        ],
        env,
        this.prepare_timeout_ms,
      );
      const args = [
        ...protectedGitArguments,
        '--git-dir',
        gitDirectory,
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ];
      const observed = (await command('/usr/bin/git', args, env, this.prepare_timeout_ms))
        .toString('ascii')
        .trim();
      if (observed !== commit_oid) throw new V1Error('INTEGRITY_MISMATCH');
      const inventory = await command(
        '/usr/bin/git',
        [
          ...protectedGitArguments,
          '--no-lazy-fetch',
          '--git-dir',
          gitDirectory,
          'cat-file',
          '--batch-all-objects',
          '--batch-check=%(objecttype) %(objectsize)',
        ],
        env,
        this.prepare_timeout_ms,
      );
      const acquisition = {
        schema_version: 1,
        commit_oid,
        initial_blob_count: 0,
        initial_blob_payload_bytes: 0,
        initial_metadata_payload_bytes: 0,
      };
      for (const line of inventory.toString('ascii').trim().split('\n').filter(Boolean)) {
        const [kind, sizeText] = line.split(' '),
          size = Number(sizeText);
        valid(
          ['blob', 'tree', 'commit', 'tag'].includes(kind) &&
            /^\d+$/.test(sizeText) &&
            Number.isSafeInteger(size),
        );
        if (kind === 'blob') {
          acquisition.initial_blob_count += 1;
          acquisition.initial_blob_payload_bytes += size;
        } else acquisition.initial_metadata_payload_bytes += size;
      }
      entry.acquisition = Object.freeze(acquisition);
      const metadata = await command(
        '/usr/bin/git',
        [
          ...protectedGitArguments,
          '--no-lazy-fetch',
          '--git-dir',
          gitDirectory,
          'ls-tree',
          '-r',
          '-z',
          commit_oid,
        ],
        env,
        this.prepare_timeout_ms,
      );
      const files = new Map();
      for (const line of decoder.decode(metadata).split('\0').filter(Boolean)) {
        const tab = line.indexOf('\t'),
          header = line.slice(0, tab).split(' '),
          path = line.slice(tab + 1);
        valid(tab > 0 && path.split('/').every((part) => part && part !== '.' && part !== '..'));
        if (header[1] !== 'blob') continue;
        gitOid(header[2], commit_oid.length);
        if (!files.has(header[2])) files.set(header[2], { path, mode: header[0] });
      }
      entry.daemon = spawn(
        this.binary,
        ['daemon', '--root', mountRoot, '--hydration-concurrency', '1'],
        { env, stdio: 'ignore' },
      );
      let failed = false;
      entry.daemon.on('error', () => {
        failed = true;
      });
      const deadline = Date.now() + this.mount_timeout_ms;
      for (;;) {
        if (failed || entry.daemon.exitCode !== null) throw new V1Error('UNSUPPORTED_CAPABILITY');
        try {
          await command('/usr/bin/mountpoint', ['-q', entry.mount], env, 1000);
          break;
        } catch {
          if (Date.now() >= deadline) throw new V1Error('UNSUPPORTED_CAPABILITY');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const status = (
        await command(this.binary, ['status', '--name', 'source'], env, 1000)
      ).toString('utf8');
      if (
        !status.includes('required_commit=' + commit_oid + ' ') ||
        !status.includes('base_commit=' + commit_oid + ' ') ||
        !status.includes('acquisition=verified ')
      )
        throw new V1Error('INTEGRITY_MISMATCH');
      entry.source = new WorkspaceSource({
        repo_id: this.repository.id,
        cache: this.cache,
        provider: new ArtifactFSObjects({
          repository: this.repository,
          directory: gitDirectory,
          mount: entry.mount,
          files,
          maximum: this.max_object_bytes,
        }),
      });
      return entry;
    } catch (error) {
      await this.#dispose(entry);
      throw error instanceof V1Error ? error : new V1Error('PROVIDER_UNAVAILABLE');
    }
  }

  async fetch(input, filter = {}) {
    const revision = copyJsonData(input),
      selected = copyJsonData(filter);
    if (this.#closed) throw new V1Error('PROVIDER_UNAVAILABLE');
    if (revision.repo_id !== this.repository.id) throw new V1Error('FORBIDDEN');
    gitOid(revision.commit_oid);
    if (revision.ref && revision.ref !== this.repository.ref) throw new V1Error('FORBIDDEN');
    if (!this.#entries.has(revision.commit_oid)) {
      const preparing = this.#prepare(revision.commit_oid).catch((error) => {
        this.#entries.delete(revision.commit_oid);
        throw error;
      });
      this.#entries.set(revision.commit_oid, preparing);
    }
    const entry = await this.#entries.get(revision.commit_oid);
    if (this.#closed || entry.daemon.exitCode !== null) throw new V1Error('PROVIDER_UNAVAILABLE');
    const workspace = await entry.source.fetch(revision, selected);
    return Object.freeze({ ...workspace, acquisitionMetrics: () => entry.acquisition });
  }

  async #dispose(entry) {
    const daemon = entry.daemon;
    if (daemon && daemon.exitCode === null && daemon.pid) {
      const stopped = new Promise((resolve) => daemon.once('exit', resolve));
      const timer = setTimeout(() => daemon.kill('SIGKILL'), 2000);
      daemon.kill('SIGTERM');
      await stopped;
      clearTimeout(timer);
    }
    try {
      await command('/usr/bin/mountpoint', ['-q', entry.mount], entry.env, 1000);
      await command('/usr/bin/fusermount3', ['-u', '-z', entry.mount], entry.env, 1000);
    } catch {
      /* A stopped daemon normally unmounts its private source itself. */
    }
    // Never traverse a live mount during cleanup.
    let mounted = false;
    try {
      await command('/usr/bin/mountpoint', ['-q', entry.mount], entry.env, 1000);
      mounted = true;
    } catch {
      /* Not mounted. */
    }
    if (!mounted) await rm(entry.directory, { recursive: true, force: true });
  }

  async close() {
    this.#closed = true;
    const entries = await Promise.allSettled(this.#entries.values());
    for (const result of entries)
      if (result.status === 'fulfilled') await this.#dispose(result.value);
    this.#entries.clear();
  }
}
