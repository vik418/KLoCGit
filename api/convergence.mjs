/** Authenticated v1 routes. Scope comes from routing, never request JSON. */
import { V1Error } from '../core/v1/conventions.mjs';
import { coordinationScope } from '../core/v1/coordination.mjs';
import { PRIVATE_JSON_HEADERS, errorResponse } from './http.mjs';
import { readBoundedJson } from './resolve.mjs';

export function createConvergenceHandler({ scope, authenticate, convergence, resolution, promotion, max_request_bytes }) {
  const target = coordinationScope(scope);
  if (target.kind !== 'REF' || typeof authenticate !== 'function' || !Number.isSafeInteger(max_request_bytes) || max_request_bytes < 1 || typeof convergence?.discover !== 'function' || typeof convergence?.review !== 'function' || typeof resolution?.resolve !== 'function' || typeof promotion?.promote !== 'function' || typeof promotion?.reconcile !== 'function')
    throw new V1Error('INVALID_ARGUMENT');
  return async (request) => {
    try {
      const principal = await authenticate(request);
      if (!principal) throw new V1Error('UNAUTHENTICATED');
      const path = new URL(request.url).pathname;
      const match = path.match(/^\/api\/v1\/decisions\/([^/]+)(?:\/(resolve|promote|reconcile))?$/);
      if (request.method === 'GET' && match && !match[2])
        return Response.json(await convergence.review(target, match[1], { principal }), { headers: PRIVATE_JSON_HEADERS });
      if (request.method !== 'POST')
        return new Response(null, { status: 405, headers: { ...PRIVATE_JSON_HEADERS, allow: 'POST' } });
      const body = await readBoundedJson(request, max_request_bytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new V1Error('INVALID_ARGUMENT');
      const reserved = ['scope', 'decision_id', 'actor_id', 'tenant_id', 'system_id', 'repo_id', 'ref'];
      if (reserved.some((key) => Object.hasOwn(body, key))) throw new V1Error('INVALID_ARGUMENT');
      if (path === '/api/v1/convergence')
        return Response.json(await convergence.discover({ ...body, scope: target }, { principal }), { headers: PRIVATE_JSON_HEADERS });
      if (!match?.[2]) throw new V1Error('NOT_FOUND');
      if (match[2] === 'resolve')
        return Response.json(await resolution.resolve({ ...body, scope: target, decision_id: match[1] }, { principal }), { headers: PRIVATE_JSON_HEADERS });
      const input = { ...body, tenant_id: target.tenant_id, system_id: target.system_id, ...target.resource_id, decision_id: match[1] };
      return Response.json(await promotion[match[2]](input, { principal }), { headers: PRIVATE_JSON_HEADERS });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
