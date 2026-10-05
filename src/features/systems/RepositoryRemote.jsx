import { useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Input } from '../../ui/Input.jsx';

export function RepositoryRemote({ remote }) {
  const id = useId();
  const [copiedRemote, setCopiedRemote] = useState(null);
  const copied = copiedRemote === remote;
  const [error, setError] = useState(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(remote);
      setCopiedRemote(remote);
      setError(null);
    } catch {
      setError('Copy was unavailable. Select the remote to copy it.');
    }
  }

  return (
    <div className="mt-3 min-w-0">
      <label htmlFor={id} className="mb-2 block text-xs text-muted-foreground">
        Git remote
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={id}
          readOnly
          value={remote}
          className="min-w-0 font-mono text-xs"
          onFocus={(event) => event.target.select()}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={copy}
          aria-label={copied ? 'Remote copied' : 'Copy Git remote'}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      {error && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        Use this remote with git clone, fetch and push. Artifacts Git access needs a separate,
        scoped repository credential.
      </p>
    </div>
  );
}
