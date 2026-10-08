import { useState } from 'react';
import { Checkbox } from '../../ui/Checkbox.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function SettlementDialog({
  operation,
  repository,
  repositories = [],
  onClose,
  reload,
  message,
}) {
  // Pin the observations the operator saw. A rerender must not silently change consent.
  const [observed] = useState(() => (repositories.length ? repositories : repository ? [repository] : [])
    .map((entry) => ({ id: entry.id, head: entry.head, unavailable: !!entry.unavailable })));
  const stages = operation.stages ?? [];
  const uncertain = stages.filter((stage) => stage.status === 'uncertain');
  const [repoId, setRepoId] = useState(uncertain[0]?.repo ?? operation.repo);
  const [abandon, setAbandon] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [rationale, setRationale] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const selected = observed.find((entry) => entry.id === repoId);
  const expectedHeads = Object.fromEntries(observed.map((entry) => [entry.id, entry.head]));
  const unresolved = stages.some((stage) => stage.status === 'uncertain' ||
    (stage.status === 'prepared' && stage.dispatch_state === 'issued'));
  const fullVector = observed.length > 0 &&
    Object.keys(operation.reviewed_heads ?? {}).every((id) => expectedHeads[id]) &&
    observed.every((entry) => entry.head && !entry.unavailable);
  const canAbandon = stages.length > 0 && operation.status === 'recovery-required' &&
    !unresolved && fullVector;
  const ready = confirmed && rationale.trim() && (abandon
    ? canAbandon
    : selected?.head && !selected.unavailable && outcome &&
      (!stages.length || uncertain.some((stage) => stage.repo === repoId)));

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    const result = await mutate(
      '/promotions/' + encodeURIComponent(operation.id) + '/settle',
      {
        ...(abandon
          ? { abandon: true, expected_heads: expectedHeads }
          : { repo_id: repoId, expected_head: selected.head, outcome }),
        confirmed,
        rationale,
      },
      abandon
        ? 'Remaining rollout abandoned. Applied Git state was kept.'
        : 'Operator settlement recorded. Git was not changed.',
    );
    if (result) onClose();
  }

  return (
    <NativeFormDialog
      title={abandon ? 'Keep this partial state' : 'Settle uncertain promotion'}
      description="Confirm inspected history. Settlement never repeats or undoes Git; any reversal requires a new candidate."
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      disabled={!ready}
      submitLabel={abandon ? 'Abandon remaining rollout' : 'Record settlement'}
      pendingLabel="Recording…"
    >
      <div className="space-y-4">
        {stages.length > 0 && (
          <>
            <section className="space-y-2" aria-label="Repository rollout states">
              {stages.map((stage) => (
                <div key={stage.repo} className="rounded-md border p-3 text-sm">
                  <p className="break-all font-medium">{stage.repo}</p>
                  <p className="text-xs text-muted-foreground">
                    {stage.status}
                    {stage.status === 'applied' && stage.current === false ? ' · ref moved after application' : ''}
                  </p>
                </div>
              ))}
            </section>
            <label className="grid gap-2 text-sm">
              Recovery action
              <NativeSelect aria-label="Recovery action" value={abandon ? 'abandon' : 'settle'}
                onChange={(event) => {
                  setAbandon(event.target.value === 'abandon');
                  setConfirmed(false);
                }}>
                <option value="settle">Confirm an uncertain repository outcome</option>
                <option value="abandon" disabled={!canAbandon}>Keep partial state and abandon the remainder</option>
              </NativeSelect>
            </label>
            {!canAbandon && (
              <p className="text-xs leading-6 text-muted-foreground">
                Reconcile repository refs and settle every uncertain stage before abandoning the remainder.
              </p>
            )}
          </>
        )}
        {abandon ? (
          <>
            <p className="text-sm leading-6">
              Applied changes stay in Git. The remaining stages will not run.
            </p>
            <section className="space-y-2" aria-label="Reviewed canonical heads">
              {observed.map((entry) => (
                <div key={entry.id} className="rounded-md border p-3">
                  <p className="break-all text-sm font-medium">{entry.id}</p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{entry.head}</p>
                </div>
              ))}
            </section>
          </>
        ) : (
          <>
            {stages.length > 0 && (
              <label className="grid gap-2 text-sm">
                Uncertain repository
                <NativeSelect aria-label="Uncertain repository" value={repoId ?? ''}
                  onChange={(event) => {
                    setRepoId(event.target.value);
                    setConfirmed(false);
                    setOutcome('');
                  }}>
                  {!uncertain.length && <option value="">No uncertain repository</option>}
                  {uncertain.map((stage) => <option key={stage.repo} value={stage.repo}>{stage.repo}</option>)}
                </NativeSelect>
              </label>
            )}
            <dl className="space-y-2 break-all font-mono text-xs text-muted-foreground">
              <dt>Repository</dt>
              <dd>{repoId}</dd>
              <dt>Prepared target</dt>
              <dd>{stages.find((stage) => stage.repo === repoId)?.target_commit ?? operation.target_commit}</dd>
              <dt>Observed canonical head</dt>
              <dd>{selected?.head ?? 'Unavailable'}</dd>
            </dl>
            <label className="grid gap-2 text-sm">
              Confirmed outcome
              <NativeSelect
                aria-label="Confirmed outcome"
                value={outcome}
                onChange={(event) => {
                  setOutcome(event.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">Choose the inspected outcome</option>
                <option value="not_applied">Write did not apply</option>
                <option value="applied_then_moved">Write applied, then the ref moved</option>
              </NativeSelect>
            </label>
          </>
        )}
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
          {abandon
            ? 'I reviewed every canonical head and choose to keep this partial state.'
            : 'I checked Git history and confirmed this outcome.'}
        </label>
        <p className="text-xs leading-6 text-muted-foreground">
          Your attestation is declared information. Current refs are separate observations and
          do not prove whether the earlier write landed.
        </p>
      </div>
    </NativeFormDialog>
  );
}
