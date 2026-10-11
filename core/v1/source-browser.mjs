/** Bounded read-only navigation over an immutable Git snapshot. */
import { V1Error } from './conventions.mjs';
import { gitOid } from './domain.mjs';
import { gitSnapshot } from './git-store.mjs';
import { gitObjectOid } from './workspace.mjs';
import { observationRef } from '../git-refs.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

export function sourcePath(value = '') {
  valid(typeof value === 'string' && value.length <= 4096 && !value.includes('\0'));
  valid(!value.includes('\\'));
  if (value) {
    const parts = value.split('/');
    valid(parts.length <= 64 && parts.every((part) => part && part !== '.' && part !== '..'));
  }
  return value;
}

function pageNumber(value, defaultValue, maximum, minimum = 1) {
  if (value === undefined || value === null) return defaultValue;
  valid(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)));
  const result = Number(value);
  valid(Number.isSafeInteger(result) && result >= minimum && result <= maximum);
  return result;
}

async function verifyTree(oid, entries, maximum) {
  if (!Array.isArray(entries) || entries.length > maximum)
    throw new V1Error('UNSUPPORTED_CAPABILITY');
  const seen = new Set();
  const parts = [];
  let size = 0;
  const modes = { tree: ['040000'], blob: ['100644', '100755', '120000'], commit: ['160000'] };
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      entry.name.includes('/') ||
      entry.name.includes('\0') ||
      ['.', '..'].includes(entry.name) ||
      seen.has(entry.name) ||
      !Object.hasOwn(modes, entry.kind) ||
      !modes[entry.kind].includes(entry.mode)
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    gitOid(entry.oid, oid.length);
    seen.add(entry.name);
    // Git orders tree entries itself. Reordering before verification changes the OID.
    const prefix = encoder.encode(entry.mode.replace(/^0/, '') + ' ' + entry.name + '\0');
    const hash = Uint8Array.from(entry.oid.match(/../g), (pair) => parseInt(pair, 16));
    parts.push(prefix, hash);
    size += prefix.length + hash.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  if ((await gitObjectOid('tree', bytes, oid.length)) !== oid)
    throw new V1Error('INTEGRITY_MISMATCH');
  return entries.map((entry) => ({ ...entry }));
}

/** Parse display metadata only after verifying the complete Git commit object. */
export async function sourceCommitFromBytes(repo_id, commit_oid, bytes) {
  if ((await gitObjectOid('commit', bytes, commit_oid.length)) !== commit_oid)
    throw new V1Error('INTEGRITY_MISMATCH');
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new V1Error('UNSUPPORTED_CAPABILITY');
  }
  const separator = text.indexOf('\n\n');
  if (separator < 0) throw new V1Error('INTEGRITY_MISMATCH');
  const headers = text.slice(0, separator).split('\n');
  const identity = gitSnapshot({
    schema_version: 1,
    repo_id,
    commit_oid,
    tree_oid: headers[0].startsWith('tree ') ? headers[0].slice(5) : '',
    parent_oids: headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
  });
  const author = headers.find((line) => line.startsWith('author '))?.slice(7) ?? null;
  return {
    ...identity,
    message: text.slice(separator + 2),
    author,
    // A signature's presence is a Git fact. Verification requires a separate verifier.
    signature: headers.some((line) => line.startsWith('gpgsig ')) ? 'UNVERIFIED' : 'ABSENT',
  };
}

export class SourceBrowser {
  constructor({ repo_id, provider, limits = {} }) {
    valid(typeof repo_id === 'string' && repo_id.length > 0);
    valid(
      ['resolveRef', 'listRefs', 'readCommit', 'readTree', 'readBlob'].every(
        (method) => typeof provider?.[method] === 'function',
      ),
    );
    this.repo_id = repo_id;
    this.provider = provider;
    this.limits = {
      file_bytes: pageNumber(limits.file_bytes, 1048576, 1048576),
      tree_entries: pageNumber(limits.tree_entries, 20000, 20000),
      summary_trees: pageNumber(limits.summary_trees, 1000, 1000),
      history_commits: pageNumber(limits.history_commits, 1000, 1000),
    };
  }

  async refs(input = {}) {
    const limit = pageNumber(input.limit, 100, 200);
    if (input.cursor) observationRef(input.cursor);
    const result = await this.provider.listRefs({ limit, cursor: input.cursor });
    if (
      !Array.isArray(result?.refs) ||
      result.refs.length > limit ||
      typeof result.has_more !== 'boolean' ||
      (result.has_more && !result.next_cursor)
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    for (const entry of result.refs) {
      observationRef(entry.ref);
      gitOid(entry.object_id);
      if (entry.commit !== null) gitOid(entry.commit, entry.object_id.length);
      if (entry.available_for_future !== Boolean(entry.commit))
        throw new V1Error('INTEGRITY_MISMATCH');
    }
    if (result.next_cursor) observationRef(result.next_cursor);
    return {
      schema_version: 1,
      repo_id: this.repo_id,
      refs: result.refs,
      has_more: result.has_more,
      next_cursor: result.next_cursor,
    };
  }

  async commit(commit_oid) {
    gitOid(commit_oid);
    const result = await this.provider.readCommit(commit_oid);
    if (!result) throw new V1Error('NOT_FOUND');
    const identity = gitSnapshot({
      schema_version: 1,
      repo_id: result.repo_id,
      commit_oid: result.commit_oid,
      tree_oid: result.tree_oid,
      parent_oids: result.parent_oids,
    });
    if (identity.repo_id !== this.repo_id || identity.commit_oid !== commit_oid)
      throw new V1Error('INTEGRITY_MISMATCH');
    if (
      ![null, 'ABSENT', 'UNVERIFIED'].includes(result.signature ?? null) ||
      (result.message !== null && typeof result.message !== 'string') ||
      (result.author !== null && typeof result.author !== 'string')
    )
      throw new V1Error('INTEGRITY_MISMATCH');
    if ((result.message?.length ?? 0) > 65536 || (result.author?.length ?? 0) > 4096)
      throw new V1Error('UNSUPPORTED_CAPABILITY');
    return {
      ...identity,
      message: result.message,
      author: result.author,
      signature: result.signature ?? null,
    };
  }

  async snapshot({ commit_oid, ref } = {}) {
    valid(Boolean(commit_oid) !== Boolean(ref));
    if (ref) {
      observationRef(ref);
      commit_oid = await this.provider.resolveRef(ref);
    }
    return this.commit(commit_oid);
  }

  async treeEntries(tree_oid) {
    return verifyTree(tree_oid, await this.provider.readTree(tree_oid), this.limits.tree_entries);
  }

  async locate(snapshot, input) {
    const path = sourcePath(input);
    let entry = { name: '', kind: 'tree', mode: '040000', oid: snapshot.tree_oid };
    for (const part of path ? path.split('/') : []) {
      if (entry.kind !== 'tree') throw new V1Error('NOT_FOUND');
      entry = (await this.treeEntries(entry.oid)).find((child) => child.name === part);
      if (!entry) throw new V1Error('NOT_FOUND');
    }
    return entry;
  }

  async directory(input) {
    const path = sourcePath(input.path);
    const limit = pageNumber(input.limit, 100, 200);
    const offset = pageNumber(input.offset, 0, this.limits.tree_entries, 0);
    const snapshot = await this.snapshot(input);
    const target = await this.locate(snapshot, path);
    if (target.kind !== 'tree') throw new V1Error('NOT_FOUND');
    const entries = (await this.treeEntries(target.oid)).sort((a, b) => {
      if ((a.kind === 'tree') !== (b.kind === 'tree')) return a.kind === 'tree' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return {
      schema_version: 1,
      snapshot,
      path,
      tree_oid: target.oid,
      entries: entries.slice(offset, offset + limit).map((entry) => ({
        ...entry,
        path: path ? path + '/' + entry.name : entry.name,
      })),
      entry_count: entries.length,
      next_offset: offset + limit < entries.length ? offset + limit : null,
    };
  }

  async file(input) {
    const path = sourcePath(input.path);
    valid(path.length > 0);
    const snapshot = await this.snapshot(input);
    const entry = await this.locate(snapshot, path);
    if (entry.kind !== 'blob') throw new V1Error('UNSUPPORTED_CAPABILITY');
    const bytes = await this.provider.readBlob({
      snapshot,
      path,
      oid: entry.oid,
      limit: this.limits.file_bytes,
    });
    if (!(bytes instanceof Uint8Array)) throw new V1Error('PROVIDER_UNAVAILABLE');
    if (bytes.length > this.limits.file_bytes) throw new V1Error('UNSUPPORTED_CAPABILITY');
    if ((await gitObjectOid('blob', bytes, entry.oid.length)) !== entry.oid)
      throw new V1Error('INTEGRITY_MISMATCH');
    let text = null;
    if (!bytes.includes(0)) {
      try {
        text = decoder.decode(bytes);
      } catch {
        /* Binary files have no text preview. */
      }
    }
    return {
      schema_version: 1,
      snapshot,
      path,
      blob_oid: entry.oid,
      mode: entry.mode,
      size_bytes: bytes.length,
      content_kind: text === null ? 'BINARY' : entry.mode === '120000' ? 'SYMLINK' : 'TEXT',
      text,
    };
  }

  async history(input) {
    const limit = pageNumber(input.limit, 30, 100);
    const offset = pageNumber(input.offset, 0, this.limits.history_commits - 1, 0);
    const snapshot = await this.snapshot(input);
    const commits = [];
    let current = snapshot;
    let visited = 0;
    let hasMore = false;
    // First-parent pagination is explicit; merge parents remain available in commit details.
    while (current && visited < this.limits.history_commits && commits.length < limit) {
      if (visited >= offset) commits.push(current);
      visited += 1;
      const parent = current.parent_oids[0];
      hasMore = Boolean(parent);
      if (!parent || visited >= this.limits.history_commits || commits.length >= limit) break;
      current = await this.commit(parent);
    }
    return {
      schema_version: 1,
      snapshot,
      mode: 'FIRST_PARENT',
      commits,
      next_offset: hasMore && visited < this.limits.history_commits ? visited : null,
      truncated: hasMore && visited >= this.limits.history_commits,
    };
  }

  async summary(input) {
    const snapshot = await this.snapshot(input);
    const pending = [snapshot.tree_oid];
    let trees = 0;
    let files = 0;
    let submodules = 0;
    let entries = 0;
    while (
      pending.length &&
      trees < this.limits.summary_trees &&
      entries < this.limits.tree_entries
    ) {
      const children = await this.treeEntries(pending.pop());
      trees += 1;
      for (const child of children) {
        if (entries >= this.limits.tree_entries) {
          return {
            schema_version: 1,
            snapshot,
            files,
            directories: trees - 1,
            submodules,
            complete: false,
          };
        }
        entries += 1;
        if (child.kind === 'tree') pending.push(child.oid);
        else if (child.kind === 'commit') submodules += 1;
        else files += 1;
      }
    }
    return {
      schema_version: 1,
      snapshot,
      files,
      directories: trees - 1,
      submodules,
      complete: pending.length === 0,
    };
  }
}
