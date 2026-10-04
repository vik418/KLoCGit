export function asArray(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? Object.values(value) : [];
}

export function getMergeRequests(workspace) {
  return asArray(
    workspace.mergeRequestViews ?? workspace.mergeRequests ?? workspace.mr?.mergeRequests,
  ).map((request) => (request.merge_request ? { ...request.merge_request, ...request } : request));
}

export function getQueueEntries(workspace) {
  return asArray(workspace.mergeQueue ?? workspace.queueEntries ?? workspace.queue?.entries);
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function getPreparedDecisionId(result) {
  return (
    result?.component_id ??
    result?.decision_component_id ??
    result?.component?.id ??
    result?.decision_component?.id ??
    result?.id
  );
}
