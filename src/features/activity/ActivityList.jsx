import { GitFork, GitCommitHorizontal, Layers } from 'lucide-react';
import { Badge } from '../../ui/Badge.jsx';
import { shortId } from '../../lib/format.js';

function activityLabel(type) {
  // Historical event types stay intact when the displayed product name changes.
  const label = type.replace(/^system\./, 'group.');
  return label.replaceAll('.', ' · ').replaceAll('-', ' ');
}

export function ActivityList({ workspace }) {
  return (
    <div className="activity-list">
      {workspace.audit
        .slice()
        .reverse()
        .map((a) => (
          <div key={a.id} className="activity-item">
            <span className="activity-icon">
              {a.type.includes('canonical') ? (
                <GitCommitHorizontal size={18} />
              ) : a.type.includes('decision') ? (
                <GitFork size={18} />
              ) : (
                <Layers size={18} />
              )}
            </span>
            <div>
              <b>{activityLabel(a.type)}</b>
              <p>
                {a.actor} <span>·</span> {new Date(a.created_at).toLocaleTimeString()}
              </p>
              <code>
                {shortId(a.id)} · previous {shortId(a.previous)}
              </code>
            </div>
            <Badge
              tone={a.type.includes('rejected') || a.type.includes('failed') ? 'amber' : 'neutral'}
            >
              {a.type.includes('updated') ? 'Canonical transition' : 'Audit record'}
            </Badge>
          </div>
        ))}
    </div>
  );
}
