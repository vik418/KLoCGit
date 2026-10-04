import { useCallback, useEffect, useRef, useState } from 'react';

export function useNotifications() {
  const [notification, setNotification] = useState(null);
  const timeout = useRef(null);

  const dismissNotification = useCallback(() => {
    clearTimeout(timeout.current);
    setNotification(null);
  }, []);

  const notify = useCallback((text, tone = 'success') => {
    clearTimeout(timeout.current);
    setNotification({ text, tone });
    timeout.current = setTimeout(() => setNotification(null), 6000);
  }, []);

  useEffect(() => () => clearTimeout(timeout.current), []);

  return { notification, notify, dismissNotification };
}
