import { Plus, RefreshCw, GitFork } from 'lucide-react';
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
          <dt className="text-muted-foreground">Commit</dt>
          <dd className="break-all font-mono text-muted-foreground">{entry.commit}</dd>
          <dt className="text-muted-foreground">Tree</dt>
          <dd className="break-all font-mono text-muted-foreground">{entry.tree}</dd>
        </dl>
      ))}
      {!entries.length && <p className="text-xs text-muted-foreground">{label} has no observed Git state.</p>}
    </div>
  );
}

export function FuturesView({ nativeState, onNewFuture, reload, message }) {
  const { busy, pendingPath, error, mutate } = useNativeMutation(reload, message);
  const ready = nativeState.repositories.some((repository) => repository.status === 'ready' && repository.head && repository.tree);

  return (
    <section aria-label="Isolated futures" className="space-y-5 py-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm leading-6 text-muted-foreground">Independent Git work recorded as immutable revisions.</p>
        <Button type="button" size="sm" onClick={() => onNewFuture()} disabled={!ready}><Plus aria-hidden="true" />Open isolated work</Button>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {!nativeState.futures.length && <p className="rounded-lg border bg-card p-5 text-sm leading-6 text-muted-foreground">{ready ? 'Open a future from a ready repository to begin independent work.' : 'Add a repository with a first commit before opening isolated work.'}</p>}
      {nativeState.futures.map((future) => {
        const objective = nativeState.objectives.find((candidate) => candidate.id === future.objective_id);
        const revision = nativeState.futureRevisions.find((candidate) => candidate.id === future.current_revision_id);
        const revisions = nativeState.futureRevisions.filter((candidate) => candidate.future_id === future.id);
        return (
          <Card key={future.id} className="gap-4">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle><h2 className="flex items-center gap-2 text-base"><GitFork className="size-4 shrink-0 text-primary" aria-hidden="true" /><span className="break-all">{future.name}</span></h2></CardTitle>
                <span className="rounded border px-2 py-1 text-xs text-muted-foreground">{future.status}</span>
              </div>
              {objective?.statement ? <CardDescription>{objective.statement}</CardDescription> : <CardDescription>Intent not recorded.</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-4">
              {future.repositories.map((repository) => (
                <div key={repository.repo_id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3"><p className="break-all text-sm font-medium">{repository.repo_id}</p><span className="text-xs text-muted-foreground">{repository.status}</span></div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">Derived from {repository.canonical_repo_id}</p>
                  {repository.remote && <RepositoryRemote remote={repository.remote} />}
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs leading-6 text-muted-foreground">{revision ? 'An immutable Git revision is recorded. No validation result is implied.' : 'Waiting for an observed commit and tree.'}</p>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => mutate('/futures/' + encodeURIComponent(future.id) + '/observe', { expected_version: future.version }, 'Future Git state observed.')}>
                  <RefreshCw aria-hidden="true" />{pendingPath === '/futures/' + encodeURIComponent(future.id) + '/observe' ? 'Reading…' : 'Observe Git state'}
                </Button>
              </div>
              <details className="rounded-md border p-4">
                <summary className="cursor-pointer text-sm text-muted-foreground">Git state and revision history</summary>
                <div className="mt-4 space-y-6">
                  {revision && <p className="text-xs text-muted-foreground">Provenance: {revision.provenance_state}</p>}
                  <section><h3 className="mb-3 text-sm font-medium">Fork baseline</h3><GitSnapshot entries={future.baseline_refs} label="Baseline" /></section>
                  {revision && <section><h3 className="mb-3 text-sm font-medium">Current revision</h3><GitSnapshot entries={revision.repository_heads.map((head) => ({ ...head, tree: revision.tree_hashes.find((entry) => entry.repo_id === head.repo_id)?.tree }))} label="Revision" /></section>}
                  <ul className="space-y-2 text-xs leading-6 text-muted-foreground">{revisions.map((record) => <li key={record.id} className="break-all font-mono">{record.id}</li>)}</ul>
                </div>
              </details>
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}
