import { Badge } from '../../ui/Badge.jsx';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { useMutation } from '../../hooks/useMutation.js';
import { decisionTitle } from '../decisions/presentation.js';
import { shortId } from '../../lib/format.js';
import { getQueueEntries } from '../../lib/workspace.js';
import { getErrorReasons } from '../../lib/errors.js';

export function MergeQueue({ workspace, reload, message, onDecision }) {
  const { busy, error, mutate } = useMutation(reload, message),
    entries = getQueueEntries(workspace);
  async function process() {
    const result = await mutate(
      '/merge-queue/process',
      {},
      'Queue examined against current Git and review inputs.',
    );
    if (result?.reason)
      message(
        typeof result.reason === 'string'
          ? result.reason
          : (result.reason.message ?? result.reason.code ?? JSON.stringify(result.reason)),
        'error',
      );
  }
  return (
    <>
      <div className="work-actions">
        <p className="muted">Each entry preserves the exact reviewed composition.</p>
        <button
          className="button dark small"
          disabled={busy || !entries.some((e) => ['queued', 'blocked'].includes(e.status))}
          onClick={process}
        >
          {busy ? 'Processing…' : 'Process next'}
        </button>
      </div>
      <ErrorMessage error={error} />
      {!entries.length && (
        <p className="empty-state">Queue a reviewed decision to schedule its exact composition.</p>
      )}
      <div className="queue-list">
        {entries.map((entry, i) => {
          const c = workspace.decisionComponents.find((c) => c.id === entry.component_id);
          return (
            <article className="queue-row" key={entry.id}>
              <div className="queue-heading">
                <span className="decision-number">{i + 1}</span>
                <h3>{c ? decisionTitle(c, workspace) : 'Reviewed composition'}</h3>
                <Badge
                  tone={
                    entry.status === 'merged'
                      ? 'mint'
                      : ['blocked', 'needs_review', 'recovery_required'].includes(entry.status)
                        ? 'amber'
                        : 'neutral'
                  }
                >
                  {entry.status.replaceAll('_', ' ')}
                </Badge>
              </div>
              <p>
                {entry.repo} · {entry.selected_revision_ids?.length ?? 0} revisions
              </p>
              {getErrorReasons(entry.blockers).map((reason, i) => (
                <p className="queue-blocker" key={i}>
                  {reason}
                </p>
              ))}
              {entry.status === 'needs_review' && (
                <p className="queue-blocker">
                  Inputs changed. Review a fresh decision and enqueue a new entry.
                </p>
              )}
              <div className="inline-actions">
                {c && (
                  <button className="button outline small" onClick={() => onDecision(c.id)}>
                    Review decision
                  </button>
                )}
                {['queued', 'blocked', 'needs_review'].includes(entry.status) && (
                  <button
                    className="button ghost small"
                    disabled={busy}
                    onClick={() =>
                      mutate('/merge-queue/' + entry.id + '/cancel', {}, 'Queue entry cancelled.')
                    }
                  >
                    Cancel
                  </button>
                )}
              </div>
              <details className="compact-details">
                <summary>Reviewed inputs</summary>
                <p>
                  Basis <code>{shortId(entry.basis_hash)}</code> · canonical head{' '}
                  <code>{shortId(entry.expected_canonical_head)}</code>
                </p>
                <p>Submitted by {entry.actor}</p>
              </details>
            </article>
          );
        })}
      </div>
    </>
  );
}
