import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api.js';

/** A changed source selection must never briefly display another commit's data. */
export function useSourceQuery(path) {
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    apiRequest(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ path, attempt, data });
      },
      (error) => {
        if (!controller.signal.aborted) setResult({ path, attempt, error: error.message });
      },
    );
    return () => controller.abort();
  }, [path, attempt]);
  return {
    ...(result?.path === path && result.attempt === attempt ? result : {}),
    loading: Boolean(path && (result?.path !== path || result.attempt !== attempt)),
    retry: () => setAttempt((value) => value + 1),
  };
}
