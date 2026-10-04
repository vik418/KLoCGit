import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

export function Notification({ notification, onDismiss }) {
  if (!notification) return null;

  return (
    <div className={`toast ${notification.tone}`} role="status">
      {notification.tone === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
      <span>{notification.text}</span>
      <button onClick={onDismiss} aria-label="Dismiss notification">
        <X size={16} />
      </button>
    </div>
  );
}
