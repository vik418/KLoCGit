import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Dialog, DialogDescription, DialogTitle } from '../../ui/Dialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { apiRequest } from '../../lib/api.js';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function CandidateDialog({ id, onClose, reload, message }) {
  const [review, setReview] = useState(null);
  const [readError, setReadError] = useState(null);
  const [version, setVersion] = useState(0);
  const [rationale, setRationale] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);

  useEffect(() => {
    let cancelled = false;
    apiRequest('/candidates/' + encodeURIComponent(id) + '/review').then(
      (result) => {
        if (!cancelled) {
          setReview(result);
          setReadError(null);
        }
      },
      (failure) => {
        if (!cancelled) setReadError(failure.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  function refresh() {
    setReview(null);
    setVersion((current) => current + 1);
  }

  async function validate() {
    const result = await mutate(
      '/candidates/' + encodeURIComponent(id) + '/validate',
      {},
      'Candidate validation recorded.',
    );
    if (result) refresh();
  }

  async function promote(event) {
    event.preventDefault();
    if (!review) return;
    const result = await mutate(
      '/candidates/' + encodeURIComponent(id) + '/promote',
      {
        decision_basis_hash: review.decision_basis_hash,
        expected_heads: review.expected_heads,
        rationale,
      },
      'Canonical Git updated.',
    );
    if (result) onClose();
  }

  const canPromote =
    review?.sources_current &&
    review.heads_current &&
    review.validation_passing &&
    review.promotion_supported;

  return (
    <Dialog
      onClose={() => {
        if (!busy) onClose();
      }}
      className="max-w-xl"
      hasDescription
    >
      <div className="dialog-header">
        <div>
          <DialogTitle>Apply this candidate?</DialogTitle>
          <DialogDescription className="mt-2">
            Review the combined state, its evidence and your reason for choosing it.
          </DialogDescription>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          disabled={busy}
          aria-label="Close candidate"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <form onSubmit={promote}>
        <div className="native-body space-y-5">
          {(error || readError) && (
            <p role="alert" className="error-banner">
              {error || readError}
            </p>
          )}
          {!review && <p className="text-sm text-muted-foreground">Reading candidate basis…</p>}
          {review && (
            <>
              <p className="text-sm">
                {review.candidate.selection_ids.length} selections across{' '}
                {review.candidate.repositories.length} repositories.
              </p>
              {(!review.sources_current || !review.heads_current) && (
                <p role="status" className="text-sm text-muted-foreground">
                  Git or the Future revision changed. Compose a new candidate; this state cannot be
                  promoted.
                </p>
              )}
              {!review.promotion_supported && (
                <p className="text-sm text-muted-foreground">
                  Promotion requires exactly one changed repository. Cross-repository promotion is
                  not supported.
                </p>
              )}
              <section className="space-y-3" aria-label="Candidate evidence">
                <h2 className="text-sm font-medium">Composed-state evidence</h2>
                {review.candidate.repositories.map((repo, index) => {
                  const evidence = review.evidence[index];
                  return (
                    <div key={repo.repo_id} className="space-y-2 rounded-md border p-3">
                      <h3 className="break-all text-sm font-medium">{repo.repo_id}</h3>
                      <p className="text-xs text-muted-foreground">
                        {evidence
                          ? evidence.validity.status === 'stale'
                            ? 'Stale evidence'
                            : evidence.result.passed
                              ? 'Checks passed within their stated scope'
                              : 'Checks did not pass'
                          : 'Not validated'}
                      </p>
                      {evidence?.result.checks?.map((check) => (
                        <p key={check.name} className="text-xs text-muted-foreground">
                          {check.name}: {check.passed === true ? 'passed' : 'did not pass'}
                        </p>
                      ))}
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Exact Git state
                        </summary>
                        <dl className="mt-2 space-y-2 break-all font-mono text-xs text-muted-foreground">
                          <dt>Base</dt>
                          <dd>{repo.base_commit}</dd>
                          <dt>Candidate</dt>
                          <dd>{repo.commit}</dd>
                          <dt>Tree</dt>
                          <dd>{repo.tree}</dd>
                        </dl>
                      </details>
                    </div>
                  );
                })}
              </section>
              <p className="text-xs leading-6 text-muted-foreground">
                Passing checks do not prove global correctness or independence of selected patches.
              </p>
              <label className="grid gap-2 text-sm">
                Why choose this candidate?
                <Textarea
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  maxLength={4000}
                  disabled={busy}
                />
              </label>
            </>
          )}
        </div>
        <div className="dialog-footer flex-wrap">
          <Button type="button" variant="ghost" disabled={busy} onClick={refresh}>
            <RefreshCw aria-hidden="true" /> Refresh review
          </Button>
          <Button type="button" variant="outline" disabled={busy || !review} onClick={validate}>
            {busy ? 'Working…' : 'Run validation'}
          </Button>
          <Button type="submit" disabled={busy || !canPromote || !rationale.trim()}>
            Apply candidate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
