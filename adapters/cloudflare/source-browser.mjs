/** Native Artifacts reads; browsing does not create repositories or Git objects. */
import { SourceBrowser } from '../../core/v1/source-browser.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';
import { readArtifactsTree } from './git-store.mjs';

export function artifactsSourceBrowser(adapter, repository, limits) {
  return new SourceBrowser({
    repo_id: repository.id,
    limits,
    provider: {
      resolveRef: (ref) => adapter.ref(repository, ref),
      listRefs: (input) => adapter.listRefs(repository, input),
      readTree: async (oid) => (await readArtifactsTree(adapter, repository, oid)).entries,
      readCommit: (oid) =>
        adapter.withRepo(repository, async (repo) => {
          const commit = await repo.readCommit(oid);
          if (!commit) return null;
          return {
            schema_version: 1,
            repo_id: repository.id,
            commit_oid: commit.hash,
            tree_oid: commit.treeHash,
            parent_oids: commit.parents,
            message: commit.message,
            author: null,
            signature: null,
          };
        }),
      readBlob: ({ snapshot, path, limit }) =>
        adapter.withRepo(repository, async (repo) => {
          const blob = await repo.readFile({ ref: snapshot.commit_oid, path });
          if (!blob) throw new V1Error('NOT_FOUND');
          if (blob.size > limit) throw new V1Error('UNSUPPORTED_CAPABILITY');
          return new Uint8Array(await blob.arrayBuffer());
        }),
    },
  });
}
