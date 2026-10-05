import { DomainError } from './hash.mjs';

const publicImportHosts = ['github.com', 'gitlab.com'];

/** Trusted adapters use this only before any repository mutation is issued. */
export class RepositoryPreflightError extends DomainError {
  constructor(error) {
    super(error.code, error.message, error.status, error.details);
  }
}

export function repositoryId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value))
    throw new DomainError('INVALID_REPO', 'Use a bounded repository name');
  return value;
}

export function repositoryRef(value = 'refs/heads/main') {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value
      .split('/')
      .some((part) => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw new DomainError('INVALID_REF', 'Use a valid branch ref');
  return value;
}

export function repositoryDescription(value = '') {
  if (
    typeof value !== 'string' ||
    value.length > 1000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new DomainError('INVALID_DESCRIPTION', 'Repository descriptions are bounded text');
  if (value.includes('[klocgit-operation:'))
    throw new DomainError('INVALID_DESCRIPTION', 'Repository operation markers are reserved');
  return value;
}

export function repositoryOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value))
    throw new DomainError('INVALID_OPERATION', 'A bounded repository operation ID is required');
  return value;
}

export function repositoryOperationDescription(description, operationId) {
  const text = repositoryDescription(description);
  return (text + '\n[klocgit-operation:' + repositoryOperationId(operationId) + ']').trim();
}

export function repositoryDescriptionOperation(value) {
  if (typeof value !== 'string') return null;
  return (
    /(?:^|\n)\[klocgit-operation:([A-Za-z0-9][A-Za-z0-9_-]{0,159})\]$/.exec(value)?.[1] ?? null
  );
}

export function repositoryObjectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value))
    throw new DomainError('INVALID_COMMIT', 'Use an immutable Git object ID');
  return value;
}

/**
 * Validate public import inputs before they reach Git or Artifacts. The v0
 * boundary permits canonical hosted Git URLs, not arbitrary network endpoints.
 * Private remotes use ordinary Git pushes and separately scoped credentials.
 *
 * @param {object} source Public HTTPS URL and optional branch/depth.
 * @param {string[]|string} hosts Operator subset of the built-in public forge hosts.
 * @returns {object} Normalized credential-free source parameters.
 * @throws {DomainError} The source is outside the public import boundary.
 */
export function repositoryImportSource(source, hosts = publicImportHosts) {
  let url;
  try {
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.keys(source).some((key) => !['url', 'branch', 'depth'].includes(key)) ||
      typeof source.url !== 'string' ||
      source.url.length > 2048
    )
      throw new Error();
    url = new URL(source.url);
  } catch {
    throw new DomainError('INVALID_IMPORT_SOURCE', 'Use a public HTTPS Git remote');
  }
  const allowed = typeof hosts === 'string' ? hosts.split(',').map((host) => host.trim()) : hosts;
  const parts = url.pathname.split('/').slice(1);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !Array.isArray(allowed) ||
    !allowed.includes(url.hostname) ||
    !publicImportHosts.includes(url.hostname) ||
    source.url !== url.href ||
    parts.length < 2 ||
    (url.hostname === 'github.com' && parts.length !== 2) ||
    parts.some(
      (part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part) || part === '.' || part === '..',
    ) ||
    parts.at(-1) === '.git'
  )
    throw new DomainError(
      'IMPORT_SOURCE_NOT_ALLOWED',
      'Import requires a canonical public GitHub or GitLab HTTPS remote without credentials, query, or fragment',
      422,
    );
  let branch;
  if (source.branch !== undefined) {
    if (typeof source.branch !== 'string')
      throw new DomainError('INVALID_REF', 'Use a valid source branch');
    branch = repositoryRef('refs/heads/' + source.branch).slice(11);
  }
  const depth = source.depth ?? 100;
  if (!Number.isInteger(depth) || depth < 1 || depth > 1000)
    throw new DomainError('IMPORT_DEPTH_LIMIT', 'Import depth must be between 1 and 1000', 422);
  return { url: url.href, ...(branch ? { branch } : {}), depth };
}

export function verifyForkState(observed, source) {
  repositoryObjectId(source.commit);
  repositoryObjectId(source.tree);
  if (observed.status === 'importing' || observed.status === 'forking') return observed;
  if (observed.commit !== source.commit || observed.tree !== source.tree)
    throw new DomainError(
      'FORK_BASELINE_CHANGED',
      'The fork does not contain the requested exact baseline; inspect the retained repository',
      409,
    );
  return observed;
}
