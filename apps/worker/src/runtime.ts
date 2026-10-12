import type { FutureRevision, CanonicalFutureRevisionState } from '../../../packages/contracts/src/index.ts';

export interface Scope {
  tenant_id: string;
  organization_id: string;
  repo_id: string;
  objective_id: string;
}

export interface Bindings {
  OBJECTIVES: DurableObjectNamespace;
  REFS: DurableObjectNamespace;
  PAYLOADS: R2Bucket;
  ANALYSIS_QUEUE: Queue;
  DEAD_LETTER_QUEUE: Queue;
  GIT_EXECUTOR: Fetcher;
  ENGINE: Fetcher;
  AUTH_SIGNING_KEY: string;
  INTERNAL_SIGNING_KEY: string;
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
}

export interface ObservedRevision {
  state: CanonicalFutureRevisionState;
  revision: FutureRevision;
}

export class Failure extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Failure('INVALID_INPUT', 400, 'Invalid resource identifier');
  return value;
}

export function validateScope(value: Scope): Scope {
  for (const key of ['tenant_id', 'organization_id', 'repo_id', 'objective_id'] as const) identifier(value[key]);
  return value;
}

export function failureResponse(error: unknown): Response {
  const failure = error instanceof Failure ? error : new Failure('INTERNAL_ERROR', 500, 'Request could not be completed');
  return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
}

export async function readJson<T>(request: Request, maxBytes = 32 * 1024): Promise<T> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw new Failure('PAYLOAD_TOO_LARGE', 413, 'Request exceeds limit');
  const reader = request.body?.getReader();
  if (!reader) throw new Failure('INVALID_INPUT', 400, 'Request body is required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new Failure('PAYLOAD_TOO_LARGE', 413, 'Request exceeds limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Failure('INVALID_INPUT', 400, 'Invalid JSON'); }
}
