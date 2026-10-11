/** Bounded authenticated provider HTTP. Credentials stay outside serialized records. */
import { V1Error } from '../core/v1/conventions.mjs';

export class ProviderHttp {
  constructor({
    base_url,
    credential,
    fetch: request = globalThis.fetch,
    timeout_ms,
    max_bytes,
    headers = {},
  }) {
    const url = new URL(base_url);
    if (
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      typeof credential !== 'function' ||
      typeof request !== 'function' ||
      !Number.isSafeInteger(timeout_ms) ||
      timeout_ms <= 0 ||
      !Number.isSafeInteger(max_bytes) ||
      max_bytes <= 0
    )
      throw new V1Error('INVALID_ARGUMENT');
    this.base = url;
    this.credential = credential;
    this.fetch = request;
    this.timeout_ms = timeout_ms;
    this.max_bytes = max_bytes;
    this.headers = { ...headers };
  }

  async request(method, path, body, headers = {}, { signal } = {}) {
    const effect = method !== 'GET';
    if (
      !['GET', 'PATCH', 'POST'].includes(method) ||
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.startsWith('//')
    )
      throw new V1Error('INVALID_ARGUMENT');
    const url = new URL(this.base.pathname.replace(/\/$/, '') + path, this.base);
    if (url.origin !== this.base.origin) throw new V1Error('INVALID_ARGUMENT');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && new TextEncoder().encode(encoded).length > this.max_bytes)
      throw new V1Error('INVALID_ARGUMENT');
    // Resolve credentials before dispatch; a missing credential caused no external effect.
    const token = await this.credential();
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token))
      throw new V1Error('UNAUTHENTICATED');
    try {
      const response = await this.fetch(url.href, {
        method,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout_ms)])
          : AbortSignal.timeout(this.timeout_ms),
        headers: {
          ...this.headers,
          ...headers,
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: 'Bearer ' + token,
        },
        body: encoded,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new V1Error('FORBIDDEN');
        if (response.status === 404) throw new V1Error('NOT_FOUND');
        if ([409, 412, 422].includes(response.status)) throw new V1Error('CONFLICT');
        if (response.status === 429) throw new V1Error('RATE_LIMITED');
        if (response.status === 400) throw new V1Error('INVALID_ARGUMENT');
        throw new V1Error(effect ? 'OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new V1Error(effect ? 'OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE');
      let count = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.length;
          if (count > this.max_bytes) {
            await reader.cancel();
            throw new V1Error(effect ? 'OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(count);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      if (error instanceof V1Error) throw error;
      throw new V1Error(effect ? 'OUTCOME_UNKNOWN' : 'PROVIDER_UNAVAILABLE');
    }
  }
}
