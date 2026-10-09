import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { Button } from '../../ui/Button.jsx';
import { Dialog, DialogTitle, DialogDescription } from '../../ui/Dialog.jsx';

const fields = [
  ['Statement', 'statement'],
  ['Rationale', 'rationale'],
  ['Status', 'status'],
  ['Result', 'result'],
  ['Provenance', 'provenance_state'],
  ['Actor', 'actor'],
  ['Created by', 'created_by'],
  ['Recorded at', 'created_at'],
  ['Repository', 'repo_id'],
  ['Commit', 'commit'],
  ['Head commit', 'head_commit'],
  ['Tree', 'tree'],
  ['Tree hash', 'tree_hash'],
  ['Configuration', 'config_hash'],
  ['Decision basis', 'decision_basis_hash'],
  ['Context snapshot', 'context_snapshot_id'],
  ['Objective', 'objective_id'],
  ['Future', 'future_id'],
  ['Revision', 'revision_id'],
  ['Candidate', 'candidate_id'],
  ['Decision', 'decision_id'],
  ['Subject', 'subject_ref'],
];

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function referenceLabel(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return 'Unspecified reference';
  return (
    [scalar(value.kind), scalar(value.id)].filter(Boolean).join(' · ') || 'Unspecified reference'
  );
}

function RecordDetails({ record }) {
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer break-all text-sm">
        {scalar(record.kind) ?? 'Record'} · {scalar(record.id) ?? 'Identity not provided'}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Basis: {scalar(record.basis) ?? 'Not recorded'}
        </p>
        <dl className="space-y-2 text-sm">
          {fields.map(([label, key]) =>
            scalar(record[key]) !== null ? (
              <div key={key}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="break-all whitespace-pre-wrap">{scalar(record[key])}</dd>
              </div>
            ) : null,
          )}
        </dl>
        {Array.isArray(record.sources) && record.sources.length > 0 && (
          <section aria-label="Immutable sources" className="space-y-2">
            <h4 className="text-xs font-medium">Immutable sources</h4>
            {record.sources
              .filter((source) => source && typeof source === 'object')
              .map((source, index) => (
                <dl key={source.id ?? index} className="space-y-1 rounded border p-2 text-xs">
                  {[
                    ['Repository', 'repo_id'],
                    ['Path', 'path'],
                    ['Commit', 'commit'],
                    ['Tree', 'tree'],
                    ['Blob', 'blob'],
                    ['Content hash', 'content_hash'],
                    ['Basis', 'basis'],
                  ].map(([label, key]) =>
                    scalar(source[key]) !== null ? (
                      <div key={key}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="break-all">{scalar(source[key])}</dd>
                      </div>
                    ) : null,
                  )}
                </dl>
              ))}
          </section>
        )}
        {Array.isArray(record.references) && record.references.length > 0 && (
          <section aria-label="Linked records" className="space-y-1">
            <h4 className="text-xs font-medium">Linked records</h4>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {record.references.map((reference, index) => (
                <li key={index} className="break-all">
                  {referenceLabel(reference)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}

export function ProvenanceDialog({ subject, onClose }) {
  const [provenance, setProvenance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const kind = subject?.kind;
  const id = subject?.id;
  const repoId = subject?.repo_id;

  useEffect(() => {
    const controller = new AbortController();
    setProvenance(null);
    setError(null);
    setLoading(true);

    async function read() {
      try {
        if (!kind || !id) throw new Error('A provenance subject is required.');
        const query = repoId ? '?repo_id=' + encodeURIComponent(repoId) : '';
        const result = await apiRequest(
          '/provenance/' + encodeURIComponent(kind) + '/' + encodeURIComponent(id) + query,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setProvenance(result);
      } catch (failure) {
        if (!controller.signal.aborted) setError(getErrorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    read();
    return () => controller.abort();
  }, [kind, id, repoId, loadVersion]);

  const records = Array.isArray(provenance?.records)
    ? provenance.records.filter((record) => record && typeof record === 'object')
    : [];
  const links = Array.isArray(provenance?.links)
    ? provenance.links.filter((link) => link && typeof link === 'object')
    : [];

  return (
    <Dialog onClose={onClose} className="max-w-lg" hasDescription>
      <div className="dialog-header">
        <div className="min-w-0">
          <DialogTitle>Provenance</DialogTitle>
          <DialogDescription className="mt-2">
            Follow recorded context, decisions, code and evidence through immutable references.
          </DialogDescription>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="native-body space-y-5" aria-busy={loading}>
        <section aria-label="Provenance subject" className="space-y-1">
          <p className="text-sm font-medium">{kind}</p>
          <p className="break-all text-xs text-muted-foreground">{id}</p>
          {repoId && <p className="break-all text-xs text-muted-foreground">{repoId}</p>}
        </section>
        {error && (
          <div className="space-y-3">
            <p className="error-banner" role="alert">
              {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setLoadVersion((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        )}
        {loading && (
          <p className="text-sm text-muted-foreground" role="status">
            Loading recorded provenance…
          </p>
        )}
        {!loading && provenance && (
          <>
            <section aria-label="Provenance records" className="space-y-3">
              <h3 className="text-sm font-medium">Recorded history ({records.length})</h3>
              {!records.length && (
                <p className="text-sm leading-6 text-muted-foreground">
                  No structured records were returned for this subject.
                </p>
              )}
              {records.map((record, index) => (
                <RecordDetails key={record.id ?? index} record={record} />
              ))}
            </section>
            {links.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm">
                  Recorded links ({links.length})
                </summary>
                <ul className="mt-3 space-y-3 text-xs">
                  {links.map((link, index) => (
                    <li key={link.id ?? index} className="space-y-1 rounded-md border p-3">
                      <p className="break-all">{referenceLabel(link.from)}</p>
                      <p className="text-muted-foreground">{scalar(link.type) ?? 'Linked'}</p>
                      <p className="text-muted-foreground">
                        Basis: {scalar(link.basis) ?? 'Not recorded'}
                      </p>
                      <p className="break-all">{referenceLabel(link.to)}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
      <div className="dialog-footer">
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
