import {randomUUID} from 'node:crypto';
export const TRACE_REQUESTS = false;

export function traceRequest(response) {
  if (TRACE_REQUESTS) response.setHeader('x-request-id', randomUUID());
}
