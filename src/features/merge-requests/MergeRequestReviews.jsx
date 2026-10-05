import { Badge } from '../../ui/Badge.jsx';
import { shortId } from '../../lib/format.js';
export function MergeRequestReviews({
  mergeRequest,
  reviews,
  currentApprovalCount,
  busy,
  form,
  onDismiss,
}) {
  return (
    <section className="native-section">
      <h3>Reviews</h3>
      <p className="muted">
        {currentApprovalCount} current approval{currentApprovalCount === 1 ? '' : 's'} · revision{' '}
        <code>{shortId(mergeRequest.revision_id)}</code>
      </p>
      {reviews.length > 0 && (
        <div className="review-history">
          {reviews.map((review) => (
            <div className="history-row" key={review.id}>
              <div>
                <b>{review.action.replaceAll('_', ' ')}</b>
                <span>{review.actor}</span>
                {review.body && <p>{review.body}</p>}
              </div>
              <Badge
                tone={
                  review.stale || review.revision_id !== mergeRequest.revision_id
                    ? 'amber'
                    : 'neutral'
                }
              >
                {review.stale || review.revision_id !== mergeRequest.revision_id
                  ? 'Historical'
                  : review.dismissed
                    ? 'Dismissed'
                    : 'Current revision'}
              </Badge>
              {mergeRequest.status === 'open' &&
                !review.dismissed &&
                !review.stale &&
                review.revision_id === mergeRequest.revision_id &&
                ['approve', 'request_changes'].includes(review.action) && (
                  <button
                    className="button ghost small"
                    disabled={busy}
                    onClick={() => onDismiss(review.id)}
                  >
                    Dismiss
                  </button>
                )}
            </div>
          ))}
        </div>
      )}
      {mergeRequest.status === 'open' && (
        <form onSubmit={form.onSubmit}>
          <label className="field">
            Review decision
            <select
              aria-label="Review decision"
              value={form.action}
              onChange={(e) => form.setAction(e.target.value)}
            >
              <option value="approve">Approve this revision</option>
              <option value="request_changes">Request changes</option>
              <option value="comment">Comment without approval</option>
            </select>
          </label>
          <label className="field">
            Review rationale
            <textarea value={form.body} onChange={(e) => form.setBody(e.target.value)} rows={2} />
          </label>
          <button
            className="button outline small"
            disabled={busy || (form.action !== 'approve' && !form.body.trim())}
          >
            Submit review
          </button>
        </form>
      )}
    </section>
  );
}
