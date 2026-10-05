import { useState } from 'react';
import { Checkbox } from '../../ui/Checkbox.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function SettlementDialog({ operation, repository, onClose, reload, message }) {
  const [expectedHead] = useState(repository?.head);
  const [outcome, setOutcome] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [rationale, setRationale] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const ready =
    expectedHead && !repository?.unavailable && confirmed && outcome && rationale.trim();

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    const result = await mutate(
      '/promotions/' + encodeURIComponent(operation.id) + '/settle',
      {
        expected_head: expectedHead,
        outcome,
        confirmed,
        rationale,
      },
      'Operator settlement recorded. Git was not changed.',
    );
    if (result) onClose();
  }

  return (
    <NativeFormDialog
      title="Settle uncertain promotion"
      description="Check Git history before confirming the outcome. The current ref alone cannot establish whether the earlier write landed. Settlement never repeats or undoes Git."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!ready}
      submitLabel="Record settlement"
      pendingLabel="Recording…"
    >
      <div className="space-y-4">
        <dl className="space-y-2 break-all font-mono text-xs text-muted-foreground">
          <dt>Repository</dt>
          <dd>{operation.repo}</dd>
          <dt>Prepared target</dt>
          <dd>{operation.target_commit}</dd>
          <dt>Observed canonical head</dt>
          <dd>{expectedHead ?? 'Unavailable'}</dd>
        </dl>
        <label className="grid gap-2 text-sm">
          Confirmed outcome
          <NativeSelect
            aria-label="Confirmed outcome"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="">Choose the inspected outcome</option>
            <option value="not_applied">Write did not apply</option>
            <option value="applied_then_moved">Write applied, then the ref moved</option>
          </NativeSelect>
        </label>
        <label className="grid gap-2 text-sm">
          What establishes this outcome?
          <Textarea
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            maxLength={4000}
          />
        </label>
        <label className="flex items-start gap-3 text-sm leading-6">
          <Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />
          I checked Git history and confirmed this outcome.
        </label>
        <p className="text-xs leading-6 text-muted-foreground">
          The attestation is recorded as declared information, alongside the observed ref. It is not
          an automatic proof of history.
        </p>
      </div>
    </NativeFormDialog>
  );
}
