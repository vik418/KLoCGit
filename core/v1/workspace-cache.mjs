/** Bounded, rebuildable object cache. A hit never certifies content identity. */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';

export function workspaceCachePolicy(input) {
  const policy = copyJsonData(input);
  assertSchemaVersion(policy);
  if (
    Object.keys(policy).length !== 4 ||
    ['max_entries', 'max_bytes', 'ttl_ms'].some(
      (key) => !Number.isSafeInteger(policy[key]) || policy[key] < 0,
    )
  )
    throw new V1Error('INVALID_ARGUMENT');
  return Object.freeze(policy);
}

export class NoWorkspaceCache {
  async get() {
    return null;
  }
  async put() {}
}

export class BoundedWorkspaceCache {
  #entries = new Map();
  #bytes = 0;
  #evictions = 0;
  #expirations = 0;

  constructor({ policy, now = () => performance.now() }) {
    if (typeof now !== 'function') throw new V1Error('INVALID_ARGUMENT');
    this.policy = workspaceCachePolicy(policy);
    this.now = now;
  }

  #remove(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#bytes -= entry.bytes.length;
    this.#entries.delete(key);
  }

  #expire() {
    const now = this.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expires_at <= now) {
        this.#remove(key);
        this.#expirations += 1;
      }
    }
  }

  async get(key) {
    this.#expire();
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.bytes.slice();
  }

  async put(key, input) {
    if (typeof key !== 'string' || !key || !(input instanceof Uint8Array))
      throw new V1Error('INVALID_ARGUMENT');
    this.#expire();
    this.#remove(key);
    const { max_entries, max_bytes, ttl_ms } = this.policy;
    // Oversized objects are served from the provider without being retained.
    if (!max_entries || !max_bytes || !ttl_ms || input.length > max_bytes) return;
    while (this.#entries.size >= max_entries || this.#bytes + input.length > max_bytes) {
      this.#remove(this.#entries.keys().next().value);
      this.#evictions += 1;
    }
    const bytes = input.slice();
    this.#entries.set(key, { bytes, expires_at: this.now() + ttl_ms });
    this.#bytes += bytes.length;
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }

  stats() {
    this.#expire();
    return Object.freeze({
      schema_version: 1,
      entries: this.#entries.size,
      payload_bytes: this.#bytes,
      evictions: this.#evictions,
      expirations: this.#expirations,
      retention_class: 'REBUILDABLE',
    });
  }
}
