import { useState } from 'react';
import { CircleHelp, GitFork, Layers3 } from 'lucide-react';
import { Button } from '../ui/Button.jsx';
import { useNotifications } from '../hooks/useNotifications.js';
import { useWorkspace } from '../hooks/useWorkspace.js';
import { CapabilitiesDialog } from '../features/capabilities/CapabilitiesDialog.jsx';
import { DecisionDialog } from '../features/decisions/DecisionDialog.jsx';
import { AttentionView } from '../features/attention/AttentionView.jsx';
import { SystemsView } from '../features/systems/SystemsView.jsx';
import { FuturesView } from '../features/futures/FuturesView.jsx';
import { NewRepository } from '../features/systems/NewRepository.jsx';
import { NewSystem } from '../features/systems/NewSystem.jsx';
import { NewObjective } from '../features/systems/NewObjective.jsx';
import { NewCandidate } from '../features/futures/NewCandidate.jsx';
import { SettlementDialog } from '../features/futures/SettlementDialog.jsx';
import { CandidateDialog } from '../features/futures/CandidateDialog.jsx';
import { NewFuture } from '../features/futures/NewFuture.jsx';
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
  ['attention', 'Attention', CircleHelp],
  ['futures', 'Futures', GitFork],
  ['systems', 'Systems', Layers3],
];
const secondaryViews = [
  ['work', 'Git workflows'],
  ['evidence', 'Evidence'],
  ['activity', 'History'],
];

function pageTitle(activeTab) {
  if (activeTab === 'attention') return 'What needs your attention?';
  return [...tabs, ...secondaryViews].find(([key]) => key === activeTab)[1];
}

function pageDescription(activeTab) {
  if (activeTab === 'attention') return 'Questions, choices and operations requiring judgment.';
  if (activeTab === 'futures') return 'Isolated repositories derived from exact Git baselines.';
  if (activeTab === 'systems') return 'Repositories and optional system groupings.';
  if (activeTab === 'work') return 'Compatibility workflows for merge requests and branch changes.';
  if (activeTab === 'evidence') return 'Checks tied to exact code and configuration.';
  return 'Recorded decisions and Git updates.';
}

export function App() {
  const { notification, notify, dismissNotification } = useNotifications();
  const { workspace, requiresAuthentication, authenticate, reload } = useWorkspace(notify);
  const [activeTab, setActiveTab] = useState('attention');
  const [selectedDecisionId, setSelectedDecisionId] = useState(null);
  const [selectedProposalId, setSelectedProposalId] = useState(null);
  const [selectedMergeRequestId, setSelectedMergeRequestId] = useState(null);
  const [showNewMergeRequest, setShowNewMergeRequest] = useState(false);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [settlementId, setSettlementId] = useState(null);
  const [candidateId, setCandidateId] = useState(null);
  const [nativeDialog, setNativeDialog] = useState(null);

  function openDecision(decisionId) {
    setSelectedMergeRequestId(null);
    setSelectedProposalId(null);
    setSelectedDecisionId(decisionId);
    setActiveTab('attention');
  }

  function openNewFuture(selection = {}) {
    setNativeDialog({ type: 'future', ...selection });
  }

  function nativeCreated(view) {
    setNativeDialog(null);
    setActiveTab(view);
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
    <div className="app dark">
      <div className="shell">
        <WorkspaceHeader
          workspace={workspace}
          onNewRepository={() => setNativeDialog({ type: 'repository' })}
        />
        <main>
          <div className="page-heading">
            <h1>{pageTitle(activeTab)}</h1>
            <p>{pageDescription(activeTab)}</p>
          </div>
          <nav className="content-tabs" aria-label="Workspace views">
            {tabs.map(([key, label, Icon]) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                className={activeTab === key ? 'selected' : ''}
                aria-current={activeTab === key ? 'page' : undefined}
                onClick={() => setActiveTab(key)}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </Button>
            ))}
          </nav>
          {activeTab === 'attention' && (
            <AttentionView
              workspace={workspace}
              onNewRepository={() => setNativeDialog({ type: 'repository' })}
              onSystems={() => setActiveTab('systems')}
              onFutures={() => setActiveTab('futures')}
              onCandidate={setCandidateId}
              onSettlement={setSettlementId}
              onDecision={setSelectedDecisionId}
              onProposal={setSelectedProposalId}
              reload={reload}
              message={notify}
            />
          )}
          {activeTab === 'systems' && (
            <SystemsView
              nativeState={workspace.nativeState}
              onNewRepository={() => setNativeDialog({ type: 'repository' })}
              onNewSystem={() => setNativeDialog({ type: 'system' })}
              onNewObjective={(systemId) => setNativeDialog({ type: 'objective', systemId })}
              onNewFuture={openNewFuture}
              reload={reload}
              message={notify}
            />
          )}
          {activeTab === 'futures' && (
            <FuturesView
              nativeState={workspace.nativeState}
              onNewFuture={openNewFuture}
              onCompose={() => setNativeDialog({ type: 'candidate' })}
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
            <span>
              Git remains authoritative ·{' '}
              {workspace.workspace.mode === 'local' ? 'Local Git' : 'Cloudflare Artifacts'}
            </span>
            <nav className="footer-actions" aria-label="Supporting views">
              {secondaryViews.map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-current={activeTab === key ? 'page' : undefined}
                  onClick={() => setActiveTab(key)}
                >
                  {label}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowCapabilities(true)}
              >
                Capabilities
              </Button>
            </nav>
          </footer>
        </main>
      </div>
      {nativeDialog?.type === 'candidate' && (
        <NewCandidate
          nativeState={workspace.nativeState}
          onClose={() => setNativeDialog(null)}
          reload={reload}
          message={notify}
          onCreated={(id) => {
            setNativeDialog(null);
            setCandidateId(id);
            setActiveTab('attention');
          }}
        />
      )}
      {settlementId && workspace.nativeState.promotions.some((operation) => operation.id === settlementId) && (
        <SettlementDialog
          operation={workspace.nativeState.promotions.find((operation) => operation.id === settlementId)}
          repository={workspace.repositories.find((repo) =>
            repo.id === workspace.nativeState.promotions.find((operation) => operation.id === settlementId).repo
          )}
          onClose={() => setSettlementId(null)} reload={reload} message={notify}
        />
      )}
      {candidateId && (
        <CandidateDialog
          id={candidateId}
          onClose={() => setCandidateId(null)}
          reload={reload}
          message={notify}
        />
      )}
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
      {nativeDialog?.type === 'repository' && (
        <NewRepository
          onClose={() => setNativeDialog(null)}
          onCreated={() => nativeCreated('systems')}
          reload={reload}
          message={notify}
        />
      )}
      {nativeDialog?.type === 'system' && (
        <NewSystem
          nativeState={workspace.nativeState}
          onClose={() => setNativeDialog(null)}
          onCreated={() => nativeCreated('systems')}
          reload={reload}
          message={notify}
        />
      )}
      {nativeDialog?.type === 'objective' && (
        <NewObjective
          nativeState={workspace.nativeState}
          initialSystemId={nativeDialog.systemId}
          onClose={() => setNativeDialog(null)}
          onCreated={() => nativeCreated('systems')}
          reload={reload}
          message={notify}
        />
      )}
      {nativeDialog?.type === 'future' && (
        <NewFuture
          nativeState={workspace.nativeState}
          initialRepositoryId={nativeDialog.repositoryId}
          initialSystemId={nativeDialog.systemId}
          onClose={() => setNativeDialog(null)}
          onCreated={() => nativeCreated('futures')}
          reload={reload}
          message={notify}
        />
      )}
      {showCapabilities && <CapabilitiesDialog onClose={() => setShowCapabilities(false)} />}
      <Notification notification={notification} onDismiss={dismissNotification} />
    </div>
  );
}
