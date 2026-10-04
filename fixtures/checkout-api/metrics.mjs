export const METRICS_ENABLED = false;
let requests = 0;

export function observeRequest() {
  if (METRICS_ENABLED) requests++;
}
export function metricsSnapshot() {
  return { enabled: METRICS_ENABLED, requests };
}
