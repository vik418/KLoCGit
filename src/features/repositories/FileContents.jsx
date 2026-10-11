import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Textarea } from '../../ui/Textarea.jsx';

export function FileContents({ file, onCopy }) {
  const [raw, setRaw] = useState(false);
  const fileLines = useMemo(() => file.text?.split('\n') ?? [], [file.text]);
  return (
    <section aria-label="File contents" className="min-w-0 overflow-hidden rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-4 py-3 text-xs text-muted-foreground">
        <span>
          {file.size_bytes} bytes · {file.content_kind.toLowerCase()}
        </span>
        {file.text !== null && (
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRaw((value) => !value)}
            >
              {raw ? 'Line view' : 'Raw view'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onCopy(file.text, 'File')}
            >
              <Copy aria-hidden="true" />
              Copy file
            </Button>
          </div>
        )}
      </div>
      {file.content_kind === 'SYMLINK' && (
        <p className="border-b px-4 py-3 text-xs text-muted-foreground">
          Link target shown as text. The link is not followed.
        </p>
      )}
      {file.text === null ? (
        <p className="p-5 text-sm text-muted-foreground">Binary file · no text preview.</p>
      ) : raw ? (
        <Textarea
          aria-label="Raw file contents"
          readOnly
          value={file.text}
          className="min-h-72 rounded-none border-0 font-mono text-xs"
        />
      ) : (
        <div className="max-h-[50dvh] overflow-auto">
          <pre className="source-lines py-3 text-xs leading-6">
            <code>
              {fileLines.slice(0, 1000).map((line, index) => (
                <span key={index} className="source-line">
                  <span aria-hidden="true" className="source-line-number">
                    {index + 1}
                  </span>
                  <span>{line || '\u200b'}</span>
                </span>
              ))}
            </code>
          </pre>
          {fileLines.length > 1000 && (
            <p className="px-4 pb-3 text-xs text-muted-foreground">
              Showing 1,000 of {fileLines.length} lines. Raw view contains the complete file.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
