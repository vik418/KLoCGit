import { useEffect, useState } from 'react';
import { validationPassed } from '../../../core/evidence.mjs';
import { RefreshCw, X } from 'lucide-react';
import { Dialog, DialogDescription, DialogTitle } from '../../ui/Dialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { Textarea } from '../../ui/Textarea.jsx';
import { apiRequest } from '../../lib/api.js';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function CandidateDialog({ id, onClose, reload, message }) {
  const [review, setReview] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [readError, setReadError] = useState(null);
  const [evaluatorError, setEvaluatorError] = useState(null);
  const [version, setVersion] = useState(0);
  const [rationale, setRationale] = useState('');
  const { busy, error, mutate } = useNativeMutation(reload, message);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      apiRequest('/candidates/' + encodeURIComponent(id) + '/review'),
      apiRequest('/evaluators'),
    ]).then(([candidate, evaluators]) => {
      if (cancelled) return;
      if (candidate.status === 'fulfilled') {
        setReview(candidate.value);
        setReadError(null);
      } else {
        setReadError(candidate.reason.message);
      }
      if (evaluators.status === 'fulfilled') {
        const current = new Set(
          (evaluators.value.bindings ?? []).map((binding) => binding.profile_id),
        );
        setProfiles(
          (evaluators.value.profiles ?? []).filter(
            (profile) => current.has(profile.id) && profile.enabled,
          ),
        );
        setEvaluatorError(null);
      } else {
        setProfiles([]);
        setEvaluatorError(evaluators.reason.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  function refresh() {
    setReview(null);
    setReadError(null);
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

  async function issue(profile) {
    const result = await mutate(
      '/evaluation-runs',
      { candidate_id: id, profile_id: profile.id },
      'Evaluation run issued for the exact candidate state.',
    );
    if (result) refresh();
  }

  async function dispatch(runId) {
    const result = await mutate(
      '/evaluation-runs/' + encodeURIComponent(runId) + '/dispatch',
      {},
      'Evaluation results recorded.',
    );
    if (result) refresh();
  }

  async function cancel(runId) {
    const result = await mutate(
      '/evaluation-runs/' + encodeURIComponent(runId) + '/cancel',
      { reason: 'Cancelled during candidate review.' },
      'Evaluation cancelled.',
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
      'Canonical promotion recorded.',
    );
    if (result) onClose();
  }

  const canPromote =
    review?.sources_current &&
    review.heads_current &&
    review.validation_passing &&
    review.promotion_supported;
  const changed =
    review?.candidate.repositories.filter((repo) => repo.tree !== repo.base_tree) ?? [];
  const requiredEvaluators = review?.external_evaluations?.configured === true;
  const eligibleProfiles = profiles.filter((profile) =>
    review?.candidate.repositories.every((repo) => profile.repo_ids.includes(repo.repo_id)),
  );
  const runs = review?.external_evaluations?.runs ?? [];

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
      <form onSubmit={promote} aria-busy={busy}>
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
              {changed.length > 1 && (
                <p role="status" className="rounded-md border p-3 text-sm leading-6">
                  Repositories advance separately. If a later update fails, earlier updates remain
                  applied. Review the partial state before continuing; rollback is never automatic.
                </p>
              )}
              {(!review.sources_current || !review.heads_current) && (
                <p role="status" className="text-sm text-muted-foreground">
                  Git, context or a Future revision changed. Compose and review a new candidate.
                </p>
              )}
              {!review.promotion_supported && (
                <p className="text-sm text-muted-foreground">
                  This candidate does not change canonical code.
                </p>
              )}
              {review.context && (
                <section className="space-y-2" aria-label="Candidate context">
                  <h2 className="text-sm font-medium">Context</h2>
                  <p className="text-xs text-muted-foreground">
                    {review.context.status === 'current'
                      ? 'Current context'
                      : 'Context requires review'}
                    {review.context.requires_human_judgment
                      ? ' · unresolved assumptions require judgment'
                      : ''}
                  </p>
                  {review.context.snapshots?.flatMap((snapshot) =>
                    (snapshot.validity?.reasons ?? []).map((reason) => (
                      <p key={snapshot.id + reason} className="text-xs text-muted-foreground">
                        {reason}
                      </p>
                    )),
                  )}
                </section>
              )}
              <section className="space-y-3" aria-label="Candidate evidence">
                <h2 className="text-sm font-medium">Composed-state evidence</h2>
                {review.candidate.repositories.map((repo, index) => {
                  const evidence = review.evidence[index];
                  return (
                    <div key={repo.repo_id} className="space-y-2 rounded-md border p-3">
                      <h3 className="break-all text-sm font-medium">{repo.repo_id}</h3>
                      <p className="text-xs text-muted-foreground">
                        {repo.tree === repo.base_tree ? 'Canonical tree unchanged · ' : ''}
                        {evidence
                          ? evidence.validity.status === 'stale'
                            ? 'Stale evidence'
                            : validationPassed(evidence)
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
              {(requiredEvaluators || eligibleProfiles.length > 0 || runs.length > 0) && (
                <section className="space-y-3" aria-label="Evaluator runs">
                  <h2 className="text-sm font-medium">Evaluations</h2>
                  {evaluatorError && (
                    <p role="status" className="text-xs text-muted-foreground">
                      Evaluator configuration could not be read: {evaluatorError}
                    </p>
                  )}
                  {review.external_evaluations?.reasons?.map((reason) => (
                    <p key={reason} className="text-xs text-muted-foreground">
                      {reason}
                    </p>
                  ))}
                  {eligibleProfiles.map((profile) => {
                    const latest = runs
                      .filter((entry) => entry.run?.profile_id === profile.id)
                      .at(-1);
                    const active = latest && ['pending', 'running'].includes(latest.state);
                    return (
                      <div key={profile.id} className="space-y-2 rounded-md border p-3">
                        <p className="text-sm font-medium">{profile.key}</p>
                        <p className="text-xs text-muted-foreground">
                          {profile.required ? 'Required' : 'Optional'} · {profile.mode}
                          {latest ? ' · ' + latest.state : ' · no run issued'}
                        </p>
                        {latest?.validity?.reasons?.map((reason) => (
                          <p key={reason} className="text-xs text-muted-foreground">
                            {reason}
                          </p>
                        ))}
                        {latest?.event?.result?.checks?.map((check) => (
                          <p key={check.id} className="text-xs text-muted-foreground">
                            {check.id}: {check.state}
                          </p>
                        ))}
                        {profile.mode === 'external' && active && (
                          <p className="text-xs text-muted-foreground">
                            Awaiting the trusted evaluator callback.
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              busy || active || !review.sources_current || !review.heads_current
                            }
                            onClick={() => issue(profile)}
                          >
                            {latest ? 'Issue new run' : 'Issue run'}
                          </Button>
                          {profile.mode === 'builtin' && latest?.state === 'pending' && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => dispatch(latest.run.id)}
                            >
                              Run checks
                            </Button>
                          )}
                          {active && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => cancel(latest.run.id)}
                            >
                              Cancel run
                            </Button>
                          )}
                        </div>
                        {latest && (
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            Run {latest.run.id}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}
              <p className="text-xs leading-6 text-muted-foreground">
                Passing checks establish only their stated scope.
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
          {!requiredEvaluators && (
            <Button type="button" variant="outline" disabled={busy || !review} onClick={validate}>
              {busy ? 'Working…' : 'Run validation'}
            </Button>
          )}
          <Button type="submit" disabled={busy || !canPromote || !rationale.trim()}>
            Apply candidate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
