/** Read source through isolated, byte-preserving Git object commands. */
import { SourceBrowser, sourceCommitFromBytes } from '../../core/v1/source-browser.mjs';
import { V1Error } from '../../core/v1/conventions.mjs';
import { LocalGitObjectProvider, LocalWorkspaceSource } from './workspace-source.mjs';
import { LocalGitStore, gitFailure } from './git-store.mjs';
import { git } from '../../server/git.mjs';

export function localSourceBrowser(adapter, repository, limits) {
  const objects = new LocalGitObjectProvider({ adapter, repository, max_object_bytes: 1048576 });
  const store = new LocalGitStore({
    adapter,
    repository,
    workspaceSource: new LocalWorkspaceSource({ adapter, repository }),
  });
  async function read(oid, kind) {
    const object = await objects.readObject({ repo_id: repository.id, oid, kind });
    if (object.status === 'MISSING') throw new V1Error('NOT_FOUND');
    if (object.status !== 'AVAILABLE') throw new V1Error('PROVIDER_UNAVAILABLE');
    return object.bytes;
  }
  return new SourceBrowser({
    repo_id: repository.id,
    limits,
    provider: {
      resolveRef: async (ref) => {
        try {
          return await adapter.ref(repository, ref);
        } catch (error) {
          throw gitFailure(error);
        }
      },
      listRefs: async (input) => {
        try {
          return await adapter.listRefs(repository, input);
        } catch (error) {
          throw gitFailure(error);
        }
      },
      readCommit: async (oid) =>
        sourceCommitFromBytes(repository.id, oid, await read(oid, 'commit')),
      readTree: async (oid) => (await store.read_tree(oid)).entries,
      readBlob: async ({ oid, limit }) => {
        const size = Number(
          await git(adapter.dir(repository), [
            '--no-replace-objects',
            '--no-lazy-fetch',
            'cat-file',
            '-s',
            oid,
          ]),
        );
        if (!Number.isSafeInteger(size) || size < 0) throw new V1Error('INTEGRITY_MISMATCH');
        if (size > limit) throw new V1Error('UNSUPPORTED_CAPABILITY');
        return read(oid, 'blob');
      },
    },
  });
}
