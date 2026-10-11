/** Translate native Artifacts reads and trusted Git CAS into the v1 contract. */
import { V1Error, assertIdempotencyKey } from '../../core/v1/conventions.mjs';
import { copyJsonData, gitOid, gitRef } from '../../core/v1/domain.mjs';
import { gitSnapshot } from '../../core/v1/git-store.mjs';

function readFailure(error) {
  if (error instanceof V1Error) return error;
  const codes = {
    NOT_FOUND: 'NOT_FOUND',
    REF_NOT_FOUND: 'NOT_FOUND',
    MISSING_COMMIT: 'NOT_FOUND',
    MISSING_TREE: 'NOT_FOUND',
    INVALID_INPUT: 'INVALID_ARGUMENT',
    INVALID_REF: 'INVALID_ARGUMENT',
    INVALID_COMMIT: 'INVALID_ARGUMENT',
    MEMORY_LIMIT: 'UNSUPPORTED_CAPABILITY',
    SOURCE_WRITE_FORBIDDEN: 'FORBIDDEN',
    SOURCE_AUTHORITY_INVALID: 'FORBIDDEN',
    CONFIG_STALE: 'STALE_BASIS',
    VALIDATION_PROFILE_MISMATCH: 'POLICY_REJECTED',
  };
  return new V1Error(codes[error?.code] ?? 'PROVIDER_UNAVAILABLE');
}

const treeKinds = { tree: 'tree', blob: 'blob', exec: 'blob', symlink: 'blob', gitlink: 'commit' };
const treeModes = {
  tree: '040000',
  blob: '100644',
  exec: '100755',
  symlink: '120000',
  gitlink: '160000',
};

function sha1Oid(value) {
  gitOid(value);
  if (value.length !== 40) throw new V1Error('UNSUPPORTED_CAPABILITY');
  return value;
}

export async function readArtifactsTree(adapter, repository, tree_oid) {
  sha1Oid(tree_oid);
  try {
    return await adapter.withRepo(repository, async (repo) => {
      const children = await repo.readTree(tree_oid);
      if (!children) throw new V1Error('NOT_FOUND');
      const entries = children.map((entry) => {
        const mode = entry.mode === '40000' ? '040000' : entry.mode;
        if (!Object.hasOwn(treeKinds, entry.type) || treeModes[entry.type] !== mode)
          throw new V1Error('INTEGRITY_MISMATCH');
        return { name: entry.name, mode, oid: entry.hash, kind: treeKinds[entry.type] };
      });
      return { schema_version: 1, tree_oid, entries };
    });
  } catch (error) {
    throw readFailure(error);
  }
}

export class ArtifactsGitStore {
  constructor({ adapter, repository, workspaceSource }) {
    if (
      !['withRepo', 'readRef', 'execute', 'descriptor'].every(
        (method) => typeof adapter?.[method] === 'function',
      ) ||
      typeof repository?.id !== 'string' ||
      !repository.id.trim() ||
      typeof workspaceSource?.fetch !== 'function'
    ) {
      throw new V1Error('INVALID_ARGUMENT');
    }
    this.adapter = adapter;
    this.repository = Object.freeze(copyJsonData(repository));
    this.workspaceSource = workspaceSource;
  }

  async observe_ref(repo, ref) {
    if (repo !== this.repository.id) throw new V1Error('FORBIDDEN');
    gitRef(ref);
    try {
      // Tags need their object identity, so use the existing trusted read-ref path.
      return sha1Oid((await this.adapter.readRef(this.repository, ref)).object_id);
    } catch (error) {
      throw readFailure(error);
    }
  }

  async snapshot(commit_oid) {
    sha1Oid(commit_oid);
    try {
      return await this.adapter.withRepo(this.repository, async (repo) => {
        const commit = await repo.readCommit(commit_oid);
        if (!commit) throw new V1Error('NOT_FOUND');
        if (commit.hash !== commit_oid) throw new V1Error('INTEGRITY_MISMATCH');
        return gitSnapshot({
          schema_version: 1,
          repo_id: this.repository.id,
          commit_oid: commit.hash,
          tree_oid: commit.treeHash,
          parent_oids: commit.parents,
        });
      });
    } catch (error) {
      throw readFailure(error);
    }
  }

  async fetch(revision, filter) {
    if (revision.repo_id !== this.repository.id) throw new V1Error('FORBIDDEN');
    const identity = await this.snapshot(revision.commit_oid);
    if (revision.tree_oid && revision.tree_oid !== identity.tree_oid)
      throw new V1Error('INTEGRITY_MISMATCH');
    try {
      const source = await this.workspaceSource.fetch(identity, filter);
      const observed = gitSnapshot(source?.identity);
      if (
        observed.repo_id !== identity.repo_id ||
        observed.commit_oid !== identity.commit_oid ||
        observed.tree_oid !== identity.tree_oid ||
        observed.parent_oids.length !== identity.parent_oids.length ||
        observed.parent_oids.some((oid, index) => oid !== identity.parent_oids[index])
      ) {
        throw new V1Error('INTEGRITY_MISMATCH');
      }
      return source;
    } catch (error) {
      throw readFailure(error);
    }
  }

  async read_tree(tree_oid) {
    return readArtifactsTree(this.adapter, this.repository, tree_oid);
  }

  async compare_and_swap_ref(ref, expected_oid, target_oid, options) {
    gitRef(ref);
    sha1Oid(expected_oid);
    sha1Oid(target_oid);
    assertIdempotencyKey(options?.idempotency_key);
    try {
      const result = await this.adapter.execute('cas', {
        ...this.adapter.descriptor(this.repository),
        ref,
        expected: expected_oid,
        commit: target_oid,
        idempotency_key: options.idempotency_key,
      });
      if (typeof result?.updated !== 'boolean') throw new V1Error('OUTCOME_UNKNOWN');
      return result.updated;
    } catch (error) {
      // Only explicit precondition rejection proves that no write happened.
      // A missing reply may follow success; the promotion journal must reconcile it.
      if (error instanceof V1Error) throw error;
      if (
        [
          'INVALID_REF',
          'INVALID_COMMIT',
          'SOURCE_WRITE_FORBIDDEN',
          'SOURCE_AUTHORITY_INVALID',
          'CONFIG_STALE',
          'VALIDATION_PROFILE_MISMATCH',
        ].includes(error?.code)
      ) {
        throw readFailure(error);
      }
      throw new V1Error('OUTCOME_UNKNOWN');
    }
  }
}
