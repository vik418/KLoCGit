export function MergeRequestDetails({ mergeRequest, busy, form }) {
  return (
    <details className="native-details">
      <summary>Edit request details</summary>
      <form onSubmit={form.onSubmit}>
        <label className="field">
          Title
          <input
            value={form.title}
            onChange={(e) => form.setTitle(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label className="field">
          Description
          <textarea
            value={form.description}
            onChange={(e) => form.setDescription(e.target.value)}
            rows={3}
          />
        </label>
        <button
          className="button outline small"
          disabled={busy || mergeRequest.status === 'merged'}
        >
          Save details
        </button>
      </form>
    </details>
  );
}
