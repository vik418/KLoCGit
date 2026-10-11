import { useState } from 'react';
import {
  Activity,
  CircleHelp,
  GitFork,
  GitPullRequest,
  KeyRound,
  Layers3,
  MoreHorizontal,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '../ui/Button.jsx';

export const workspaceViews = [
  {
    key: 'attention',
    label: 'Attention',
    description: 'Decisions and work that need your review.',
    icon: CircleHelp,
  },
  {
    key: 'systems',
    label: 'Repositories',
    description: 'Browse source and start independent work.',
    icon: Layers3,
  },
  {
    key: 'futures',
    label: 'Futures',
    description: 'Independent work, ready to compare and combine.',
    icon: GitFork,
  },
  {
    key: 'evidence',
    label: 'Evidence',
    description: 'Checks tied to exact code and configuration.',
    icon: ShieldCheck,
    secondary: true,
  },
  {
    key: 'activity',
    label: 'History',
    description: 'Recorded decisions and Git updates.',
    icon: Activity,
    secondary: true,
  },
  {
    key: 'work',
    label: 'Git workflows',
    description: 'Merge requests and branch changes.',
    icon: GitPullRequest,
    secondary: true,
  },
];

export function WorkspaceNavigation({ activeView, onNavigate, onCapabilities, onAccess }) {
  const [expanded, setExpanded] = useState(false);

  function navigate(key) {
    onNavigate(key);
    setExpanded(false);
  }

  function viewButton({ key, label, icon: Icon }) {
    return (
      <Button
        key={key}
        type="button"
        variant="ghost"
        aria-current={activeView === key ? 'page' : undefined}
        onClick={() => navigate(key)}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </Button>
    );
  }

  return (
    <aside className="workspace-navigation" aria-label="Workspace navigation">
      <div className="navigation-primary">
        <nav aria-label="Workspace views">
          {workspaceViews.filter((view) => !view.secondary).map(viewButton)}
        </nav>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="navigation-toggle"
          aria-label="More workspace views"
          aria-expanded={expanded}
          aria-controls="supporting-navigation"
          onClick={() => setExpanded(!expanded)}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </div>
      <div id="supporting-navigation" className="navigation-secondary" data-expanded={expanded}>
        <p className="navigation-label">Workspace</p>
        <nav aria-label="Supporting views">
          {workspaceViews.filter((view) => view.secondary).map(viewButton)}
        </nav>
        <nav className="navigation-settings" aria-label="Workspace settings">
          <Button type="button" variant="ghost" onClick={onCapabilities}>
            <SlidersHorizontal aria-hidden="true" />
            Capabilities
          </Button>
          <Button type="button" variant="ghost" onClick={onAccess}>
            <KeyRound aria-hidden="true" />
            Access
          </Button>
        </nav>
      </div>
    </aside>
  );
}
