import { GitFork, Plus } from 'lucide-react';
import { Button } from '../ui/Button.jsx';

export function WorkspaceHeader({ workspace, onNewRepository }) {
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
        <Button type="button" variant="outline" size="sm" onClick={onNewRepository}>
          <Plus aria-hidden="true" />
          New repository
        </Button>
      </div>
    </header>
  );
}
