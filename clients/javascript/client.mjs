/** Small HTTP client for the versioned klocgit coordination API. */
export class KlocgitError extends Error {
  constructor(status, data) {
    super(typeof data?.message === 'string' ? data.message : 'klocgit request failed');
    this.name = 'KlocgitError';
    this.status = status;
    this.code = data?.error ?? 'HTTP_ERROR';
    this.details = data;
  }
}

/**
 * Create a client without persisting credentials or retrying mutations.
 *
 * @param {object} options Client configuration.
 * @param {string} options.baseUrl Absolute origin or /api URL.
 * @param {() => string|Promise<string>} [options.getToken] Current credential.
 * @param {typeof fetch} [options.fetch] Fetch implementation.
 * @returns {object} Native coordination API methods.
 */
export function createClient({
  baseUrl,
  getToken = () => null,
  fetch: fetcher = globalThis.fetch,
}) {
  const base = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new TypeError('Use a credential-free HTTP origin or API URL');
  const prefix = base.pathname.replace(/\/$/, '');
  base.pathname = prefix.endsWith('/api') ? prefix + '/' : prefix + '/api/';
  const id = (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('An object ID is required');
    return encodeURIComponent(value);
  };
  async function request(path, { method = 'GET', body, signal, headers: extra = {} } = {}) {
    const headers = new Headers(extra);
    headers.set('accept', 'application/json');
    const token = await getToken();
    if (token) headers.set('authorization', 'Bearer ' + token);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetcher(new URL(path, base), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new KlocgitError(response.status, data);
    return data;
  }
  function mutate(path, body, options) {
    if (typeof body?.request_id !== 'string' || !body.request_id.trim())
      throw new TypeError('Supply a stable request_id and reuse it after a lost response');
    // Canonical writes are never automatically retried or given a fresh request ID.
    return request(path, { ...options, method: 'POST', body });
  }
  return Object.freeze({
    session: (options) => request('session', options),
    state: (options) => request('native-state', options),
    createRepository: (body, options) => mutate('repositories', body, options),
    createSystem: (body, options) => mutate('systems', body, options),
    createObjective: (body, options) => mutate('objectives', body, options),
    createFuture: (body, options) => mutate('futures', body, options),
    observeFuture: (futureId, body, options) =>
      mutate('futures/' + id(futureId) + '/observe', body, options),
    select: (body, options) => mutate('selections', body, options),
    compose: (body, options) => mutate('candidates', body, options),
    evaluate: (candidateId, body, options) =>
      mutate('candidates/' + id(candidateId) + '/validate', body, options),
    compare: (body, options) => mutate('discovery', body, options),
    review: (candidateId, options) => request('candidates/' + id(candidateId) + '/review', options),
    decide: (groupId, body, options) =>
      mutate('decision-groups/' + id(groupId) + '/resolve', body, options),
    promote: (candidateId, body, options) =>
      mutate('candidates/' + id(candidateId) + '/promote', body, options),
    provenance: (kind, subjectId, options) =>
      request('provenance/' + id(kind) + '/' + id(subjectId), options),
    exportContext: (systemId, options) =>
      request('systems/' + id(systemId) + '/context/export', options),
    request,
  });
}
