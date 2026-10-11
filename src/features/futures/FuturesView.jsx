import { Plus, RefreshCw, GitFork, GitBranch, History, ShieldCheck } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/Card.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';
import { RepositoryRemote } from '../systems/RepositoryRemote.jsx';

function GitSnapshot({ entries, label }) {
  return (
    <div className="space-y-4">
      {entries.map((entry) => (
        <dl key={entry.repo_id} className="space-y-2 text-xs">
          <dt className="font-medium">{entry.canonical_repo_id ?? entry.repo_id}</dt>
          {entry.ref && (
            <>
              <dt className="text-muted-foreground">Ref</dt>
              <dd className="break-all font-mono text-muted-foreground">{entry.ref}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="break-all font-mono text-muted-foreground">{entry.commit}</dd>
          <dt className="text-muted-foreground">Tree</dt>
          <dd className="break-all font-mono text-muted-foreground">{entry.tree}</dd>
        </dl>
      ))}
      {!entries.length && (
        <p className="text-xs text-muted-foreground">{label} has no observed Git state.</p>
      )}
    </div>
  );
}

function retentionConfirmed(revision, retentions) {
  return (
    revision.repository_heads.length > 0 &&
    revision.repository_heads.every((head) => {
      const objects = [...new Set([head.object_id ?? head.commit, head.commit])].sort();
      // A later receipt applies only to these exact objects in the same archive repository.
      const receipt = retentions
        .filter(
          (entry) =>
            entry.subject.source_repo_id === head.source_repo_id &&
            entry.subject.archive_repo_id === head.repo_id &&
            entry.subject.object_ids.length === objects.length &&
            [...entry.subject.object_ids].sort().every((id, index) => id === objects[index]),
        )
        .at(-1);
      return receipt?.status === 'retained';
    })
  );
}

export function FuturesView({
  nativeState,
  onNewFuture,
  onCompose,
  onSourceRefs,
  onInspectProvenance,
  reload,
  message,
}) {
  const { busy, pendingPath, error, mutate } = useNativeMutation(reload, message);
  const ready = nativeState.repositories.some(
    (repository) => repository.status === 'ready' && repository.head && repository.tree,
  );
  const retentions = nativeState.retentions ?? [];

  return (
    <section aria-label="Isolated futures" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm leading-6 text-muted-foreground">
          {nativeState.futures.length} {nativeState.futures.length === 1 ? 'future' : 'futures'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onCompose}
            disabled={
              !onCompose ||
              !nativeState.futures.some(
                (future) => future.status === 'active' && future.current_revision_id,
              )
            }
          >
            Compose candidate
          </Button>
          <Button type="button" size="sm" onClick={() => onNewFuture()} disabled={!ready}>
            <Plus aria-hidden="true" />
            Fork repositories
          </Button>
        </div>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!nativeState.futures.length && (
        <p className="rounded-lg border bg-card p-5 text-sm leading-6 text-muted-foreground">
          {ready
            ? 'Fork a ready repository to begin independent work.'
            : 'Add a repository with a first commit before opening isolated work.'}
        </p>
      )}
      {nativeState.futures.map((future) => {
        const objective = nativeState.objectives.find((item) => item.id === future.objective_id);
        const revision = nativeState.futureRevisions.find(
          (item) => item.id === future.current_revision_id,
        );
        const revisions = nativeState.futureRevisions.filter(
          (item) => item.future_id === future.id,
        );
        const observable = ['active', 'unavailable', 'preparing'].includes(future.status);
        const sourceRefsEditable = ['active', 'unavailable'].includes(future.status);
        const observePath = '/futures/' + encodeURIComponent(future.id) + '/observe';
        return (
          <Card key={future.id} className="gap-4">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>
                  <h2 className="flex items-center gap-2 text-base">
                    <GitFork className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span className="break-all">{future.name}</span>
                  </h2>
                </CardTitle>
                <span className="rounded border px-2 py-1 text-xs text-muted-foreground">
                  {future.status}
                </span>
              </div>
              <CardDescription>{objective?.statement ?? 'Intent not recorded.'}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {future.status === 'unavailable' && (
                <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm leading-6 text-muted-foreground">
                  A tracked source no longer resolves to a commit. The last recorded revision
                  remains in history. Choose another source ref or restore the missing ref in Git.
                </p>
              )}
              {future.repositories.map((repository) => (
                <div key={repository.repo_id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="break-all text-sm font-medium">{repository.canonical_repo_id}</p>
                    <span className="text-xs text-muted-foreground">{repository.status}</span>
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    Fork · {repository.repo_id}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {repository.ref}
                  </p>
                  {repository.remote && (
                    <details className="mt-3 text-sm text-muted-foreground">
                      <summary>Clone repository</summary>
                      <RepositoryRemote remote={repository.remote} />
                    </details>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs leading-6 text-muted-foreground">
                  {revision
                    ? 'Source revision recorded'
                    : 'Waiting for an observed commit and tree.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {onSourceRefs && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy || !sourceRefsEditable}
                      onClick={() => onSourceRefs(future)}
                    >
                      <GitBranch aria-hidden="true" />
                      Choose source refs
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !observable}
                    onClick={() =>
                      mutate(
                        observePath,
                        { expected_version: future.version },
                        'Future Git state observed.',
                      )
                    }
                  >
                    <RefreshCw aria-hidden="true" />
                    {pendingPath === observePath ? 'Reading…' : 'Observe Git state'}
                  </Button>
                </div>
              </div>
              <details className="rounded-md border p-4">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Git state and revision history
                </summary>
                <div className="mt-4 space-y-6">
                  {revision && (
                    <div className="space-y-1 text-xs leading-6 text-muted-foreground">
                      <p>Provenance: {revision.provenance_state}</p>
                      <p>Context binding: {revision.context_binding_state ?? 'unknown'}</p>
                    </div>
                  )}
                  <section>
                    <h3 className="mb-3 text-sm font-medium">Fork baseline</h3>
                    <GitSnapshot entries={future.baseline_refs} label="Baseline" />
                  </section>
                  {revision && (
                    <section>
                      <h3 className="mb-3 text-sm font-medium">
                        {future.status === 'unavailable'
                          ? 'Last recorded revision'
                          : 'Current revision'}
                      </h3>
                      <GitSnapshot
                        entries={revision.repository_heads.map((head) => ({
                          ...head,
                          tree: revision.tree_hashes.find((entry) => entry.repo_id === head.repo_id)
                            ?.tree,
                        }))}
                        label="Revision"
                      />
                    </section>
                  )}
                  <section className="space-y-3" aria-label={'Revision history for ' + future.name}>
                    <h3 className="text-sm font-medium">Revision history</h3>
                    {[...revisions].reverse().map((record, index) => {
                      const retained = retentionConfirmed(record, retentions);
                      const retainPath = '/revisions/' + encodeURIComponent(record.id) + '/retain';
                      return (
                        <div key={record.id} className="space-y-3 rounded-md border p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <p className="font-medium">
                              Revision {revisions.length - index}
                              {record.id === future.current_revision_id ? ' · current' : ''}
                            </p>
                            <span className="text-muted-foreground">
                              {retained ? 'Archive receipt recorded' : 'Archive receipt missing'}
                            </span>
                          </div>
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {record.id}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {onInspectProvenance && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  onInspectProvenance({ kind: 'revision', id: record.id })
                                }
                              >
                                <History aria-hidden="true" />
                                Inspect provenance
                              </Button>
                            )}
                            {!retained && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  mutate(retainPath, {}, 'Historical Git object retention checked.')
                                }
                              >
                                <ShieldCheck aria-hidden="true" />
                                {pendingPath === retainPath ? 'Retaining…' : 'Retain Git objects'}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                </div>
              </details>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
