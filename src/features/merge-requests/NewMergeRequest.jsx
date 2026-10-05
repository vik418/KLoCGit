import { useState } from 'react';
import { X } from 'lucide-react';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { Dialog } from '../../ui/Dialog.jsx';
import { useMutation } from '../../hooks/useMutation.js';

export function NewMergeRequest({ workspace, onClose, onCreated, reload, message }) {
  const [repo, setRepo] = useState(workspace.repositories[0]?.id ?? ''),
    [sourceRepo, setSourceRepo] = useState(''),
    [sourceRef, setSourceRef] = useState(''),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [draft, setDraft] = useState(true);
  const { busy, error, mutate } = useMutation(reload, message);
  const sources = [
    repo,
    ...(workspace.forks ?? []).filter((f) => f.repo === repo).map((f) => f.id),
  ];
  async function submit(e) {
    e.preventDefault();
    const result = await mutate(
      '/merge-requests',
      {
        repo,
        source_repo: sourceRepo || repo,
        source_ref: sourceRef.startsWith('refs/') ? sourceRef : 'refs/heads/' + sourceRef,
        title,
        description,
        draft,
      },
      'Merge request opened from the current Git branch.',
    );
    const id = result?.merge_request?.id ?? result?.id;
    if (id) onCreated(id);
  }
  return (
    <Dialog onClose={onClose} className="mr-dialog">
      <div className="dialog-header">
        <div>
          <span className="eyebrow">NATIVE MERGE REQUEST</span>
          <h2>Open a merge request</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close new merge request">
          <X size={20} />
        </button>
      </div>
      <form onSubmit={submit}>
        <div className="native-body">
          <ErrorMessage error={error} />
          <div className="form-grid">
            <label className="field">
              Target repository
              <select
                aria-label="Target repository"
                value={repo}
                onChange={(e) => {
                  setRepo(e.target.value);
                  setSourceRepo('');
                }}
              >
                {workspace.repositories.map((r) => (
                  <option key={r.id}>{r.id}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Source repository
              <select
                aria-label="Source repository"
                value={sourceRepo || repo}
                onChange={(e) => setSourceRepo(e.target.value)}
              >
                {sources.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            Source branch
            <input
              list="native-source-refs"
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
              required
            />
            <datalist id="native-source-refs">
              {workspace.proposals
                .filter((p) => (p.source_repo ?? p.repo) === (sourceRepo || repo))
                .map((p) => (
                  <option key={p.id} value={p.ref} />
                ))}
            </datalist>
          </label>
          <label className="field">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <label className="field">
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            Start as a draft
          </label>
          <p className="muted">
            The source stays an ordinary Git branch. Opening a request records coordination
            metadata.
          </p>
        </div>
        <div className="dialog-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button dark"
            disabled={busy || !repo || !sourceRef.trim() || !title.trim()}
          >
            {busy ? 'Opening…' : 'Open merge request'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
