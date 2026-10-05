import { Checkbox } from '../../ui/Checkbox.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { useState } from 'react';
import { Input } from '../../ui/Input.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function NewSystem({ nativeState, onClose, onCreated, reload, message }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repositoryIds, setRepositoryIds] = useState([]);
  const { busy, error, mutate } = useNativeMutation(reload, message);

  function toggle(id) {
    setRepositoryIds((selected) =>
      selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id],
    );
  }

  async function submit(event) {
    event.preventDefault();
    const result = await mutate(
      '/systems',
      {
        name: name.trim(),
        description: description.trim(),
        repository_ids: [...repositoryIds].sort(),
      },
      'System created.',
    );
    if (result) onCreated(result.system);
  }

  return (
    <NativeFormDialog
      title="Create a system"
      description="A system groups the repositories that make one product."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!name.trim() || !repositoryIds.length}
      submitLabel="Create system"
      pendingLabel="Creating…"
    >
      <label className="field">
        Name
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={100}
        />
      </label>
      <label className="field">
        Description (optional)
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          maxLength={1000}
        />
      </label>
      <fieldset className="mt-5 min-w-0 border-0 p-0">
        <legend className="mb-2 text-sm font-medium">Repositories</legend>
        {nativeState.repositories.map((repository) => {
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
                {!ready && <small>{repository.status} · refresh after a commit is available</small>}
              </span>
            </label>
          );
        })}
        {!nativeState.repositories.length && (
          <p className="text-sm text-muted-foreground">Add a repository first.</p>
        )}
      </fieldset>
      <p className="mt-4 text-xs leading-6 text-muted-foreground">
        Only repositories with a known commit and tree can become a canonical baseline.
      </p>
    </NativeFormDialog>
  );
}
