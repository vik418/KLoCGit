import { CircleHelp, GitFork, TriangleAlert } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../ui/Card.jsx';
import { DecisionList } from '../decisions/DecisionList.jsx';

export function AttentionView({
  workspace,
  onNewRepository,
  onSystems,
  onFutures,
  onDecision,
  onProposal,
  reload,
  message,
}) {
  const native = workspace.nativeState;
  const recovery = native.requests.filter((request) =>
    ['prepared', 'recovery_required'].includes(request.status),
  );
  const hasReviewWork = workspace.proposals.length > 0 || workspace.tasks.length > 0;
  const hasFutures = native.futures.some((future) => future.status !== 'abandoned');

  return (
    <div className="space-y-6 py-7">
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
      {!hasReviewWork && (
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
