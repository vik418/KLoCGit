import { useState, useEffect } from 'react';
import { FileCode2, X } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { Dialog, DialogTitle } from '../../ui/Dialog.jsx';
import { useMutation } from '../../hooks/useMutation.js';
import { apiRequest } from '../../lib/api.js';
import { shortId } from '../../lib/format.js';
import { getPreparedDecisionId } from '../../lib/workspace.js';

export function ProposalDialog({ id, workspace, onClose, onDecision, reload, message }) {
  const r = workspace.revisions.find((r) => r.id === id),
    p = workspace.proposals.find((p) => p.id === r?.proposal_id),
    [diff, setDiff] = useState('Loading exact Git diff…');
  const { busy, error, mutate } = useMutation(reload, message);
  useEffect(() => {
    apiRequest('/diff?revision=' + encodeURIComponent(id))
      .then((d) => setDiff(d.diff || 'No tree differences.'))
      .catch((e) => setDiff(e.message));
  }, [id]);
  if (!r || !p)
    return (
      <Dialog onClose={onClose}>
        <div className="native-body">
          <DialogTitle>Revision unavailable</DialogTitle><p>This historical revision is unavailable.</p>
          <button className="button ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </Dialog>
    );
  const settled = workspace.dispositions?.some((d) => d.revision_id === id);
  async function prepare() {
    const result = await mutate(
      '/reviews/prepare',
      { revision_ids: [id], title: 'Review ' + p.title },
      'Review prepared. Inspect the exact checked composition.',
    );
    const component = getPreparedDecisionId(result);
    if (component) onDecision(component);
  }
  return (
    <Dialog onClose={onClose} className="proposal-dialog">
      <div className="dialog-header">
        <div>
          <span className="eyebrow">IMMUTABLE PROPOSAL REVISION</span>
          <DialogTitle asChild><h2>{p.title}</h2></DialogTitle>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close proposal">
          <X size={20} />
        </button>
      </div>
      <ErrorMessage error={error} />
      <div className="proposal-info">
        <div>
          <span>{p.provenance_state === 'unknown' ? 'Intent unavailable' : 'Declared intent'}</span>
          <p>{p.statement}</p>
        </div>
        <div>
          <span>Producer</span>
          <b>{p.producer}</b>
          <Badge tone={r.provenance_state === 'unknown' ? 'amber' : 'neutral'}>
            {r.provenance_state}
          </Badge>
        </div>
        <div>
          <span>Git facts · observed</span>
          <code>
            {shortId(r.base_commit)} → {shortId(r.head_commit)}
          </code>
          <p>
            {p.repo} · {r.affected_scope.join(', ')}
          </p>
        </div>
      </div>
      {r.context_task_id && (
        <div className="proposal-info">
          <div>
            <span>Context before code</span>
            <p>
              Task {shortId(r.context_task_id)} · answer {shortId(r.context_answer_ref)} ·{' '}
              {r.context_binding_state}
            </p>
            {workspace.contexts
              .find((c) => c.id === r.context_version)
              ?.sources?.map((source) => (
                <p key={source.id}>
                  Retrieved {source.repo}/{source.path} at <code>{shortId(source.commit)}</code>
                </p>
              ))}
          </div>
        </div>
      )}
      <div className="diff-heading">
        <FileCode2 size={16} />
        <b>Exact revision diff</b>
        <code>{shortId(r.tree_hash)}</code>
      </div>
      <pre className="diff">
        {diff.split('\n').map((line, i) => (
          <span
            key={i}
            className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      <div className="dialog-footer native-dialog-footer">
        <span>Git facts are observed. Intent remains declared or unknown.</span>
        <div className="inline-actions">
          {!r.stale && !settled && (
            <button className="button outline" disabled={busy} onClick={prepare}>
              Prepare review
            </button>
          )}
          <button className="button dark" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
