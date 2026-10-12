export interface RetryPolicy {
  attempts: number;
  delayMs: number;
}

export function retryLimit(policy: RetryPolicy): number {
  return Math.max(1, policy.attempts);
}

function internal(): number {
  return 2;
}
