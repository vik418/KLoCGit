import { DomainError } from '../core/hash.mjs';

export async function readRequestBody(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      throw new DomainError('PAYLOAD_TOO_LARGE', 'Request exceeds 1MB', 413);
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be JSON');
  }
}

export function jsonResponse(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

export function authenticatedActor(request, { actor, ownerToken }) {
  if (ownerToken && request.headers.authorization !== 'Bearer ' + ownerToken) {
    throw new DomainError(
      'UNAUTHENTICATED',
      'The configured local owner credential is required',
      401,
    );
  }
  if (!actor.trim()) {
    throw new DomainError('UNAUTHENTICATED', 'A configured local owner identity is required', 401);
  }
  return actor;
}

export function assertSameOrigin(request) {
  if (request.method === 'GET' || !request.headers.origin) return;
  const origin = new URL(request.headers.origin);
  if (origin.host !== request.headers.host) {
    throw new DomainError('FORBIDDEN_ORIGIN', 'Cross-origin mutations are not allowed', 403);
  }
}
