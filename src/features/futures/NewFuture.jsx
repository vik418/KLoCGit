import { useId, useState } from 'react';
import { Checkbox } from '../../ui/Checkbox.jsx';
import { Input } from '../../ui/Input.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

function repositoryReady(repository) {
  return (
    repository.status === 'ready' &&
    Boolean(repository.head && repository.tree) &&
    (!repository.event_subscription || repository.event_subscription.status === 'ready')
  );
}

export function NewFuture({
  nativeState,
  initialRepositoryId = '',
  initialSystemId = '',
  initialObjective = null,
  contextSnapshotId = null,
  onClose,
  onCreated,
  reload,
  message,
}) {
  const objectiveSelectId = useId();
  const initialObjectiveId =
    typeof initialObjective === 'string' ? initialObjective : (initialObjective?.id ?? '');
  const [objectiveId, setObjectiveId] = useState(initialObjectiveId);
  const objective = nativeState.objectives.find((item) => item.id === objectiveId);
  const systemId = objective?.system_id ?? initialSystemId;
  const system = nativeState.systems.find((item) => item.id === systemId);
  const eligibleRepositories = system
    ? nativeState.repositories.filter((repository) => system.repository_ids.includes(repository.id))
    : nativeState.repositories;
  const [repositoryIds, setRepositoryIds] = useState(() =>
    initialRepositoryId
      ? [initialRepositoryId]
      : (system?.repository_ids ?? []).filter((id) =>
          eligibleRepositories.some(
            (repository) => repository.id === id && repositoryReady(repository),
          ),
        ),
  );
  const [statement, setStatement] = useState('');
  const [name, setName] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const selectedReady =
    repositoryIds.length > 0 &&
    repositoryIds.every((id) =>
      eligibleRepositories.some(
        (repository) => repository.id === id && repositoryReady(repository),
      ),
    );
  const objectiveReady = !objectiveId || objective?.status === 'open';
  const contextReady = !contextSnapshotId || (objective && objectiveId === initialObjectiveId);
  const availableObjectives = nativeState.objectives.filter(
    (item) => item.status === 'open' && (!initialSystemId || item.system_id === initialSystemId),
  );

  function chooseObjective(id) {
    setObjectiveId(id);
    const selectedObjective = nativeState.objectives.find((item) => item.id === id);
    const selectedSystem = nativeState.systems.find(
      (item) => item.id === (selectedObjective?.system_id ?? initialSystemId),
    );
    const allowedIds = selectedSystem?.repository_ids;
    setRepositoryIds((selected) =>
      selected.filter(
        (repoId) =>
          (!allowedIds || allowedIds.includes(repoId)) &&
          nativeState.repositories.some(
            (repository) => repository.id === repoId && repositoryReady(repository),
          ),
      ),
    );
  }

  function toggle(id) {
    setRepositoryIds((selected) =>
      selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id],
    );
  }

  async function submit(event) {
    event.preventDefault();
    if (!selectedReady || !objectiveReady || !contextReady) return;
    const body = { repository_ids: [...repositoryIds].sort() };
    if (systemId) body.system_id = systemId;
    if (objectiveId) body.objective_id = objectiveId;
    else if (statement.trim()) body.statement = statement.trim();
    if (contextSnapshotId) body.context_snapshot_id = contextSnapshotId;
    if (name.trim()) body.name = name.trim();
    const result = await mutate('/futures', body, 'Repositories forked. Future created.');
    if (result) onCreated(result.future);
  }

  return (
    <NativeFormDialog
      title="Fork repositories"
      description="Create isolated Git repositories from the current states. The original repositories stay unchanged."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!selectedReady || !objectiveReady || !contextReady}
      submitLabel="Fork repositories"
      pendingLabel="Forking…"
    >
      <fieldset className="min-w-0 border-0 p-0">
        <legend className="mb-2 text-sm font-medium">Repositories</legend>
        {eligibleRepositories.map((repository) => {
          const ready = repositoryReady(repository);
          return (
            <label key={repository.id} className="checkbox-label">
              <Checkbox
                value={repository.id}
                checked={repositoryIds.includes(repository.id)}
                onCheckedChange={() => toggle(repository.id)}
                disabled={!ready}
              />
              <span className="min-w-0 break-all">
                {repository.id}
                {!ready && (
                  <small>{repository.status} · refresh its Git state before forking</small>
                )}
              </span>
            </label>
          );
        })}
        {!eligibleRepositories.length && (
          <p className="text-sm text-muted-foreground">
            No repositories are available for this work.
          </p>
        )}
      </fieldset>
      {availableObjectives.length > 0 && (
        <div className="field">
          <label htmlFor={objectiveSelectId}>Objective (optional)</label>
          <NativeSelect
            id={objectiveSelectId}
            value={objectiveId}
            onChange={(event) => chooseObjective(event.target.value)}
            disabled={Boolean(contextSnapshotId)}
          >
            <option value="">New objective</option>
            {availableObjectives.map((item) => (
              <option key={item.id} value={item.id}>
                {item.statement ?? 'Intent not recorded'}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {!objectiveId && (
        <label className="field">
          What do you want to change? (optional)
          <Textarea
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            rows={3}
            maxLength={2000}
          />
        </label>
      )}
      {objective && (
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          {objective.statement ?? 'Intent not recorded.'}
        </p>
      )}
      {contextSnapshotId && contextReady && (
        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          The reviewed context snapshot will be bound to this Future and its first revision.
        </p>
      )}
      {(!objectiveReady || !contextReady) && (
        <p className="error-banner mt-4" role="alert">
          This Objective or its context is no longer available. Close this form and review the
          current Objective before forking.
        </p>
      )}
      <details className="mt-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Name this work (optional)
        </summary>
        <label className="field">
          Name
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} />
        </label>
      </details>
      <p className="mt-4 text-xs leading-6 text-muted-foreground">
        Use any Git client in the isolated repositories. A future records exact versions as work
        arrives.
      </p>
    </NativeFormDialog>
  );
}
