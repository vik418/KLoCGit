export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function getMergeRequests(workspace) {
  return asArray(workspace.mergeRequests);
}

export function getQueueEntries(workspace) {
  return asArray(workspace.mergeQueue);
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function getPreparedDecisionId(result) {
  return result?.id;
}
