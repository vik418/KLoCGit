import { Badge } from '../../ui/Badge.jsx';
export function MergeRequestDiscussion({
  mergeRequest,
  busy,
  threads,
  comments,
  form,
  onReply,
  onToggleThread,
}) {
  return (
    <>
      <div className="thread-list">
        {threads.map((thread) => {
          const events = comments.filter(
            (commentEvent) =>
              thread.comment_ids?.includes(commentEvent.id) ||
              (commentEvent.thread_id === thread.id && commentEvent.action === 'comment'),
          );
          const stale = thread.revision_id !== mergeRequest.revision_id;
          return (
            <article
              className={'comment-thread ' + (thread.resolved ? 'resolved' : '')}
              key={thread.id}
            >
              <div className="thread-heading">
                <b>
                  {thread.file
                    ? thread.file + (thread.line ? ':' + thread.line : '')
                    : 'Discussion'}
                </b>
                <Badge tone={stale ? 'amber' : thread.resolved ? 'mint' : 'neutral'}>
                  {stale ? 'Historical' : thread.resolved ? 'Resolved' : 'Unresolved'}
                </Badge>
              </div>
              {events
                .filter((commentEvent) => commentEvent.action === 'comment')
                .map((commentEvent) => (
                  <div className="comment-body" key={commentEvent.id}>
                    <small>{commentEvent.actor}</small>
                    <p>{commentEvent.body}</p>
                  </div>
                ))}
              {mergeRequest.status === 'open' && !stale && (
                <div className="inline-actions">
                  <button
                    className="button ghost small"
                    disabled={busy}
                    onClick={() => onReply(thread.id)}
                  >
                    Reply
                  </button>
                  <button
                    className="button outline small"
                    disabled={busy}
                    onClick={() => onToggleThread(thread)}
                  >
                    {thread.resolved ? 'Reopen thread' : 'Resolve thread'}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!threads.length && <p className="muted">No discussion yet.</p>}
      {mergeRequest.status === 'open' && (
        <form className="native-section" onSubmit={form.onSubmit}>
          <h3>{form.replyTo ? 'Reply to discussion' : 'Add a comment'}</h3>
          {form.replyTo && (
            <button
              type="button"
              className="button ghost small"
              onClick={() => form.setReplyTo(null)}
            >
              Cancel reply
            </button>
          )}
          <label className="field">
            Comment
            <textarea
              value={form.comment}
              onChange={(e) => form.setComment(e.target.value)}
              rows={3}
              required
            />
          </label>
          {!form.replyTo && (
            <details className="compact-details">
              <summary>Attach to a file</summary>
              <div className="form-grid">
                <label className="field">
                  File path
                  <input
                    value={form.file}
                    onChange={(e) => form.setFile(e.target.value)}
                    placeholder="client/retry.mjs"
                  />
                </label>
                <label className="field">
                  Line
                  <input
                    type="number"
                    min="1"
                    value={form.line}
                    onChange={(e) => form.setLine(e.target.value)}
                  />
                </label>
              </div>
            </details>
          )}
          <button className="button outline small" disabled={busy || !form.comment.trim()}>
            Post comment
          </button>
        </form>
      )}
    </>
  );
}
