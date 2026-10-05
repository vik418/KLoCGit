import { CircleHelp, GitFork, TriangleAlert } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../ui/Card.jsx';
import { DecisionList } from '../decisions/DecisionList.jsx';

export function AttentionView({
  workspace,
  onNewRepository,
  onSystems,
  onFutures,
  onCandidate,
  onDecision,
  onProposal,
  reload,
  message,
}) {
  const native = workspace.nativeState;
  const recovery = native.requests.filter((request) =>
    ['prepared', 'recovery_required'].includes(request.status),
  );
  const candidates = (native.candidates ?? []).filter(
    (candidate) =>
      !(native.promotions ?? []).some(
        (operation) => operation.candidate_id === candidate.id && operation.status === 'applied',
      ),
  );
  const promotions = (native.promotions ?? []).filter((operation) =>
    ['prepared', 'recovery-required'].includes(operation.status),
  );
  const hasReviewWork = workspace.proposals.length > 0 || workspace.tasks.length > 0;
  const hasFutures = native.futures.some((future) => future.status !== 'abandoned');

  return (
    <div className="space-y-6 py-7">
      {promotions.length > 0 && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Confirm canonical Git state</CardTitle>
            <CardDescription>
              A promotion has an uncertain outcome. Recovery reads Git and never repeats the write.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                try {
                  const { apiRequest } = await import('../../lib/api.js');
                  await apiRequest('/recover', { method: 'POST', body: {} });
                  await reload();
                  message(
                    'Canonical reconciliation completed. Inspect any remaining recovery state.',
                  );
                } catch (error) {
                  message(error.message, 'error');
                }
              }}
            >
              Reconcile promotion
            </Button>
          </CardContent>
        </Card>
      )}
      {candidates.map((candidate) => (
        <Card key={candidate.id} className="gap-4">
          <CardHeader>
            <CardTitle>Apply this combined state?</CardTitle>
            <CardDescription>
              {candidate.selection_ids.length} selections across {candidate.repositories.length}{' '}
              repositories. Review composed-state evidence before choosing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" size="sm" onClick={() => onCandidate(candidate.id)}>
              Review candidate
            </Button>
          </CardContent>
        </Card>
      ))}
      {recovery.length > 0 && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>
              <h2 className="flex items-center gap-2 text-base">
                <TriangleAlert className="size-4 text-primary" aria-hidden="true" />
                Confirm repository state
              </h2>
            </CardTitle>
            <CardDescription>
              A repository operation has an uncertain outcome. Inspect Git before retrying.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" size="sm" onClick={onSystems}>
              Review recovery
            </Button>
          </CardContent>
        </Card>
      )}
      {hasReviewWork && (
        <DecisionList
          workspace={workspace}
          onDecision={onDecision}
          onProposal={onProposal}
          reload={reload}
          message={message}
        />
      )}
      {!hasReviewWork && !candidates.length && !promotions.length && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>
              <h2 className="flex items-center gap-2 text-base">
                <CircleHelp className="size-4 text-primary" aria-hidden="true" />
                No decisions ready
              </h2>
            </CardTitle>
            <CardDescription>
              {hasFutures
                ? 'Your work is recorded. It has not been evaluated.'
                : 'Start with a repository. Open independent work when its first commit is available.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {hasFutures ? (
              <Button type="button" size="sm" onClick={onFutures}>
                <GitFork aria-hidden="true" />
                Inspect futures
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={onNewRepository}>
                Create repository
              </Button>
            )}
            {native.repositories.length > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={onSystems}>
                View repositories
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
