import { DomainError } from '../core/hash.mjs';
import { redactSensitive } from '../core/access.mjs';
import { configuredWorkspace } from './config.mjs';
import {
  authenticateRequest,
  authenticateEvaluationReport,
  forwardPrincipal,
} from './identity.mjs';

export const MAX_REQUEST_BYTES = 1_000_000;
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function readBoundedRequest(request, limit = MAX_REQUEST_BYTES) {
  if (['GET', 'HEAD'].includes(request.method) || !request.body) return { raw: '', bytes: 0 };
  if (Number(request.headers.get('Content-Length') ?? 0) > limit)
    throw new DomainError('PAYLOAD_TOO_LARGE', 'Request exceeds the configured limit', 413);
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new DomainError('PAYLOAD_TOO_LARGE', 'Request exceeds the configured limit', 413);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { raw: new TextDecoder('utf-8', { fatal: true }).decode(buffer), bytes };
  } catch {
    throw new DomainError('INVALID_JSON', 'Request must contain valid UTF-8 JSON');
  }
}

export async function handlePublicRequest(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  try {
    const workspace = configuredWorkspace(env);
    const origin = request.headers.get('Origin');
    if (!['GET', 'HEAD'].includes(request.method) && origin) {
      let allowed = false;
      try {
        allowed = new URL(origin).origin === url.origin;
      } catch {
        /* Reject invalid origins. */
      }
      if (!allowed)
        throw new DomainError('FORBIDDEN_ORIGIN', 'Cross-origin mutations are not allowed', 403);
    }
    const report =
      request.method === 'POST' && url.pathname.match(/^\/api\/evaluation-runs\/([^/]+)\/report$/);
    let principal;
    let payload;
    if (report) {
      payload = await readBoundedRequest(request);
      let input;
      try {
        input = JSON.parse(payload.raw);
      } catch {
        throw new DomainError('INVALID_JSON', 'Request body must be JSON');
      }
      principal = await authenticateEvaluationReport(request, env, input, report[1]);
    } else {
      principal = await authenticateRequest(request, env, {
        ingress: url.pathname === '/api/events',
      });
      payload = await readBoundedRequest(request);
    }
    request = new Request(request, {
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : payload.raw,
    });
    const forwarded = await forwardPrincipal(request, principal, env);
    const id = env.COORDINATOR.idFromName(workspace);
    return env.COORDINATOR.get(id).fetch(forwarded);
  } catch (error) {
    return jsonResponse(
      {
        error: error.code ?? 'INTERNAL_ERROR',
        message: error.status ? error.message : 'Coordination failed. Git remains available.',
        details: redactSensitive(error.details ?? {}),
      },
      error.status ?? 500,
    );
  }
}
