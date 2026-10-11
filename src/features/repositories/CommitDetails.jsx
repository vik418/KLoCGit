import { Button } from '../../ui/Button.jsx';
import { shortId } from '../../lib/format.js';

export function CommitDetails({ commit, onCommit }) {
  return (
    <article className="min-w-0 space-y-3 rounded-md border bg-card p-4">
      <h3 className="text-sm font-semibold">{commit.message?.split('\n')[0] || 'Commit'}</h3>
      <code className="block break-all text-xs text-muted-foreground">{commit.commit_oid}</code>
      {commit.author && <p className="break-all text-xs text-muted-foreground">{commit.author}</p>}
      <p className="text-xs text-muted-foreground">
        {commit.signature === 'ABSENT'
          ? 'No embedded signature'
          : commit.signature === 'UNVERIFIED'
            ? 'Embedded signature · not verified'
            : 'Signature status unavailable'}
      </p>
      {commit.parent_oids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Parents</span>
          {commit.parent_oids.map((oid) => (
            <Button
              key={oid}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCommit(oid)}
            >
              {shortId(oid)}
            </Button>
          ))}
        </div>
      )}
      {commit.message && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Full commit message
          </summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs">{commit.message}</pre>
        </details>
      )}
    </article>
  );
}
