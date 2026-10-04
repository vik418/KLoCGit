import { MergeRequestReviews } from './MergeRequestReviews.jsx';
import { MergeRequestDetails } from './MergeRequestDetails.jsx';
import { MergeRequestDependencies } from './MergeRequestDependencies.jsx';
import { MergeRequestRules } from './MergeRequestRules.jsx';
export function MergeRequestOverview({
  mergeRequest,
  workspace,
  controller,
  onProposal,
  reload,
  message,
}) {
  return (
    <>
      <p className="native-description">{mergeRequest.description || 'No description supplied.'}</p>
      <div className="inline-actions">
        {controller.revision && (
          <button
            className="button outline small"
            onClick={() => onProposal(controller.revision.id)}
          >
            Inspect exact diff
          </button>
        )}
        {mergeRequest.status === 'open' && (
          <>
            <button
              className="button ghost small"
              disabled={controller.busy}
              onClick={() => controller.transition(mergeRequest.draft ? 'ready' : 'draft')}
            >
              {mergeRequest.draft ? 'Mark ready' : 'Return to draft'}
            </button>
            <button
              className="button ghost small"
              disabled={controller.busy}
              onClick={() => controller.transition('close')}
            >
              Close request
            </button>
          </>
        )}
        {mergeRequest.status === 'closed' && (
          <button
            className="button outline small"
            disabled={controller.busy}
            onClick={() => controller.transition('reopen')}
          >
            Reopen request
          </button>
        )}
      </div>

      <MergeRequestReviews
        mergeRequest={mergeRequest}
        reviews={controller.reviews}
        currentApprovalCount={controller.currentApprovalCount}
        busy={controller.busy}
        form={controller.reviewForm}
        onDismiss={controller.dismissReview}
      />
      <MergeRequestDetails
        mergeRequest={mergeRequest}
        busy={controller.busy}
        form={controller.detailsForm}
      />
      <MergeRequestDependencies
        mergeRequest={mergeRequest}
        busy={controller.busy}
        choices={controller.dependencies.choices}
        selected={controller.dependencies.selected}
        onSelect={controller.dependencies.setSelected}
        onSave={controller.dependencies.onSave}
      />
      <MergeRequestRules
        mergeRequest={mergeRequest}
        workspace={workspace}
        missingChecks={controller.missingChecks}
        reload={reload}
        message={message}
      />
    </>
  );
}
