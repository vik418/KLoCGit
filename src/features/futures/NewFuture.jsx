import { Checkbox } from '../../ui/Checkbox.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { useState } from 'react';
import { Input } from '../../ui/Input.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function NewFuture({
  nativeState,
  initialRepositoryId = '',
  initialSystemId = '',
  onClose,
  onCreated,
  reload,
  message,
}) {
  const initialSystem = nativeState.systems.find((system) => system.id === initialSystemId);
  const eligibleRepositories = initialSystem
    ? nativeState.repositories.filter((repository) =>
        initialSystem.repository_ids.includes(repository.id),
      )
    : nativeState.repositories;
  const [repositoryIds, setRepositoryIds] = useState(
    initialRepositoryId ? [initialRepositoryId] : (initialSystem?.repository_ids ?? []),
  );
  const [statement, setStatement] = useState('');
  const [name, setName] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const selectedReady =
    repositoryIds.length > 0 &&
    repositoryIds.every((id) =>
      eligibleRepositories.some(
        (repository) =>
          repository.id === id &&
          repository.status === 'ready' &&
          repository.head &&
          repository.tree,
      ),
    );

  function toggle(id) {
    setRepositoryIds((selected) =>
      selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id],
    );
  }

  async function submit(event) {
    event.preventDefault();
    const body = { repository_ids: [...repositoryIds].sort() };
    if (initialSystemId) body.system_id = initialSystemId;
    if (statement.trim()) body.statement = statement.trim();
    if (name.trim()) body.name = name.trim();
    const result = await mutate('/futures', body, 'Isolated work recorded.');
    if (result) onCreated(result.future);
  }

  return (
    <NativeFormDialog
      title="Open isolated work"
      description="Fork known Git states without changing the canonical repositories."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!selectedReady}
      submitLabel="Create future"
      pendingLabel="Creating…"
    >
      <fieldset className="min-w-0 border-0 p-0">
        <legend className="mb-2 text-sm font-medium">Repositories</legend>
        {eligibleRepositories.map((repository) => {
          const ready = repository.status === 'ready' && repository.head && repository.tree;
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
                {!ready && <small>{repository.status} · a commit is needed before forking</small>}
              </span>
            </label>
          );
        })}
      </fieldset>
      <label className="field">
        What do you want to change? (optional)
        <Textarea
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          rows={3}
          maxLength={2000}
        />
      </label>
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
