import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiRequest } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { asArray } from '../../lib/workspace.js';
import { Badge } from '../../ui/Badge.jsx';
import { Dialog } from '../../ui/Dialog.jsx';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';

function statusLabel(status) {
  return status.id.toLowerCase() === 'supported'
    ? 'Supported locally'
    : (status.label ?? status.id);
}

function CapabilityItem({ capability, status }) {
  const statusId = capability.status.toLowerCase();
  const tone = statusId === 'supported' ? 'mint' : statusId === 'partial' ? 'amber' : 'neutral';

  return (
    <article className="capability-item">
      <div className="capability-heading">
        <h4>{capability.title}</h4>
        <Badge tone={tone}>{status ? statusLabel(status) : capability.status}</Badge>
      </div>
      <div className="capability-description">
        <b>Scope</b>
        <p>{capability.scope}</p>
      </div>
      <div className="capability-description">
        <b>Limits</b>
        <p>{capability.limits}</p>
      </div>
    </article>
  );
}

export function CapabilitiesDialog({ onClose }) {
  const [registry, setRegistry] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    setError(null);

    apiRequest('/capabilities')
      .then((result) => {
        if (isMounted) setRegistry(result);
      })
      .catch((failure) => {
        if (isMounted) setError(getErrorMessage(failure));
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [loadAttempt]);

  const capabilities = asArray(registry?.capabilities);
  const statuses = asArray(registry?.statuses);
  const filteredCapabilities = capabilities.filter(
    (capability) => statusFilter === 'all' || capability.status === statusFilter,
  );
  const categories = [
    ...new Set(filteredCapabilities.map((capability) => capability.category ?? 'Other')),
  ];
  const selectedStatus = statuses.find((status) => status.id === statusFilter);

  return (
    <Dialog onClose={onClose} className="capabilities-dialog" labelledBy="capabilities-title">
      <div className="dialog-header">
        <div>
          <span className="eyebrow">IMPLEMENTATION SCOPE</span>
          <h2 id="capabilities-title">Capabilities</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close capabilities">
          <X size={20} />
        </button>
      </div>
      <div className="native-body capabilities-body">
        <ErrorMessage error={error} />
        {isLoading && !registry ? (
          <p className="muted" role="status">
            Loading capability registry…
          </p>
        ) : (
          registry && (
            <>
              <p className="muted">
                Support reflects the implementation and verification scope recorded here.
              </p>
              <div className="capability-scope">
                <p>{registry.verification_scope}</p>
              </div>
              <div
                className="capability-filters"
                role="group"
                aria-label="Capability status filters"
              >
                <button
                  className={statusFilter === 'all' ? 'selected' : ''}
                  aria-pressed={statusFilter === 'all'}
                  onClick={() => setStatusFilter('all')}
                >
                  All <span>{capabilities.length}</span>
                </button>
                {statuses.map((status) => (
                  <button
                    key={status.id}
                    className={statusFilter === status.id ? 'selected' : ''}
                    aria-pressed={statusFilter === status.id}
                    onClick={() => setStatusFilter(status.id)}
                  >
                    {statusLabel(status)}{' '}
                    <span>
                      {capabilities.filter((capability) => capability.status === status.id).length}
                    </span>
                  </button>
                ))}
              </div>
              {selectedStatus?.description && (
                <p className="muted capability-filter-description">{selectedStatus.description}</p>
              )}
              <p className="capability-count">
                Showing {filteredCapabilities.length} of {capabilities.length} capabilities ·
                registry {registry.version}
              </p>
              {categories.map((category) => (
                <section className="capability-category" key={category}>
                  <h3>{category}</h3>
                  {filteredCapabilities
                    .filter((capability) => (capability.category ?? 'Other') === category)
                    .map((capability) => (
                      <CapabilityItem
                        key={capability.id}
                        capability={capability}
                        status={statuses.find((status) => status.id === capability.status)}
                      />
                    ))}
                </section>
              ))}
              {!filteredCapabilities.length && (
                <p className="empty-state">No capabilities with this status.</p>
              )}
            </>
          )
        )}
        {error && !registry && (
          <button
            className="button outline small"
            disabled={isLoading}
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            Retry
          </button>
        )}
      </div>
      <div className="dialog-footer">
        <span>Finite checks establish only their recorded scope.</span>
        <button className="button dark" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
