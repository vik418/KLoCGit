import { useId } from 'react';
import { GitFork, ChevronRight, ShieldCheck, GitCompareArrows, AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { Button } from '../../ui/Button.jsx';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../../ui/Card.jsx';
import { decisionTitle, decisionSummary } from './presentation.js';

export function DecisionCard({ decision, workspace, index, onOpen }) {
  const titleId = useId();
  const title = decisionTitle(decision, workspace);
  const checksPassed =
    decision.alternatives.length > 0 &&
    decision.alternatives.every((alternative) => alternative.validation === 'passed');
  const proposalCount = decision.revision_ids.length;

  return (
    <Card className="decision-card" role="article" aria-labelledby={titleId}>
      <CardHeader className="decision-card-header">
        <div className="card-meta">
          <span className="decision-number" aria-label={`Decision ${index + 1}`}>
            D{String(index + 1).padStart(2, '0')}
          </span>
          <Badge tone="amber">
            {decision.kind === 'Semantic interaction' ? (
              <GitCompareArrows size={12} aria-hidden="true" />
            ) : (
              <GitFork size={12} aria-hidden="true" />
            )}
            {decision.kind}
          </Badge>
          <span className="card-scope">
            {decision.scope.length > 1
              ? `Across ${decision.scope.length} repositories`
              : decision.scope[0]}
          </span>
        </div>
        <CardTitle>
          <h3 id={titleId}>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="decision-card-content">
        <p>{decisionSummary(decision)}</p>
      </CardContent>
      <CardFooter className="card-footer">
        <div className="card-evidence">
          {decision.stale ? (
            <>
              <AlertTriangle size={14} aria-hidden="true" />
              <span>Basis changed · refresh required</span>
            </>
          ) : (
            <>
              <ShieldCheck size={15} aria-hidden="true" />
              <span>{checksPassed ? 'Listed checks passed' : 'Review validation results'}</span>
            </>
          )}
          <span className="meta-dot" aria-hidden="true">
            ·
          </span>
          <span>
            {proposalCount} {proposalCount === 1 ? 'proposal' : 'proposals'}
          </span>
        </div>
        <Button type="button" size="sm" onClick={onOpen} aria-label={`Review decision: ${title}`}>
          Review decision <ChevronRight size={15} aria-hidden="true" />
        </Button>
      </CardFooter>
    </Card>
  );
}
