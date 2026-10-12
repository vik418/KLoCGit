export interface RetryPolicy {
  attempts: number;
}

export function retryLimit(policy: RetryPolicy): number {
  return policy.attempts;
}

function internal(): number {
  return 1;
}
