import { RepositoryPolicy } from './RepositoryPolicy.jsx';
import { shortId } from '../../lib/format.js';
export function MergeRequestRules({ mergeRequest, workspace, missingChecks, reload, message }) {
  return (
    <details className="native-details">
      <summary>Revision and merge rules</summary>
      <p>
        Head <code>{shortId(mergeRequest.head_commit)}</code> · revision{' '}
        <code>{shortId(mergeRequest.revision_id)}</code> · version {mergeRequest.version}
      </p>
      <p className="muted">
        Required approvals: {mergeRequest.policy?.minApprovals ?? '—'}. Required checks:{' '}
        {(mergeRequest.policy?.requiredChecks ?? []).join(', ') || 'None configured'}.
      </p>
      {missingChecks.map((reason, i) => (
        <p key={i} className="queue-blocker">
          Missing: {reason}
        </p>
      ))}
      {workspace.repositories.find((repository) => repository.id === mergeRequest.repo) && (
        <RepositoryPolicy
          repo={workspace.repositories.find((repository) => repository.id === mergeRequest.repo)}
          workspace={workspace}
          reload={reload}
          message={message}
        />
      )}
    </details>
  );
}
