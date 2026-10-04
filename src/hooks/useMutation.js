import { useState } from 'react';
import { apiRequest } from '../lib/api.js';
import { createRequestId } from '../lib/workspace.js';
import { getErrorMessage } from '../lib/errors.js';

export function useMutation(reload, message) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  async function mutate(path, body = {}, success) {
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest(path, {
        method: 'POST',
        body: { request_id: createRequestId(), ...body },
      });
      await reload();
      if (success) message(success);
      return result;
    } catch (e) {
      setError(getErrorMessage(e));
      await reload().catch(() => {});
      return null;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, mutate };
}
