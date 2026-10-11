/** Scoped host-side reads. Untrusted processes receive data, never credentials or sockets. */
import { V1Error, assertSchemaVersion, digestBytes, parseDigest } from './conventions.mjs';
import { copyJsonData } from './domain.mjs';
import { authenticatedPrincipal } from './authorization.mjs';

function valid(condition, code = 'INVALID_ARGUMENT') {
  if (!condition) throw new V1Error(code);
}
function text(value) {
  valid(typeof value === 'string' && value.length > 0 && value.length <= 1024);
}

/** Catch literal and common encodings; process isolation prevents access in the first place. */
export function containsSecret(input, secrets) {
  valid(input instanceof Uint8Array && Array.isArray(secrets));
  const body = new TextDecoder().decode(input);
  return secrets.some((secret) => {
    valid(secret instanceof Uint8Array && secret.length > 0);
    const value = new TextDecoder('utf-8', { fatal: true }).decode(secret);
    // Build the binary string without an argument spread, which overflows for
    // large credentials and would turn screening into an availability failure.
    let binary = '';
    for (const byte of secret) binary += String.fromCharCode(byte);
    const base64 = btoa(binary);
    return [
      value,
      encodeURIComponent(value),
      base64,
      base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''),
      [...secret].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    ].some((encoded) => body.includes(encoded));
  });
}

export class SecretNetworkBroker {
  constructor({
    tenant_id,
    system_id,
    principal,
    authorize,
    resolveResource,
    readObject,
    resolveSecret,
    secretGuard,
    audit,
    allowed_origins,
    fetch: request = globalThis.fetch,
    max_bytes,
    timeout_ms,
    now,
  }) {
    text(tenant_id);
    text(system_id);
    valid(
      [
        authorize,
        resolveResource,
        readObject,
        resolveSecret,
        secretGuard,
        audit,
        request,
        now,
      ].every((value) => typeof value === 'function'),
    );
    valid(
      Array.isArray(allowed_origins) &&
        Number.isSafeInteger(max_bytes) &&
        max_bytes > 0 &&
        Number.isSafeInteger(timeout_ms) &&
        timeout_ms > 0,
    );
    const origins = new Set(
      allowed_origins.map((origin) => {
        const url = new URL(origin);
        valid(
          url.href === url.origin + '/' &&
            !url.username &&
            !url.password &&
            (url.protocol === 'https:' ||
              (url.protocol === 'http:' &&
                ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))),
        );
        return url.origin;
      }),
    );
    Object.assign(this, {
      tenant_id,
      system_id,
      principal: authenticatedPrincipal(principal),
      authorize,
      resolveResource,
      readObject,
      resolveSecret,
      secretGuard,
      audit,
      origins,
      fetch: request,
      max_bytes,
      timeout_ms,
      now,
    });
  }

  async #http(resource) {
    const url = new URL(resource.url);
    valid(this.origins.has(url.origin) && !url.username && !url.password && !url.hash, 'FORBIDDEN');
    const headers = { accept: 'application/octet-stream' };
    let credential;
    try {
      if (resource.credential_id !== null) {
        const registered = await this.resolveSecret(resource.credential_id);
        assertSchemaVersion(registered);
        valid(
          registered.purpose === 'sandbox-resource-read' &&
            registered.resource_id === resource.id &&
            registered.bytes instanceof Uint8Array &&
            registered.bytes.length > 0 &&
            registered.bytes.length <= this.max_bytes &&
            Number.isSafeInteger(registered.expires_ms) &&
            registered.expires_ms > this.now(),
          'FORBIDDEN',
        );
        // Cleanup owns this copy only. A rejected operation must not erase a
        // credential in the host registry or affect another in-flight read.
        credential = { ...registered, bytes: registered.bytes.slice() };
        const token = new TextDecoder('utf-8', { fatal: true }).decode(credential.bytes);
        valid(!/[\r\n\0]/.test(token), 'FORBIDDEN');
        headers.authorization = 'Bearer ' + token;
      }
      const response = await this.fetch(url.href, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout_ms),
        headers,
      });
      valid(response.ok && response.body, 'PROVIDER_UNAVAILABLE');
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > this.max_bytes) {
            await reader.cancel();
            throw new V1Error('INCOMPLETE_ANALYSIS');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      valid(!credential || !containsSecret(bytes, [credential.bytes]), 'FORBIDDEN');
      return bytes;
    } finally {
      credential?.bytes?.fill(0);
      delete headers.authorization;
    }
  }

  async read(resource_id, scopeInput) {
    text(resource_id);
    const scope = copyJsonData(scopeInput);
    assertSchemaVersion(scope);
    valid(Object.keys(scope).length === 5);
    parseDigest(scope.candidate_digest, 'object-candidate');
    text(scope.trace_id);
    valid(
      scope.tenant_id === this.tenant_id &&
        scope.system_id === this.system_id &&
        this.principal.tenant_id === this.tenant_id,
      'FORBIDDEN',
    );
    const authorization = { ...scope, action: 'sandbox.resource.read', resource_id };
    valid((await this.authorize(this.principal, authorization)) === true, 'FORBIDDEN');
    const record = {
      schema_version: 1,
      tenant_id: scope.tenant_id,
      system_id: scope.system_id,
      trace_id: scope.trace_id,
      object_id: resource_id,
      candidate_digest: scope.candidate_digest,
      event: 'sandbox.resource.read',
      from_state: null,
      to_state: 'REQUESTED',
      failure_class: null,
    };
    await this.audit(record);
    try {
      const resource = copyJsonData(await this.resolveResource(resource_id, scope));
      assertSchemaVersion(resource);
      valid(
        resource.id === resource_id &&
          resource.tenant_id === this.tenant_id &&
          resource.system_id === this.system_id &&
          resource.candidate_digest === scope.candidate_digest,
        'FORBIDDEN',
      );
      parseDigest(resource.digest, 'broker-resource');
      let bytes;
      if (resource.kind === 'OBJECT')
        bytes = await this.readObject(resource.payload_ref, scope, this.max_bytes);
      else if (resource.kind === 'HTTP_READ') bytes = await this.#http(resource);
      else throw new V1Error('UNSUPPORTED_CAPABILITY');
      valid(bytes instanceof Uint8Array && bytes.length <= this.max_bytes, 'INCOMPLETE_ANALYSIS');
      valid(
        (await digestBytes('broker-resource', bytes)) === resource.digest,
        'INTEGRITY_MISMATCH',
      );
      valid((await this.secretGuard(bytes.slice())) === true, 'FORBIDDEN');
      await this.audit({ ...record, from_state: 'REQUESTED', to_state: 'VERIFIED' });
      return bytes.slice();
    } catch (error) {
      const code = error instanceof V1Error ? error.code : 'PROVIDER_UNAVAILABLE';
      await this.audit({
        ...record,
        from_state: 'REQUESTED',
        to_state: 'REJECTED',
        failure_class: code,
      });
      throw new V1Error(code);
    }
  }
}
