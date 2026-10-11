/**
 * Exact Git object hydration without provider types or a required full clone.
 * Cache contents and caller-provided cache hints are rebuildable optimizations.
 */
import { V1Error, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData, gitOid } from './domain.mjs';
import { gitSnapshot } from './git-store.mjs';
import { NoWorkspaceCache } from './workspace-cache.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function pathName(path) {
  valid(typeof path === 'string' && path.length > 0 && !path.includes('\0'));
  valid(path.split('/').every((part) => part && part !== '.' && part !== '..'));
  return path;
}

function paths(input) {
  const value = copyJsonData(input);
  valid(Array.isArray(value));
  value.forEach(pathName);
  valid(new Set(value).size === value.length);
  return value.sort();
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function field(record, name) {
  const descriptor = record && Object.getOwnPropertyDescriptor(record, name);
  valid(descriptor && Object.hasOwn(descriptor, 'value'));
  return descriptor.value;
}

/** Git's own object identity, distinct from KLoCGit's domain-separated digests. */
export async function gitObjectOid(kind, input, oid_length = 40) {
  valid(['commit', 'tree', 'blob'].includes(kind));
  valid(input instanceof Uint8Array && [40, 64].includes(oid_length));
  const bytes = input.slice();
  const prefix = encoder.encode(kind + ' ' + bytes.length + '\0');
  const framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix);
  framed.set(bytes, prefix.length);
  const hashed = new Uint8Array(
    await crypto.subtle.digest(oid_length === 40 ? 'SHA-1' : 'SHA-256', framed),
  );
  return [...hashed].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verified(kind, oid, input) {
  if (!(input instanceof Uint8Array)) throw new V1Error('INTEGRITY_MISMATCH');
  const bytes = input.slice();
  if ((await gitObjectOid(kind, bytes, oid.length)) !== oid)
    throw new V1Error('INTEGRITY_MISMATCH');
  return bytes;
}

function commitSnapshot(repo_id, commit_oid, bytes) {
  // Only identity-bearing ASCII headers are interpreted. Author/message text
  // may legitimately use a non-UTF8 encoding and is never executed or trusted.
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const separator = text.indexOf('\n\n');
  if (separator < 0) throw new V1Error('INTEGRITY_MISMATCH');
  const headers = text.slice(0, separator).split('\n');
  const trees = headers.filter((line) => line.startsWith('tree '));
  if (trees.length !== 1 || headers[0] !== trees[0]) throw new V1Error('INTEGRITY_MISMATCH');
  return gitSnapshot({
    schema_version: 1,
    repo_id,
    commit_oid,
    tree_oid: trees[0].slice(5),
    parent_oids: headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
  });
}

function treeEntries(bytes, oid_length) {
  const entries = [];
  const names = new Set();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const nul = bytes.indexOf(0, space + 1);
    const end = nul + 1 + oid_length / 2;
    if (space < offset || nul < space || end > bytes.length)
      throw new V1Error('INTEGRITY_MISMATCH');
    const rawMode = String.fromCharCode(...bytes.slice(offset, space));
    const modes = {
      40000: ['040000', 'tree'],
      100644: ['100644', 'blob'],
      100755: ['100755', 'blob'],
      120000: ['120000', 'blob'],
      160000: ['160000', 'commit'],
    };
    if (!Object.hasOwn(modes, rawMode)) throw new V1Error('UNSUPPORTED_CAPABILITY');
    let name;
    try {
      name = decoder.decode(bytes.slice(space + 1, nul));
    } catch {
      throw new V1Error('UNSUPPORTED_CAPABILITY');
    }
    pathName(name);
    if (name.includes('/') || names.has(name)) throw new V1Error('INTEGRITY_MISMATCH');
    names.add(name);
    const oid = [...bytes.slice(nul + 1, end)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    gitOid(oid, oid_length);
    const [mode, kind] = modes[rawMode];
    entries.push({ name, mode, kind, oid });
    offset = end;
  }
  return entries;
}

function selection(input) {
  const value = copyJsonData(input);
  valid(value && typeof value === 'object' && !Array.isArray(value));
  valid(Object.keys(value).every((key) => ['blobs', 'paths', 'cache_hint'].includes(key)));
  const selected = Object.hasOwn(value, 'paths') ? paths(value.paths) : null;
  const blobs = value.blobs ?? (selected === null ? 'none' : 'selected');
  valid(['none', 'selected', 'all'].includes(blobs));
  valid(blobs !== 'selected' || selected !== null);
  if (Object.hasOwn(value, 'cache_hint')) {
    const hint = value.cache_hint;
    assertSchemaVersion(hint);
    valid(
      Object.keys(hint).length === 5 &&
        ['repo_id', 'commit_oid', 'tree_oid', 'object_oids'].every((key) =>
          Object.hasOwn(hint, key),
        ),
    );
    valid(typeof hint.repo_id === 'string' && hint.repo_id.trim());
    gitOid(hint.commit_oid);
    gitOid(hint.tree_oid, hint.commit_oid.length);
    valid(Array.isArray(hint.object_oids));
    hint.object_oids.forEach((oid) => gitOid(oid, hint.commit_oid.length));
  }
  // Hints never supply identity, completeness, bytes, or proof of a cache hit.
  return { paths: selected, blobs };
}

/**
 * Provider contract: readObject({repo_id,oid,kind}) returns
 * {status:'AVAILABLE',bytes:Uint8Array,bytes_transferred:number}, or
 * {status:'MISSING'|'UNAVAILABLE',bytes_transferred:number}.
 * The counter measures provider payload bytes delivered to this workspace,
 * excluding protocol overhead. A provider must document its transfer boundary.
 */
export class WorkspaceSource {
  constructor({ repo_id, provider, cache = new NoWorkspaceCache() }) {
    valid(typeof repo_id === 'string' && repo_id.trim());
    valid(typeof provider?.readObject === 'function');
    valid(typeof cache?.get === 'function' && typeof cache?.put === 'function');
    this.repo_id = repo_id;
    this.provider = provider;
    this.cache = cache;
  }

  async fetch(input, filter = {}) {
    const revision = copyJsonData(input);
    assertSchemaVersion(revision);
    if (revision.repo_id !== this.repo_id) throw new V1Error('FORBIDDEN');
    gitOid(revision.commit_oid);
    if (Object.hasOwn(revision, 'tree_oid')) gitOid(revision.tree_oid, revision.commit_oid.length);
    const selected = selection(filter);
    const metrics = {
      schema_version: 1,
      bytes_transferred: 0,
      metadata_bytes_transferred: 0,
      blob_bytes_transferred: 0,
      cache_hits: 0,
      cache_misses: 0,
      provider_reads: 0,
    };
    const workspace = new Workspace({ source: this, metrics });
    const commit = await workspace.object(revision.commit_oid, 'commit');
    if (commit.status !== 'AVAILABLE')
      throw new V1Error(commit.status === 'MISSING' ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE');
    workspace.identity = commitSnapshot(this.repo_id, revision.commit_oid, commit.bytes);
    workspace.bindCommit(revision.commit_oid);
    if (
      (revision.tree_oid && revision.tree_oid !== workspace.identity.tree_oid) ||
      (revision.parent_oids &&
        JSON.stringify(revision.parent_oids) !== JSON.stringify(workspace.identity.parent_oids))
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    await workspace.readTree(workspace.identity.tree_oid, '');
    if (selected.blobs === 'all') await workspace.hydrate();
    else if (selected.blobs === 'selected') await workspace.hydrate(selected.paths);
    // Assembly helpers and mutable internal maps never cross the provider
    // boundary. Callers can neither replace identity nor append another tree.
    return Object.freeze({
      identity: workspace.identity,
      listFiles: workspace.listFiles.bind(workspace),
      hydrate: workspace.hydrate.bind(workspace),
      readFile: workspace.readFile.bind(workspace),
      loadProject: workspace.loadProject.bind(workspace),
      metrics: workspace.metrics.bind(workspace),
      cacheHint: workspace.cacheHint.bind(workspace),
      status: workspace.status.bind(workspace),
      readObject: workspace.readObject.bind(workspace),
      objectInventory: workspace.objectInventory.bind(workspace),
    });
  }

  async loadProject(revision, filter = {}) {
    const value = copyJsonData(filter);
    const workspace = await this.fetch(revision, {
      ...value,
      blobs: Object.hasOwn(value, 'paths') ? 'selected' : 'all',
    });
    return workspace.loadProject(revision, value.paths);
  }
}

class Workspace {
  #reachable = new Map();
  #source;
  #metrics;
  #entries = new Map();
  #objects = new Map();
  #knownOids = new Set();
  #missingTrees = false;
  #unavailableTrees = [];
  #files = new Map();

  constructor({ source, metrics }) {
    this.#source = source;
    this.#metrics = metrics;
  }

  bindCommit(oid) {
    this.#reachable.set(oid, 'commit');
  }

  objectInventory() {
    return freeze(
      [...this.#reachable.entries()]
        .map(([oid, kind]) => ({ oid, kind }))
        .sort((left, right) => (left.oid < right.oid ? -1 : 1)),
    );
  }

  async readObject(oid, kind) {
    gitOid(oid, this.identity.commit_oid.length);
    if (this.#reachable.get(oid) !== kind) throw new V1Error('FORBIDDEN');
    const object = await this.object(oid, kind);
    return Object.freeze({ ...object, bytes: object.bytes?.slice() });
  }

  async object(oid, kind) {
    const key = JSON.stringify([this.#source.repo_id, kind, oid]);
    if (this.#objects.has(key))
      return { status: 'AVAILABLE', bytes: this.#objects.get(key).slice() };
    let cached;
    try {
      cached = await this.#source.cache.get(key);
      if (cached !== null && cached !== undefined) cached = await verified(kind, oid, cached);
    } catch {
      cached = null;
    }
    if (cached) {
      this.#metrics.cache_hits += 1;
      this.#objects.set(key, cached);
      this.#knownOids.add(oid);
      return { status: 'AVAILABLE', bytes: cached.slice() };
    }
    this.#metrics.cache_misses += 1;
    this.#metrics.provider_reads += 1;
    let response;
    try {
      response = await this.#source.provider.readObject({
        repo_id: this.#source.repo_id,
        oid,
        kind,
      });
    } catch (error) {
      if (error instanceof V1Error && ['FORBIDDEN', 'INTEGRITY_MISMATCH'].includes(error.code))
        throw error;
      return { status: 'UNAVAILABLE' };
    }
    const status = field(response, 'status');
    const transferred = field(response, 'bytes_transferred');
    valid(['AVAILABLE', 'MISSING', 'UNAVAILABLE'].includes(status));
    valid(Number.isSafeInteger(transferred) && transferred >= 0);
    this.#metrics.bytes_transferred += transferred;
    this.#metrics[kind === 'blob' ? 'blob_bytes_transferred' : 'metadata_bytes_transferred'] +=
      transferred;
    if (status !== 'AVAILABLE') return { status };
    const bytes = await verified(kind, oid, field(response, 'bytes'));
    this.#objects.set(key, bytes);
    this.#knownOids.add(oid);
    try {
      await this.#source.cache.put(key, bytes.slice());
    } catch {
      // Cache failure cannot prevent an otherwise verified exact read.
    }
    return { status: 'AVAILABLE', bytes: bytes.slice() };
  }

  async readTree(oid, prefix) {
    this.#reachable.set(oid, 'tree');
    const tree = await this.object(oid, 'tree');
    if (tree.status !== 'AVAILABLE') {
      this.#missingTrees = true;
      this.#unavailableTrees.push({ tree_oid: oid, path: prefix, status: tree.status });
      return;
    }
    for (const entry of treeEntries(tree.bytes, oid.length)) {
      if (entry.kind !== 'commit') this.#reachable.set(entry.oid, entry.kind);
      const path = prefix + entry.name;
      if (entry.kind === 'tree') await this.readTree(entry.oid, path + '/');
      else
        this.#entries.set(
          path,
          freeze({ path, oid: entry.oid, mode: entry.mode, kind: entry.kind }),
        );
    }
  }

  listFiles() {
    return Object.freeze([...this.#entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)));
  }

  metrics() {
    return freeze({ ...this.#metrics });
  }

  cacheHint() {
    return freeze({
      schema_version: 1,
      repo_id: this.identity.repo_id,
      commit_oid: this.identity.commit_oid,
      tree_oid: this.identity.tree_oid,
      object_oids: [...this.#knownOids].sort(),
    });
  }

  status() {
    return freeze({
      schema_version: 1,
      metadata_complete: !this.#missingTrees,
      unavailable_trees: this.#unavailableTrees.map((entry) => ({ ...entry })),
    });
  }

  async hydrate(input = this.listFiles().map((entry) => entry.path)) {
    const selected = paths(input);
    const files = [];
    for (const path of selected) {
      const file = await this.readFile(path);
      files.push({ path, status: file.status });
    }
    return freeze({
      schema_version: 1,
      complete: !this.#missingTrees && files.every((file) => file.status === 'AVAILABLE'),
      files,
    });
  }

  async readFile(input) {
    const path = pathName(copyJsonData(input));
    if (!this.#files.has(path)) {
      const entry = this.#entries.get(path);
      const record = {
        repo_id: this.identity.repo_id,
        commit_oid: this.identity.commit_oid,
        tree_oid: this.identity.tree_oid,
        path,
        blob_oid: entry?.kind === 'blob' ? entry.oid : null,
        mode: entry?.mode ?? null,
        status: entry ? 'UNSUPPORTED' : this.#missingTrees ? 'UNAVAILABLE' : 'MISSING',
        bytes: null,
        contents: null,
      };
      if (entry?.kind === 'blob') {
        const object = await this.object(entry.oid, 'blob');
        record.status = object.status;
        if (object.status === 'AVAILABLE') {
          record.bytes = object.bytes;
          try {
            // NUL is a binary marker, not source text for an analysisProject.
            if (object.bytes.includes(0)) throw new Error('binary');
            record.contents = decoder.decode(object.bytes);
          } catch {
            record.status = 'UNSUPPORTED';
          }
        }
      }
      // Retry transient/missing provider objects on a later call: a promised
      // blob can become available without changing the immutable snapshot.
      if (!['MISSING', 'UNAVAILABLE'].includes(record.status) || !entry)
        this.#files.set(path, record);
      else return Object.freeze({ ...record });
    }
    const file = this.#files.get(path);
    return Object.freeze({ ...file, bytes: file.bytes?.slice() ?? null });
  }

  async loadProject(input = this.identity, selectedPaths) {
    const revision = copyJsonData(input);
    if (
      revision.repo_id !== this.identity.repo_id ||
      revision.commit_oid !== this.identity.commit_oid ||
      revision.tree_oid !== this.identity.tree_oid
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    const selected =
      selectedPaths === undefined
        ? this.listFiles().map((entry) => entry.path)
        : paths(selectedPaths);
    const files = [];
    let complete = !this.#missingTrees && selected.length === this.#entries.size;
    for (const path of selected) {
      const file = await this.readFile(path);
      if (file.status === 'AVAILABLE') files.push({ path, contents: file.contents });
      else complete = false;
    }
    return freeze({
      schema_version: 1,
      repo_id: this.identity.repo_id,
      commit_oid: this.identity.commit_oid,
      tree_oid: this.identity.tree_oid,
      complete,
      files,
    });
  }
}
