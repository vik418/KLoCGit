import { useId, useState } from 'react';
import {
  ChevronDown,
  GitCommitHorizontal,
  GitFork,
  Layers3,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../ui/Button.jsx';

export function WorkspaceHeader({ workspace, isBusy, onDemoAction }) {
  const [showDemoMenu, setShowDemoMenu] = useState(false);
  const menuId = useId();

  function runDemoAction(action) {
    setShowDemoMenu(false);
    onDemoAction(action);
  }

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="klocgit home">
        <span className="brand-mark">
          <GitFork size={19} aria-hidden="true" />
        </span>
        klocgit
      </a>
      <div className="breadcrumb">
        <span>/</span>
        <b>{workspace.workspace.name}</b>
        <span className="workspace-description">{workspace.workspace.description}</span>
      </div>
      <div className="topbar-actions">
        <span className="repository-count">
          <Layers3 size={14} aria-hidden="true" />
          {workspace.repositories.length}{' '}
          {workspace.repositories.length === 1 ? 'repository' : 'repositories'}
        </span>
        {workspace.workspace.mode === 'local' && (
          <div
            className="menu-anchor"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setShowDemoMenu(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setShowDemoMenu(false);
            }}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowDemoMenu(!showDemoMenu)}
              aria-expanded={showDemoMenu}
              aria-controls={menuId}
              disabled={isBusy}
            >
              Demo controls <ChevronDown size={14} aria-hidden="true" />
            </Button>
            {showDemoMenu && (
              <div className="dropdown" id={menuId}>
                <button type="button" onClick={() => runDemoAction('reset')}>
                  <RefreshCw size={15} aria-hidden="true" />
                  Reset workspace and context
                </button>
                <button type="button" onClick={() => runDemoAction('stale')}>
                  <GitCommitHorizontal size={15} aria-hidden="true" />
                  Simulate an external Git update
                </button>
                <button type="button" onClick={() => runDemoAction('constraint')}>
                  <ShieldCheck size={15} aria-hidden="true" />
                  Change a constraint version
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
