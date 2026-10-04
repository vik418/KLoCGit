import { useState } from 'react';
import { ChevronDown, GitCommitHorizontal, GitFork, RefreshCw, ShieldCheck } from 'lucide-react';

export function WorkspaceHeader({ workspace, isBusy, onDemoAction }) {
  const [showDemoMenu, setShowDemoMenu] = useState(false);

  function runDemoAction(action) {
    setShowDemoMenu(false);
    onDemoAction(action);
  }

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="KLoCGit home">
        <GitFork size={22} />
        KLoCGit
      </a>
      <div className="breadcrumb">
        {workspace.workspace.name}
        <span>/</span>
        <b>{workspace.workspace.description}</b>
      </div>
      {workspace.workspace.mode === 'local-demo' && (
        <div className="menu-anchor">
          <button
            className="button ghost small"
            onClick={() => setShowDemoMenu(!showDemoMenu)}
            disabled={isBusy}
          >
            Demo controls <ChevronDown size={14} />
          </button>
          {showDemoMenu && (
            <div className="dropdown">
              <button onClick={() => runDemoAction('reset')}>
                <RefreshCw size={15} />
                Reset workspace and context
              </button>
              <button onClick={() => runDemoAction('stale')}>
                <GitCommitHorizontal size={15} />
                Simulate an external Git update
              </button>
              <button onClick={() => runDemoAction('constraint')}>
                <ShieldCheck size={15} />
                Change a constraint version
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
