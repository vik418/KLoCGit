import { DomainError, hash, stable } from '../core/hash.mjs';

const MAX_JWT_BYTES = 32_768;
const MAX_JWKS_BYTES = 65_536;
const PRINCIPAL_HEADER = 'X-Klocgit-Principal';
const SIGNATURE_HEADER = 'X-Klocgit-Principal-Signature';
const verifiers = new Map();
const signingAlgorithms = Object.freeze({
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
});

function fail(code = 'UNAUTHENTICATED', status = 401) {
  throw new DomainError(
    code,
    status === 503
      ? 'Identity verification is unavailable or not configured'
      : 'A valid authenticated identity is required',
    status,
  );
}
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value, limit) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > limit ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    fail();
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (base64url(bytes) !== value) fail();
    return bytes;
  } catch {
    fail();
  }
}
function objectSegment(segment) {
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decode(segment, MAX_JWT_BYTES)),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    return value;
  } catch {
    fail();
  }
}
function secureUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      fail('AUTH_NOT_CONFIGURED', 503);
    return url;
  } catch {
    fail('AUTH_NOT_CONFIGURED', 503);
  }
}
function identity(principal) {
  if (
    !principal ||
    typeof principal.actor_id !== 'string' ||
    !principal.actor_id.trim() ||
    principal.actor_id.length > 200 ||
    /[\u0000-\u001f]/.test(principal.actor_id) ||
    !['human', 'service', 'internal'].includes(principal.kind) ||
    !['oidc', 'owner-token', 'ingest-token', 'evaluator-hmac', 'internal'].includes(
      principal.auth_method,
    )
  )
    fail();
  if (
    (principal.kind === 'human' && !['oidc', 'owner-token'].includes(principal.auth_method)) ||
    (principal.kind === 'service' &&
      !['ingest-token', 'evaluator-hmac'].includes(principal.auth_method)) ||
    (principal.kind === 'internal' && principal.auth_method !== 'internal')
  )
    fail();
  return Object.freeze({
    actor_id: principal.actor_id,
    kind: principal.kind,
    auth_method: principal.auth_method,
  });
}
async function limitedJson(response) {
  if (!response.ok || !response.body) fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
  if (Number(response.headers.get('Content-Length') ?? 0) > MAX_JWKS_BYTES)
    fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_JWKS_BYTES) {
        await reader.cancel();
        fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Verify signatures against an operator-pinned issuer/audience/JWKS endpoint.
 * Token key URLs and embedded keys are rejected. Expired key caches are never
 * accepted during provider failure. Cache bounds and timeouts are local to each
 * Worker isolate; they are not provider revocation or global rate guarantees.
 */
export class JwtVerifier {
  constructor({
    issuer,
    audience,
    jwksUrl,
    algorithms = ['RS256'],
    fetch: fetcher = globalThis.fetch,
    now = () => Date.now(),
    crypto: cryptoProvider = globalThis.crypto,
    cacheMs = 300_000,
    timeoutMs = 5000,
  }) {
    secureUrl(issuer);
    secureUrl(jwksUrl);
    if (
      typeof audience !== 'string' ||
      !audience.trim() ||
      audience.length > 512 ||
      !Array.isArray(algorithms) ||
      !algorithms.length ||
      algorithms.some((algorithm) => !Object.hasOwn(signingAlgorithms, algorithm)) ||
      new Set(algorithms).size !== algorithms.length ||
      !Number.isSafeInteger(cacheMs) ||
      cacheMs < 1000 ||
      cacheMs > 300_000 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 10_000 ||
      typeof fetcher !== 'function' ||
      !cryptoProvider?.subtle
    )
      fail('AUTH_NOT_CONFIGURED', 503);
    Object.assign(this, {
      issuer,
      audience,
      jwksUrl,
      algorithms: [...algorithms],
      fetcher,
      now,
      crypto: cryptoProvider,
      cacheMs,
      timeoutMs,
    });
    this.keys = [];
    this.imported = new Map();
    this.expiresAt = 0;
    this.lastFetchAt = null;
    this.inflight = null;
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const controller = new AbortController();
      let timeout;
      try {
        const work = (async () => {
          const response = await this.fetcher(this.jwksUrl, {
            redirect: 'error',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });
          return limitedJson(response);
        })();
        const expired = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new DomainError('IDENTITY_PROVIDER_UNAVAILABLE', 'Identity provider timed out', 503),
            );
          }, this.timeoutMs);
        });
        const document = await Promise.race([work, expired]);
        if (
          !document ||
          !Array.isArray(document.keys) ||
          !document.keys.length ||
          document.keys.length > 32
        )
          fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
        const ids = new Set();
        for (const key of document.keys) {
          if (
            !key ||
            typeof key !== 'object' ||
            typeof key.kid !== 'string' ||
            !key.kid ||
            key.kid.length > 200 ||
            ids.has(key.kid) ||
            ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((field) => Object.hasOwn(key, field))
          )
            fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
          ids.add(key.kid);
        }
        this.keys = document.keys;
        this.imported.clear();
        this.lastFetchAt = this.now();
        this.expiresAt = this.lastFetchAt + this.cacheMs;
      } catch {
        fail('IDENTITY_PROVIDER_UNAVAILABLE', 503);
      } finally {
        clearTimeout(timeout);
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  async key(kid, algorithm) {
    if (this.now() >= this.expiresAt) await this.refresh();
    let jwk = this.keys.find((key) => key.kid === kid);
    // Unknown-key traffic cannot repeatedly trigger outbound key refreshes.
    if (!jwk && this.lastFetchAt !== null && this.now() - this.lastFetchAt >= 30_000) {
      await this.refresh();
      jwk = this.keys.find((key) => key.kid === kid);
    }
    if (
      !jwk ||
      (jwk.alg !== undefined && jwk.alg !== algorithm) ||
      (jwk.use !== undefined && jwk.use !== 'sig') ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify')))
    )
      fail();
    if (algorithm === 'RS256') {
      if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') fail();
      const modulus = decode(jwk.n, 2048);
      if (modulus.length < 256 || modulus.length > 1024) fail();
    } else if (
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      decode(jwk.x, 100).length !== 32 ||
      decode(jwk.y, 100).length !== 32
    )
      fail();
    const id = kid + ':' + algorithm;
    if (!this.imported.has(id)) {
      try {
        const key = await this.crypto.subtle.importKey(
          'jwk',
          jwk,
          signingAlgorithms[algorithm],
          false,
          ['verify'],
        );
        if (this.imported.size >= 32) this.imported.delete(this.imported.keys().next().value);
        this.imported.set(id, key);
      } catch {
        fail();
      }
    }
    return this.imported.get(id);
  }

  async verify(token) {
    if (typeof token !== 'string' || token.length > MAX_JWT_BYTES) fail();
    const segments = token.split('.');
    if (segments.length !== 3) fail();
    const header = objectSegment(segments[0]);
    const claims = objectSegment(segments[1]);
    if (
      !this.algorithms.includes(header.alg) ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.kid.length > 200 ||
      (header.typ !== undefined && !['JWT', 'at+jwt'].includes(header.typ)) ||
      Object.hasOwn(header, 'crit') ||
      Object.hasOwn(header, 'b64') ||
      ['jku', 'jwk', 'x5u'].some((field) => Object.hasOwn(header, field))
    )
      fail();
    const seconds = Math.floor(this.now() / 1000);
    const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (
      claims.iss !== this.issuer ||
      !Array.isArray(audience) ||
      !audience.length ||
      audience.length > 10 ||
      audience.some((value) => typeof value !== 'string') ||
      new Set(audience).size !== audience.length ||
      !audience.includes(this.audience) ||
      (audience.length > 1 && claims.azp !== this.audience) ||
      typeof claims.sub !== 'string' ||
      !claims.sub.trim() ||
      claims.sub.length > 512 ||
      /[\u0000-\u001f]/.test(claims.sub) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= seconds ||
      (claims.nbf !== undefined &&
        (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds || claims.nbf >= claims.exp)) ||
      (claims.iat !== undefined &&
        (!Number.isSafeInteger(claims.iat) || claims.iat > seconds || claims.iat >= claims.exp))
    )
      fail();
    const key = await this.key(header.kid, header.alg);
    let valid = false;
    try {
      const algorithm =
        header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : signingAlgorithms.RS256;
      valid = await this.crypto.subtle.verify(
        algorithm,
        key,
        decode(segments[2], MAX_JWT_BYTES),
        new TextEncoder().encode(segments[0] + '.' + segments[1]),
      );
    } catch {
      fail();
    }
    if (!valid) fail();
    return identity({
      actor_id: 'actor_' + (await hash({ issuer: this.issuer, subject: claims.sub })),
      kind: 'human',
      auth_method: 'oidc',
    });
  }
}

function oidcVerifier(env) {
  const values = [env.OIDC_ISSUER, env.OIDC_AUDIENCE, env.OIDC_JWKS_URL];
  if (values.every((value) => value === undefined || value === '')) return null;
  if (values.some((value) => typeof value !== 'string' || !value.trim()))
    fail('AUTH_NOT_CONFIGURED', 503);
  const algorithms =
    env.OIDC_ALLOWED_ALGORITHMS === undefined
      ? ['RS256']
      : String(env.OIDC_ALLOWED_ALGORITHMS)
          .split(',')
          .map((value) => value.trim());
  const configuration = {
    issuer: values[0],
    audience: values[1],
    jwksUrl: values[2],
    algorithms,
  };
  const key = stable(configuration);
  if (!verifiers.has(key)) {
    if (verifiers.size >= 8) verifiers.delete(verifiers.keys().next().value);
    verifiers.set(key, new JwtVerifier(configuration));
  }
  return verifiers.get(key);
}

async function sameSecret(actual, expected) {
  if (typeof expected !== 'string' || !expected.trim()) return false;
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  return a === b;
}

/**
 * Authenticate credentials only; membership authorization runs inside the coordinator.
 * The legacy 'human' category means an individually granted owner/OIDC principal.
 * It does not establish personhood; workloads can use their own OIDC subjects.
 */
function missingConfiguration(names) {
  throw new DomainError(
    'AUTH_NOT_CONFIGURED',
    'Configure ' + names.join(', ') + ' before authenticating requests',
    503,
    { missing: names },
  );
}

/** Authenticate one credential without choosing a workspace or trusting payload identity. */
export async function authenticateRequest(request, env, { ingress = false } = {}) {
  const authorization = request.headers.get('Authorization') ?? '';
  if (authorization.length > MAX_JWT_BYTES + 7) fail();
  const bearer = authorization.match(/^Bearer +([^\s]+)$/i)?.[1] ?? null;
  const configured = (name) => typeof env[name] === 'string' && Boolean(env[name].trim());
  if (ingress) {
    if (!configured('INGEST_TOKEN')) missingConfiguration(['INGEST_TOKEN']);
    if (!bearer || !(await sameSecret(bearer, env.INGEST_TOKEN)))
      throw new DomainError('UNAUTHENTICATED', 'INGEST_TOKEN is missing or incorrect', 401);
    return identity({ actor_id: 'git-ingress', kind: 'service', auth_method: 'ingest-token' });
  }
  const verifier = oidcVerifier(env);
  if (!verifier) {
    const missing = ['AUTH_TOKEN', 'ACTOR_ID'].filter((name) => !configured(name));
    if (missing.length) missingConfiguration(missing);
  }
  if (bearer && (await sameSecret(bearer, env.AUTH_TOKEN))) {
    if (!configured('ACTOR_ID')) missingConfiguration(['ACTOR_ID']);
    return identity({ actor_id: env.ACTOR_ID, kind: 'human', auth_method: 'owner-token' });
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (bearer && assertion && bearer !== assertion) fail();
  if (verifier && (bearer || assertion)) return verifier.verify(bearer || assertion);
  if (!verifier)
    throw new DomainError('UNAUTHENTICATED', 'AUTH_TOKEN is missing or incorrect', 401);
  fail();
}

/** Parse ephemeral evaluator credentials; never include this object in persisted metadata. */
export function evaluatorServices(env) {
  if (env.EVALUATOR_SERVICES === undefined || env.EVALUATOR_SERVICES === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(env.EVALUATOR_SERVICES);
  } catch {
    fail('EVALUATOR_SERVICES_NOT_CONFIGURED', 503);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length > 32
  )
    fail('EVALUATOR_SERVICES_NOT_CONFIGURED', 503);
  const services = {};
  for (const [id, service] of Object.entries(parsed)) {
    if (
      !/^[A-Za-z0-9._-]{1,100}$/.test(id) ||
      !service ||
      typeof service !== 'object' ||
      typeof service.secret !== 'string' ||
      service.secret.length < 16 ||
      service.secret.length > 4096 ||
      typeof service.key_id !== 'string' ||
      !service.key_id.trim() ||
      service.key_id.length > 200 ||
      !Array.isArray(service.repo_ids) ||
      !service.repo_ids.length ||
      service.repo_ids.length > 100 ||
      service.repo_ids.some(
        (repo) => typeof repo !== 'string' || !repo.trim() || repo.length > 200,
      ) ||
      new Set(service.repo_ids).size !== service.repo_ids.length
    )
      fail('EVALUATOR_SERVICES_NOT_CONFIGURED', 503);
    Object.defineProperty(services, id, {
      enumerable: true,
      value: Object.freeze({
        secret: service.secret,
        key_id: service.key_id,
        repo_ids: Object.freeze([...service.repo_ids]),
      }),
    });
  }
  return Object.freeze(services);
}

/** Public preflight; the evaluator rechecks run pins, credential version and scope inside the DO. */
export async function authenticateEvaluationReport(request, env, body, runId) {
  const id = request.headers.get('X-Klocgit-Evaluator-Service');
  const signature = request.headers.get('X-Klocgit-Evaluator-Signature');
  const services = evaluatorServices(env);
  if (
    !id ||
    !Object.hasOwn(services, id) ||
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  )
    fail();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(services[id].secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(signature.match(/.{2}/g), (pair) => parseInt(pair, 16));
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    bytes,
    new TextEncoder().encode(stable({ run_id: runId, body })),
  );
  if (!valid) fail();
  return identity({ actor_id: 'evaluator:' + id, kind: 'service', auth_method: 'evaluator-hmac' });
}

export function internalPrincipal(actor = 'coordinator') {
  if (!['coordinator', 'merge-queue-coordinator', 'artifacts-ingress'].includes(actor)) fail();
  return identity({ actor_id: actor, kind: 'internal', auth_method: 'internal' });
}

async function transportKey(env) {
  const secret = env.COORDINATOR_AUTH_SECRET || env.AUTH_TOKEN;
  if (typeof secret !== 'string' || !secret.trim()) fail('AUTH_NOT_CONFIGURED', 503);
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
function workspaceId(env) {
  if (
    typeof env.WORKSPACE_ID !== 'string' ||
    !env.WORKSPACE_ID.trim() ||
    env.WORKSPACE_ID.length > 200
  )
    fail('AUTH_NOT_CONFIGURED', 503);
  return env.WORKSPACE_ID;
}
async function requestBinding(request) {
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname + url.search,
    body_hash: await hash(
      ['GET', 'HEAD'].includes(request.method) ? '' : await request.clone().text(),
    ),
    service_hash: await hash({
      evaluator_service: request.headers.get('X-Klocgit-Evaluator-Service'),
      evaluator_signature: request.headers.get('X-Klocgit-Evaluator-Signature'),
    }),
  };
}

/**
 * Gateway/queue-to-private-DO transport. User-supplied identity headers are
 * replaced and credentials are removed. The one-minute signed envelope binds
 * the workspace, method, path and body. Mutation request IDs still provide
 * durable replay protection; this envelope does not replace idempotency.
 */
export async function forwardPrincipal(request, principal, env, { now = () => Date.now() } = {}) {
  const seconds = Math.floor(now() / 1000);
  const envelope = {
    v: 1,
    workspace: workspaceId(env),
    ...(await requestBinding(request)),
    issued_at: seconds,
    expires_at: seconds + 60,
    principal: identity(principal),
  };
  const encoded = base64url(new TextEncoder().encode(stable(envelope)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await transportKey(env),
    new TextEncoder().encode(encoded),
  );
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()])
    if (
      (/^x-klocgit-/i.test(key) &&
        !['x-klocgit-evaluator-service', 'x-klocgit-evaluator-signature'].includes(
          key.toLowerCase(),
        )) ||
      ['authorization', 'cookie', 'cf-access-jwt-assertion', 'x-actor-id'].includes(
        key.toLowerCase(),
      )
    )
      headers.delete(key);
  headers.set(PRINCIPAL_HEADER, encoded);
  headers.set(SIGNATURE_HEADER, base64url(new Uint8Array(signature)));
  return new Request(request, { headers });
}

/** Reject direct requests and stale/tampered envelopes before reading any domain input. */
export async function trustedPrincipal(request, env, { now = () => Date.now() } = {}) {
  const encoded = request.headers.get(PRINCIPAL_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!encoded || encoded.length > 4096 || !signature) fail();
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await transportKey(env),
      decode(signature, 100),
      new TextEncoder().encode(encoded),
    );
  } catch (error) {
    if (error.status === 503) throw error;
    fail();
  }
  if (!valid) fail();
  const envelope = objectSegment(encoded);
  const seconds = Math.floor(now() / 1000);
  const binding = await requestBinding(request);
  if (
    envelope.v !== 1 ||
    envelope.workspace !== workspaceId(env) ||
    !Number.isSafeInteger(envelope.issued_at) ||
    !Number.isSafeInteger(envelope.expires_at) ||
    envelope.issued_at > seconds ||
    envelope.expires_at <= seconds ||
    envelope.expires_at - envelope.issued_at !== 60 ||
    envelope.method !== binding.method ||
    envelope.path !== binding.path ||
    envelope.body_hash !== binding.body_hash ||
    envelope.service_hash !== binding.service_hash
  )
    fail();
  return identity(envelope.principal);
}
