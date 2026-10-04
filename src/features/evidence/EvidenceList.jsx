import { ShieldCheck, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { shortId } from '../../lib/format.js';

export function EvidenceList({ workspace }) {
  return (
    <>
      <div className="evidence-explainer">
        <Info size={18} />
        <p>
          Evidence records are immutable. Eligibility is derived from the current canonical heads,
          check configuration, and constraint versions.
        </p>
        <Badge tone="amber">{workspace.summary.staleEvidence} stale</Badge>
      </div>
      <div className="evidence-table">
        <div className="table-head">
          <span>Verification & exact subject</span>
          <span>Result</span>
          <span>Eligibility</span>
          <span>Tree</span>
        </div>
        {workspace.evidence
          .slice()
          .reverse()
          .map((e) => (
            <details key={e.id} className="evidence-row">
              <summary>
                <span>
                  <ShieldCheck size={16} />
                  <span>
                    <b>
                      {e.type === 'composed-interaction'
                        ? 'Observed interaction'
                        : e.type === 'textual-composition-conflict'
                          ? 'Git merge conflict'
                          : 'Trusted application checks'}
                    </b>
                    <small>
                      {e.source} ·{' '}
                      {shortId(e.subject_ref instanceof Array ? e.subject_ref[0] : e.subject_ref)}
                    </small>
                  </span>
                </span>
                <Badge tone={e.result.passed ? 'mint' : 'red'}>
                  {e.result.passed ? 'Checks passed' : 'Check failed'}
                </Badge>
                <Badge tone={e.validity.status === 'stale' ? 'amber' : 'neutral'}>
                  {e.validity.status}
                </Badge>
                <code>{shortId(e.tree_hash)}</code>
              </summary>
              <div className="evidence-detail">
                {e.result.checks?.map((c, i) => (
                  <div key={i} className={'check-line ' + (c.passed ? '' : 'failed')}>
                    {c.passed ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                    <div>
                      <b>{c.name}</b>
                      <p>{c.detail}</p>
                    </div>
                  </div>
                ))}
                <p className="bounded-claim">{e.claim}</p>
                {e.validity.reasons.length > 0 && (
                  <p className="stale-text">Ineligible: {e.validity.reasons.join(', ')}.</p>
                )}
              </div>
            </details>
          ))}
      </div>
    </>
  );
}
