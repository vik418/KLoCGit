import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { NativeFormDialog } from '../../ui/NativeFormDialog.jsx';
import { Button } from '../../ui/Button.jsx';
import { Input } from '../../ui/Input.jsx';

const roles = ['reader', 'producer', 'reviewer', 'maintainer', 'admin'];

export function AccessDialog({ onClose, reload, message }) {
  const [session, setSession] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [actorId, setActorId] = useState('');
  const [repoId, setRepoId] = useState('');
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [revoking, setRevoking] = useState(false);
  const pending = useRef(false);
  const admin = session?.workspace_roles?.includes('admin') ?? false;

  function clearEditor() {
    setActorId('');
    setRepoId('');
    setSelectedRoles([]);
    setRevoking(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPolicy(null);
    setSession(null);

    async function read() {
      try {
        const identity = await apiRequest('/session', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSession(identity);
        if (identity.workspace_roles?.includes('admin')) {
          const current = await apiRequest('/access', { signal: controller.signal });
          if (controller.signal.aborted) return;
          setPolicy(current);
        }
        setStale(false);
      } catch (failure) {
        if (!controller.signal.aborted) setError(getErrorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    read();
    return () => controller.abort();
  }, [loadVersion]);

  function refresh() {
    clearEditor();
    setLoadVersion((value) => value + 1);
  }

  function edit(grant, revoke = false) {
    setActorId(grant.actor_id);
    setRepoId(grant.repo_id ?? '');
    setSelectedRoles(revoke ? [] : [...grant.roles]);
    setRevoking(revoke);
    setError(null);
  }

  function toggleRole(role) {
    setSelectedRoles((current) =>
      current.includes(role) ? current.filter((value) => value !== role) : [...current, role],
    );
    setRevoking(false);
  }

  const actor = actorId.trim();
  const repository = repoId.trim() || null;
  const existing = policy?.grants?.find(
    (grant) => grant.actor_id === actor && grant.repo_id === repository,
  );
  const unchanged =
    existing?.roles.length === selectedRoles.length &&
    selectedRoles.every((role) => existing.roles.includes(role));
  const valid =
    admin &&
    policy &&
    !stale &&
    actor &&
    actor !== policy.owner_id &&
    (revoking ? Boolean(existing) : selectedRoles.length > 0) &&
    !unchanged;

  async function submit(event) {
    event.preventDefault();
    if (!admin && session && !loading) {
      onClose();
      return;
    }
    if (pending.current || !valid) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const updated = await apiRequest('/access', {
        method: 'POST',
        body: {
          expected_version: policy.version,
          changes: [{ actor_id: actor, repo_id: repository, roles: selectedRoles }],
        },
      });
      setPolicy(updated);
      clearEditor();
      try {
        const identity = await apiRequest('/session');
        setSession(identity);
        if (!identity.workspace_roles?.includes('admin')) setPolicy(null);
        await reload();
        message(revoking ? 'Access revoked.' : 'Access updated.');
      } catch (refreshError) {
        setPolicy(null);
        message(
          'Access saved. Reload access to confirm your current permissions. ' +
            getErrorMessage(refreshError),
          'error',
        );
      }
    } catch (failure) {
      setError(getErrorMessage(failure));
      if (failure.error === 'ACCESS_POLICY_STALE') setStale(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <NativeFormDialog
      title="Workspace access"
      description="Grant roles to people and producers. Repository grants add to workspace roles."
      onClose={onClose}
      onSubmit={submit}
      busy={saving}
      error={error}
      disabled={loading || (admin ? !valid : !session)}
      submitLabel={admin ? (revoking ? 'Revoke grant' : 'Save grant') : 'Done'}
      pendingLabel="Saving access…"
    >
      {loading && (
        <p className="text-sm text-muted-foreground" role="status">
          Loading access…
        </p>
      )}
      {session && (
        <section aria-label="Your access" className="mb-5 space-y-2 rounded-md border p-3">
          <h3 className="text-sm font-medium">Your access</h3>
          <p className="break-all text-sm">{session.actor_id}</p>
          <p className="text-xs text-muted-foreground">
            Workspace: {session.workspace_roles?.join(', ') || 'No roles granted'}
          </p>
          {session.repository_roles?.map((grant) => (
            <p key={grant.repo_id} className="break-all text-xs text-muted-foreground">
              {grant.repo_id}: {grant.roles.join(', ')}
            </p>
          ))}
          {!admin && (
            <p className="text-sm leading-6 text-muted-foreground">
              A workspace administrator can grant or revoke access.
            </p>
          )}
        </section>
      )}
      {!loading && (
        <Button type="button" variant="outline" size="sm" className="mb-5" onClick={refresh}>
          Reload access and discard edits
        </Button>
      )}
      {policy && admin && (
        <>
          <p className="mb-4 break-all text-xs text-muted-foreground">
            Policy version {policy.version} · Owner {policy.owner_id} has workspace administration.
          </p>
          {stale && (
            <p className="mb-4 text-sm leading-6 text-primary" role="status">
              Access changed while you edited. Reload the policy, then review your change again.
            </p>
          )}
          <fieldset disabled={stale} className="min-w-0 border-0 p-0">
            <label className="field">
              Actor identity
              <Input
                value={actorId}
                onChange={(event) => {
                  setActorId(event.target.value);
                  setRevoking(false);
                }}
                required
                maxLength={200}
                autoComplete="off"
              />
            </label>
            <label className="field">
              Repository identity (leave empty for workspace access)
              <Input
                value={repoId}
                onChange={(event) => {
                  setRepoId(event.target.value);
                  setRevoking(false);
                }}
                maxLength={200}
                autoComplete="off"
              />
            </label>
            <fieldset className="mb-4 space-y-2 rounded-md border p-3">
              <legend className="px-1 text-sm">Roles for this grant</legend>
              {roles.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={selectedRoles.includes(role)}
                    onChange={() => toggleRole(role)}
                  />
                  {role}
                </label>
              ))}
            </fieldset>
            {actor === policy.owner_id && (
              <p className="mb-4 text-sm text-muted-foreground">
                The workspace owner's implicit access cannot be edited here.
              </p>
            )}
            {revoking && (
              <p className="mb-4 break-all text-sm">
                Revoke {actor}'s grant for {repository ?? 'the workspace'}. Other grants remain.
              </p>
            )}
            {actor === session.actor_id && (
              <p className="mb-4 text-sm text-muted-foreground">
                This changes your own grant and may remove your administration access.
              </p>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={clearEditor}>
              Clear edit
            </Button>
          </fieldset>
          <details className="mt-5">
            <summary className="cursor-pointer text-sm">
              Existing grants ({policy.grants.length})
            </summary>
            <div className="mt-3 space-y-3">
              {!policy.grants.length && (
                <p className="text-sm text-muted-foreground">No explicit grants.</p>
              )}
              {policy.grants.map((grant) => (
                <div
                  key={JSON.stringify([grant.actor_id, grant.repo_id])}
                  className="space-y-2 rounded-md border p-3"
                >
                  <p className="break-all text-sm font-medium">{grant.actor_id}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    {grant.repo_id ?? 'Workspace'} · {grant.roles.join(', ')}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={stale}
                      onClick={() => edit(grant)}
                      aria-label={'Edit access for ' + grant.actor_id}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={stale}
                      onClick={() => edit(grant, true)}
                      aria-label={'Prepare revocation for ' + grant.actor_id}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </NativeFormDialog>
  );
}
