import { Failure, strictUtf8, validateScope } from './runtime.ts';
import type { Bindings, Scope } from './runtime.ts';

export type Action = 'read' | 'ingest' | 'agent:mint' | 'promote';
export interface Principal {
  sub: string;
  actor_type: 'human' | 'agent' | 'service';
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  grants: { scope: Scope; actions: Action[] }[];
  capability?: { id: string; scope: Scope; budget: number };
}

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Failure('UNAUTHENTICATED', 401, 'Invalid token');
  try { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0)); }
  catch { throw new Failure('UNAUTHENTICATED', 401, 'Invalid token'); }
}

async function key(secret: string): Promise<CryptoKey> {
  if (!secret || encoder.encode(secret).length < 32) throw new Failure('AUTH_NOT_CONFIGURED', 503, 'Authentication is not configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(claims: unknown, secret: string): Promise<string> {
  const header = base64(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64(encoder.encode(JSON.stringify(claims)));
  const body = header + '.' + payload;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body)));
  return body + '.' + base64(signature);
}

export async function verifyToken<T>(token: string, secret: string): Promise<T> {
  if (token.length > 16 * 1024) throw new Failure('UNAUTHENTICATED', 401, 'Token exceeds limit');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Failure('UNAUTHENTICATED', 401, 'Invalid token');
  let header: { alg?: string; typ?: string };
  try { header = JSON.parse(strictUtf8(decode(parts[0]))); }
  catch { throw new Failure('UNAUTHENTICATED', 401, 'Invalid token'); }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Failure('UNAUTHENTICATED', 401, 'Unsupported token algorithm');
  const valid = await crypto.subtle.verify('HMAC', await key(secret), decode(parts[2]), encoder.encode(parts[0] + '.' + parts[1]));
  if (!valid) throw new Failure('UNAUTHENTICATED', 401, 'Invalid token signature');
  try { return JSON.parse(strictUtf8(decode(parts[1]))); }
  catch { throw new Failure('UNAUTHENTICATED', 401, 'Invalid token'); }
}

export async function authenticate(request: Request, env: Bindings): Promise<Principal> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Failure('UNAUTHENTICATED', 401, 'Authentication is required');
  const claims = await verifyToken<Principal>(authorization.slice(7), env.AUTH_SIGNING_KEY);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== env.AUTH_ISSUER || claims.aud !== env.AUTH_AUDIENCE || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256
    || !['human', 'agent', 'service'].includes(claims.actor_type)
    || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
    || claims.exp <= now || claims.iat > now || claims.exp <= claims.iat
    || !Array.isArray(claims.grants) || claims.grants.length > 128) {
    throw new Failure('UNAUTHENTICATED', 401, 'Invalid or expired identity');
  }
  for (const grant of claims.grants) {
    validateScope(grant.scope);
    if (!Array.isArray(grant.actions) || grant.actions.some((value) => !['read', 'ingest', 'agent:mint', 'promote'].includes(value))) throw new Failure('UNAUTHENTICATED', 401, 'Invalid grants');
  }
  if (claims.actor_type === 'agent') {
    const capability = claims.capability;
    if (!capability || !capability.id || !Number.isSafeInteger(capability.budget) || capability.budget < 0) throw new Failure('UNAUTHENTICATED', 401, 'Agent capability is required');
    validateScope(capability.scope);
  }
  return claims;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.tenant_id === b.tenant_id && a.organization_id === b.organization_id && a.repo_id === b.repo_id && a.objective_id === b.objective_id;
}

export function authorize(principal: Principal, scope: Scope, action: Action): void {
  if (principal.actor_type === 'agent' && (action === 'promote' || action === 'agent:mint'
    || !sameScope(principal.capability!.scope, scope))) throw new Failure('FORBIDDEN', 403, 'Agent scope does not allow this action');
  if (!principal.grants.some((grant) => sameScope(grant.scope, scope) && grant.actions.includes(action))) throw new Failure('FORBIDDEN', 403, 'Resource scope does not allow this action');
}

export interface InternalGrant {
  schema_version: 1;
  aud: 'objective' | 'ref' | 'queue';
  scope: Scope;
  action: string;
  subject_digest: string;
  actor_id: string;
  expires_at: number;
}

export async function verifyInternal(request: Request, env: Bindings, audience: InternalGrant['aud'], action: string, subjectDigest: string): Promise<InternalGrant> {
  const token = request.headers.get('x-klocgit-internal');
  if (!token) throw new Failure('FORBIDDEN', 403, 'Internal authorization is required');
  const grant = await verifyToken<InternalGrant>(token, env.INTERNAL_SIGNING_KEY);
  if (grant.schema_version !== 1 || grant.aud !== audience || grant.action !== action
    || grant.subject_digest !== subjectDigest || !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= Date.now() || !grant.actor_id) throw new Failure('FORBIDDEN', 403, 'Invalid internal authorization');
  validateScope(grant.scope);
  return grant;
}
