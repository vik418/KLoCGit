import { useState } from 'react';
import { ErrorMessage } from '../../ui/ErrorMessage.jsx';
import { useMutation } from '../../hooks/useMutation.js';
import { apiRequest } from '../../lib/api.js';

export function RepositoryPolicy({ repo, reload, message }) {
  const [policy, setPolicy] = useState(null),
    [approvals, setApprovals] = useState(1),
    [self, setSelf] = useState(true),
    [checks, setChecks] = useState('trusted-validation'),
    [loading, setLoading] = useState(false);
  const { busy, error, mutate } = useMutation(reload, message);
  async function load() {
    if (policy || loading) return;
    setLoading(true);
    try {
      const result = await apiRequest('/repositories/' + encodeURIComponent(repo.id) + '/policy'),
        p = result.policy ?? result;
      setPolicy(p);
      setApprovals(p.minApprovals ?? 1);
      setSelf(p.allowSelfApproval ?? true);
      setChecks((p.requiredChecks ?? ['trusted-validation']).join(', '));
    } catch (e) {
      message(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }
  async function save(e) {
    e.preventDefault();
    const result = await mutate(
      '/repositories/' + encodeURIComponent(repo.id) + '/policy',
      {
        policy: {
          minApprovals: Number(approvals),
          allowSelfApproval: self,
          requiredChecks: checks
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        expected_version: policy?.version,
      },
      'Repository merge rules updated. Existing review bases may need refreshing.',
    );
    if (result) setPolicy(result.policy ?? result);
  }
  return (
    <details
      className="native-details"
      onToggle={(e) => {
        if (e.currentTarget.open) load();
      }}
    >
      <summary>{repo.id}</summary>
      {loading ? (
        <p className="muted">Loading rules…</p>
      ) : (
        policy && (
          <form onSubmit={save}>
            <ErrorMessage error={error} />
            <div className="form-grid">
              <label className="field">
                Required approvals
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={approvals}
                  onChange={(e) => setApprovals(e.target.value)}
                />
              </label>
              <label className="field">
                Required platform checks
                <input value={checks} onChange={(e) => setChecks(e.target.value)} />
              </label>
            </div>
            <label className="checkbox-label">
              <input type="checkbox" checked={self} onChange={(e) => setSelf(e.target.checked)} />
              Allow the author to approve
            </label>
            <p className="muted">
              Reported CI checks are informational. Required checks must have current platform
              evidence.
            </p>
            <button className="button outline small" disabled={busy}>
              Save merge rules
            </button>
          </form>
        )
      )}
    </details>
  );
}
