import { useState } from 'react';
import {
  Code2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Input } from '../../ui/Input.jsx';
import { shortId } from '../../lib/format.js';
import { RepositoryRemote } from './RepositoryRemote.jsx';

export function RepositoryList({
  repositories,
  busy,
  pendingPath,
  onCreate,
  onBrowse,
  onFork,
  onRefresh,
}) {
  const [query, setQuery] = useState('');
  const matching = repositories.filter((repository) =>
    repository.id.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <section aria-label="Repositories" className="repository-section">
      <div className="repository-toolbar">
        <div className="repository-search">
          <Search aria-hidden="true" />
          <Input
            aria-label="Find a repository"
            placeholder="Find a repository…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button type="button" size="sm" onClick={onCreate}>
          <Plus aria-hidden="true" />
          Add repository
        </Button>
      </div>
      <p className="repository-result-count" role="status">
        {query.trim() ? `${matching.length} of ${repositories.length}` : repositories.length}{' '}
        {repositories.length === 1 ? 'repository' : 'repositories'}
      </p>
      {repositories.length === 0 ? (
        <div className="repository-empty">
          <Code2 aria-hidden="true" />
          <h2>Your source starts here</h2>
          <p>Create a repository or import existing Git work.</p>
        </div>
      ) : (
        <ul className="repository-list">
          {matching.map((repository) => {
            const refreshPath = '/repositories/' + encodeURIComponent(repository.id) + '/refresh';
            return (
              <li key={repository.id} className="repository-row">
                <div className="repository-row-heading">
                  <h2>{repository.id}</h2>
                  <span className="repository-status">
                    {repository.status === 'ready' ? 'Source available' : repository.status}
                  </span>
                </div>
                {repository.status === 'ready' ? (
                  <div className="repository-metadata">
                    {repository.canonical_ref && (
                      <span>
                        <GitBranch aria-hidden="true" />
                        {repository.canonical_ref.replace(/^refs\/heads\//, '')}
                      </span>
                    )}
                    {repository.head && (
                      <span>
                        <GitCommitHorizontal aria-hidden="true" />
                        <code title={repository.head}>{shortId(repository.head)}</code>
                      </span>
                    )}
                  </div>
                ) : (
                  <p className="repository-note">
                    {repository.status === 'empty'
                      ? 'Push a first commit, then refresh.'
                      : ['importing', 'forking'].includes(repository.status)
                        ? 'Preparing source. Refresh to check progress.'
                        : 'Refresh to read the current Git state.'}
                  </p>
                )}
                <div className="repository-actions">
                  {repository.status === 'ready' && onBrowse && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onBrowse(repository.id)}
                    >
                      <Code2 aria-hidden="true" />
                      Browse code
                    </Button>
                  )}
                  {repository.status === 'ready' && repository.head && repository.tree && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onFork({ repositoryId: repository.id })}
                    >
                      <GitFork aria-hidden="true" />
                      Fork repository
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={pendingPath === refreshPath ? 'Refreshing…' : 'Refresh Git state'}
                    disabled={busy}
                    onClick={() => onRefresh(refreshPath)}
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={pendingPath === refreshPath ? 'animate-spin' : undefined}
                    />
                  </Button>
                  {repository.remote && (
                    <details className="repository-clone">
                      <summary>Clone</summary>
                      <RepositoryRemote remote={repository.remote} />
                    </details>
                  )}
                </div>
              </li>
            );
          })}
          {!matching.length && (
            <li className="repository-no-results">No repositories match “{query.trim()}”.</li>
          )}
        </ul>
      )}
    </section>
  );
}
