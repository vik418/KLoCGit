import { useState } from 'react';
import {
  ArrowLeft,
  Code2,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Link2,
  RefreshCw,
  X,
} from 'lucide-react';
import { Dialog, DialogTitle, DialogDescription } from '../../ui/Dialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { useSourceQuery } from '../../hooks/useSourceQuery.js';
import { shortId } from '../../lib/format.js';
import { RepositoryRemote } from '../systems/RepositoryRemote.jsx';
import { CommitDetails } from './CommitDetails.jsx';
import { FileContents } from './FileContents.jsx';

function endpoint(id, action, input = {}) {
  return (
    '/source/repositories/' +
    encodeURIComponent(id) +
    '/' +
    action +
    '?' +
    new URLSearchParams(input)
  );
}

function QueryStatus({ query }) {
  if (query.loading)
    return (
      <p role="status" className="p-5 text-sm text-muted-foreground">
        Reading Git…
      </p>
    );
  if (!query.error) return null;
  return (
    <div role="alert" className="space-y-3 rounded-md border p-5">
      <p className="text-sm">{query.error}</p>
      <p className="text-xs text-muted-foreground">
        This read changed no Git refs or files. Retry the read or choose another revision.
      </p>
      <Button type="button" size="sm" variant="outline" onClick={query.retry}>
        Retry read
      </Button>
    </div>
  );
}

function SnapshotBrowser({ repository, snapshot, initialPath, onCommit, onFork }) {
  const [view, setView] = useState('code');
  const [location, setLocation] = useState({
    path: initialPath ?? '',
    kind: initialPath ? 'blob' : 'tree',
  });
  const [offset, setOffset] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const selected = { commit_oid: snapshot.commit_oid };
  const directory = useSourceQuery(
    view === 'code' && location.kind === 'tree'
      ? endpoint(repository.id, 'tree', { ...selected, path: location.path, offset })
      : null,
  );
  const file = useSourceQuery(
    view === 'code' && location.kind === 'blob'
      ? endpoint(repository.id, 'file', { ...selected, path: location.path })
      : null,
  );
  const history = useSourceQuery(
    view === 'commits' ? endpoint(repository.id, 'history', { ...selected, offset }) : null,
  );
  const summary = useSourceQuery(endpoint(repository.id, 'summary', selected));
  const query = view === 'commits' ? history : location.kind === 'blob' ? file : directory;

  function navigate(path, kind = 'tree') {
    setLocation({ path, kind });
    setOffset(0);
    setCopyStatus('');
  }

  async function copy(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(label + ' copied.');
    } catch {
      setCopyStatus('Copy unavailable. Use the displayed commit and path.');
    }
  }

  function permalink() {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({
      repo: repository.id,
      commit: snapshot.commit_oid,
      ...(location.path ? { path: location.path } : {}),
    }).toString();
    return url.toString();
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <GitCommitHorizontal className="size-4" aria-hidden="true" />
          <code>{shortId(snapshot.commit_oid)}</code> · pinned snapshot
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onFork}>
          <GitBranch aria-hidden="true" />
          Fork repository
        </Button>
      </div>
      <nav className="source-tabs flex flex-wrap gap-3 border-b pb-3" aria-label="Repository views">
        {[
          ['code', 'Code', Code2],
          ['commits', 'Commits', GitCommitHorizontal],
        ].map(([key, label, Icon]) => (
          <Button
            key={key}
            type="button"
            variant="ghost"
            size="sm"
            aria-current={view === key ? 'page' : undefined}
            onClick={() => {
              setView(key);
              setOffset(0);
            }}
          >
            <Icon aria-hidden="true" />
            {label}
          </Button>
        ))}
      </nav>
      {view === 'code' && (
        <>
          <nav
            aria-label="Repository path"
            className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate('')}>
              {repository.id}
            </Button>
            {location.path
              .split('/')
              .filter(Boolean)
              .map((part, index, parts) => (
                <span
                  key={parts.slice(0, index + 1).join('/')}
                  className="flex min-w-0 items-center gap-1"
                >
                  <span aria-hidden="true">/</span>
                  {index === parts.length - 1 ? (
                    <span className="break-all">{part}</span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(parts.slice(0, index + 1).join('/'))}
                    >
                      {part}
                    </Button>
                  )}
                </span>
              ))}
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            {summary.data && (
              <span>
                {summary.data.complete ? '' : 'At least '}
                {summary.data.files} files · {summary.data.directories} directories ·{' '}
                {summary.data.submodules} submodules
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => copy(permalink(), 'Permalink')}
            >
              <Link2 aria-hidden="true" />
              Copy permalink
            </Button>
          </div>
          {summary.error && (
            <p className="text-xs text-muted-foreground">
              File count unavailable. Directory browsing remains available.
            </p>
          )}
        </>
      )}
      <QueryStatus query={query} />
      {!query.loading &&
        !query.error &&
        view === 'code' &&
        location.kind === 'tree' &&
        directory.data && (
          <div className="overflow-hidden rounded-md border">
            <div className="flex justify-between border-b bg-card px-4 py-3 text-xs text-muted-foreground">
              <span>{directory.data.entry_count} entries</span>
              <code>{shortId(directory.data.tree_oid)}</code>
            </div>
            {location.path && (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start rounded-none border-b"
                onClick={() => navigate(location.path.split('/').slice(0, -1).join('/'))}
              >
                <ArrowLeft aria-hidden="true" />
                Parent directory
              </Button>
            )}
            {!directory.data.entries.length && (
              <p className="p-5 text-sm text-muted-foreground">This directory is empty.</p>
            )}
            <ul aria-label="Directory entries" className="divide-y">
              {directory.data.entries.map((entry) => (
                <li key={entry.path} className="min-w-0">
                  {entry.kind === 'commit' ? (
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                      <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
                      <span className="break-all">{entry.name}</span>
                      <span className="text-xs text-muted-foreground">
                        Submodule · {shortId(entry.oid)}
                      </span>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start rounded-none px-4 py-3 text-left"
                      onClick={() => navigate(entry.path, entry.kind)}
                    >
                      {entry.kind === 'tree' ? (
                        <Folder className="text-primary" aria-hidden="true" />
                      ) : entry.mode === '120000' ? (
                        <Link2 aria-hidden="true" />
                      ) : (
                        <FileText aria-hidden="true" />
                      )}
                      <span className="min-w-0 whitespace-normal break-all">{entry.name}</span>
                      <code className="ml-auto text-xs text-muted-foreground">
                        {shortId(entry.oid)}
                      </code>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      {!query.loading &&
        !query.error &&
        file.data &&
        view === 'code' &&
        location.kind === 'blob' && (
          <FileContents key={file.data.blob_oid} file={file.data} onCopy={copy} />
        )}
      {!history.loading && !history.error && history.data && view === 'commits' && (
        <section aria-label="Commit history" className="space-y-3">
          <p className="text-xs text-muted-foreground">
            First-parent history. Open parent commits to inspect merged branches.
          </p>
          {history.data.commits.map((commit) => (
            <CommitDetails key={commit.commit_oid} commit={commit} onCommit={onCommit} />
          ))}
          {history.data.truncated && (
            <p className="text-xs text-muted-foreground">
              History read limit reached. Older commits remain in Git.
            </p>
          )}
        </section>
      )}
      {!query.loading && !query.error && (
        <div className="flex gap-2">
          {offset > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={() => setOffset(0)}>
              First page
            </Button>
          )}
          {query.data?.next_offset !== null && query.data?.next_offset !== undefined && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOffset(query.data.next_offset)}
            >
              Next page
            </Button>
          )}
        </div>
      )}
      {copyStatus && (
        <p role="status" className="text-xs text-muted-foreground">
          {copyStatus}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Clone and fetch</summary>
        {repository.remote && <RepositoryRemote remote={repository.remote} />}
      </details>
    </div>
  );
}

export function RepositoryBrowser({ repository, initialCommit, initialPath, onClose, onFork }) {
  const [selection, setSelection] = useState(
    initialCommit ? { commit_oid: initialCommit } : { ref: repository.canonical_ref },
  );
  const [refCursor, setRefCursor] = useState('');
  const refs = useSourceQuery(
    endpoint(repository.id, 'refs', { limit: 200, ...(refCursor ? { cursor: refCursor } : {}) }),
  );
  const snapshot = useSourceQuery(endpoint(repository.id, 'commit', selection));
  const [refresh, setRefresh] = useState(0);

  return (
    <Dialog onClose={onClose} hasDescription className="source-browser">
      <div className="flex items-start justify-between gap-3 border-b p-6">
        <div>
          <DialogTitle>{repository.id} · source</DialogTitle>
          <DialogDescription className="mt-2">Browse immutable Git state.</DialogDescription>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close source browser"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="min-w-0 space-y-5 p-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="source-ref" className="mb-2 block text-xs text-muted-foreground">
              Branch or tag
            </label>
            <NativeSelect
              id="source-ref"
              value={selection.ref ?? ''}
              onChange={(event) => setSelection({ ref: event.target.value })}
            >
              <option value="" disabled>
                {selection.commit_oid
                  ? 'Pinned commit · ' + shortId(selection.commit_oid)
                  : 'Choose a ref'}
              </option>
              {selection.ref && !refs.data?.refs.some((entry) => entry.ref === selection.ref) && (
                <option value={selection.ref}>{selection.ref}</option>
              )}
              {refs.data?.refs.map((entry) => (
                <option key={entry.ref} value={entry.ref} disabled={!entry.available_for_future}>
                  {entry.ref}
                </option>
              ))}
            </NativeSelect>
          </div>
          {selection.ref && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                snapshot.retry();
                setRefresh((value) => value + 1);
              }}
            >
              <RefreshCw aria-hidden="true" />
              Refresh ref
            </Button>
          )}
          {refs.data?.has_more && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRefCursor(refs.data.next_cursor)}
            >
              More refs
            </Button>
          )}
          {refCursor && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRefCursor('')}>
              First refs
            </Button>
          )}
        </div>
        {refs.error && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Ref list unavailable. The selected snapshot can still be read.
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={refs.retry}>
              Retry refs
            </Button>
          </div>
        )}
        <QueryStatus query={snapshot} />
        {!snapshot.loading && snapshot.data && (
          <SnapshotBrowser
            key={snapshot.data.commit.commit_oid + ':' + refresh}
            repository={repository}
            snapshot={snapshot.data.commit}
            initialPath={
              initialCommit === snapshot.data.commit.commit_oid ? initialPath : undefined
            }
            onCommit={(oid) => setSelection({ commit_oid: oid })}
            onFork={onFork}
          />
        )}
      </div>
    </Dialog>
  );
}
