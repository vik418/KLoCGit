import { hash } from '../core/hash.mjs';
import { configuredWorkspace } from './config.mjs';

const MAX_REQUEST_BYTES = 1_000_000;

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function authenticated(request, secret) {
  if (!secret) return false;
  const authorization = request.headers.get('Authorization') ?? '';
  const [actual, expected] = await Promise.all([hash(authorization), hash('Bearer ' + secret)]);
  return actual === expected;
}

export async function handlePublicRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

  const ingress = url.pathname === '/api/events';
  const requiredBindings = ingress ? ['INGEST_TOKEN'] : ['AUTH_TOKEN', 'ACTOR_ID'];
  const missingBindings = requiredBindings.filter(
    (name) => typeof env[name] !== 'string' || !env[name].trim(),
  );
  // Missing deployment credentials are an operator error, not a rejected login.
  // Check them before forwarding so an incomplete deployment stays fail-closed.
  if (missingBindings.length) {
    return jsonResponse(
      {
        error: 'AUTH_NOT_CONFIGURED',
        message:
          'Authentication is not configured. Missing or invalid runtime bindings: ' +
          missingBindings.join(', ') +
          '.',
        details: { missing: missingBindings },
      },
      503,
    );
  }

  const secret = ingress ? env.INGEST_TOKEN : env.AUTH_TOKEN;
  if (!(await authenticated(request, secret))) {
    return jsonResponse(
      {
        error: 'UNAUTHENTICATED',
        message: ingress
          ? 'The ingress credential is missing or incorrect. Supply the configured INGEST_TOKEN as a Bearer token.'
          : 'The owner credential is missing or incorrect. Use the token stored as AUTH_TOKEN on this Worker.',
      },
      401,
    );
  }

  let workspace;
  try {
    workspace = configuredWorkspace(env);
  } catch (error) {
    return jsonResponse({ error: error.code, message: error.message }, error.status);
  }

  const origin = request.headers.get('Origin');
  if (request.method !== 'GET' && origin && new URL(origin).origin !== url.origin) {
    return jsonResponse({ error: 'FORBIDDEN_ORIGIN' }, 403);
  }
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_REQUEST_BYTES) {
      return jsonResponse({ error: 'PAYLOAD_TOO_LARGE' }, 413);
    }
    request = new Request(request, { body: raw });
  }

  const id = env.COORDINATOR.idFromName(workspace);
  return env.COORDINATOR.get(id).fetch(request);
}
