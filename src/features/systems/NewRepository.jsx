import { Textarea } from '../../ui/Textarea.jsx';
import { useState } from 'react';
import { Input } from '../../ui/Input.jsx';
import { Button } from '../../ui/Button.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

const modes = [
  ['create', 'New repository'],
  ['import', 'Import Git'],
  ['adopt', 'Existing Artifacts'],
];

export function NewRepository({ onClose, onCreated, reload, message }) {
  const [mode, setMode] = useState('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);

  async function submit(event) {
    event.preventDefault();
    const body = { id: name.trim(), description: description.trim(), mode };
    if (mode === 'import') {
      body.source = { url: url.trim() };
      if (branch.trim()) body.source.branch = branch.trim();
    }
    const result = await mutate('/repositories', body, 'Repository recorded.');
    if (result) onCreated(result.repository);
  }

  return (
    <NativeFormDialog
      title="Add a repository"
      description="Git stays usable with any standard client."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!name.trim() || (mode === 'import' && !url.trim())}
      submitLabel={mode === 'create' ? 'Create repository' : mode === 'import' ? 'Import repository' : 'Connect repository'}
      pendingLabel={mode === 'create' ? 'Creating…' : mode === 'import' ? 'Importing…' : 'Connecting…'}
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label="Repository source">
        {modes.map(([value, label]) => (
          <Button key={value} type="button" variant={mode === value ? 'secondary' : 'ghost'} size="sm" aria-pressed={mode === value} onClick={() => setMode(value)}>
            {label}
          </Button>
        ))}
      </div>
      <label className="field">
        Repository name
        <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoComplete="off" />
      </label>
      {mode === 'import' && (
        <>
          <label className="field">
            Public Git URL
            <Input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required autoComplete="off" />
          </label>
          <label className="field">
            Source branch (optional)
            <Input value={branch} onChange={(event) => setBranch(event.target.value)} autoComplete="off" />
          </label>
          <p className="text-xs leading-6 text-muted-foreground">Import accepts approved public HTTPS repositories. Do not include credentials in the URL.</p>
        </>
      )}
      {mode !== 'adopt' && (
        <label className="field">
          Description (optional)
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={1000} />
        </label>
      )}
      <p className="mt-4 text-sm leading-6 text-muted-foreground">
        {mode === 'create'
          ? 'The repository starts empty. Push your first commit, then refresh it before opening a future.'
          : mode === 'import'
            ? 'The import becomes ready only after its Git commit and tree can be read.'
            : 'Connect a repository already present in this Artifacts namespace.'}
      </p>
    </NativeFormDialog>
  );
}
