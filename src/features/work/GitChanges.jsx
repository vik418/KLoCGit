import { useState } from 'react';
import { Badge } from '../../ui/Badge.jsx';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { useMutation } from '../../hooks/useMutation.js';
import { RepositoryState } from './RepositoryState.jsx';
import { shortId } from '../../lib/format.js';
import { getPreparedDecisionId } from '../../lib/workspace.js';

export function GitChanges({ workspace, onProposal, onDecision, reload, message }) {
  const [selection, setSelection] = useState([]);
  const { busy, error, mutate } = useMutation(reload, message);
  async function prepare() {
    const result = await mutate(
      '/reviews/prepare',
      { revision_ids: selection, title: 'Review selected Git changes' },
      'Review prepared. Inspect the checked composition.',
    );
    const id = getPreparedDecisionId(result);
    if (id) onDecision(id);
  }
  return (
    <>
      <div className="work-actions">
        <p className="muted">Every producer history is preserved.</p>
        {selection.length > 0 && (
          <button className="button dark small" disabled={busy} onClick={prepare}>
            Prepare review ({selection.length})
          </button>
        )}
      </div>
      <ErrorMessage error={error} />
      <div className="mr-list">
        {workspace.proposals.map((p) => {
          const r =
            workspace.revisions.find((r) => r.proposal_id === p.id && !r.stale) ??
            workspace.revisions.filter((r) => r.proposal_id === p.id).at(-1);
          if (!r) return null;
          const settled = workspace.dispositions?.some((d) => d.revision_id === r.id);
          return (
            <article className="mr-row" key={p.id}>
              <label className="row-checkbox">
                <input
                  type="checkbox"
                  aria-label={'Select ' + p.title}
                  checked={selection.includes(r.id)}
                  disabled={r.stale || settled}
                  onChange={(e) =>
                    setSelection((ids) =>
                      e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id),
                    )
                  }
                />
              </label>
              <button className="mr-row-main" onClick={() => onProposal(r.id)}>
                <h3>{p.title}</h3>
                <p>
                  {p.repo} · {p.producer} · <code>{shortId(r.head_commit)}</code>
                </p>
                <small>
                  {settled
                    ? 'Applied or deferred'
                    : r.stale
                      ? 'Historical revision'
                      : workspace.discovery?.conventional_review_ids?.includes(r.id)
                        ? 'Conventional review'
                        : 'Available for composition'}
                </small>
              </button>
              <Badge tone={r.provenance_state === 'unknown' ? 'amber' : 'neutral'}>
                {r.provenance_state}
              </Badge>
            </article>
          );
        })}
      </div>
      {!workspace.proposals.length && <p className="empty-state">No Git changes ingested.</p>}
      <details className="work-details">
        <summary>Workspace details</summary>
        <div className="metrics-strip">
          <span>
            Review compression <b>{workspace.summary.compressionRatio.toFixed(2)}</b>
          </span>
          <span>
            <b>{workspace.summary.contextAnswersRecorded}</b> context answers recorded separately
          </span>
          <span>
            <b>{workspace.summary.comparisonsAvoided}</b> comparisons avoided
          </span>
          <span>
            <b>{workspace.metrics.casFailures}</b> stale requests rejected
          </span>
        </div>
        <RepositoryState workspace={workspace} />
      </details>
    </>
  );
}
