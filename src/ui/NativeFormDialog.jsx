import { LoaderCircle, X } from 'lucide-react';
import { Button } from './Button.jsx';
import { Dialog, DialogTitle, DialogDescription } from './Dialog.jsx';

export function NativeFormDialog({
  title, description, children, onClose, onSubmit, busy, error, disabled, submitLabel, pendingLabel,
}) {
  function close() {
    if (!busy) onClose();
  }

  return (
    <Dialog onClose={close} className="max-w-lg" hasDescription={Boolean(description)}>
      <div className="dialog-header">
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription className="mt-2">{description}</DialogDescription>}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={close} disabled={busy} aria-label={`Close ${title.toLowerCase()}`}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <form onSubmit={onSubmit} aria-busy={busy}>
        <div className="native-body">
          {error && <p className="error-banner" role="alert">{error}</p>}
          <fieldset disabled={busy} className="min-w-0 border-0 p-0">{children}</fieldset>
        </div>
        <div className="dialog-footer">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || disabled}>
            {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            {busy ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
