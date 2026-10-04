import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
export function MergeRequestChecks({
  mergeRequest,
  busy,
  runs,
  platformEvidence,
  form,
  onValidate,
}) {
  return (
    <>
      <section className="native-section">
        <div className="section-heading">
          <h3>Platform validation</h3>
          <button
            className="button outline small"
            disabled={busy || !mergeRequest.revision_id || mergeRequest.source_deleted}
            onClick={onValidate}
          >
            {busy ? 'Checking…' : 'Run platform checks'}
          </button>
        </div>
        {platformEvidence ? (
          <>
            <Badge tone={platformEvidence.result.passed ? 'mint' : 'red'}>
              {platformEvidence.result.passed ? 'Listed checks passed' : 'A listed check failed'}
            </Badge>
            {platformEvidence.result.checks?.map((check, i) => (
              <div className={'check-line ' + (check.passed ? '' : 'failed')} key={i}>
                {check.passed ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                <div>
                  <b>{check.name}</b>
                  <p>{check.detail}</p>
                </div>
              </div>
            ))}
            <p className="bounded-claim">{platformEvidence.claim}</p>
          </>
        ) : (
          <p className="muted">No current platform evidence for this exact revision.</p>
        )}
      </section>
      <section className="native-section">
        <h3>Reported checks</h3>
        <p className="muted">
          Producer and CI declarations remain separate from platform evidence.
        </p>
        {runs.map((run) => (
          <div className="history-row" key={run.id}>
            <div>
              <b>{run.name}</b>
              <p>{run.details}</p>
              <small>
                {run.actor} ·{' '}
                {run.stale || run.revision_id !== mergeRequest.revision_id
                  ? 'Historical revision'
                  : 'Current revision'}
              </small>
            </div>
            <Badge tone={run.status === 'failed' ? 'red' : 'neutral'}>
              {run.status} · reported
            </Badge>
          </div>
        ))}
        {mergeRequest.status === 'open' && (
          <details className="native-details">
            <summary>Report a check</summary>
            <form onSubmit={form.onSubmit}>
              <div className="form-grid">
                <label className="field">
                  Check name
                  <input
                    value={form.name}
                    onChange={(e) => form.setName(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  Status
                  <select
                    aria-label="Status"
                    value={form.status}
                    onChange={(e) => form.setStatus(e.target.value)}
                  >
                    {['pending', 'running', 'passed', 'failed', 'cancelled'].map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                Details
                <textarea
                  value={form.details}
                  onChange={(e) => form.setDetails(e.target.value)}
                  rows={2}
                />
              </label>
              <button className="button outline small" disabled={busy || !form.name.trim()}>
                Record reported check
              </button>
            </form>
          </details>
        )}
      </section>
    </>
  );
}
