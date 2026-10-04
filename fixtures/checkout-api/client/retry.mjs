import { delayMilliseconds } from '../config/retry-delay.mjs';
export const MAX_ATTEMPTS = 1;

/** One order keeps one idempotency key across all attempts. */
export async function checkout({ baseUrl, orderId, amountCents, idempotencyKey }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ orderId, amountCents }),
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) throw new Error(`Payment service returned ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, delayMilliseconds(attempt)));
    }
  }
  throw lastError;
}
