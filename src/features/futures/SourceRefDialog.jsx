import { useEffect, useRef, useState } from 'react';
import { Check, GitBranch, RefreshCw, Tag } from 'lucide-react';
import { apiRequest } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { Button } from '../../ui/Button.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

async function fetchRefs(repoId, cursor = '', signal) {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const result = await apiRequest('/repositories/' + encodeURIComponent(repoId) + '/refs?' + query, { signal });
  if (result.repo_id !== repoId || !Array.isArray(result.refs) ||
      typeof result.has_more !== 'boolean' ||
      (result.has_more && (typeof result.next_cursor !== 'string' || !result.next_cursor))) {
    throw new Error('The repository returned an invalid ref page.');
  }
  return result;
}

export function SourceRefDialog({ future, repositories, onClose, reload, message }) {
  const [selected, setSelected] = useState(() =>
    Object.fromEntries(future.repositories.map((repository) => [repository.repo_id, repository.ref])),
  );
  const [pages, setPages] = useState({});
  const [loading, setLoading] = useState({});
  const [readErrors, setReadErrors] = useState({});
  const generation = useRef(0);
  const readController = useRef(null);
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const editable = ['active', 'unavailable'].includes(future.status);
  const selectionReady = editable && future.repositories.length > 0 &&
    future.repositories.every((repository) => {
      const entry = pages[repository.repo_id]?.refs.find((item) => item.ref === selected[repository.repo_id]);
      return entry && entry.available_for_future !== false && !loading[repository.repo_id];
    });

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    readController.current = controller;
    const pending = [...future.repositories];
    setPages({});
    setReadErrors({});
    setLoading(Object.fromEntries(pending.map((repository) => [repository.repo_id, true])));
    async function readNext() {
      while (pending.length && generation.current === current) {
        const repository = pending.shift();
        try {
          const result = await fetchRefs(repository.repo_id, '', controller.signal);
          if (generation.current === current)
            setPages((previous) => ({ ...previous, [repository.repo_id]: result }));
        } catch (failure) {
          if (generation.current === current)
            setReadErrors((previous) => ({ ...previous, [repository.repo_id]: getErrorMessage(failure) }));
        } finally {
          if (generation.current === current)
            setLoading((previous) => ({ ...previous, [repository.repo_id]: false }));
        }
      }
    }
    // Ref listings are read-only, but a large Future must not fan out hundreds of requests at once.
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, readNext));
    return () => {
      if (generation.current === current) generation.current = current + 1;
      controller.abort();
    };
  }, [future.id, future.repositories]);

  async function loadPage(repoId, append = false) {
    if (loading[repoId]) return;
    const current = generation.current;
    const cursor = append ? pages[repoId]?.next_cursor : '';
    if (append && !cursor) return;
    setLoading((previous) => ({ ...previous, [repoId]: true }));
    setReadErrors((previous) => ({ ...previous, [repoId]: null }));
    try {
      const result = await fetchRefs(repoId, cursor, readController.current?.signal);
      if (generation.current !== current) return;
      setPages((previous) => ({
        ...previous,
        [repoId]: {
          ...result,
          refs: append
            ? [...new Map([...previous[repoId].refs, ...result.refs].map((entry) => [entry.ref, entry])).values()]
            : result.refs,
        },
      }));
    } catch (failure) {
      if (generation.current === current)
        setReadErrors((previous) => ({ ...previous, [repoId]: getErrorMessage(failure) }));
    } finally {
      if (generation.current === current)
        setLoading((previous) => ({ ...previous, [repoId]: false }));
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!selectionReady) return;
    const result = await mutate('/futures/' + encodeURIComponent(future.id) + '/observe', {
      expected_version: future.version,
      repository_refs: future.repositories.map((repository) => ({
        repo_id: repository.repo_id,
        ref: selected[repository.repo_id],
      })).sort((a, b) => a.repo_id.localeCompare(b.repo_id)),
    }, 'Source refs observed. Previous revisions remain recorded.');
    if (result) onClose();
  }

  return (
    <NativeFormDialog
      title="Choose source refs"
      description="Observe one branch or tag from each isolated repository. Canonical refs stay unchanged."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!selectionReady}
      submitLabel="Observe selected refs"
      pendingLabel="Observing…"
    >
      {!editable && (
        <p className="error-banner" role="alert">
          This Future is {future.status}. Resolve its lifecycle state before choosing source refs.
        </p>
      )}
      <div className="space-y-6">
        {future.repositories.map((repository) => {
          const page = pages[repository.repo_id];
          const descriptor = repositories.find((item) => item.id === repository.canonical_repo_id);
          const chosen = page?.refs.find((entry) => entry.ref === selected[repository.repo_id]);
          return (
            <fieldset key={repository.repo_id} className="min-w-0 space-y-3 rounded-md border p-4">
              <legend className="max-w-full break-all px-1 text-sm font-medium">
                {descriptor?.name ?? repository.canonical_repo_id}
              </legend>
              <p className="break-all text-xs text-muted-foreground">{repository.repo_id}</p>
              <p className="break-all text-xs leading-6 text-muted-foreground">
                Recorded source: {repository.ref}
              </p>
              {loading[repository.repo_id] && <p className="text-xs text-muted-foreground" role="status">Reading refs…</p>}
              {readErrors[repository.repo_id] && <p className="error-banner text-xs" role="alert">{readErrors[repository.repo_id]}</p>}
              <div className="max-h-64 space-y-2 overflow-y-auto" role="group" aria-label={'Source refs for ' + repository.repo_id}>
                {page?.refs.map((entry) => {
                  const isSelected = selected[repository.repo_id] === entry.ref;
                  const selectable = entry.available_for_future !== false;
                  const Icon = entry.ref.startsWith('refs/tags/') ? Tag : GitBranch;
                  return (
                    <Button
                      key={entry.ref}
                      type="button"
                      variant={isSelected ? 'secondary' : 'outline'}
                      className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                      disabled={!editable || !selectable || loading[repository.repo_id]}
                      aria-pressed={isSelected}
                      onClick={() => setSelected((previous) => ({ ...previous, [repository.repo_id]: entry.ref }))}
                    >
                      <Icon className="mt-0.5 self-start" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block break-all text-xs">{entry.ref}</span>
                        <span className="mt-1 block break-all font-mono text-[0.65rem] text-muted-foreground">{entry.commit ?? entry.object_id}</span>
                        {!selectable && <span className="mt-1 block text-xs text-muted-foreground">Does not resolve to a Git commit.</span>}
                        {entry.available_for_future === null && <span className="mt-1 block text-xs text-muted-foreground">Commit target will be verified during observation.</span>}
                      </span>
                      {isSelected && <Check aria-hidden="true" />}
                    </Button>
                  );
                })}
              </div>
              {page && !page.refs.length && <p className="text-xs text-muted-foreground">No branches or tags were found.</p>}
              {page && !chosen && <p className="text-xs text-muted-foreground">Choose a listed ref. Load more if the recorded source is not on this page.</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="ghost" disabled={busy || loading[repository.repo_id]} onClick={() => loadPage(repository.repo_id)}>
                  <RefreshCw aria-hidden="true" />Refresh refs
                </Button>
                {page?.has_more && (
                  <Button type="button" size="sm" variant="outline" disabled={busy || loading[repository.repo_id]} onClick={() => loadPage(repository.repo_id, true)}>
                    Load more refs
                  </Button>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>
      <p className="mt-4 text-xs leading-6 text-muted-foreground">
        The server reads the selected refs again and verifies their commit and tree. A changed source creates a new immutable revision.
      </p>
    </NativeFormDialog>
  );
}
