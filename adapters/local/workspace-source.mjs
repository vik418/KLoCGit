/** Read-only local Git object transport; it creates neither clones nor Git objects. */
import { execFile } from 'node:child_process';
import { protectedGitArguments } from '../../server/git.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';
import { gitOid } from '../../core/v1/domain.mjs';
import { WorkspaceSource } from '../../core/v1/workspace.mjs';

// In particular, inherited credentials, alternates, SSH commands, Git config,
// replacement objects, and lazy promisor fetches cannot enter this reader.
const environment = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
});

export class LocalGitObjectProvider {
  constructor({ adapter, repository, max_object_bytes = 16 * 1024 * 1024 }) {
    if (
      typeof adapter?.dir !== 'function' ||
      typeof repository?.id !== 'string' ||
      !Number.isSafeInteger(max_object_bytes) ||
      max_object_bytes < 1
    )
      throw new V1Error('INVALID_ARGUMENT');
    this.adapter = adapter;
    this.repository = Object.freeze({ ...repository });
    this.max_object_bytes = max_object_bytes;
  }

  async readObject({ repo_id, oid, kind }) {
    if (repo_id !== this.repository.id) throw new V1Error('FORBIDDEN');
    gitOid(oid);
    if (!['commit', 'tree', 'blob'].includes(kind)) throw new V1Error('INVALID_ARGUMENT');
    let output;
    try {
      output = await new Promise((resolve, reject) => {
        const child = execFile(
          '/usr/bin/git',
          [
            ...protectedGitArguments,
            '--no-replace-objects',
            '--no-lazy-fetch',
            'cat-file',
            '--batch',
          ],
          {
            cwd: this.adapter.dir(this.repository),
            env: environment,
            encoding: 'buffer',
            timeout: 30000,
            maxBuffer: this.max_object_bytes + 256,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin.end(oid + '\n');
      });
    } catch {
      return { status: 'UNAVAILABLE', bytes_transferred: 0 };
    }
    const newline = output.indexOf(10);
    const header = output.subarray(0, newline).toString('ascii');
    if (header === oid + ' missing') return { status: 'MISSING', bytes_transferred: 0 };
    const [actualOid, actualKind, sizeText] = header.split(' ');
    const size = Number(sizeText);
    if (
      newline < 0 ||
      actualOid !== oid ||
      actualKind !== kind ||
      !/^\d+$/.test(sizeText ?? '') ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      output.length !== newline + 1 + size + 1 ||
      output.at(-1) !== 10
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    if (size > this.max_object_bytes) return { status: 'UNAVAILABLE', bytes_transferred: size };
    // Counter boundary: exact object payload read from the local source into
    // the workspace. It does not claim network or total disk read accounting.
    return {
      status: 'AVAILABLE',
      bytes: new Uint8Array(output.subarray(newline + 1, newline + 1 + size)),
      bytes_transferred: size,
    };
  }
}

export class LocalWorkspaceSource extends WorkspaceSource {
  constructor(options) {
    const provider = new LocalGitObjectProvider(options);
    super({ repo_id: options.repository.id, provider, cache: options.cache });
  }
}
