export const RETRY_STRATEGY = 'none';

export function delayMilliseconds(attempt) {
  if (RETRY_STRATEGY === 'fixed') return 20;
  if (RETRY_STRATEGY === 'exponential') return 20 * 2 ** (attempt - 1);
  return 0;
}
