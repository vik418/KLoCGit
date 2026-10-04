import { GitFork, ChevronRight, ShieldCheck, GitCompareArrows, AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { decisionTitle, decisionSummary } from './presentation.js';

export function DecisionCard({ decision, workspace, index, onOpen }) {
  return (
    <article className="decision-card">
      <div className="card-meta">
        <span className="decision-number">D{String(index + 1).padStart(2, '0')}</span>
        <Badge tone={decision.kind === 'Semantic interaction' ? 'amber' : 'blue'}>
          {decision.kind === 'Semantic interaction' ? (
            <GitCompareArrows size={12} />
          ) : (
            <GitFork size={12} />
          )}{' '}
          {decision.kind}
        </Badge>
        <span className="card-scope">
          {decision.scope.length === 2 ? 'Across 2 repositories' : decision.scope[0]}
        </span>
      </div>
      <h3>{decisionTitle(decision, workspace)}</h3>
      <p>{decisionSummary(decision)}</p>
      <div className="card-footer">
        <div className="card-evidence">
          {decision.stale ? (
            <>
              <AlertTriangle size={14} />
              <span>Basis changed · refresh required</span>
            </>
          ) : (
            <>
              <ShieldCheck size={15} />
              <span>
                {decision.alternatives.length > 0 &&
                decision.alternatives.every((a) => a.validation === 'passed')
                  ? 'Listed checks passed'
                  : 'Review validation results'}
              </span>
              <span className="meta-dot">·</span>
              <span>{decision.revision_ids.length} proposals</span>
            </>
          )}
        </div>
        <button className="button dark small" onClick={onOpen}>
          Review decision <ChevronRight size={15} />
        </button>
      </div>
    </article>
  );
}
