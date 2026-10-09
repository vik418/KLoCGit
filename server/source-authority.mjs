import { DomainError } from '../core/hash.mjs';

const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const sourceOperations = new Set([
  'retain-observation',
  'read-ref',
  'list-refs',
  'compose',
  'compose-selections',
  'is-ancestor',
  'merge-base',
  'validate',
  'suite',
  'profile',
  'trailers',
  'diff',
]);
const canonicalOperations = new Set(['cas', 'compose', 'compose-selections', 'revert']);
export const SOURCE_TOKEN_TTL = 900;

function reject(code = 'SOURCE_AUTHORITY_INVALID') {
  throw new DomainError(code, 'The private source authority does not match this operation', 403);
}

/** Source pairs come only from core-owned Future/fork records, never producer HTTP fields. */
export function requestSourceBindings(operation, payload) {
  const pairs = new Map();
  const add = (id, canonical) => {
    if (!name.test(id ?? '') || !name.test(canonical ?? '') || id === canonical) reject();
    if (pairs.has(id) && pairs.get(id) !== canonical) reject();
    pairs.set(id, canonical);
  };
  if (payload.canonical_repo && payload.canonical_repo !== payload.repo) {
    if (canonicalOperations.has(operation)) reject('SOURCE_WRITE_FORBIDDEN');
    add(payload.repo, payload.canonical_repo);
  }
  for (const entry of [...(payload.revisions ?? []), ...(payload.selections ?? [])]) {
    if (entry.source_repo && entry.source_repo !== payload.repo)
      add(entry.source_repo, payload.repo);
  }
  if (pairs.size && !sourceOperations.has(operation)) reject('SOURCE_WRITE_FORBIDDEN');
  if (pairs.size > 100) reject();
  return [...pairs].map(([id, canonical_repo]) => ({ id, canonical_repo }));
}

/** Parse one exact credential-free Artifacts Git URL; account and namespace stay pinned. */
export function artifactRemote(remote, id) {
  let url;
  try {
    url = new URL(remote);
  } catch {
    reject();
  }
  const parts = url.pathname.split('/');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !url.hostname.endsWith('.artifacts.cloudflare.net') ||
    parts.length !== 4 ||
    parts[1] !== 'git' ||
    !name.test(parts[2]) ||
    parts[3] !== id + '.git'
  )
    reject();
  return { remote: url.href, origin: url.origin, namespace: parts[2] };
}

export function validSourceToken(value, now = Date.now()) {
  const expiry = typeof value?.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  return (
    value?.scope === 'read' &&
    typeof value.plaintext === 'string' &&
    value.plaintext.length > 0 &&
    value.plaintext.length <= 4096 &&
    !/[\r\n\0]/.test(value.plaintext) &&
    Number.isFinite(expiry) &&
    expiry > now &&
    expiry <= now + (SOURCE_TOKEN_TTL + 30) * 1000
  );
}

/**
 * Validate a private per-call credential envelope against operator-owned canonical
 * policy. The returned map is process memory only and grants reads, never pushes.
 */
export function admittedSources(manifest, operation, payload, now = Date.now()) {
  const bindings = requestSourceBindings(operation, payload);
  const expected = new Map(bindings.map((entry) => [entry.id, entry.canonical_repo]));
  const sources = payload.source_credentials ?? [];
  if (!Array.isArray(sources) || sources.length > 100) reject();
  const result = new Map();
  for (const source of sources) {
    if (!source || expected.get(source.id) !== source.canonical_repo || result.has(source.id))
      reject();
    const canonical = manifest.repositories?.[source.canonical_repo];
    if (!canonical) reject();
    const baseline = artifactRemote(canonical.remote, source.canonical_repo);
    const remote = artifactRemote(source.remote, source.id);
    if (
      baseline.origin !== remote.origin ||
      baseline.namespace !== remote.namespace ||
      !validSourceToken(source, now)
    )
      reject();
    // New Future repo identities bind the canonical prefix and a content-addressed suffix.
    // Older explicitly configured fork identities retain their operator admission.
    const prefix = source.canonical_repo.slice(0, 40) + '--';
    if (
      !manifest.repositories?.[source.id] &&
      (!source.id.startsWith(prefix) || !/^[a-f0-9]{40}$/.test(source.id.slice(prefix.length)))
    )
      reject();
    result.set(source.id, {
      id: source.id,
      canonical_repo: source.canonical_repo,
      remote: remote.remote,
      validation_profile: canonical.validation_profile ?? null,
      context_repo: canonical.context_repo ?? canonical.dependencies?.[0] ?? null,
      readonly: true,
      plaintext: source.plaintext,
      expiresAt: source.expiresAt,
    });
  }
  for (const { id } of bindings)
    if (!result.has(id) && !manifest.repositories?.[id]) reject('SOURCE_CREDENTIAL_REQUIRED');
  return result;
}
