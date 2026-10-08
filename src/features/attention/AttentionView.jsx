import { CircleHelp, GitFork, TriangleAlert } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../ui/Card.jsx';
import { useNativeMutation } from '../../hooks/useNativeMutation.js';
import { DecisionList } from '../decisions/DecisionList.jsx';

export function AttentionView({
  workspace,
  onNewRepository,
  onSystems,
  onFutures,
  onCandidate,
  onSettlement,
  onDecision,
  onOpenDecisionGroup,
  onDiscover,
  onContinue,
  onProposal,
  reload,
  message,
}) {
  const native = workspace.nativeState;
  const { busy, error, mutate } = useNativeMutation(reload, message);
  const recovery = native.requests.filter((request) =>
    ['prepared', 'recovery_required'].includes(request.status),
  );
  const groups = (native.decisionGroups ?? []).filter((group) => group.status === 'open');
  const discovery = native.discovery ?? {};
  const conventional = discovery.conventional_review_count ?? 0;
  const analysisCandidateIds = new Set(discovery.analysis_candidate_ids ?? []);
  const candidates = (native.candidates ?? []).filter(
    (candidate) =>
      !analysisCandidateIds.has(candidate.id) && !(native.promotions ?? []).some(
        (operation) => operation.candidate_id === candidate.id && operation.status === 'applied',
      ),
  );
  const promotions = (native.promotions ?? []).filter((operation) =>
    ['prepared', 'recovery-required', 'partially-applied', 'partial-applied'].includes(operation.status),
  );
  const hasReviewWork = workspace.proposals.length > 0 || workspace.tasks.length > 0;
  const hasFutures = native.futures.some((future) => future.status !== 'abandoned');

  return (
    <div className="space-y-6 py-7">
      {hasFutures && <Card className="gap-4">
        <CardHeader>
          <CardTitle>Understand the work</CardTitle>
          <CardDescription>
            {groups.length} grouped {groups.length === 1 ? 'decision' : 'decisions'}.
            {' '}{conventional} {conventional === 1 ? 'change still needs' : 'changes still need'} conventional review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && <p className="error-banner" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => onDiscover ? onDiscover() : mutate('/discovery', {}, 'Decision discovery completed. Unclassified work remains explicit.')}>
              {busy ? 'Discovering…' : 'Discover decisions'}
            </Button>
            {conventional > 0 && <Button type="button" size="sm" variant="outline" onClick={onFutures}>Review unclassified work</Button>}
          </div>
          {(discovery.diagnostics ?? []).map((diagnostic, index) => <p key={diagnostic.code + ':' + index} className="muted text-sm">{diagnostic.message}</p>)}
          {discovery.possible_comparisons > 0 && <details className="native-details">
            <summary>Analysis scope</summary>
            <p className="muted text-sm">{discovery.comparisons} comparisons performed; {discovery.comparisons_avoided_is_lower_bound ? 'at least ' : ''}{discovery.comparisons_avoided} avoided by indexing and deterministic filtering. {discovery.compositions} retained compositions and {discovery.validation_runs} trusted validation runs.</p>
            <p className="muted text-sm">These measurements cover this finite run. Unexamined interactions remain unknown.</p>
          </details>}
        </CardContent>
      </Card>}
      {groups.map((group) => <Card key={group.id} className="gap-4">
        <CardHeader><CardTitle>{group.title}</CardTitle>
          <CardDescription>{group.revision_ids.length} changes share this decision. {group.stale ? 'Earlier interaction evidence needs renewed review.' : 'Inspect the recorded choices and evidence.'}</CardDescription>
        </CardHeader>
        <CardContent><Button type="button" size="sm" onClick={() => onOpenDecisionGroup(group.id)}>Review decision</Button></CardContent>
      </Card>)}
      {promotions.length > 0 && (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle>Confirm canonical Git state</CardTitle>
            <CardDescription>
              A promotion has an uncertain outcome. Recovery reads Git and never repeats the write.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                mutate(
                  '/recover',
                  {},
                  'Canonical reconciliation completed. Inspect remaining recovery state.',
                )
              }
            >
              {busy ? 'Reconciling…' : 'Reconcile promotion'}
            </Button>
            {onContinue && promotions.filter((operation) => operation.stages?.some((stage) => stage.status === 'applied') &&
              operation.stages.some((stage) => stage.status !== 'applied')).map((operation) => (
              <Button key={'continue-' + operation.id} type="button" variant="outline" disabled={busy} onClick={() => onContinue(operation.id)}>
                Review remaining repositories
              </Button>
            ))}
            {promotions
              .filter(
                (operation) =>
                  operation.status === 'recovery-required' && operation.dispatch_state === 'issued',
              )
              .map((operation) => (
                <Button
                  key={operation.id}
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onSettlement(operation.id)}
                >
                  Inspect outcome for {operation.repo}
                </Button>
              ))}
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
      {!hasReviewWork && !candidates.length && !promotions.length && !groups.length && !conventional && (
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
