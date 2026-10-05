import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../lib/utils.js';

function DialogTitle({ className, ...props }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg font-semibold leading-none', className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm leading-6 text-muted-foreground', className)}
      {...props}
    />
  );
}

// Keep the existing feature API while Radix owns focus trapping and dismissal.
function Dialog({ children, onClose, className, labelledBy, describedBy, hasDescription = false }) {
  const [returnFocus] = useState(() => document.activeElement);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
          {...(describedBy
            ? { 'aria-describedby': describedBy }
            : hasDescription
              ? {}
              : { 'aria-describedby': undefined })}
          className={cn(
            'dialog dark fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card text-card-foreground shadow-lg outline-none duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            className,
          )}
          onCloseAutoFocus={(event) => {
            // The app mounts dialogs from several views, without a persistent Radix trigger.
            event.preventDefault();
            if (returnFocus?.isConnected) returnFocus.focus();
          }}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { Dialog, DialogTitle, DialogDescription };
