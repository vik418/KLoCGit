import { GitBranch, Box, ShieldCheck, GitCommitHorizontal } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { shortId } from '../../lib/format.js';

export function RepositoryState({ workspace }) {
  return (
    <div className="rail-card repo-panel">
      <div className="rail-heading">
        <h3>Canonical state</h3>
        <GitBranch size={16} />
      </div>
      {workspace.repositories.map((r) => (
        <div key={r.id} className="repo-state">
          <span>
            <Box size={15} />
            <b>{r.name}</b>
            <Badge tone="neutral">main</Badge>
          </span>
          <div>
            <GitCommitHorizontal size={13} />
            <code>{shortId(r.head)}</code>
            <span>Immutable commit</span>
          </div>
        </div>
      ))}
      <div className="repo-foot">
        <ShieldCheck size={14} />
        Head + decision basis checked on apply
      </div>
    </div>
  );
}
