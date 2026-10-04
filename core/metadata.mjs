export const PRODUCER_METADATA_DIRECTORY = '.klocgit';

/**
 * Read the current producer format first. Legacy files remain usable when the
 * current file is absent; invalid or empty current files must not hide behind
 * older declarations. The adapter's null/undefined result means absent.
 */
export async function readProducerMetadata(git, repo, commit, filename) {
  const current = await git.file(repo, commit, `${PRODUCER_METADATA_DIRECTORY}/${filename}`);
  if (current !== null && current !== undefined) return current;
  return git.file(repo, commit, `.converge/${filename}`);
}
