/** Operator configuration for a service implementing the Ranker JSON contract. */
import { HttpRanker } from '../adapters/ranking/http.mjs';

export function createRanker(env = process.env) {
  let url;
  try {
    url = new URL(env.KLOCGIT_RANKER_URL);
  } catch {
    throw new TypeError('KLOCGIT_RANKER_URL must be an HTTPS service URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new TypeError('KLOCGIT_RANKER_URL must be an HTTPS service URL without credentials.');
  const token = env.KLOCGIT_RANKER_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token))
    throw new TypeError('KLOCGIT_RANKER_TOKEN must be a nonblank service credential.');
  const timeout_ms = Number(env.KLOCGIT_RANKER_TIMEOUT_MS);
  const max_bytes = Number(env.KLOCGIT_RANKER_MAX_BYTES);
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1)
    throw new TypeError('KLOCGIT_RANKER_TIMEOUT_MS must be a positive integer.');
  if (!Number.isSafeInteger(max_bytes) || max_bytes < 1)
    throw new TypeError('KLOCGIT_RANKER_MAX_BYTES must be a positive integer.');
  const path = url.pathname;
  url.pathname = '/';
  return new HttpRanker({
    base_url: url.href,
    path,
    timeout_ms,
    max_bytes,
    credential: () => token,
  });
}
