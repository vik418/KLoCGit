/** Fetch handler. Scope and authenticated identity come from trusted routing. */
import { V1Error, publicError } from '../core/v1/conventions.mjs';
import { coordinationScope } from '../core/v1/coordination.mjs';

const status = {
  AUTHORIZATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INCOMPLETE: 409,
  POLICY: 409,
  VALIDATION: 400,
  UNSUPPORTED: 422,
  INTEGRITY: 422,
  TRANSIENT: 503,
  AMBIGUOUS: 503,
  INTERNAL: 500,
};

async function boundedJson(request, maximum) {
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
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' };
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
    try {
      const principal = await authenticate(request);
      if (!principal) throw new V1Error('UNAUTHENTICATED');
      const body = await boundedJson(request, max_request_bytes);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'scope'))
        throw new V1Error('INVALID_ARGUMENT');
      const decision = await service.resolve({ ...body, scope: target }, { principal });
      return Response.json({ schema_version: 1, decision }, { headers });
    } catch (error) {
      const failure = publicError(error);
      return Response.json(
        { schema_version: 1, error: failure },
        {
          status: failure.code === 'UNAUTHENTICATED' ? 401 : status[failure.failure_class],
          headers,
        },
      );
    }
  };
}
