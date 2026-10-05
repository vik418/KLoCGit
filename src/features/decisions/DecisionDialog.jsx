import { useState } from 'react';
import {
  Check,
  ChevronRight,
  ShieldCheck,
  GitCompareArrows,
  FileCode2,
  X,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { Dialog } from '../../ui/Dialog.jsx';
import { decisionTitle, decisionSummary } from './presentation.js';
import { apiRequest } from '../../lib/api.js';
import { shortId } from '../../lib/format.js';
import { createRequestId } from '../../lib/workspace.js';
import { getErrorMessage } from '../../lib/errors.js';

export function DecisionDialog({ id, workspace, onClose, reload, message, onProposal }) {
  const decision = workspace.decisionComponents.find((decision) => decision.id === id);
  const [selectedAlternativeId, setSelectedAlternativeId] = useState(
      decision.selected ?? decision.alternatives[0]?.id ?? null,
    ),
    [activePanel, setActivePanel] = useState('overview'),
    [rationale, setRationale] = useState(''),
    [isBusy, setIsBusy] = useState(false),
    [error, setError] = useState(null);
  const selectedAlternative = decision.alternatives.find((a) => a.id === selectedAlternativeId),
    evidence = (selectedAlternative?.evidence_ids ?? [])
      .map((id) => workspace.evidence.find((e) => e.id === id))
      .filter(Boolean);
  const reviewedInput = {
    alternative_id: selectedAlternativeId,
    basis_hash: decision.basis_hash,
    expected_canonical_head: decision.canonical_head_seen,
    rationale,
    mr_basis_hash:
      selectedAlternative?.merge_request_basis_hash ?? decision.merge_request_basis_hash,
  };
  async function refresh() {
    setIsBusy(true);
    try {
      const result = await apiRequest('/decisions/' + id + '/refresh', { method: 'POST' });
      await reload();
      setError(null);
      setRationale('');
      if (result?.id && result.id !== id) onClose();
      message('Decision refreshed. Review the current code and checks.');
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setIsBusy(false);
    }
  }
  async function resolve() {
    setIsBusy(true);
    try {
      await apiRequest('/decisions/' + id + '/resolve', { method: 'POST', body: reviewedInput });
      await reload();
      message('Decision applied. Git updated and the rationale recorded.');
    } catch (e) {
      setError(getErrorMessage(e));
      await reload();
    } finally {
      setIsBusy(false);
    }
  }
  async function enqueue() {
    setIsBusy(true);
    try {
      await apiRequest('/merge-queue', {
        method: 'POST',
        body: { ...reviewedInput, component_id: id, request_id: createRequestId() },
      });
      await reload();
      message('Exact reviewed composition queued. Open Work → Merge queue to process it.');
      onClose();
    } catch (e) {
      setError(getErrorMessage(e));
      await reload();
    } finally {
      setIsBusy(false);
    }
  }
  return (
    <Dialog onClose={onClose} className="decision-dialog">
      <div className="dialog-header">
        <div>
          <span className="eyebrow">DECISION / {decision.kind.toUpperCase()}</span>
          <h2>{decisionTitle(decision, workspace)}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close decision">
          <X size={21} />
        </button>
      </div>
      <div className="dialog-tabs">
        {['overview', 'evidence', 'proposals'].map((t) => (
          <button
            className={activePanel === t ? 'selected' : ''}
            onClick={() => setActivePanel(t)}
            key={t}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="dialog-body">
        <section className="decision-main">
          {decision.stale && !['resolved', 'deferred'].includes(decision.status) && (
            <div className="stale-banner">
              <AlertTriangle size={19} />
              <div>
                <b>The reviewed basis has changed</b>
                <p>Rebuild against current heads and constraints before applying.</p>
              </div>
              <button className="button outline small" disabled={isBusy} onClick={refresh}>
                <RefreshCw size={14} />
                Refresh basis
              </button>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {activePanel === 'overview' && (
            <>
              <p className="decision-summary">{decisionSummary(decision)}</p>
              {decision.edges?.map((edge) => (
                <div className="interaction-callout" key={edge.relationship_id}>
                  <GitCompareArrows size={18} />
                  <div>
                    <b>
                      {edge.classification === 'observed-interaction'
                        ? 'A clean merge failed a trusted behavior check'
                        : edge.classification === 'textual-conflict'
                          ? 'Git cannot compose these versions'
                          : 'Recorded competing choices'}
                    </b>
                    <p>{edge.observation}</p>
                    <small>{edge.explanation}</small>
                  </div>
                </div>
              ))}
              {!decision.alternatives.length && (
                <p>
                  This component exceeds automatic planning bounds. Review its changes through
                  ordinary Git before recording a resolution.
                </p>
              )}
              <h3 className="subheading">Choose an outcome</h3>
              <div className="alternatives">
                {decision.alternatives.map((a) => (
                  <label
                    className={'alternative ' + (selectedAlternativeId === a.id ? 'chosen' : '')}
                    key={a.id}
                  >
                    <input
                      type="radio"
                      name="alternative"
                      value={a.id}
                      checked={selectedAlternativeId === a.id}
                      onChange={() => setSelectedAlternativeId(a.id)}
                      disabled={['resolved', 'deferred'].includes(decision.status)}
                    />
                    <div>
                      <div>
                        <b>{a.title}</b>
                        {a.recommended && <Badge tone="mint">Suggested</Badge>}
                      </div>
                      <p>{a.description}</p>
                      <span>{a.tradeoff}</span>
                    </div>
                  </label>
                ))}
              </div>
              {decision.included.length > 0 && (
                <div className="decision-included">
                  <h3 className="subheading">Included in this composition</h3>
                  {decision.included.map((text) => (
                    <div key={text}>
                      <Check size={15} />
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              )}
              {decision.assumptions.length > 0 && (
                <div className="assumption">
                  <Info size={17} />
                  <div>
                    <b>Assumption requiring your judgment</b>
                    {decision.assumptions.map((a) => (
                      <p key={a.value}>
                        {a.value} <Badge tone="neutral">{a.basis}</Badge>
                      </p>
                    ))}
                    <small>
                      Choosing a retry policy acknowledges this assumption for this decision.
                    </small>
                  </div>
                </div>
              )}
              {!['resolved', 'deferred'].includes(decision.status) && (
                <label className="rationale-label">
                  Decision rationale
                  <textarea
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    rows={3}
                  />
                </label>
              )}
            </>
          )}
          {activePanel === 'evidence' && (
            <>
              <h3 className="subheading">Evidence for the selected composition</h3>
              {evidence.map((e) => (
                <div className="composition-evidence" key={e.id}>
                  <div className="composition-evidence-head">
                    <ShieldCheck size={17} />
                    <b>{e.result.passed ? 'Listed checks passed' : 'A listed check failed'}</b>
                    <Badge tone={e.validity.status === 'stale' ? 'amber' : 'mint'}>
                      {e.validity.status}
                    </Badge>
                  </div>
                  {e.result.checks.map((check, i) => (
                    <div key={i} className={'check-line ' + (check.passed ? '' : 'failed')}>
                      {check.passed ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                      <div>
                        <b>{check.name}</b>
                        <p>{check.detail}</p>
                      </div>
                    </div>
                  ))}
                  <p className="bounded-claim">{e.claim}</p>
                  <div className="hash-row">
                    Tree <code>{e.tree_hash}</code>
                  </div>
                  <div className="hash-row">
                    Config <code>{e.config_hash}</code>
                  </div>
                </div>
              ))}
              {decision.edges
                ?.flatMap((edge) => edge.evidence_refs)
                .map((id) => workspace.evidence.find((e) => e.id === id))
                .filter(Boolean)
                .map((e) => (
                  <div className="interaction-callout" key={e.id}>
                    <AlertTriangle size={18} />
                    <div>
                      <b>Evidence behind the blocking relationship</b>
                      <p>
                        {e.result.checks
                          ?.filter((decision) => !decision.passed)
                          .map((decision) => decision.detail)
                          .join(' ')}
                      </p>
                      <small>{e.claim}</small>
                    </div>
                  </div>
                ))}
            </>
          )}
          {activePanel === 'proposals' && (
            <>
              <h3 className="subheading">Immutable proposal revisions</h3>
              {decision.revision_ids.map((id) => {
                const r = workspace.revisions.find((r) => r.id === id),
                  p = workspace.proposals.find((p) => p.id === r.proposal_id);
                return (
                  <button className="detail-proposal" key={id} onClick={() => onProposal(id)}>
                    <FileCode2 size={19} />
                    <div>
                      <b>{p.title}</b>
                      <p>
                        {p.producer} · {p.repo} · {shortId(r.head_commit)}
                      </p>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                );
              })}
              <p className="bounded-claim">
                Identical trees share an implementation. Intent, provenance, and rationale remain
                separate.
              </p>
            </>
          )}
        </section>
        <details className="decision-snapshot">
          <summary>Technical review details</summary>
          <Badge
            tone={
              ['resolved', 'deferred'].includes(decision.status)
                ? 'mint'
                : decision.stale
                  ? 'amber'
                  : 'neutral'
            }
          >
            {['resolved', 'deferred'].includes(decision.status)
              ? 'Applied'
              : decision.stale
                ? 'Changed since review'
                : 'Current basis'}
          </Badge>
          <div>
            <span>Decision basis</span>
            <code>{shortId(decision.basis_hash)}</code>
          </div>
          <div>
            <span>Expected canonical head</span>
            <code>{shortId(decision.canonical_head_seen)}</code>
          </div>
          <div>
            <span>Selected tree</span>
            <code>
              {shortId(
                workspace.compositions.find((x) => x.id === selectedAlternative?.composition_id)
                  ?.resulting_tree,
              )}
            </code>
          </div>
          <div>
            <span>Constraint versions</span>
            <b>
              {workspace.constraints.filter((constraint) => constraint.active).length} active
              constraints
            </b>
          </div>
          <div>
            <span>Git destination</span>
            <b>{selectedAlternative?.repo ?? 'Manual review'}</b>
            <code>refs/heads/main</code>
          </div>
          <p>
            <ShieldCheck size={15} />
            Both the reviewed basis and Git head must match at apply time.
          </p>
          <small>
            One repository advances per operation. Cross-repository updates are not atomic.
          </small>
        </details>
      </div>
      <div className="dialog-footer native-dialog-footer">
        <div>
          <ShieldCheck size={16} />
          <span>
            {['resolved', 'deferred'].includes(decision.status)
              ? 'Decision recorded.'
              : 'The displayed composition and review inputs must still match.'}
          </span>
        </div>
        {['resolved', 'deferred'].includes(decision.status) ? (
          <button className="button dark" onClick={onClose}>
            Done
          </button>
        ) : (
          <div className="inline-actions">
            <button
              className="button outline"
              disabled={
                isBusy ||
                decision.stale ||
                rationale.trim().length < 5 ||
                selectedAlternative?.validation !== 'passed'
              }
              onClick={enqueue}
            >
              Add to merge queue
            </button>
            <button
              className="button dark"
              disabled={
                isBusy ||
                decision.stale ||
                rationale.trim().length < 5 ||
                selectedAlternative?.validation !== 'passed'
              }
              onClick={resolve}
            >
              {isBusy
                ? 'Working…'
                : decision.review_kind === 'revert'
                  ? 'Apply reviewed revert'
                  : 'Apply decision'}
              <Check size={16} />
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
