import { X, RefreshCw, AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { Dialog, DialogTitle } from '../../ui/Dialog.jsx';
import { shortId } from '../../lib/format.js';
import { MergeRequestOverview } from './MergeRequestOverview.jsx';
import { MergeRequestDiscussion } from './MergeRequestDiscussion.jsx';
import { MergeRequestChecks } from './MergeRequestChecks.jsx';
import { useMergeRequestDialog } from './useMergeRequestDialog.js';

export function MergeRequestDialog({
  id,
  workspace,
  onClose,
  onDecision,
  onProposal,
  reload,
  message,
}) {
  const controller = useMergeRequestDialog({ id, workspace, onDecision, reload, message });
  const { mergeRequest, tab, setTab, busy, error, sourceChanged, mergedDecision, mergedOperation } =
    controller;
  if (!mergeRequest)
    return (
      <Dialog onClose={onClose}>
        <div className="native-body">
          <DialogTitle>Loading merge request</DialogTitle>
          <p>Reading the current request and its history…</p>
          <button className="button ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
    );

  return (
    <Dialog onClose={onClose} className="mr-dialog">
      <div className="dialog-header">
        <div>
          <span className="eyebrow">MERGE REQUEST · {mergeRequest.repo}</span>
          <DialogTitle asChild>
            <h2>{mergeRequest.title}</h2>
          </DialogTitle>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close merge request">
          <X size={20} />
        </button>
      </div>
      <div className="dialog-tabs">
        {[
          ['overview', 'Overview'],
          ['discussion', 'Discussion'],
          ['checks', 'Checks'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="native-body">
        <ErrorMessage error={error} />
        <div className="mr-meta">
          <Badge
            tone={
              mergeRequest.status === 'merged' ? 'mint' : mergeRequest.draft ? 'neutral' : 'blue'
            }
          >
            {mergeRequest.status === 'open'
              ? mergeRequest.draft
                ? 'Draft'
                : 'Ready'
              : mergeRequest.status}
          </Badge>
          <span>
            {mergeRequest.source_repo !== mergeRequest.repo ? mergeRequest.source_repo + ' / ' : ''}
            {mergeRequest.source_ref?.replace('refs/heads/', '')} →{' '}
            {mergeRequest.target_ref?.replace('refs/heads/', '') ?? 'main'}
          </span>
          <button
            className="button ghost small"
            onClick={() => reload().catch((error) => message(error.message, 'error'))}
          >
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
        {sourceChanged && (
          <div className="stale-banner">
            <AlertTriangle size={18} />
            <p>
              The source revision changed. Previous reviews and checks remain historical; review the
              current code.
            </p>
          </div>
        )}
        {mergeRequest.source_deleted && (
          <div className="stale-banner">
            <AlertTriangle size={18} />
            <p>
              The source branch was deleted. Its immutable history remains inspectable; restore the
              branch before preparing review.
            </p>
          </div>
        )}
        {tab === 'overview' && (
          <MergeRequestOverview
            mergeRequest={mergeRequest}
            workspace={workspace}
            controller={controller}
            onProposal={onProposal}
            reload={reload}
            message={message}
          />
        )}
        {tab === 'discussion' && (
          <MergeRequestDiscussion
            mergeRequest={mergeRequest}
            busy={busy}
            {...controller.discussion}
          />
        )}
        {tab === 'checks' && (
          <MergeRequestChecks mergeRequest={mergeRequest} busy={busy} {...controller.checks} />
        )}
        {mergeRequest.status === 'merged' && (
          <div className="native-section">
            <h3>Merged composition</h3>
            <p className="muted">
              Commit{' '}
              <code>{shortId(mergedOperation?.target_commit ?? mergeRequest.merge_commit)}</code>
              {mergedDecision
                ? ' · ' + mergedDecision.proposal_revision_ids.length + ' proposal histories'
                : ''}
              . Reverting reviews the inverse of this merged composition, including any changes
              merged together.
            </p>
            {mergeRequest.reverted_by_decision && (
              <p className="muted">
                A revert decision has already been recorded for this composition.
              </p>
            )}
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <span>Actions refer to the displayed revision and request version.</span>
        {mergeRequest.status === 'merged' ? (
          <button
            className="button outline"
            disabled={busy || !!mergeRequest.reverted_by_decision}
            onClick={controller.prepareRevert}
          >
            Review revert of merged composition
          </button>
        ) : (
          <button
            className="button dark"
            disabled={
              busy ||
              mergeRequest.status !== 'open' ||
              mergeRequest.draft ||
              mergeRequest.source_deleted
            }
            onClick={controller.prepareReview}
          >
            {busy ? 'Preparing…' : 'Prepare review'}
          </button>
        )}
      </div>
    </Dialog>
  );
}
