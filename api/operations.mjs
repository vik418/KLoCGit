import { V1Error } from '../core/v1/conventions.mjs';
import { PRIVATE_JSON_HEADERS, errorResponse } from './http.mjs';

export function createOperationsHandler({ authenticate, service }) {
  if (typeof authenticate !== 'function' || typeof service?.read !== 'function')
    throw new V1Error('INVALID_ARGUMENT');
  return async (request) => {
    if (request.method !== 'GET')
      return new Response(null, {
        status: 405,
        headers: { ...PRIVATE_JSON_HEADERS, allow: 'GET' },
      });
    try {
      const principal = await authenticate(request);
      if (!principal) throw new V1Error('UNAUTHENTICATED');
      return Response.json(await service.read(principal), { headers: PRIVATE_JSON_HEADERS });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
