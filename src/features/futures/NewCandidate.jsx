import { useState } from 'react';
import { Checkbox } from '../../ui/Checkbox.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function NewCandidate({ nativeState, onClose, onCreated, reload, message }) {
  const [choices, setChoices] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const futures = nativeState.futures.filter(
    (future) => future.status === 'active' && future.current_revision_id,
  );
  const selected = futures.filter((future) => choices[future.id]?.selected);

  function change(id, fields) {
    setChoices((current) => ({
      ...current,
      [id]: { kind: 'future', commits: '', ...current[id], ...fields },
    }));
  }

  const valid = selected.length > 0 && selected.every((future) => {
    const choice = choices[future.id];
    return choice.kind === 'future' || (
      choice.repo_id &&
      choice.commits.trim().split(/\s+/).every((commit) => /^[a-f0-9]{40}$/.test(commit))
    );
  });

  async function submit(event) {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const selectionIds = [];
      for (const future of selected) {
        const choice = choices[future.id];
        const result = await mutate('/selections', {
          future_revision_id: future.current_revision_id,
          kind: choice.kind,
          ...(choice.kind === 'commits' ? {
            repo_id: choice.repo_id,
            commits: choice.commits.trim().split(/\s+/),
          } : {}),
        });
        if (!result) return;
        selectionIds.push(result.selection.id);
      }
      const result = await mutate('/candidates', { selection_ids: selectionIds }, 'Candidate created.');
      if (result) onCreated(result.candidate.id);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <NativeFormDialog
      title="Compose a candidate"
      description="Combine pinned Future revisions. Commit selections apply only their patches, in the order entered."
      onClose={onClose}
      onSubmit={submit}
      busy={busy || submitting}
      error={error}
      disabled={!valid}
      submitLabel="Create candidate"
      pendingLabel="Composing…"
    >
      <div className="space-y-4">
        {futures.map((future) => {
          const choice = choices[future.id];
          const revision = nativeState.futureRevisions.find(
            (entry) => entry.id === future.current_revision_id,
          );
          return (
            <section key={future.id} className="space-y-3 rounded-md border p-4">
              <label className="flex items-center gap-3 text-sm font-medium">
                <Checkbox
                  checked={choice?.selected ?? false}
                  onCheckedChange={(checked) => change(future.id, { selected: checked === true })}
                />
                {future.name}
              </label>
              {choice?.selected && (
                <>
                  <label className="grid gap-2 text-sm">
                    Selection for {future.name}
                    <NativeSelect
                      value={choice.kind}
                      onChange={(event) => change(future.id, { kind: event.target.value })}
                    >
                      <option value="future">Whole Future</option>
                      <option value="commits">Selected commits</option>
                    </NativeSelect>
                  </label>
                  {choice.kind === 'commits' && (
                    <>
                      <label className="grid gap-2 text-sm">
                        Repository for {future.name}
                        <NativeSelect
                          value={choice.repo_id ?? ''}
                          onChange={(event) => change(future.id, { repo_id: event.target.value })}
                        >
                          <option value="">Choose repository</option>
                          {revision.repository_heads.map((head) => (
                            <option key={head.repo_id} value={head.repo_id}>{head.repo_id}</option>
                          ))}
                        </NativeSelect>
                      </label>
                      <label className="grid gap-2 text-sm">
                        Commit hashes for {future.name}
                        <Textarea
                          value={choice.commits}
                          onChange={(event) => change(future.id, { commits: event.target.value })}
                          className="font-mono"
                          rows={3}
                        />
                      </label>
                      <p className="text-xs leading-6 text-muted-foreground">
                        Full hashes, one per line. Merge commits and automatic dependency closure are not supported.
                      </p>
                    </>
                  )}
                  <p className="break-all text-xs text-muted-foreground">
                    Provenance: {revision.provenance_state}. Validation is required on the combined tree.
                  </p>
                </>
              )}
            </section>
          );
        })}
        {!futures.length && <p className="text-sm text-muted-foreground">No active Futures are ready.</p>}
      </div>
    </NativeFormDialog>
  );
}
