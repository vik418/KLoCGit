import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Dialog, DialogTitle, DialogDescription } from '../../ui/Dialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { apiRequest } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { createRequestId } from '../../lib/workspace.js';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';

export function DecisionGroupDialog({ group, onClose, reload, message, onInspectProvenance }) {
  const id = typeof group === 'string' ? group : group.id;
  const [review, setReview] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  const [rationale, setRationale] = useState('');
  const [candidateReview, setCandidateReview] = useState(null);
  const [candidateChoices, setCandidateChoices] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [readError, setReadError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const preparation = useRef(null);
  const { busy, error, mutate } = useNativeMutation(reload, message);

  useEffect(() => {
    let current = true;
    apiRequest('/decision-groups/' + id + '/review').then((value) => {
      if (current) { setReview(value); setReadError(null); }
    }).catch((failure) => { if (current) setReadError(getErrorMessage(failure)); });
    return () => { current = false; };
  }, [id, refresh]);

  const revisions = review?.revisions ?? [];
  const accepted = revisions.filter((revision) => outcomes[revision.id] === 'accept').map((revision) => revision.id).sort();
  const choiceKey = JSON.stringify(accepted);
  const complete = revisions.length > 0 && revisions.every((revision) => ['accept', 'defer', 'reject'].includes(outcomes[revision.id]));
  const current = review?.sources_current && review.group.status === 'open';
  const checked = accepted.length === 0 || (candidateChoices === choiceKey && candidateReview?.validation_passing &&
    candidateReview.sources_current && candidateReview.heads_current);
  const pending = busy || preparing;

  function choose(ids) {
    setOutcomes(Object.fromEntries(revisions.map((revision) => [revision.id, ids.includes(revision.id) ? 'accept' : 'defer'])));
    setCandidateReview(null);
  }

  async function prepare() {
    if (pending || !accepted.length || !current) return;
    setPreparing(true); setReadError(null);
    const key = JSON.stringify({ accepted, heads: review.expected_heads });
    if (preparation.current?.key !== key) preparation.current = { key, id: createRequestId() };
    const requestId = preparation.current.id;
    try {
      const selectionIds = [];
      for (const [index, revisionId] of accepted.entries()) {
        const result = await apiRequest('/selections', { method: 'POST', body: {
          future_revision_id: revisionId, kind: 'future', request_id: requestId + '-s-' + index,
        } });
        selectionIds.push(result.selection.id);
      }
      const result = await apiRequest('/candidates', { method: 'POST', body: {
        selection_ids: selectionIds.sort(), expected_heads: review.expected_heads, request_id: requestId + '-compose',
      } });
      await apiRequest('/candidates/' + result.candidate.id + '/validate', { method: 'POST', body: { request_id: requestId + '-validate' } });
      const [candidate, nextReview] = await Promise.all([
        apiRequest('/candidates/' + result.candidate.id + '/review'),
        apiRequest('/decision-groups/' + id + '/review'),
      ]);
      setCandidateReview(candidate); setCandidateChoices(choiceKey); setReview(nextReview);
      preparation.current = null;
      await reload();
    } catch (failure) {
      setReadError(getErrorMessage(failure));
      // Keep the request identity after a lost response. Validation and composition
      // retain objects only; no canonical Git write happens in this step.
    } finally { setPreparing(false); }
  }

  async function resolve() {
    if (pending || !review || !complete || !checked || !rationale.trim() || !current) return;
    const result = await mutate('/decision-groups/' + id + '/resolve', {
      decision_basis_hash: review.decision_basis_hash,
      expected_heads: review.expected_heads,
      rationale: rationale.trim(),
      dispositions: revisions.map((revision) => ({ future_revision_id: revision.id, outcome: outcomes[revision.id] })),
      ...(accepted.length ? { candidate_id: candidateReview.candidate.id, candidate_basis_hash: candidateReview.decision_basis_hash } : {}),
    }, accepted.length ? 'Decision recorded and selected code applied.' : 'Decision recorded. Git is unchanged.');
    if (result) onClose();
  }

  return (
    <Dialog onClose={onClose} labelledBy="decision-group-title" describedBy="decision-group-description">
      <div className="dialog-header">
        <div>
          <DialogTitle id="decision-group-title">{review?.group.title ?? 'Review a decision'}</DialogTitle>
          <DialogDescription id="decision-group-description">
            Choose the outcome for each change. Selected code receives composed validation before it can be applied.
          </DialogDescription>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close decision"><X size={20} /></button>
      </div>
      <div className="native-body space-y-5">
        {(readError || error) && <p className="error-banner" role="alert">{readError || error}</p>}
        {!review && !readError && <p className="muted" role="status">Loading decision…</p>}
        {readError && <Button type="button" variant="outline" disabled={pending} onClick={() => setRefresh((value) => value + 1)}>Refresh reviewed basis</Button>}
        {review && <>
          {review.stale_reasons.length > 0 && <div className="error-banner" role="status">
            {review.stale_reasons.map((reason) => <p key={reason}>{reason}</p>)}
            <p>Refresh the reviewed basis after updated analysis. Changed inputs are never approved silently.</p>
          </div>}
          <section className="space-y-3" aria-label="Why these changes need one decision">
            <h3 className="font-semibold">Why these changes are together</h3>
            {review.relationships.filter((relation) => review.group.relationship_ids.includes(relation.id)).map((relation) => (
              <p key={relation.id} className="text-sm leading-6">
                <span className="font-medium">{relation.basis === 'declared' ? 'Declared choice: ' : 'Observed interaction: '}</span>
                {relation.observation}
              </p>
            ))}
          </section>
          {review.alternatives.length > 0 && <section className="space-y-3" aria-label="Candidate choices">
            <h3 className="font-semibold">Candidate choices</h3>
            <div className="flex flex-wrap gap-2">
              {review.alternatives.map((alternative, index) => (
                <Button key={alternative.revision_ids.join(':')} type="button" variant="outline" size="sm" disabled={pending || !current}
                  onClick={() => choose(alternative.revision_ids)}>
                  Choose {alternative.revision_ids.map((revisionId) => revisions.find((revision) => revision.id === revisionId)?.name ??
                    ('change ' + (revisions.findIndex((revision) => revision.id === revisionId) + 1))).join(' + ') || (index + 1)}
                </Button>
              ))}
            </div>
            <p className="muted text-sm">These sets satisfy the recorded choice relationships. Their combined behavior still needs validation.</p>
          </section>}
          <section className="space-y-3" aria-label="Individual change outcomes">
            <h3 className="font-semibold">Outcomes</h3>
            {revisions.map((revision, index) => <div key={revision.id} className="rounded-md border p-3 space-y-2">
              <label className="native-field" htmlFor={'outcome-' + revision.id}>
                <span>{revision.name ?? ('Change ' + (index + 1))}</span>
                <select id={'outcome-' + revision.id} value={outcomes[revision.id] ?? ''} disabled={pending || !current}
                  onChange={(event) => { setOutcomes((value) => ({ ...value, [revision.id]: event.target.value })); setCandidateReview(null); }}>
                  <option value="">Choose an outcome</option><option value="accept">Accept selected code</option>
                  <option value="defer">Defer this change</option><option value="reject">Reject this change</option>
                </select>
              </label>
              {revision.objective_statement && <p className="muted text-sm">Declared objective: {revision.objective_statement}</p>}
              {revision.provenance_state === 'unknown' && <p className="muted text-sm">Producer provenance is unknown. This history remains explicit.</p>}
              {onInspectProvenance && <Button type="button" size="sm" variant="ghost" onClick={() => onInspectProvenance({ kind: 'revision', id: revision.id })}>Inspect provenance</Button>}
            </div>)}
          </section>
          <label className="native-field" htmlFor="group-rationale"><span>Decision rationale</span>
            <textarea id="group-rationale" value={rationale} maxLength={4000} disabled={pending} onChange={(event) => setRationale(event.target.value)} placeholder="Explain the choice and relevant constraints." />
          </label>
          {accepted.length > 0 && <section className="space-y-3" aria-label="Selected composition validation">
            <Button type="button" variant="outline" disabled={pending || !current || !complete} onClick={prepare}>
              {preparing ? 'Validating selected code…' : 'Validate selected code'}
            </Button>
            {candidateReview && <p className={candidateReview.validation_passing ? 'muted' : 'error-banner'} role="status">
              {candidateReview.validation_passing ? 'The selected composition passed its listed finite checks. Review the evidence before applying.' :
                'The selected composition has no current passing trusted validation. Choose another set or update the code.'}
            </p>}
            {candidateReview && <details className="native-details"><summary>Selected composition evidence</summary>
              {candidateReview.evidence.filter(Boolean).map((evidence) => <div key={evidence.id} className="space-y-2">
                <p className="muted">{evidence.claim}</p>
                {(evidence.result?.checks ?? []).map((check, index) => <p key={check.id ?? check.name ?? index} className="text-sm">
                  {check.passed ? 'Passed: ' : 'Not passed: '}{check.name ?? check.id}
                </p>)}
              </div>)}
            </details>}
          </section>}
          <details className="native-details"><summary>Interaction evidence and affected repositories</summary>
            {review.evidence.map((evidence) => <p key={evidence.id} className="muted text-sm">
              {evidence.claim} Evidence is {evidence.validity.status}.
            </p>)}
            {revisions.map((revision) => <p key={revision.id} className="muted text-sm">
              {revision.name ?? 'Change'}: {revision.repository_heads.map((head) => head.repo_id).join(', ')}
            </p>)}
            <p className="muted text-sm">Finite checks establish their stated scope; missing relationships are not proof of compatibility.</p>
          </details>
        </>}
      </div>
      <div className="dialog-footer">
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Close</Button>
        <Button type="button" disabled={pending || !current || !complete || !checked || !rationale.trim()} onClick={resolve}>
          {busy ? 'Recording decision…' : accepted.length ? 'Apply selected code' : 'Record outcomes'}
        </Button>
      </div>
    </Dialog>
  );
}
