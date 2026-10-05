export const PRODUCER_METADATA_DIRECTORY = '.klocgit';

/**
 * Read the current producer format first. Legacy files remain usable when the
 * current file is absent; invalid or empty current files must not hide behind
 * older declarations. The adapter's null/undefined result means absent. Both
 * reads use the same immutable commit; parsing and provenance validation remain
 * the caller's responsibility.
 *
 * @param {object} git Repository adapter exposing file(repo, commit, path).
 * @param {object} repo Registered canonical or producer repository descriptor.
 * @param {string} commit Immutable Git commit binding the declaration to code.
 * @param {string} filename Relative metadata filename selected by the caller.
 * @returns {Promise<string | null | undefined>} Raw content, or the adapter's absence value.
 */
export async function readProducerMetadata(git, repo, commit, filename) {
  const current = await git.file(repo, commit, `${PRODUCER_METADATA_DIRECTORY}/${filename}`);
  if (current !== null && current !== undefined) return current;
  return git.file(repo, commit, `.converge/${filename}`);
}
