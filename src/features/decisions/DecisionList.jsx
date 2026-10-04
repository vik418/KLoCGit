import { CheckCircle2 } from 'lucide-react';
import { ContextTask } from '../context/ContextTask.jsx';
import { DecisionCard } from './DecisionCard.jsx';

export function DecisionList({ workspace, onDecision, onProposal, reload, message }) {
  const { summary } = workspace;
  const openDecisions = workspace.decisionComponents.filter(
    (decision) =>
      decision.actionable !== false && !['resolved', 'deferred'].includes(decision.status),
  );
  const resolvedDecisions = workspace.decisionComponents.filter((decision) =>
    ['resolved', 'deferred'].includes(decision.status),
  );
  const contextTasks = (workspace.tasks ?? []).filter(
    (task) =>
      !workspace.proposals.length &&
      (!task.authorization || workspace.workspace.mode === 'local-demo'),
  );
  const conventionalRevisions = workspace.discovery?.conventional_review_ids ?? [];

  function proposalTitle(revisionId) {
    const revision = workspace.revisions.find((candidate) => candidate.id === revisionId);
    return workspace.proposals.find((proposal) => proposal.id === revision?.proposal_id)?.title;
  }

  const emptyMessage = workspace.tasks?.some((task) => !task.authorization)
    ? 'The context question comes before coordinated work.'
    : summary.conventionalReview
      ? 'Conventional review remains.'
      : workspace.proposals.length
        ? 'All decision groups resolved.'
        : 'No proposals have been ingested.';

  return (
    <>
      {contextTasks.map((task) => (
        <ContextTask
          key={task.task.id}
          task={task}
          local={workspace.workspace.mode === 'local-demo'}
          reload={reload}
          message={message}
        />
      ))}
      <section className="decision-list" aria-label="Decision queue">
        {openDecisions.map((decision, index) => (
          <DecisionCard
            key={decision.id}
            decision={decision}
            workspace={workspace}
            index={index}
            onOpen={() => onDecision(decision.id)}
          />
        ))}
        {!openDecisions.length && <p className="empty-decisions">{emptyMessage}</p>}
        {conventionalRevisions.length > 0 && (
          <div className="review-notice">
            <h3>Conventional review</h3>
            <p>Review these Git changes individually or prepare a checked composition.</p>
            {conventionalRevisions.map((revisionId) => (
              <button
                className="button outline small"
                key={revisionId}
                onClick={() => onProposal(revisionId)}
              >
                {proposalTitle(revisionId)}
              </button>
            ))}
          </div>
        )}
        {workspace.proposals.length > 0 && (
          <details className="work-details">
            <summary>Why these decisions?</summary>
            <p>{workspace.discovery?.explanation}</p>
            <p>
              {summary.independentWork} independent proposal histories remain outside the blocking
              graph. The displayed compositions explicitly include eligible independent work.{' '}
              {summary.contextAnswersRecorded} context answer(s) recorded before work are counted
              separately from these review decisions. Tests establish only their listed scenarios.
            </p>
          </details>
        )}
        {resolvedDecisions.map((decision) => (
          <div className="resolved-card" key={decision.id}>
            <CheckCircle2 size={21} />
            <div>
              <h3>{decision.title}</h3>
              <p>
                {
                  decision.alternatives.find((alternative) => alternative.id === decision.selected)
                    ?.title
                }
              </p>
            </div>
            <button className="button ghost small" onClick={() => onDecision(decision.id)}>
              View decision
            </button>
          </div>
        ))}
      </section>
    </>
  );
}
