/** Bridge the existing guarded Git adapter to the v1 contract. */
import { git } from '../../server/git.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';
import { gitSnapshot } from '../../core/v1/git-store.mjs';
import { gitOid } from '../../core/v1/domain.mjs';

export function gitFailure(error) {
  if (error instanceof V1Error) return error;
  const codes = {
    REF_NOT_FOUND: 'NOT_FOUND',
    MISSING_COMMIT: 'NOT_FOUND',
    MISSING_TREE: 'NOT_FOUND',
    INVALID_REF: 'INVALID_ARGUMENT',
    INVALID_COMMIT: 'INVALID_ARGUMENT',
    INVALID_REPO: 'INVALID_ARGUMENT',
    SOURCE_WRITE_FORBIDDEN: 'FORBIDDEN',
    SOURCE_AUTHORITY_INVALID: 'FORBIDDEN',
    CANONICAL_WRITE_UNCERTAIN: 'OUTCOME_UNKNOWN',
    SOURCE_CREDENTIAL_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  };
  return new V1Error(codes[error?.code] ?? 'PROVIDER_UNAVAILABLE');
}

export class LocalGitStore {
  constructor({ adapter, repository, workspaceSource }) {
    if (
      typeof adapter?.readRef !== 'function' ||
      typeof adapter?.cas !== 'function' ||
      typeof adapter?.dir !== 'function' ||
      typeof repository?.id !== 'string' ||
      typeof workspaceSource?.fetch !== 'function'
    ) {
      throw new V1Error('INVALID_ARGUMENT');
    }
    this.adapter = adapter;
    this.repository = Object.freeze({ ...repository });
    this.workspaceSource = workspaceSource;
  }

  async observe_ref(repo, ref) {
    if (repo !== this.repository.id) throw new V1Error('FORBIDDEN');
    try {
      return (await this.adapter.readRef(this.repository, ref)).object_id;
    } catch (error) {
      throw gitFailure(error);
    }
  }

  async fetch(revision, filter) {
    return this.workspaceSource.fetch(revision, filter);
  }

  async snapshot(commit_oid) {
    gitOid(commit_oid);
    try {
      const value = await git(this.adapter.dir(this.repository), [
        'show',
        '-s',
        '--format=%H%n%T%n%P',
        commit_oid,
      ]);
      const [head, tree, parents = ''] = value.split('\n');
      return gitSnapshot({
        schema_version: 1,
        repo_id: this.repository.id,
        commit_oid: head,
        tree_oid: tree,
        parent_oids: parents ? parents.split(' ') : [],
      });
    } catch (error) {
      throw gitFailure(error);
    }
  }

  async read_tree(tree_oid) {
    gitOid(tree_oid);
    try {
      const output = await git(
        this.adapter.dir(this.repository),
        ['ls-tree', '-z', tree_oid],
        undefined,
        { raw: true },
      );
      // The current CLI transport decodes UTF-8. Ambiguous replacement bytes
      // cannot be used to claim exact path identity.
      if (output.includes('\ufffd')) throw new V1Error('UNSUPPORTED_CAPABILITY');
      const entries = output
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('\t');
          const [mode, kind, oid] = line.slice(0, separator).split(' ');
          return { name: line.slice(separator + 1), mode, kind, oid };
        });
      return { schema_version: 1, tree_oid, entries };
    } catch (error) {
      throw gitFailure(error);
    }
  }

  async compare_and_swap_ref(ref, expected, target, _options) {
    try {
      return await this.adapter.cas({ ...this.repository, canonical_ref: ref }, expected, target);
    } catch (error) {
      throw gitFailure(error);
    }
  }
}
