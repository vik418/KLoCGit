import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { useState } from 'react';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function NewObjective({
  nativeState,
  initialSystemId = '',
  onClose,
  onCreated,
  reload,
  message,
}) {
  const [systemId, setSystemId] = useState(initialSystemId);
  const [statement, setStatement] = useState('');
  const [scope, setScope] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);

  async function submit(event) {
    event.preventDefault();
    const result = await mutate(
      '/objectives',
      {
        system_id: systemId,
        statement: statement.trim(),
        scope: scope
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
      },
      'Objective recorded.',
    );
    if (result) onCreated(result.objective);
  }

  return (
    <NativeFormDialog
      title="Set an objective"
      description="State the outcome before starting isolated work."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!systemId || !statement.trim()}
      submitLabel="Record objective"
      pendingLabel="Recording…"
    >
      <label className="field">
        Group
        <NativeSelect
          value={systemId}
          onChange={(event) => setSystemId(event.target.value)}
          required
        >
          <option value="" disabled>
            Choose a group
          </option>
          {nativeState.systems.map((system) => (
            <option key={system.id} value={system.id}>
              {system.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="field">
        Requested outcome
        <Textarea
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          rows={4}
          required
          maxLength={2000}
        />
      </label>
      <label className="field">
        Affected scope (optional, one path or subsystem per line)
        <Textarea
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          rows={2}
          maxLength={4000}
        />
      </label>
    </NativeFormDialog>
  );
}
