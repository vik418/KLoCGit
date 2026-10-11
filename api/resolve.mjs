/** Fetch handler. Scope and authenticated identity come from trusted routing. */
import { V1Error } from '../core/v1/conventions.mjs';
import { coordinationScope } from '../core/v1/coordination.mjs';
import { PRIVATE_JSON_HEADERS, errorResponse } from './http.mjs';

export async function readBoundedJson(request, maximum) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw new V1Error('INVALID_ARGUMENT');
  const reader = request.body?.getReader();
  if (!reader) throw new V1Error('INVALID_ARGUMENT');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new V1Error('INVALID_ARGUMENT');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof V1Error) throw error;
    throw new V1Error('INVALID_ARGUMENT');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createResolveHandler({ scope, authenticate, service, max_request_bytes }) {
  const target = coordinationScope(scope);
  if (
    typeof authenticate !== 'function' ||
    typeof service?.resolve !== 'function' ||
    !Number.isSafeInteger(max_request_bytes) ||
    max_request_bytes < 1
  )
    throw new V1Error('INVALID_ARGUMENT');
  return async (request) => {
    const headers = PRIVATE_JSON_HEADERS;
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
    try {
      const principal = await authenticate(request);
      if (!principal) throw new V1Error('UNAUTHENTICATED');
      const body = await readBoundedJson(request, max_request_bytes);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'scope'))
        throw new V1Error('INVALID_ARGUMENT');
      const decision = await service.resolve({ ...body, scope: target }, { principal });
      return Response.json({ schema_version: 1, decision }, { headers });
    } catch (error) {
      return errorResponse(error, headers);
    }
  };
}
