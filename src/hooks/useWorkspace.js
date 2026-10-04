import { useCallback, useEffect, useState } from 'react';
import { apiRequest, setOwnerCredential } from '../lib/api.js';

export function useWorkspace(notify) {
  const [workspace, setWorkspace] = useState(null);
  const [requiresAuthentication, setRequiresAuthentication] = useState(false);

  const reload = useCallback(async () => {
    const result = await apiRequest('/workspace');
    setWorkspace(result);
    return result;
  }, []);

  useEffect(() => {
    reload().catch((error) => {
      if (error.error === 'UNAUTHENTICATED') setRequiresAuthentication(true);
      else notify(error.message, 'error');
    });
  }, [reload, notify]);

  async function authenticate(credential) {
    setOwnerCredential(credential);
    try {
      await reload();
      setRequiresAuthentication(false);
      return true;
    } catch (error) {
      setOwnerCredential('');
      notify(error.message, 'error');
      return false;
    }
  }

  return { workspace, setWorkspace, requiresAuthentication, authenticate, reload };
}
