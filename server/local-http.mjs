import { DomainError } from '../core/hash.mjs';
import { authenticateRequest } from '../worker/identity.mjs';

export async function readRequestPayload(request, limit = 1_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit)
      throw new DomainError('PAYLOAD_TOO_LARGE', 'Request exceeds the configured limit', 413);
    chunks.push(buffer);
  }
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return { input: raw ? JSON.parse(raw) : {}, raw, bytes };
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be JSON');
  }
}
export async function readRequestBody(request, limit) {
  return (await readRequestPayload(request, limit)).input;
}
export function jsonResponse(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}
function header(request, name) {
  return typeof request.headers.get === 'function'
    ? request.headers.get(name)
    : request.headers[name.toLowerCase()];
}
function loopback(value) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
}
/** Compatibility helper for direct tests; the real server uses authenticatedPrincipal. */
export function authenticatedActor(request, { actor, ownerToken }) {
  if (ownerToken && header(request, 'authorization') !== 'Bearer ' + ownerToken)
    throw new DomainError('UNAUTHENTICATED', 'The local owner credential is required', 401);
  if (typeof actor !== 'string' || !actor.trim())
    throw new DomainError('UNAUTHENTICATED', 'Configure the local owner identity', 401);
  return actor;
}
export async function authenticatedPrincipal(
  request,
  { actor, ownerToken, host = '127.0.0.1', identityEnv = {} },
) {
  const configuredOIDC = [
    identityEnv.OIDC_ISSUER,
    identityEnv.OIDC_AUDIENCE,
    identityEnv.OIDC_JWKS_URL,
  ].some((value) => value !== undefined && value !== '');
  if (!ownerToken && !configuredOIDC) {
    let allowedHost = false;
    try {
      allowedHost = loopback(new URL('http://' + header(request, 'host')).hostname);
    } catch {
      /* Fail closed. */
    }
    if (!loopback(host) || !allowedHost)
      throw new DomainError(
        'AUTH_NOT_CONFIGURED',
        'Remote access requires an owner credential or configured OIDC',
        503,
      );
    return Object.freeze({
      actor_id: authenticatedActor(request, { actor }),
      kind: 'human',
      auth_method: 'owner-token',
    });
  }
  const headers = new Headers();
  for (const name of ['Authorization', 'Cf-Access-Jwt-Assertion']) {
    const value = header(request, name);
    if (typeof value === 'string') headers.set(name, value);
  }
  return authenticateRequest(new Request('http://localhost/api/session', { headers }), {
    ...identityEnv,
    AUTH_TOKEN: ownerToken,
    ACTOR_ID: actor,
  });
}
export function assertSameOrigin(request) {
  const originValue = header(request, 'origin');
  if (['GET', 'HEAD'].includes(request.method) || !originValue) return;
  let allowed = false;
  try {
    allowed = new URL(originValue).host === header(request, 'host');
  } catch {
    /* Fail closed. */
  }
  if (!allowed)
    throw new DomainError('FORBIDDEN_ORIGIN', 'Cross-origin mutations are not allowed', 403);
}
