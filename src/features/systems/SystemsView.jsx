import { Code2, GitFork, Layers3, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../ui/Card.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';
import { RepositoryRemote } from './RepositoryRemote.jsx';

export function SystemsView({
  nativeState,
  onNewRepository,
  onNewSystem,
  onNewObjective,
  onNewFuture,
  onBrowseRepository,
  onContext,
  reload,
  message,
}) {
  const { busy, pendingPath, error, mutate } = useNativeMutation(reload, message);
  const recoveryRequests = nativeState.requests.filter((request) =>
    ['prepared', 'recovery_required', 'uncertain'].includes(request.status),
  );
  const ready = nativeState.repositories.some(
    (repository) => repository.status === 'ready' && repository.head && repository.tree,
  );

  return (
    <div className="space-y-8 py-7">
      {recoveryRequests.length > 0 && (
        <section aria-label="Recovery required" className="space-y-3 rounded-lg border bg-card p-5">
          <h2 className="text-base font-semibold text-primary">Recovery required</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            A repository operation has not been confirmed. Reconcile its Git state before treating
            it as complete.
          </p>
          {recoveryRequests.map((request) => (
            <div
              key={request.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{request.operation}</p>
                <p className="text-xs text-muted-foreground">{request.status}</p>
                <code className="break-all text-xs">{request.id}</code>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  mutate(
                    '/repository-requests/' + encodeURIComponent(request.id) + '/recover',
                    {},
                    'Git state reconciled.',
                  )
                }
              >
                <RefreshCw aria-hidden="true" />
                {pendingPath ===
                '/repository-requests/' + encodeURIComponent(request.id) + '/recover'
                  ? 'Reconciling…'
                  : 'Reconcile Git state'}
              </Button>
            </div>
          ))}
        </section>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <section aria-label="Repositories">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Repositories</h2>
          <Button type="button" size="sm" onClick={onNewRepository}>
            <Plus aria-hidden="true" />
            Add repository
          </Button>
        </div>
        {!nativeState.repositories.length && (
          <p className="rounded-lg border bg-card p-5 text-sm leading-6 text-muted-foreground">
            Create an empty Artifacts repository or import existing Git work.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {nativeState.repositories.map((repository) => (
            <Card key={repository.id} className="gap-4">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>
                    <h3 className="break-all text-base">{repository.id}</h3>
                  </CardTitle>
                  <span className="rounded border px-2 py-1 text-xs text-muted-foreground">
                    {repository.status === 'ready' ? 'Git state ready' : repository.status}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                {repository.status === 'empty' && (
                  <p className="text-sm leading-6 text-muted-foreground">
                    Push a first commit, then refresh this repository.
                  </p>
                )}
                {['importing', 'forking'].includes(repository.status) && (
                  <p className="text-sm leading-6 text-muted-foreground">
                    Refresh when the provider has finished preparing Git state.
                  </p>
                )}
                {repository.status === 'ready' && (
                  <p className="text-xs leading-6 text-muted-foreground">
                    A commit and tree are available. This is not a validation result.
                  </p>
                )}
                {repository.remote && <RepositoryRemote remote={repository.remote} />}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {repository.status === 'ready' && onBrowseRepository && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onBrowseRepository(repository.id)}
                    >
                      <Code2 aria-hidden="true" />
                      Browse code
                    </Button>
                  )}
                  {repository.status === 'ready' && repository.head && repository.tree && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onNewFuture({ repositoryId: repository.id })}
                    >
                      <GitFork aria-hidden="true" />
                      Fork repository
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        '/repositories/' + encodeURIComponent(repository.id) + '/refresh',
                        {},
                        'Repository state refreshed.',
                      )
                    }
                  >
                    <RefreshCw aria-hidden="true" />
                    {pendingPath ===
                    '/repositories/' + encodeURIComponent(repository.id) + '/refresh'
                      ? 'Refreshing…'
                      : 'Refresh Git state'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      <section aria-label="Groups">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Groups</h2>
          <Button type="button" size="sm" variant="outline" onClick={onNewSystem} disabled={!ready}>
            <Plus aria-hidden="true" />
            Group repositories
          </Button>
        </div>
        {!nativeState.systems.length && (
          <p className="text-sm leading-6 text-muted-foreground">
            Groups collect related repositories. You can also start work from one repository.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {nativeState.systems.map((system) => (
            <Card key={system.id} className="gap-4">
              <CardHeader>
                <CardTitle>
                  <h3 className="flex items-center gap-2 text-base">
                    <Layers3 className="size-4 text-primary" aria-hidden="true" />
                    {system.name}
                  </h3>
                </CardTitle>
                {system.description && <CardDescription>{system.description}</CardDescription>}
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-1 text-xs leading-6 text-muted-foreground">
                  {system.repository_ids.map((id) => (
                    <li key={id} className="break-all">
                      {id}
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onNewFuture({ systemId: system.id })}
                >
                  <GitFork aria-hidden="true" />
                  Fork repositories
                </Button>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    Objective without starting work
                  </summary>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="mt-3"
                    onClick={() => onNewObjective(system.id)}
                  >
                    Set objective
                  </Button>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      <section aria-label="Objectives">
        <h2 className="mb-4 text-base font-semibold">Objectives</h2>
        {!nativeState.objectives.length && (
          <p className="text-sm leading-6 text-muted-foreground">
            Record an outcome for a group, then prepare context before starting work.
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {nativeState.objectives.map((objective) => (
            <Card key={objective.id} className="gap-4">
              <CardHeader>
                <CardTitle>
                  <h3 className="text-base leading-6">{objective.statement}</h3>
                </CardTitle>
                <CardDescription>
                  {nativeState.systems.find((system) => system.id === objective.system_id)?.name ??
                    objective.system_id}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {objective.scope?.length > 0 && (
                  <ul className="space-y-1 text-xs leading-6 text-muted-foreground">
                    {objective.scope.map((scope) => (
                      <li key={scope} className="break-all">
                        {scope}
                      </li>
                    ))}
                  </ul>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!onContext}
                  onClick={() => onContext(objective)}
                >
                  Prepare context
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
