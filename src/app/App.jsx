import { useState } from 'react';
import { GitFork } from 'lucide-react';
import { apiRequest } from '../lib/api.js';
import { useNotifications } from '../hooks/useNotifications.js';
import { useWorkspace } from '../hooks/useWorkspace.js';
import { CapabilitiesDialog } from '../features/capabilities/CapabilitiesDialog.jsx';
import { DecisionDialog } from '../features/decisions/DecisionDialog.jsx';
import { DecisionList } from '../features/decisions/DecisionList.jsx';
import { WorkView } from '../features/work/WorkView.jsx';
import { MergeRequestDialog } from '../features/merge-requests/MergeRequestDialog.jsx';
import { NewMergeRequest } from '../features/merge-requests/NewMergeRequest.jsx';
import { ProposalDialog } from '../features/proposals/ProposalDialog.jsx';
import { EvidenceList } from '../features/evidence/EvidenceList.jsx';
import { ActivityList } from '../features/activity/ActivityList.jsx';
import { Notification } from './Notification.jsx';
import { OwnerConnection } from './OwnerConnection.jsx';
import { WorkspaceHeader } from './WorkspaceHeader.jsx';

const tabs = [
  ['decisions', 'Decisions'],
  ['work', 'Work'],
  ['evidence', 'Evidence'],
  ['activity', 'Activity'],
];

function pageDescription(activeTab, summary) {
  if (activeTab === 'decisions') {
    if (summary.pendingClarifications) return 'One context question before coordinated work';
    return `${summary.proposals} proposals · ${summary.decisionsRequired} ${summary.decisionsRequired === 1 ? 'decision requires' : 'decisions require'} review`;
  }
  if (activeTab === 'work') return 'Merge requests and ordinary Git changes.';
  if (activeTab === 'evidence') return 'Checks tied to exact code and configuration.';
  return 'Recorded decisions and Git updates.';
}

export function App() {
  const { notification, notify, dismissNotification } = useNotifications();
  const { workspace, setWorkspace, requiresAuthentication, authenticate, reload } =
    useWorkspace(notify);
  const [activeTab, setActiveTab] = useState('decisions');
  const [selectedDecisionId, setSelectedDecisionId] = useState(null);
  const [selectedProposalId, setSelectedProposalId] = useState(null);
  const [selectedMergeRequestId, setSelectedMergeRequestId] = useState(null);
  const [showNewMergeRequest, setShowNewMergeRequest] = useState(false);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  function openDecision(decisionId) {
    setSelectedMergeRequestId(null);
    setSelectedProposalId(null);
    setSelectedDecisionId(decisionId);
    setActiveTab('decisions');
  }

  async function runDemoAction(action) {
    setIsBusy(true);
    try {
      setWorkspace(await apiRequest(`/demo/${action}`, { method: 'POST' }));
      setSelectedDecisionId(null);
      setSelectedMergeRequestId(null);
      notify(
        action === 'reset'
          ? 'Fresh workspace created. Answer the context question before producers start.'
          : 'Decision basis changed. Open a decision to review fresh evidence.',
      );
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setIsBusy(false);
    }
  }

  if (requiresAuthentication && !workspace)
    return <OwnerConnection authenticate={authenticate} notification={notification} />;
  if (!workspace)
    return (
      <div className="loading">
        <GitFork size={32} />
        <h2>Opening your workspace</h2>
        <p>Reading Git state and immutable evidence…</p>
        {notification && <p>{notification.text}</p>}
      </div>
    );

  return (
    <div className="app minimal-app">
      <div className="shell">
        <WorkspaceHeader workspace={workspace} isBusy={isBusy} onDemoAction={runDemoAction} />
        <main>
          <div className="page-heading">
            <h1>{tabs.find(([key]) => key === activeTab)[1]}</h1>
            <p>{pageDescription(activeTab, workspace.summary)}</p>
          </div>
          <nav className="content-tabs" aria-label="Workspace views">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                className={activeTab === key ? 'selected' : ''}
                onClick={() => setActiveTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {activeTab === 'decisions' && (
            <DecisionList
              workspace={workspace}
              onDecision={setSelectedDecisionId}
              onProposal={setSelectedProposalId}
              reload={reload}
              message={notify}
            />
          )}
          {activeTab === 'work' && (
            <WorkView
              workspace={workspace}
              onMR={setSelectedMergeRequestId}
              onCreate={() => setShowNewMergeRequest(true)}
              onProposal={setSelectedProposalId}
              onDecision={openDecision}
              reload={reload}
              message={notify}
            />
          )}
          {activeTab === 'evidence' && <EvidenceList workspace={workspace} />}
          {activeTab === 'activity' && <ActivityList workspace={workspace} />}
          <footer>
            <span>{workspace.repositories.length} repositories · Git remains authoritative</span>
            <div className="footer-actions">
              <span>
                {workspace.workspace.mode === 'local-demo' ? 'Local demo' : 'Cloudflare Artifacts'}
              </span>
              <button className="button ghost small" onClick={() => setShowCapabilities(true)}>
                Capabilities
              </button>
            </div>
          </footer>
        </main>
      </div>
      {selectedDecisionId &&
        workspace.decisionComponents.some((decision) => decision.id === selectedDecisionId) && (
          <DecisionDialog
            id={selectedDecisionId}
            workspace={workspace}
            onClose={() => setSelectedDecisionId(null)}
            reload={reload}
            message={notify}
            onProposal={setSelectedProposalId}
          />
        )}
      {selectedProposalId && (
        <ProposalDialog
          id={selectedProposalId}
          workspace={workspace}
          onClose={() => setSelectedProposalId(null)}
          onDecision={openDecision}
          reload={reload}
          message={notify}
        />
      )}
      {selectedMergeRequestId && (
        <MergeRequestDialog
          id={selectedMergeRequestId}
          workspace={workspace}
          onClose={() => setSelectedMergeRequestId(null)}
          onDecision={openDecision}
          onProposal={setSelectedProposalId}
          reload={reload}
          message={notify}
        />
      )}
      {showNewMergeRequest && (
        <NewMergeRequest
          workspace={workspace}
          onClose={() => setShowNewMergeRequest(false)}
          onCreated={(requestId) => {
            setShowNewMergeRequest(false);
            setSelectedMergeRequestId(requestId);
          }}
          reload={reload}
          message={notify}
        />
      )}
      {showCapabilities && <CapabilitiesDialog onClose={() => setShowCapabilities(false)} />}
      <Notification notification={notification} onDismiss={dismissNotification} />
    </div>
  );
}
