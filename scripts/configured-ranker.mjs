/** Operator configuration for a service implementing the Ranker JSON contract. */
import { HttpRanker } from '../adapters/ranking/http.mjs';

export function createRanker() {
  const url = new URL(process.env.KLOCGIT_RANKER_URL);
  const path = url.pathname;
  url.pathname = '/';
  return new HttpRanker({
    base_url: url.href,
    path,
    timeout_ms: Number(process.env.KLOCGIT_RANKER_TIMEOUT_MS),
    max_bytes: Number(process.env.KLOCGIT_RANKER_MAX_BYTES),
    credential: () => process.env.KLOCGIT_RANKER_TOKEN,
  });
}
