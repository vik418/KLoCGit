/** Exact Git observations and conditional writes, independent of provider types. */
import { V1Error, assertIdempotencyKey, assertSchemaVersion } from './conventions.mjs';
import { copyJsonData, gitOid, gitRef } from './domain.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function gitSnapshot(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(typeof value.repo_id === 'string' && value.repo_id.trim().length > 0);
  gitOid(value.commit_oid);
  gitOid(value.tree_oid, value.commit_oid.length);
  valid(Array.isArray(value.parent_oids));
  value.parent_oids.forEach((oid) => gitOid(oid, value.commit_oid.length));
  valid(new Set(value.parent_oids).size === value.parent_oids.length);
  valid(Object.keys(value).length === 5);
  return freeze(value);
}

export class GitStore {
  constructor({ repo_id, provider }) {
    valid(typeof repo_id === 'string' && repo_id.trim().length > 0);
    valid(
      ['observe_ref', 'fetch', 'read_tree', 'compare_and_swap_ref'].every(
        (method) => typeof provider?.[method] === 'function',
      ),
    );
    this.repo_id = repo_id;
    this.provider = provider;
  }

  async observe_ref(repo, ref) {
    if (repo !== this.repo_id) throw new V1Error('FORBIDDEN');
    gitRef(ref);
    return gitOid(await this.provider.observe_ref(repo, ref));
  }

  async fetch(input, filter) {
    const revision = freeze(copyJsonData(input));
    assertSchemaVersion(revision);
    if (revision.repo_id !== this.repo_id) throw new V1Error('FORBIDDEN');
    gitOid(revision.commit_oid);
    const selection = freeze(copyJsonData(filter));
    valid(selection && typeof selection === 'object' && !Array.isArray(selection));
    const source = await this.provider.fetch(revision, selection);
    const snapshot = gitSnapshot(source?.identity);
    if (
      snapshot.repo_id !== revision.repo_id ||
      snapshot.commit_oid !== revision.commit_oid ||
      (revision.tree_oid && snapshot.tree_oid !== revision.tree_oid)
    ) {
      throw new V1Error('INTEGRITY_MISMATCH');
    }
    return source;
  }

  async read_tree(oid) {
    gitOid(oid);
    const tree = copyJsonData(await this.provider.read_tree(oid));
    assertSchemaVersion(tree);
    if (tree.tree_oid !== oid) throw new V1Error('INTEGRITY_MISMATCH');
    valid(Object.keys(tree).length === 3 && Array.isArray(tree.entries));
    const names = new Set();
    for (const entry of tree.entries) {
      valid(entry && typeof entry === 'object' && !Array.isArray(entry));
      valid(
        Object.keys(entry).length === 4 &&
          ['name', 'mode', 'oid', 'kind'].every((key) => Object.hasOwn(entry, key)),
      );
      valid(
        typeof entry.name === 'string' &&
          entry.name.length > 0 &&
          !entry.name.includes('/') &&
          !entry.name.includes('\0') &&
          !['.', '..'].includes(entry.name),
      );
      valid(!names.has(entry.name));
      names.add(entry.name);
      gitOid(entry.oid, oid.length);
      const modes = { tree: ['040000'], blob: ['100644', '100755', '120000'], commit: ['160000'] };
      valid(Object.hasOwn(modes, entry.kind) && modes[entry.kind].includes(entry.mode));
    }
    // Git tree order is significant to its identity; preserve it exactly.
    return freeze(tree);
  }

  async compare_and_swap_ref(ref, expected_oid, target_oid, options) {
    gitRef(ref);
    gitOid(expected_oid);
    gitOid(target_oid, expected_oid.length);
    const request = freeze(copyJsonData(options));
    assertIdempotencyKey(request?.idempotency_key);
    valid(Object.keys(request).length === 1);
    const updated = await this.provider.compare_and_swap_ref(
      ref,
      expected_oid,
      target_oid,
      request,
    );
    // An ambiguous reply after a write attempt requires reconciliation.
    if (typeof updated !== 'boolean') throw new V1Error('OUTCOME_UNKNOWN');
    return updated;
  }
}
