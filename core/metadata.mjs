export const PRODUCER_METADATA_DIRECTORY = '.klocgit';

/**
 * Read producer metadata from the exact immutable commit supplied by the caller.
 * The adapter's null/undefined result means absent; read failures propagate.
 * Parsing and provenance validation remain the caller's responsibility.
 *
 * @param {object} git Repository adapter exposing file(repo, commit, path).
 * @param {object} repo Registered canonical or producer repository descriptor.
 * @param {string} commit Immutable Git commit binding the declaration to code.
 * @param {string} filename Relative metadata filename selected by the caller.
 * @returns {Promise<string | null | undefined>} Raw content, or the adapter's absence value.
 */
export async function readProducerMetadata(git, repo, commit, filename) {
  return git.file(repo, commit, `${PRODUCER_METADATA_DIRECTORY}/${filename}`);
}
