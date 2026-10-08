import { useEffect, useState } from 'react';
import { validationPassed } from '../../../core/evidence.mjs';
import { RefreshCw, X } from 'lucide-react';
import { Dialog, DialogDescription, DialogTitle } from '../../ui/Dialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { NativeSelect } from '../../ui/NativeSelect.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { apiRequest } from '../../lib/api.js';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function ContinuationDialog({ operation, candidates = [], onClose, reload, message }) {
  const [candidateId, setCandidateId] = useState('');
  const [review, setReview] = useState(null);
  const [readError, setReadError] = useState(null);
  const [version, setVersion] = useState(0);
  const [rationale, setRationale] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const unresolved = operation.stages?.some((stage) => stage.status === 'uncertain' ||
    (stage.status === 'prepared' && stage.dispatch_state === 'issued'));

  useEffect(() => {
    let cancelled = false;
    if (!candidateId) return;
    apiRequest('/promotions/' + encodeURIComponent(operation.id) + '/review?candidate_id=' +
      encodeURIComponent(candidateId)).then(
      (result) => {
        if (!cancelled) {
          setReview(result);
          setReadError(null);
        }
      },
      (failure) => {
        if (!cancelled) {
          setReview(null);
          setReadError(failure.message);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [operation.id, candidateId, version]);

  function refresh() {
    setReview(null);
    setReadError(null);
    setVersion((current) => current + 1);
  }

  async function validate() {
    if (!candidateId) return;
    const result = await mutate(
      '/candidates/' + encodeURIComponent(candidateId) + '/validate',
      {},
      'Fresh continuation validation recorded.',
    );
    if (result) refresh();
  }

  async function submit(event) {
    event.preventDefault();
    if (!review) return;
    const result = await mutate(
      '/promotions/' + encodeURIComponent(operation.id) + '/continue',
      {
        candidate_id: candidateId,
        decision_basis_hash: review.decision_basis_hash,
        expected_heads: review.expected_heads,
        rationale,
      },
      'Rollout continuation recorded.',
    );
    if (result) onClose();
  }

  const ready = !unresolved && review?.sources_current && review.heads_current &&
    review.validation_passing && review.promotion_supported && rationale.trim();

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} className="max-w-xl" hasDescription>
      <div className="dialog-header">
        <div>
          <DialogTitle>Continue partial rollout</DialogTitle>
          <DialogDescription className="mt-2">
            Choose a newly composed candidate against the current system state. Applied stages stay
            in Git; only remaining repositories can advance.
          </DialogDescription>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={onClose}
          aria-label="Close continuation">
          <X aria-hidden="true" />
        </Button>
      </div>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="native-body space-y-5">
          {(error || readError) && <p role="alert" className="error-banner">{error || readError}</p>}
          <section className="space-y-2" aria-label="Partial rollout">
            {operation.stages?.map((stage) => (
              <div key={stage.repo} className="rounded-md border p-3">
                <p className="break-all text-sm font-medium">{stage.repo}</p>
                <p className="text-xs text-muted-foreground">
                  {stage.status}
                  {stage.current === false ? ' · canonical ref moved' : ''}
                </p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Prepared Git state</summary>
                  <dl className="mt-2 space-y-2 break-all font-mono text-xs text-muted-foreground">
                    <dt>Reviewed base</dt><dd>{stage.expected_head}</dd>
                    <dt>Target</dt><dd>{stage.target_commit}</dd>
                    {stage.observed_head && <><dt>Observed head</dt><dd>{stage.observed_head}</dd></>}
                  </dl>
                </details>
              </div>
            ))}
          </section>
          {unresolved && (
            <p role="status" className="text-sm leading-6 text-muted-foreground">
              Reconcile or settle uncertain stages before continuing.
            </p>
          )}
          <label className="grid gap-2 text-sm">
            New candidate
            <NativeSelect aria-label="Continuation candidate" value={candidateId} disabled={busy}
              onChange={(event) => {
                setCandidateId(event.target.value);
                setReview(null);
                setReadError(null);
                setRationale('');
              }}>
              <option value="">Choose a candidate composed from current heads</option>
              {candidates.filter((candidate) => candidate.id !== operation.candidate_id).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id.slice(0, 20)} · {candidate.repositories.length} repositories
                </option>
              ))}
            </NativeSelect>
          </label>
          {candidateId && !review && !readError && (
            <p className="text-sm text-muted-foreground">Reading the continuation basis…</p>
          )}
          {review && (
            <>
              <section className="space-y-3" aria-label="Continuation evidence">
                <h2 className="text-sm font-medium">Fresh composed-state evidence</h2>
                {review.candidate.repositories.map((repo, index) => {
                  const evidence = review.evidence[index];
                  return (
                    <div key={repo.repo_id} className="space-y-2 rounded-md border p-3">
                      <p className="break-all text-sm font-medium">{repo.repo_id}</p>
                      <p className="text-xs text-muted-foreground">
                        {repo.tree === repo.base_tree ? 'Keeps applied state' : 'Remaining update'}
                        {' · '}
                        {evidence?.validity.status === 'current' && validationPassed(evidence)
                          ? 'Finite checks passed'
                          : evidence?.validity.status === 'stale' ? 'Evidence stale' : 'Validation required'}
                      </p>
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">Exact candidate state</summary>
                        <dl className="mt-2 space-y-2 break-all font-mono text-xs text-muted-foreground">
                          <dt>Base</dt><dd>{repo.base_commit}</dd>
                          <dt>Candidate</dt><dd>{repo.commit}</dd>
                          <dt>Tree</dt><dd>{repo.tree}</dd>
                        </dl>
                      </details>
                    </div>
                  );
                })}
              </section>
              {review.external_evaluations?.configured && (
                <section className="space-y-2" aria-label="Required continuation evaluations">
                  <p className="text-sm">
                    {review.external_evaluations.passing ? 'Required evaluations passed.' : 'Required evaluations must pass.'}
                  </p>
                  {review.external_evaluations.reasons?.map((reason) => (
                    <p key={reason} className="text-xs text-muted-foreground">{reason}</p>
                  ))}
                  {!review.external_evaluations.passing && (
                    <p className="text-xs leading-6 text-muted-foreground">
                      Issue and run the required evaluators from this candidate’s review, then refresh here.
                    </p>
                  )}
                </section>
              )}
              {(!review.sources_current || !review.heads_current) && (
                <p role="status" className="text-sm text-muted-foreground">
                  This candidate is stale. Compose a new state before continuing.
                </p>
              )}
              <label className="grid gap-2 text-sm">
                Why continue with this candidate?
                <Textarea value={rationale} onChange={(event) => setRationale(event.target.value)}
                  maxLength={4000} disabled={busy} />
              </label>
            </>
          )}
          <p className="text-xs leading-6 text-muted-foreground">
            Continuation requires a new review. Repositories update separately; no rollback or retry
            happens automatically.
          </p>
        </div>
        <div className="dialog-footer flex-wrap">
          <Button type="button" variant="ghost" disabled={busy || !candidateId} onClick={refresh}>
            <RefreshCw aria-hidden="true" /> Refresh review
          </Button>
          {!review?.external_evaluations?.configured && (
            <Button type="button" variant="outline" disabled={busy || !review} onClick={validate}>
              Run validation
            </Button>
          )}
          <Button type="submit" disabled={busy || !ready}>Continue rollout</Button>
        </div>
      </form>
    </Dialog>
  );
}
