import { useState } from 'react';
import { GitFork } from 'lucide-react';
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
import { ContinuationDialog } from '../features/futures/ContinuationDialog.jsx';
import { SourceRefDialog } from '../features/futures/SourceRefDialog.jsx';
import { DecisionGroupDialog } from '../features/attention/DecisionGroupDialog.jsx';
import { ObjectiveContextDialog } from '../features/context/ObjectiveContextDialog.jsx';
import { ProvenanceDialog } from '../features/context/ProvenanceDialog.jsx';
import { AccessDialog } from '../features/settings/AccessDialog.jsx';
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
import { WorkspaceNavigation, workspaceViews } from './WorkspaceNavigation.jsx';
import { RepositoryBrowser } from '../features/repositories/RepositoryBrowser.jsx';

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
  const [decisionGroup, setDecisionGroup] = useState(null);
  const [contextObjective, setContextObjective] = useState(null);
  const [provenanceSubject, setProvenanceSubject] = useState(null);
  const [sourceFuture, setSourceFuture] = useState(null);
  const [continuationId, setContinuationId] = useState(null);
  const [showAccess, setShowAccess] = useState(false);
  const [sourceSelection, setSourceSelection] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('repo')
      ? { repo_id: params.get('repo'), commit: params.get('commit'), path: params.get('path') }
      : null;
  });

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

  const currentView = workspaceViews.find((view) => view.key === activeTab);

  return (
    <div className="app dark">
      <a className="skip-link" href="#workspace-content">
        Skip to content
      </a>
      <div className="shell">
        <WorkspaceHeader
          workspace={workspace}
          onNewRepository={() => setNativeDialog({ type: 'repository' })}
        />
        <div className="workspace-layout">
          <WorkspaceNavigation
            activeView={activeTab}
            onNavigate={setActiveTab}
            onCapabilities={() => setShowCapabilities(true)}
            onAccess={() => setShowAccess(true)}
          />
          <main id="workspace-content" tabIndex={-1}>
            <div className="page-heading">
              <h1>{currentView.label}</h1>
              <p>{currentView.description}</p>
            </div>
            {activeTab === 'attention' && (
              <AttentionView
                workspace={workspace}
                onNewRepository={() => setNativeDialog({ type: 'repository' })}
                onSystems={() => setActiveTab('systems')}
                onFutures={() => setActiveTab('futures')}
                onCandidate={setCandidateId}
                onSettlement={setSettlementId}
                onContinue={setContinuationId}
                onOpenDecisionGroup={setDecisionGroup}
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
                onBrowseRepository={(id) => setSourceSelection({ repo_id: id })}
                onContext={setContextObjective}
                reload={reload}
                message={notify}
              />
            )}
            {activeTab === 'futures' && (
              <FuturesView
                nativeState={workspace.nativeState}
                onNewFuture={openNewFuture}
                onCompose={() => setNativeDialog({ type: 'candidate' })}
                onSourceRefs={(future) => setSourceFuture(future.id)}
                onInspectProvenance={setProvenanceSubject}
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
            <footer className="workspace-footer">
              <span>
                {workspace.workspace.mode === 'local' ? 'Local Git' : 'Cloudflare Artifacts'}
              </span>
              <span>Git remains authoritative</span>
            </footer>
          </main>
        </div>
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
      {sourceSelection &&
        workspace.nativeState.repositories.some(
          (repository) => repository.id === sourceSelection.repo_id,
        ) && (
          <RepositoryBrowser
            repository={workspace.nativeState.repositories.find(
              (repository) => repository.id === sourceSelection.repo_id,
            )}
            initialCommit={sourceSelection.commit}
            initialPath={sourceSelection.path}
            onClose={() => setSourceSelection(null)}
            onFork={() => {
              setSourceSelection(null);
              openNewFuture({ repositoryId: sourceSelection.repo_id });
            }}
          />
        )}
      {settlementId &&
        workspace.nativeState.promotions.some((operation) => operation.id === settlementId) && (
          <SettlementDialog
            operation={workspace.nativeState.promotions.find(
              (operation) => operation.id === settlementId,
            )}
            repository={workspace.repositories.find(
              (repo) =>
                repo.id ===
                workspace.nativeState.promotions.find((operation) => operation.id === settlementId)
                  .repo,
            )}
            repositories={workspace.repositories}
            onClose={() => setSettlementId(null)}
            reload={reload}
            message={notify}
          />
        )}
      {candidateId && (
        <CandidateDialog
          id={candidateId}
          onInspectProvenance={setProvenanceSubject}
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
          initialObjective={nativeDialog.objective}
          contextSnapshotId={nativeDialog.contextSnapshotId}
          onClose={() => setNativeDialog(null)}
          onCreated={() => nativeCreated('futures')}
          reload={reload}
          message={notify}
        />
      )}
      {decisionGroup && (
        <DecisionGroupDialog
          group={decisionGroup}
          onClose={() => setDecisionGroup(null)}
          reload={reload}
          message={notify}
        />
      )}
      {contextObjective && (
        <ObjectiveContextDialog
          objective={contextObjective}
          repositories={workspace.nativeState.repositories}
          onClose={() => setContextObjective(null)}
          reload={reload}
          message={notify}
          onSaved={({ objective, snapshot }) => {
            setContextObjective(null);
            openNewFuture({
              systemId: objective.system_id,
              objective,
              contextSnapshotId: snapshot.id,
            });
          }}
        />
      )}
      {sourceFuture &&
        workspace.nativeState.futures.some((future) => future.id === sourceFuture) && (
          <SourceRefDialog
            future={workspace.nativeState.futures.find((future) => future.id === sourceFuture)}
            repositories={workspace.nativeState.repositories}
            onClose={() => setSourceFuture(null)}
            reload={reload}
            message={notify}
          />
        )}
      {continuationId &&
        workspace.nativeState.promotions.some((entry) => entry.id === continuationId) && (
          <ContinuationDialog
            operation={workspace.nativeState.promotions.find(
              (entry) => entry.id === continuationId,
            )}
            candidates={workspace.nativeState.candidates}
            onClose={() => setContinuationId(null)}
            reload={reload}
            message={notify}
          />
        )}
      {provenanceSubject && (
        <ProvenanceDialog subject={provenanceSubject} onClose={() => setProvenanceSubject(null)} />
      )}
      {showAccess && (
        <AccessDialog onClose={() => setShowAccess(false)} reload={reload} message={notify} />
      )}
      {showCapabilities && <CapabilitiesDialog onClose={() => setShowCapabilities(false)} />}
      <Notification notification={notification} onDismiss={dismissNotification} />
    </div>
  );
}
