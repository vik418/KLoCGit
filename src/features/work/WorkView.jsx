import { useState } from 'react';
import { ChevronRight, X, RefreshCw } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { Dialog } from '../../ui/Dialog.jsx';
import { useMutation } from '../../hooks/useMutation.js';
import { GitChanges } from './GitChanges.jsx';
import { MergeQueue } from '../queue/MergeQueue.jsx';
import { RepositoryPolicy } from '../merge-requests/RepositoryPolicy.jsx';
import { shortId } from '../../lib/format.js';
import { getMergeRequests, createRequestId, getPreparedDecisionId } from '../../lib/workspace.js';

export function WorkView({ workspace, onMR, onCreate, onProposal, onDecision, reload, message }) {
  const [activeView, setActiveView] = useState('requests'),
    [statusFilter, setStatusFilter] = useState('open'),
    [selectedRequestIds, setSelectedRequestIds] = useState([]),
    [showBatchReview, setShowBatchReview] = useState(false),
    [batchAction, setBatchAction] = useState('approve'),
    [batchRationale, setBatchRationale] = useState('');
  const { busy, error, mutate } = useMutation(reload, message);
  const mergeRequests = getMergeRequests(workspace),
    visibleRequests = mergeRequests.filter(
      (mergeRequest) => statusFilter === 'all' || mergeRequest.status === statusFilter,
    );
  async function prepare() {
    const result = await mutate(
      '/reviews/prepare',
      {
        revision_ids: selectedRequestIds
          .map((id) => mergeRequests.find((mergeRequest) => mergeRequest.id === id)?.revision_id)
          .filter(Boolean),
        title: 'Review selected merge requests',
      },
      'Review prepared. Inspect the composition before applying.',
    );
    const id = getPreparedDecisionId(result);
    if (id) onDecision(id);
  }
  async function reviewBatch(e) {
    e.preventDefault();
    const result = await mutate(
      '/merge-requests/reviews/batch',
      {
        items: selectedRequestIds
          .map((id) => mergeRequests.find((mergeRequest) => mergeRequest.id === id))
          .filter(Boolean)
          .map((mergeRequest) => ({
            mr_id: mergeRequest.id,
            action: batchAction,
            body: batchRationale,
            expected_version: mergeRequest.version,
            expected_revision_id: mergeRequest.revision_id,
            request_id: createRequestId(),
          })),
      },
      'Reviews recorded against the displayed source revisions.',
    );
    if (result) {
      setShowBatchReview(false);
      setBatchRationale('');
    }
  }
  return (
    <>
      <div className="work-toolbar">
        <div className="work-switch" aria-label="Work views">
          {[
            ['requests', 'Merge requests'],
            ['queue', 'Merge queue'],
            ['proposals', 'Git changes'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={activeView === key ? 'selected' : ''}
              onClick={() => setActiveView(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="button ghost small"
          onClick={() => reload().catch((e) => message(e.message, 'error'))}
          aria-label="Refresh workspace"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {activeView === 'requests' && (
        <>
          <div className="work-actions">
            <label className="compact-select">
              <span>Show</span>
              <select
                aria-label="Show"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {['open', 'merged', 'closed', 'all'].map((s) => (
                  <option key={s} value={s}>
                    {s === 'all' ? 'All requests' : s[0].toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-actions">
              {selectedRequestIds.length > 0 && (
                <>
                  <button
                    className="button ghost small"
                    disabled={busy}
                    onClick={() => setShowBatchReview(true)}
                  >
                    Review selected ({selectedRequestIds.length})
                  </button>
                  <button className="button outline small" disabled={busy} onClick={prepare}>
                    Prepare batch composition
                  </button>
                </>
              )}
              <button className="button dark small" onClick={onCreate}>
                Open merge request
              </button>
            </div>
          </div>
          <ErrorMessage error={error} />
          <div className="mr-list">
            {visibleRequests.map((mergeRequest) => (
              <article className="mr-row" key={mergeRequest.id}>
                <label className="row-checkbox">
                  <input
                    type="checkbox"
                    aria-label={'Select ' + mergeRequest.title}
                    checked={selectedRequestIds.includes(mergeRequest.id)}
                    disabled={mergeRequest.status !== 'open'}
                    onChange={(e) =>
                      setSelectedRequestIds((ids) =>
                        e.target.checked
                          ? [...ids, mergeRequest.id]
                          : ids.filter((id) => id !== mergeRequest.id),
                      )
                    }
                  />
                </label>
                <button className="mr-row-main" onClick={() => onMR(mergeRequest.id)}>
                  <h3>{mergeRequest.title}</h3>
                  <p>
                    {mergeRequest.repo} ·{' '}
                    {mergeRequest.source_repo !== mergeRequest.repo
                      ? mergeRequest.source_repo + ' / '
                      : ''}
                    {mergeRequest.source_ref?.replace('refs/heads/', '')}
                    <span> → </span>
                    {mergeRequest.target_ref?.replace('refs/heads/', '') ?? 'main'}
                  </p>
                  <small>
                    {mergeRequest.author} · revision {shortId(mergeRequest.revision_id)}
                    {mergeRequest.dependency_ids?.length
                      ? ' · ' + mergeRequest.dependency_ids.length + ' dependencies'
                      : ''}
                  </small>
                </button>
                <Badge
                  tone={
                    mergeRequest.status === 'merged'
                      ? 'mint'
                      : mergeRequest.draft
                        ? 'neutral'
                        : mergeRequest.stale
                          ? 'amber'
                          : ''
                  }
                >
                  {mergeRequest.status === 'open'
                    ? mergeRequest.draft
                      ? 'Draft'
                      : 'Ready'
                    : mergeRequest.status}
                </Badge>
                <button
                  className="icon-btn"
                  onClick={() => onMR(mergeRequest.id)}
                  aria-label={'Open ' + mergeRequest.title}
                >
                  <ChevronRight size={17} />
                </button>
              </article>
            ))}
          </div>
          {!visibleRequests.length && (
            <div className="empty-state">
              <p>No {statusFilter === 'all' ? '' : statusFilter + ' '}merge requests.</p>
              <button className="button ghost small" onClick={() => setActiveView('proposals')}>
                Inspect ordinary Git changes
              </button>
            </div>
          )}
          <details className="work-details">
            <summary>Repository rules</summary>
            <p>
              Merge requests track Git branches. Reviews and checks apply to exact revisions; new
              source commits require renewed review.
            </p>
            {workspace.repositories.map((repo) => (
              <RepositoryPolicy
                key={repo.id}
                repo={repo}
                workspace={workspace}
                reload={reload}
                message={message}
              />
            ))}
          </details>
        </>
      )}
      {activeView === 'queue' && (
        <MergeQueue
          workspace={workspace}
          reload={reload}
          message={message}
          onDecision={onDecision}
        />
      )}
      {activeView === 'proposals' && (
        <GitChanges
          workspace={workspace}
          onProposal={onProposal}
          onDecision={onDecision}
          reload={reload}
          message={message}
        />
      )}
      {showBatchReview && (
        <Dialog onClose={() => setShowBatchReview(false)}>
          <div className="dialog-header">
            <div>
              <span className="eyebrow">BATCH REVIEW</span>
              <h2>Review {selectedRequestIds.length} selected requests</h2>
            </div>
            <button
              className="icon-btn"
              onClick={() => setShowBatchReview(false)}
              aria-label="Close batch review"
            >
              <X size={20} />
            </button>
          </div>
          <form onSubmit={reviewBatch}>
            <div className="native-body">
              <ErrorMessage error={error} />
              {selectedRequestIds
                .map((id) => mergeRequests.find((mergeRequest) => mergeRequest.id === id))
                .filter(Boolean)
                .map((mergeRequest) => (
                  <p className="muted" key={mergeRequest.id}>
                    {mergeRequest.title} · revision <code>{shortId(mergeRequest.revision_id)}</code>
                  </p>
                ))}
              <label className="field">
                Review decision
                <select
                  aria-label="Review decision"
                  value={batchAction}
                  onChange={(e) => setBatchAction(e.target.value)}
                >
                  <option value="approve">Approve selected revisions</option>
                  <option value="request_changes">Request changes</option>
                  <option value="comment">Comment without approval</option>
                </select>
              </label>
              <label className="field">
                Rationale
                <textarea
                  value={batchRationale}
                  onChange={(e) => setBatchRationale(e.target.value)}
                  rows={3}
                />
              </label>
              <p className="muted">
                Every displayed revision and request version must still match. This records reviews;
                applying code is a separate decision.
              </p>
            </div>
            <div className="dialog-footer">
              <button
                type="button"
                className="button ghost"
                onClick={() => setShowBatchReview(false)}
              >
                Cancel
              </button>
              <button
                className="button dark"
                disabled={
                  busy ||
                  !selectedRequestIds.length ||
                  (batchAction !== 'approve' && !batchRationale.trim())
                }
              >
                Record reviews
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
