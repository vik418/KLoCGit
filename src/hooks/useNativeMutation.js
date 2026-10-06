import { useRef, useState } from 'react';
import { apiRequest } from '../lib/api.js';
import { getErrorMessage } from '../lib/errors.js';
import { createRequestId } from '../lib/workspace.js';

const retryableRejections = new Set([
  'INVALID_NATIVE_INPUT',
  'INVALID_SELECTION',
  'INVALID_COMMIT',
  'COMMIT_OUTSIDE_REVISION',
  'COMMIT_PARENT_REQUIRED',
  'COMPOSITION_CONFLICT',
  'SELECTION_STALE',
  'DECISION_STALE',
  'VALIDATION_REQUIRED',
  'MULTI_REPO_PROMOTION_UNSUPPORTED',
  'PROMOTION_NOT_ISSUED',
  'PROMOTION_SETTLED',
  'INVALID_SETTLEMENT',
  'SETTLEMENT_STALE',
  'OPERATION_NOT_UNCERTAIN',
  'RECOVERY_TARGET_PRESENT',
  'INVALID_REQUEST',
  'REPO_NOT_FOUND',
  'REPO_EXISTS',
  'REPOSITORY_NOT_READY',
  'FUTURE_NOT_READY',
  'FUTURE_STALE',
  'CANONICAL_CHANGED',
  'NO_REPOSITORY_EFFECT',
  'IMPORT_DNS_UNAVAILABLE',
  'IMPORT_SOURCE_NOT_PUBLIC',
]);

export function useNativeMutation(reload, message) {
  const [pendingPath, setPendingPath] = useState(null);
  const busy = pendingPath !== null;
  const [error, setError] = useState(null);
  const pending = useRef(false);
  const request = useRef(null);

  async function mutate(path, body, success) {
    if (pending.current) return null;
    const key = JSON.stringify({ path, body });
    // A lost response must retry the same operation, rather than create another repository.
    if (request.current?.key !== key) request.current = { key, id: createRequestId() };
    pending.current = true;
    setPendingPath(path);
    setError(null);
    try {
      const result = await apiRequest(path, {
        method: 'POST',
        body: { ...body, request_id: request.current.id },
      });
      request.current = null;
      try {
        await reload();
        if (success) message(success);
      } catch (refreshError) {
        // A failed read does not undo an acknowledged mutation.
        message(
          `Saved. Refresh the workspace to see the change. ${getErrorMessage(refreshError)}`,
          'error',
        );
      }
      return result;
    } catch (operationError) {
      // Reconciliation only inspects existing effects; an explicit rejection can be retried.
      const rejectedRecovery =
        /^\/repository-requests\/[^/]+\/recover$/.test(path) &&
        typeof operationError.error === 'string';
      if (retryableRejections.has(operationError.error) || rejectedRecovery) request.current = null;
      setError(getErrorMessage(operationError));
      await reload().catch(() => {});
      return null;
    } finally {
      pending.current = false;
      setPendingPath(null);
    }
  }

  return { busy, pendingPath, error, mutate };
}
