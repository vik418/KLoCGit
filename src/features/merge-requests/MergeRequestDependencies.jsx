export function MergeRequestDependencies({
  mergeRequest,
  busy,
  choices,
  selected,
  onSelect,
  onSave,
}) {
  return (
    <details className="native-details">
      <summary>Dependencies {selected.length > 0 ? '(' + selected.length + ')' : ''}</summary>
      <p className="muted">
        These requests must merge before this one. Dependencies do not create a cross-repository
        transaction.
      </p>
      <div className="dependency-list">
        {choices.map((request) => (
          <label className="checkbox-label" key={request.id}>
            <input
              type="checkbox"
              checked={selected.includes(request.id)}
              disabled={mergeRequest.status === 'merged'}
              onChange={(e) =>
                onSelect(
                  e.target.checked
                    ? [...selected, request.id]
                    : selected.filter((dependencyId) => dependencyId !== request.id),
                )
              }
            />
            <span>
              {request.title}
              <small>
                {request.repo} · {request.status}
              </small>
            </span>
          </label>
        ))}
      </div>
      <button
        className="button outline small"
        disabled={busy || mergeRequest.status === 'merged'}
        onClick={onSave}
      >
        Save dependencies
      </button>
    </details>
  );
}
