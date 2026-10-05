import { DomainError } from '../core/hash.mjs';
import {
  repositoryDescriptionOperation,
  repositoryId,
  repositoryImportSource,
  repositoryObjectId,
  repositoryOperationDescription,
  repositoryRef,
  verifyForkState,
} from '../core/repository-input.mjs';

const hasCode = (error, name, code) =>
  error?.code === name ||
  error?.code === code ||
  error?.message === name ||
  error?.message?.startsWith(name + ':');

function providerError(error) {
  if (error instanceof DomainError) return error;
  if (hasCode(error, 'NOT_FOUND', 10200))
    return new DomainError('REPO_NOT_FOUND', 'Artifacts repository does not exist', 404);
  if (hasCode(error, 'ALREADY_EXISTS', 10201))
    return new DomainError('REPO_EXISTS', 'Artifacts repository already exists', 409);
  // Provider diagnostics may contain a URL or token. Only known safe categories
  // leave this adapter; a failed mutation still needs authoritative inspection.
  return new DomainError('ARTIFACTS_UNAVAILABLE', 'Artifacts operation requires reconciliation', 503);
}

function safeRemote(remote) {
  let url;
  try {
    url = new URL(remote);
  } catch {}
  if (
    url?.protocol !== 'https:' ||
    url.username || url.password || url.search || url.hash || url.port ||
    !url.hostname.endsWith('.artifacts.cloudflare.net')
  )
    throw new DomainError('INVALID_ARTIFACTS_REMOTE', 'Artifacts returned an invalid Git remote', 503);
  return url.href;
}

/**
 * Read readiness from Artifacts and an observed commit, not from creation's
 * returned token/metadata. An existing empty repository has no canonical head.
 *
 * @param {object} env Artifacts namespace binding.
 * @param {object} input Repository ID and optional branch ref.
 * @returns {Promise<object>} Credential-free descriptor with exact commit/tree or pending state.
 * @throws {DomainError} The repository is absent or authoritative state cannot be read.
 */
export async function artifactRepositoryInfo(env, input) {
  const id = repositoryId(input.id);
  const ref = repositoryRef(input.ref);
  let capability;
  try {
    capability = await env.ARTIFACTS.get(id);
    const info = await capability.info();
    const entries = await capability.log({ ref, limit: 1 });
    const value = entries[0] ? await capability.readCommit(repositoryObjectId(entries[0].hash)) : null;
    if (entries.length && !value)
      throw new DomainError('MISSING_COMMIT', 'The observed Artifacts commit is unavailable', 503);
    return {
      id,
      provider: 'cloudflare-artifacts',
      remote: safeRemote(info.remote),
      ref,
      default_ref: repositoryRef('refs/heads/' + info.defaultBranch),
      operation_id: repositoryDescriptionOperation(info.description),
      status: value ? 'ready' : 'empty',
      commit: value ? repositoryObjectId(value.hash) : null,
      tree: value ? repositoryObjectId(value.treeHash) : null,
    };
  } catch (error) {
    if (hasCode(error, 'IMPORT_IN_PROGRESS', 10302) || hasCode(error, 'FORK_IN_PROGRESS', 10303))
      return {
        id,
        provider: 'cloudflare-artifacts',
        remote: null,
        ref,
        operation_id: null,
        status: hasCode(error, 'IMPORT_IN_PROGRESS', 10302) ? 'importing' : 'forking',
        commit: null,
        tree: null,
      };
    throw providerError(error);
  } finally {
    capability?.[Symbol.dispose]?.();
  }
}

export async function artifactRepositoryCreate(env, input) {
  const id = repositoryId(input.id);
  const ref = repositoryRef(input.ref);
  const description = repositoryOperationDescription(input.description, input.operation_id);
  try {
    await env.ARTIFACTS.create(id, { description, setDefaultBranch: ref.slice(11) });
    return await artifactRepositoryInfo(env, { id, ref });
  } catch (error) {
    throw providerError(error);
  }
}

export async function artifactRepositoryImport(env, input) {
  const id = repositoryId(input.id);
  const ref = repositoryRef(input.ref);
  const description = repositoryOperationDescription(input.description, input.operation_id);
  const source = repositoryImportSource(input.source, env.KLOCGIT_IMPORT_HOSTS);
  if (source.branch && source.branch !== ref.slice(11))
    throw new DomainError('IMPORT_REF_MISMATCH', 'Import branch must match the requested repository ref', 422);
  source.branch = ref.slice(11);
  try {
    // This is the documented public-import binding. Its internal DNS, redirect
    // and resource controls are provider responsibilities, not verified here.
    const result = await env.ARTIFACTS.import({ source, target: { name: id, opts: { description } } });
    const observed = await artifactRepositoryInfo(env, { id, ref });
    return { ...observed, remote: observed.remote ?? safeRemote(result.remote) };
  } catch (error) {
    throw providerError(error);
  }
}

export async function artifactRepositoryFork(env, input) {
  const id = repositoryId(input.id);
  const source = input.source;
  const sourceId = repositoryId(source?.repo_id);
  const ref = repositoryRef(source?.ref);
  repositoryObjectId(source?.commit);
  repositoryObjectId(source?.tree);
  const description = repositoryOperationDescription(input.description, input.operation_id);
  const baseline = await artifactRepositoryInfo(env, { id: sourceId, ref });
  if (baseline.status !== 'ready')
    throw new DomainError('REPO_NOT_READY', 'Forking requires an observed initial commit', 409);
  verifyForkState(baseline, source);
  if (baseline.default_ref !== ref)
    throw new DomainError('FORK_REF_UNSUPPORTED', 'Artifacts forks require the default branch baseline', 422);
  let capability;
  try {
    capability = await env.ARTIFACTS.get(sourceId);
    const result = await capability.fork(id, { description, defaultBranchOnly: true });
    const observed = await artifactRepositoryInfo(env, { id, ref });
    return verifyForkState({ ...observed, remote: observed.remote ?? safeRemote(result.remote) }, source);
  } catch (error) {
    throw providerError(error);
  } finally {
    capability?.[Symbol.dispose]?.();
  }
}
