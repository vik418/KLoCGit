import { DomainError } from '../core/hash.mjs';

const roots = ['/api/native-state', '/api/systems', '/api/objectives', '/api/futures', '/api/repository-requests'];

export function ownsNativePath(path) {
  return path === '/api/repositories' || /^\/api\/repositories\/[^/]+\/refresh$/.test(path) ||
    roots.some((root) => path === root || path.startsWith(root + '/'));
}

function pick(input, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
}

function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim())
    throw new DomainError('UNAUTHENTICATED', 'An authenticated actor is required', 401);
}

function methodError() {
  throw new DomainError('METHOD_NOT_ALLOWED', 'This native operation does not support that method', 405);
}

/**
 * Native HTTP dispatch, shared by local and Worker transports.
 * The caller authenticates and serializes mutations; request-body identities
 * cannot select audit actors or grant trusted validation/provenance.
 */
export async function handleNativeRequest(engine, { method, url, input = {}, actor }) {
  const parsed = url instanceof URL ? url : new URL(url, 'http://coordination.internal');
  const path = parsed.pathname;
  if (!ownsNativePath(path)) return null;
  requireActor(actor);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DomainError('INVALID_REQUEST', 'Native input must be a JSON object');
  if (!engine.native)
    throw new DomainError('NATIVE_STATE_UNAVAILABLE', 'Native state service is unavailable', 503);
  const native = engine.native;
  if (path === '/api/native-state') {
    if (method !== 'GET') methodError();
    return native.view(actor);
  }
  if (path === '/api/repositories') {
    if (method === 'GET') return { repositories: native.view(actor).repositories };
    if (method === 'POST') return native.registerRepository(
      pick(input, ['id', 'ref', 'mode', 'description', 'source', 'request_id']), actor,
    );
    methodError();
  }
  const repository = path.match(/^\/api\/repositories\/([^/]+)\/refresh$/);
  if (repository) {
    if (method !== 'POST') methodError();
    return native.refreshRepository(repository[1], pick(input, ['request_id']), actor);
  }
  if (path === '/api/systems') {
    if (method === 'GET') return { systems: native.view(actor).systems };
    if (method === 'POST') return native.createSystem(
      pick(input, ['name', 'description', 'repository_ids', 'request_id']), actor,
    );
    methodError();
  }
  const system = path.match(/^\/api\/systems\/([^/]+)$/);
  if (system) {
    if (method !== 'GET') methodError();
    const result = native.view(actor).systems.find((item) => item.id === system[1]);
    if (!result) throw new DomainError('SYSTEM_NOT_FOUND', 'System not found', 404);
    return { system: result };
  }
  if (path === '/api/objectives') {
    if (method === 'GET') return { objectives: native.view(actor).objectives };
    if (method === 'POST') return native.createObjective(
      pick(input, ['system_id', 'statement', 'scope', 'request_id']), actor,
    );
    methodError();
  }
  const objective = path.match(/^\/api\/objectives\/([^/]+)(?:\/(futures))?$/);
  if (objective) {
    if (!objective[2] && method === 'GET') return { objective: structuredClone(native.objective(objective[1])) };
    if (objective[2] && method === 'POST') return native.createFuture({
      ...pick(input, ['name', 'producer', 'repository_ids', 'request_id']), objective_id: objective[1],
    }, actor);
    methodError();
  }
  if (path === '/api/futures') {
    if (method === 'GET') return { futures: native.view(actor).futures };
    if (method === 'POST') return native.createFuture(
      pick(input, ['system_id', 'objective_id', 'repository_ids', 'statement', 'name', 'producer', 'request_id']), actor,
    );
    methodError();
  }
  const future = path.match(/^\/api\/futures\/([^/]+)(?:\/(revisions|observe|abandon))?$/);
  if (future) {
    if (method === 'GET' && (!future[2] || future[2] === 'revisions')) {
      const value = native.future(future[1]);
      const revisions = native.state.futureRevisions.filter((revision) => revision.future_id === value.id);
      return future[2] ? { revisions: structuredClone(revisions) } : structuredClone({ future: value, revisions });
    }
    if (method === 'POST' && future[2] === 'observe')
      return native.observeFuture(future[1], pick(input, ['expected_version', 'request_id']), actor);
    if (method === 'POST' && future[2] === 'abandon')
      return native.abandonFuture(future[1], pick(input, ['expected_version', 'request_id']), actor);
    methodError();
  }
  const request = path.match(/^\/api\/repository-requests\/([^/]+)(?:\/(recover))?$/);
  if (request) {
    if (method === 'POST' && request[2])
      return native.recoverRequest(request[1], pick(input, ['request_id']), actor);
    if (method === 'GET' && !request[2]) {
      const value = native.object('nativeRequests', request[1], 'REQUEST_NOT_FOUND');
      const details = Object.fromEntries(Object.entries(value).filter(([key]) => !['input', 'result'].includes(key)));
      return { request: structuredClone(details) };
    }
    methodError();
  }
  throw new DomainError('NOT_FOUND', 'Native endpoint not found', 404);
}
