/** Private local payload storage; object keys never contain caller paths. */
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { V1Error, assertSchemaVersion, assertIdempotencyKey } from '../../core/v1/conventions.mjs';

export class FileObjectStore {
  constructor({ root, max_bytes }) {
    if (!isAbsolute(root) || !Number.isSafeInteger(max_bytes) || max_bytes < 1)
      throw new V1Error('INVALID_ARGUMENT');
    this.root = root;
    this.max_bytes = max_bytes;
  }

  #path(key) {
    if (
      typeof key !== 'string' ||
      !/^[a-f0-9]{64}\/[a-z][a-z0-9-]*-[a-f0-9]{64}-g[1-9][0-9]*$/.test(key)
    )
      throw new V1Error('INVALID_ARGUMENT');
    return join(this.root, key);
  }

  async put({ schema_version, key, bytes, idempotency_key }) {
    assertSchemaVersion({ schema_version });
    assertIdempotencyKey(idempotency_key);
    if (!(bytes instanceof Uint8Array) || bytes.length > this.max_bytes)
      throw new V1Error('INVALID_ARGUMENT');
    const data = bytes.slice();
    const path = this.#path(key),
      temporary = path + '.' + randomUUID();
    try {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch {
      throw new V1Error('PROVIDER_UNAVAILABLE');
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(key) {
    const path = this.#path(key);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.max_bytes) throw new V1Error('INTEGRITY_MISMATCH');
      return new Uint8Array(await handle.readFile());
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof V1Error) throw error;
      throw new V1Error('PROVIDER_UNAVAILABLE');
    } finally {
      await handle?.close();
    }
  }

  async delete({ schema_version, key, idempotency_key }) {
    assertSchemaVersion({ schema_version });
    assertIdempotencyKey(idempotency_key);
    const path = this.#path(key);
    try {
      await rm(path, { force: true });
    } catch {
      throw new V1Error('PROVIDER_UNAVAILABLE');
    }
  }
}
