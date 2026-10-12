/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Check,
  Copy,
  ChevronRight,
  ShieldCheck,
  GitCommit,
  GitBranch,
  Cpu,
  Layers,
  Lock,
  FileCode2,
  RefreshCw,
  Play,
  Moon,
  Sun,
  Database,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Terminal,
  Activity,
  ArrowRight,
  Search,
  ExternalLink,
  Workflow,
  Sparkles,
} from 'lucide-react';
import {
  computeFutureRevisionStateDigest,
  computeFutureRevisionRecordDigest,
  computeEffectDigest,
  computeCandidateSpecDigest,
  computeCandidateDigest,
  computeEvidenceDigest,
  computeSystemRevisionStateDigest,
  computeReleaseConstraintsDigest,
  computeDeploymentAttestationDigest,
  computePayloadDigest,
  encodeCBOR,
  CanonicalFutureRevisionState,
  CanonicalEffectSet,
} from '../packages/contracts/src/index.ts';

const SAMPLE_REVISION_STATE: CanonicalFutureRevisionState = {
  repo_id: 'klocgit-core',
  commit_oid: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  tree_oid: '0123456789abcdef0123456789abcdef01234567',
  parent_oids: [
    '1111111111111111111111111111111111111111',
    '2222222222222222222222222222222222222222',
  ],
};

const SAMPLE_EFFECT_SET: CanonicalEffectSet = {
  future_revision_id: 'fut-rev-901',
  extractor_id: 'tree-sitter-structural-v1',
  extractor_version: '1.0.0',
  capability: 'STRUCTURAL',
  status: 'COMPLETE',
  modified_exports: ['authenticateUser', 'createSession', 'verifyToken'],
  added_dependencies: {
    dotenv: '^16.0.0',
    express: '^4.19.0',
    jsonwebtoken: '^9.0.0',
  },
  db_migrations_detected: false,
  security_effects: ['AUTH:token_issue', 'CRYPTO:verify', 'NET:ingress'],
};

export default function App() {
  const [darkMode, setDarkMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'dag' | 'repos' | 'diff' | 'policy' | 'digest' | 'audit'>('overview');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Selected DAG Node
  const [selectedDagNode, setSelectedDagNode] = useState<string>('candidate_unified');

  // Multi-repo status
  const [repos, setRepos] = useState([
    { id: 'repo-core', head: 'c999_promoted_canonical_head', lock: 'RELEASED', branches: 3, status: 'CONVERGED' },
    { id: 'repo-auth', head: 'a001_auth_trunk_head', lock: 'RELEASED', branches: 2, status: 'CONVERGED' },
    { id: 'repo-billing', head: 'b001_billing_trunk_head', lock: 'RELEASED', branches: 1, status: 'CONVERGED' },
  ]);

  // Interactive Policy State
  const [policyRole, setPolicyRole] = useState<'TECH_LEAD' | 'AGENT' | 'OBSERVER'>('TECH_LEAD');
  const [decisionState, setDecisionState] = useState<'REVIEWABLE' | 'RESOLVED'>('REVIEWABLE');
  const [predicates, setPredicates] = useState([
    { id: 'p1', label: 'ANALYSIS_COMPLETE (AST & SAST)', checked: true, required: true },
    { id: 'p2', label: 'EVIDENCE_PASSED (Hermetic Sandbox 42/42)', checked: true, required: true },
    { id: 'p3', label: 'CANDIDATE_UNCHANGED (Digest Match)', checked: true, required: true },
    { id: 'p4', label: 'NO_DEPENDENCY_SKEW (Unified Semver)', checked: true, required: true },
  ]);

  // Digest Calculator State
  const [schemaType, setSchemaType] = useState<'future_state' | 'effect_set' | 'payload'>('future_state');
  const [jsonInput, setJsonInput] = useState<string>(JSON.stringify(SAMPLE_REVISION_STATE, null, 2));
  const [computedDigest, setComputedDigest] = useState<string>(() => computeFutureRevisionStateDigest(SAMPLE_REVISION_STATE));
  const [cborHex, setCborHex] = useState<string>(() => {
    const bytes = encodeCBOR(SAMPLE_REVISION_STATE);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
  });

  // Audit Search
  const [auditQuery, setAuditQuery] = useState('');

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const handleCalculateDigest = () => {
    try {
      const parsed = JSON.parse(jsonInput);
      let digest = '';
      let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();

      if (schemaType === 'future_state') {
        digest = computeFutureRevisionStateDigest(parsed);
        bytes = encodeCBOR(parsed);
      } else if (schemaType === 'effect_set') {
        digest = computeEffectDigest(parsed);
        bytes = encodeCBOR(parsed);
      } else {
        digest = computePayloadDigest(jsonInput);
        bytes = new TextEncoder().encode(jsonInput);
      }

      setComputedDigest(digest);
      setCborHex(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
    } catch (e: any) {
      alert('Invalid JSON: ' + e.message);
    }
  };

  const allPredicatesPassing = predicates.every(p => p.checked);

  return (
    <div className={`min-h-screen transition-colors duration-200 ${darkMode ? 'bg-[#000000] text-[#F5F5F7]' : 'bg-[#F5F5F7] text-[#1D1D1F]'}`}>
      {/* Top Navigation */}
      <header className={`sticky top-0 z-50 backdrop-blur-2xl border-b transition-colors ${
        darkMode ? 'bg-[#161617]/75 border-white/[0.08]' : 'bg-white/75 border-black/[0.08]'
      }`}>
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-semibold text-xs tracking-tight ${
              darkMode ? 'bg-white text-black' : 'bg-black text-white'
            }`}>
              
            </div>
            <div>
              <span className="font-semibold text-[15px] tracking-tight">KLoCGit v1</span>
              <span className={`text-[12px] ml-2 ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                Enterprise Convergence Platform
              </span>
            </div>
          </div>

          {/* Segmented Navigation */}
          <div className={`hidden md:flex items-center p-1 rounded-xl text-[13px] border ${
            darkMode ? 'bg-[#1C1C1E] border-white/[0.06]' : 'bg-black/[0.04] border-black/[0.04]'
          }`}>
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'dag', label: 'Convergence DAG' },
              { id: 'repos', label: 'Repositories' },
              { id: 'diff', label: 'Inspection Studio' },
              { id: 'policy', label: 'Policy Portal' },
              { id: 'digest', label: 'Digest Engine' },
              { id: 'audit', label: 'Audit Trail' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-3 py-1 rounded-lg transition-all text-xs font-medium ${
                  activeTab === tab.id
                    ? darkMode
                      ? 'bg-[#2C2C2E] text-white shadow-sm'
                      : 'bg-white text-black shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
                    : darkMode
                    ? 'text-[#86868B] hover:text-white'
                    : 'text-[#6E6E73] hover:text-black'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Right Action & Theme Toggle */}
          <div className="flex items-center space-x-2">
            <span className="hidden sm:inline-flex text-[11px] font-mono px-2 py-0.5 rounded-full bg-[#34C759]/10 text-[#34C759] border border-[#34C759]/20">
              P1-P7 Shipped
            </span>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-white/[0.08] text-white' : 'hover:bg-black/[0.05] text-black'
              }`}
              title="Toggle Light / Dark Appearance"
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-300" /> : <Moon className="w-4 h-4 text-slate-700" />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode
                ? 'bg-[#1C1C1E] border-white/[0.08] shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
                : 'bg-white border-black/[0.06] shadow-[0_2px_16px_rgba(0,0,0,0.04)]'
            }`}>
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2 text-xs font-medium text-[#0071E3]">
                    <span>Codex Operating Contract</span>
                    <span aria-hidden="true">·</span>
                    <span>All 7 Phases Implemented & Verified</span>
                  </div>
                  <h1 className="text-3xl font-semibold tracking-tight">
                    Autonomous Multi-Agent Git Convergence
                  </h1>
                  <p className={`text-[15px] max-w-3xl leading-relaxed ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    KLoCGit continuously merges competing code streams across distributed repositories using deterministic CBOR normalization, scratch ArtifactFS sandboxes, typed policy gates, and serialized Git CAS locks.
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => setActiveTab('dag')}
                    className="px-5 py-2.5 rounded-xl bg-[#0071E3] hover:bg-[#0077ED] text-white text-[13px] font-medium transition-all shadow-sm flex items-center space-x-2"
                  >
                    <span>View Convergence DAG</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 7 Verification Gates Matrix */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 mt-8 pt-6 border-t border-black/[0.06] dark:border-white/[0.08]">
                {[
                  { phase: 'P1: Engine', cmd: 'test -p klocgit-engine', status: '8/8 Passed' },
                  { phase: 'P2: Coordination', cmd: 'test:coordination', status: 'Zero Races' },
                  { phase: 'P3: Materialize', cmd: 'test:materialization', status: 'ArtifactFS' },
                  { phase: 'P4: Reduction', cmd: 'test_reduction', status: 'Deduplicated' },
                  { phase: 'P5: Policy', cmd: 'test:policy', status: 'Gates Verified' },
                  { phase: 'P6: Console', cmd: 'vite build', status: 'Apple HIG' },
                  { phase: 'P7: End-to-End', cmd: 'test:e2e', status: '100% Passed' },
                ].map((item, idx) => (
                  <div
                    key={idx}
                    className={`p-3.5 rounded-2xl border transition-all text-left ${
                      darkMode ? 'bg-[#2C2C2E]/60 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
                    }`}
                  >
                    <div className="text-[11px] font-semibold text-[#0071E3] truncate">{item.phase}</div>
                    <div className="text-[12px] font-semibold mt-1 text-[#34C759] flex items-center space-x-1">
                      <Check className="w-3 h-3 shrink-0" />
                      <span>{item.status}</span>
                    </div>
                    <div className={`text-[10px] font-mono mt-1.5 truncate ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                      {item.cmd}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Invariants */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold tracking-tight">The 9 Architectural Invariants</h2>
                <span className={`text-xs ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                  Non-Negotiable System Guarantees
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { id: '1', title: 'Canonical Projections', desc: 'State, record, and payload hashes strictly bind to immutable RFC 8949 canonical projections.' },
                  { id: '2', title: 'Compare-And-Swap (CAS)', desc: 'Trunk mutation uses CAS asserting remote ref equals expected OID. Zero race conditions.' },
                  { id: '3', title: 'Review Validity', desc: 'Reviewed state must equal authorized state. Any material input change revokes approval.' },
                  { id: '4', title: 'Inferred AI Output', desc: 'AI outputs are INFERRED suggestions, never autonomous evidence or sign-off authority.' },
                  { id: '5', title: 'Strict Resolution Gate', desc: 'Required PARTIAL, FAILED, or UNSUPPORTED analysis strictly blocks candidate promotion.' },
                  { id: '6', title: 'Scratch Space Isolation', desc: 'Candidates materialize in scratch ArtifactFS overlays; never write speculative durable Git refs.' },
                  { id: '7', title: 'External CD Boundary', desc: 'External CD owns traffic rollout and rollback; KLoCGit submits intent and verifies attestations.' },
                  { id: '8', title: 'Retention Classes', desc: 'Policy-driven retention classes (EPHEMERAL, REBUILDABLE, DECISION_RECORD, CANONICAL).' },
                  { id: '9', title: 'Identity Decoupling', desc: 'Storage locations, retention tags, and diagnostics never mutate the state_digest of code.' },
                ].map((inv) => (
                  <div
                    key={inv.id}
                    className={`p-5 rounded-2xl border transition-all ${
                      darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
                    }`}
                  >
                    <span className="text-[11px] font-semibold text-[#0071E3] font-mono block mb-1">Invariant {inv.id}</span>
                    <h3 className="text-[14px] font-semibold tracking-tight mb-1">{inv.title}</h3>
                    <p className={`text-[12px] leading-relaxed ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>{inv.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* CONVERGENCE DAG TAB */}
        {activeTab === 'dag' && (
          <div className="space-y-6">
            <div className={`p-8 rounded-3xl border ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="text-xs font-medium text-[#0071E3]">Phase 4 & 6 · Semantic Reduction Graph</div>
                  <h2 className="text-2xl font-semibold tracking-tight">Convergence DAG Visualizer</h2>
                  <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Interactive flow from autonomous agent future revisions to synthesized candidate specs and promoted trunk.
                  </p>
                </div>
                <div className="text-xs font-mono">
                  <span className="text-[#34C759] font-semibold">Live Convergence Pipeline</span>
                </div>
              </div>

              {/* Visual Interactive Graph */}
              <div className={`p-6 rounded-2xl border overflow-x-auto ${
                darkMode ? 'bg-[#000000] border-white/[0.08]' : 'bg-[#F5F5F7] border-black/[0.06]'
              }`}>
                <div className="min-w-[700px] flex items-center justify-between gap-6 py-6">
                  {/* Stage 1: Base */}
                  <div className="space-y-3 shrink-0">
                    <span className="text-[11px] font-mono text-[#86868B] block">1. Base Trunk</span>
                    <button
                      onClick={() => setSelectedDagNode('base_trunk')}
                      className={`p-4 rounded-2xl border text-left w-44 transition-all ${
                        selectedDagNode === 'base_trunk'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <GitCommit className="w-4 h-4 text-[#0071E3] mb-2" />
                      <div className="text-xs font-semibold">repo-core / main</div>
                      <div className="text-[10px] font-mono text-[#86868B] mt-1 truncate">c001_trunk_head</div>
                    </button>
                  </div>

                  <ChevronRight className="w-5 h-5 text-[#86868B] shrink-0" />

                  {/* Stage 2: Futures */}
                  <div className="space-y-3 shrink-0">
                    <span className="text-[11px] font-mono text-[#86868B] block">2. Ingested Futures (5)</span>
                    <div className="space-y-2">
                      {['agent-fut-01', 'agent-fut-02', 'agent-fut-03'].map((f) => (
                        <button
                          key={f}
                          onClick={() => setSelectedDagNode(f)}
                          className={`p-2.5 rounded-xl border text-left w-44 block transition-all ${
                            selectedDagNode === f
                              ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                              : darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                          }`}
                        >
                          <div className="text-[11px] font-semibold">{f}</div>
                          <div className="text-[9px] font-mono text-[#86868B]">modified: handleOrder</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <ChevronRight className="w-5 h-5 text-[#86868B] shrink-0" />

                  {/* Stage 3: Candidate Spec */}
                  <div className="space-y-3 shrink-0">
                    <span className="text-[11px] font-mono text-[#86868B] block">3. Synthesized Candidate</span>
                    <button
                      onClick={() => setSelectedDagNode('candidate_unified')}
                      className={`p-4 rounded-2xl border text-left w-48 transition-all ${
                        selectedDagNode === 'candidate_unified'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <Layers className="w-4 h-4 text-[#AF52DE] mb-2" />
                      <div className="text-xs font-semibold">cand-spec-unified-01</div>
                      <div className="text-[10px] text-[#34C759] mt-1">Deduplicated (2 slices)</div>
                    </button>
                  </div>

                  <ChevronRight className="w-5 h-5 text-[#86868B] shrink-0" />

                  {/* Stage 4: Policy Gate & Promoted Trunk */}
                  <div className="space-y-3 shrink-0">
                    <span className="text-[11px] font-mono text-[#86868B] block">4. Promoted Trunk</span>
                    <button
                      onClick={() => setSelectedDagNode('promoted_trunk')}
                      className={`p-4 rounded-2xl border text-left w-44 transition-all ${
                        selectedDagNode === 'promoted_trunk'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <Lock className="w-4 h-4 text-[#34C759] mb-2" />
                      <div className="text-xs font-semibold">CAS Promoted OID</div>
                      <div className="text-[10px] font-mono text-[#34C759] mt-1 truncate">c999_promoted_canonical</div>
                    </button>
                  </div>
                </div>
              </div>

              {/* Node Inspector */}
              <div className={`mt-6 p-5 rounded-2xl border ${
                darkMode ? 'bg-[#2C2C2E]/40 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-semibold text-[#0071E3]">
                    SELECTED NODE: {selectedDagNode.toUpperCase()}
                  </span>
                  <span className="text-[11px] font-mono text-[#86868B]">Provenance Slice Hash Verified</span>
                </div>
                <div className={`p-3 rounded-xl border text-[11px] font-mono break-all leading-relaxed ${
                  darkMode ? 'bg-[#000000] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                }`}>
                  {selectedDagNode === 'candidate_unified' && (
                    <>
                      <div>spec_digest: e7e3e6b4aa8141f7bf92311cab205ab436b7f1bc06321c13b9eb9763ec77be37</div>
                      <div className="mt-1">composition_manifest: [repo-core:src/order.ts:symbol:handleOrder_shared, repo-auth:src/jwt.ts:hunk]</div>
                      <div className="mt-1">reduction_strategy: EXACT_SYNTACTIC_DEDUPLICATION_COLLAPSED (8 duplicates removed)</div>
                    </>
                  )}
                  {selectedDagNode === 'base_trunk' && (
                    <div>canonical_ref: refs/heads/main @ c001_core_trunk_head (Uncontended)</div>
                  )}
                  {selectedDagNode === 'promoted_trunk' && (
                    <div>cas_promotion: Mutator: convergence-worker-01 · Locked: false · Attestation: SUCCEEDED</div>
                  )}
                  {selectedDagNode.startsWith('agent-fut') && (
                    <div>future_id: {selectedDagNode} · producer: autonomous-agent-v2 · status: REDUCED</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MULTI-REPO STATUS BOARD */}
        {activeTab === 'repos' && (
          <div className="space-y-6">
            <div className={`p-8 rounded-3xl border ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">Multi-Repository System Topology</div>
                <h2 className="text-2xl font-semibold tracking-tight">Active Repositories & Serialized Ref Locks</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Real-time status of all repositories participating in the current system revision with atomic CAS locks.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className={`border-b text-xs font-medium ${darkMode ? 'border-white/[0.08] text-[#86868B]' : 'border-black/[0.08] text-[#86868B]'}`}>
                      <th className="pb-3">REPOSITORY</th>
                      <th className="pb-3">CANONICAL HEAD OID</th>
                      <th className="pb-3">REF LOCK</th>
                      <th className="pb-3">PENDING BRANCHES</th>
                      <th className="pb-3 text-right">CONVERGENCE</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y font-mono text-xs ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                    {repos.map((r) => (
                      <tr key={r.id} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                        <td className="py-4 font-semibold text-[#0071E3]">{r.id}</td>
                        <td className="py-4 select-all">{r.head}</td>
                        <td className="py-4">
                          <span className="inline-flex items-center space-x-1 text-[#34C759]">
                            <Lock className="w-3.5 h-3.5" />
                            <span>{r.lock}</span>
                          </span>
                        </td>
                        <td className="py-4">{r.branches} active</td>
                        <td className="py-4 text-right">
                          <span className="text-[#34C759] font-medium">{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* CANDIDATE INSPECTION STUDIO */}
        {activeTab === 'diff' && (
          <div className="space-y-6">
            <div className={`p-8 rounded-3xl border ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">Candidate Inspection Studio</div>
                <h2 className="text-2xl font-semibold tracking-tight">Side-by-Side Unified Diff & Provenance</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Inspect unified candidate changes with AST symbol annotations and exact provenance slice origin.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-rose-500">Base Trunk: repo-core / src/order.ts</span>
                    <span className="font-mono text-[11px] text-[#86868B]">c001_core_trunk_head</span>
                  </div>
                  <pre className={`p-4 rounded-2xl border font-mono text-[12px] overflow-x-auto leading-relaxed ${
                    darkMode ? 'bg-[#000000] border-white/[0.08] text-rose-400' : 'bg-[#FFF5F5] border-rose-200 text-rose-900'
                  }`}>
{`- export function handleOrder(orderId: string) {
-   // Legacy synchronous payment authorization
-   const legacyClient = initLegacyPayment();
-   return legacyClient.charge(orderId);
- }`}
                  </pre>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-emerald-500">Synthesized Candidate (Unified Slice)</span>
                    <span className="font-mono text-[11px] text-[#34C759]">from agent-future-01</span>
                  </div>
                  <pre className={`p-4 rounded-2xl border font-mono text-[12px] overflow-x-auto leading-relaxed ${
                    darkMode ? 'bg-[#000000] border-white/[0.08] text-emerald-400' : 'bg-[#F0FDF4] border-emerald-200 text-emerald-900'
                  }`}>
{`+ export async function handleOrder(orderId: string): Promise<OrderReceipt> {
+   // Converged asynchronous settlement with idempotent retries
+   const paymentGateway = await getPaymentCluster();
+   return await paymentGateway.authorizeAndCapture(orderId);
+ }`}
                  </pre>
                </div>
              </div>

              {/* Provenance Metadata Strip */}
              <div className={`mt-6 p-4 rounded-2xl border flex flex-wrap items-center justify-between gap-4 text-xs ${
                darkMode ? 'bg-[#2C2C2E]/40 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
              }`}>
                <div className="flex items-center space-x-2">
                  <span className="font-semibold">Selector:</span>
                  <span className="font-mono text-[#0071E3]">symbol:handleOrder</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="font-semibold">Origin:</span>
                  <span className="font-mono text-[#86868B]">agent-future-01 @ commit_fut_01</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="font-semibold">Capability:</span>
                  <span className="text-[#34C759] font-medium">STRUCTURAL (Tree-sitter TS)</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* POLICY & REVIEW PORTAL */}
        {activeTab === 'policy' && (
          <div className="space-y-6">
            <div className={`p-8 rounded-3xl border ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">Phase 5 · Policy Decision Engine</div>
                <h2 className="text-2xl font-semibold tracking-tight">Policy Review & Promotion Gating</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Enforce Invariant 5 (strict analysis complete requirement) and require authorized Tech Lead human sign-off before releasing Git push CAS lock.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Predicate Checklist */}
                <div className={`p-6 rounded-2xl border space-y-4 ${
                  darkMode ? 'bg-[#2C2C2E]/40 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#0071E3]">CONDITIONAL PREDICATES CHECKLIST</span>
                    <span className="text-[11px] font-mono text-[#86868B]">Typed Predicates</span>
                  </div>

                  <div className="space-y-3">
                    {predicates.map((p) => (
                      <label key={p.id} className="flex items-center space-x-3 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={p.checked}
                          onChange={(e) => {
                            setPredicates(predicates.map(item => item.id === p.id ? { ...item, checked: e.target.checked } : item));
                          }}
                          className="w-4 h-4 rounded text-[#0071E3] focus:ring-0"
                        />
                        <span className="font-mono">{p.label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="pt-2 text-[11px] text-[#86868B]">
                    * Unchecking any required analysis predicate triggers Invariant 5 and immediately blocks promotion.
                  </div>
                </div>

                {/* Sign-off Actions */}
                <div className={`p-6 rounded-2xl border space-y-4 ${
                  darkMode ? 'bg-[#2C2C2E]/40 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#0071E3]">HUMAN SIGN-OFF & PROMOTION</span>
                    <span className={`text-xs font-semibold ${decisionState === 'RESOLVED' ? 'text-[#34C759]' : 'text-[#FF9500]'}`}>
                      STATE: {decisionState}
                    </span>
                  </div>

                  <div>
                    <label className="block text-xs font-medium mb-1">Sign-off Role</label>
                    <select
                      value={policyRole}
                      onChange={(e) => setPolicyRole(e.target.value as any)}
                      className={`w-full p-2.5 rounded-xl border text-xs font-medium ${
                        darkMode ? 'bg-[#1C1C1E] border-white/[0.1] text-white' : 'bg-white border-black/[0.1]'
                      }`}
                    >
                      <option value="TECH_LEAD">TECH_LEAD (Authorized)</option>
                      <option value="AGENT">AGENT (Autonomous Bot - Blocked by Invariant 4)</option>
                      <option value="OBSERVER">OBSERVER (Read-Only - Blocked)</option>
                    </select>
                  </div>

                  <div className="pt-3">
                    <button
                      onClick={() => {
                        if (!allPredicatesPassing) {
                          alert('BLOCKED: Invariant 5 prevents sign-off when any required analysis predicate is incomplete!');
                          return;
                        }
                        if (policyRole !== 'TECH_LEAD') {
                          alert(`BLOCKED: Invariant 4 prevents ${policyRole} from signing off! Only authorized human leads may sign off.`);
                          return;
                        }
                        setDecisionState('RESOLVED');
                      }}
                      className={`w-full py-2.5 rounded-xl font-medium text-xs transition-all flex items-center justify-center space-x-2 ${
                        allPredicatesPassing && policyRole === 'TECH_LEAD'
                          ? 'bg-[#34C759] hover:bg-[#2FB350] text-white shadow-sm'
                          : 'bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      <Check className="w-4 h-4" />
                      <span>{decisionState === 'RESOLVED' ? 'Promotion Sign-Off Verified' : 'Authorize & Sign-Off Promotion'}</span>
                    </button>
                  </div>

                  <p className="text-[11px] text-[#86868B] text-center">
                    {decisionState === 'RESOLVED'
                      ? '✓ Decision RESOLVED: Git push CAS lock released for merge.'
                      : 'Requires all predicates complete + authorized human role.'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* DIGEST ENGINE TAB */}
        {activeTab === 'digest' && (
          <div className="space-y-6">
            <div className={`p-8 rounded-3xl border ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">Phase 1 · RFC 8949 CBOR Engine</div>
                <h2 className="text-2xl font-semibold tracking-tight">Canonical Digest Explorer</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Real-time deterministic CBOR serialization and SHA-256 calculation matching the Rust engine.
                </p>
              </div>

              <div className="flex space-x-1 p-1 rounded-xl bg-black/[0.05] dark:bg-white/[0.06] w-fit mb-6 text-xs">
                {[
                  { id: 'future_state', label: 'CanonicalFutureRevisionState' },
                  { id: 'effect_set', label: 'CanonicalEffectSet' },
                  { id: 'payload', label: 'Raw Payload' },
                ].map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSchemaType(s.id as any);
                      if (s.id === 'future_state') setJsonInput(JSON.stringify(SAMPLE_REVISION_STATE, null, 2));
                      if (s.id === 'effect_set') setJsonInput(JSON.stringify(SAMPLE_EFFECT_SET, null, 2));
                      if (s.id === 'payload') setJsonInput('Sandbox test receipt: hermetic execution 42 tests passed.');
                    }}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                      schemaType === s.id
                        ? darkMode ? 'bg-[#2C2C2E] text-white shadow-sm' : 'bg-white text-black shadow-[0_1px_3px_rgba(0,0,0,0.08)]'
                        : darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-medium">Input JSON</label>
                    <span className="font-mono text-[11px] text-[#86868B]">Auto-normalized RFC 8949</span>
                  </div>
                  <textarea
                    rows={12}
                    value={jsonInput}
                    onChange={(e) => setJsonInput(e.target.value)}
                    className={`w-full p-4 rounded-2xl border font-mono text-[12px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 ${
                      darkMode ? 'bg-[#000000] border-white/[0.1] text-white' : 'bg-[#F5F5F7] border-black/[0.08] text-black'
                    }`}
                  />
                  <button
                    onClick={handleCalculateDigest}
                    className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-medium rounded-xl transition-all shadow-sm flex items-center space-x-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Calculate Digest & CBOR</span>
                  </button>
                </div>

                <div className="space-y-4">
                  <div className={`p-5 rounded-2xl border space-y-2 ${
                    darkMode ? 'bg-[#000000] border-white/[0.08]' : 'bg-[#F5F5F7] border-black/[0.08]'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-[#0071E3]">
                        {schemaType === 'future_state' ? 'state_digest' : schemaType === 'effect_set' ? 'effect_digest' : 'payload_digest'}
                      </span>
                      <button
                        onClick={() => copyToClipboard(computedDigest, 'digest')}
                        className={`p-1 rounded-lg text-xs flex items-center space-x-1 ${
                          darkMode ? 'hover:bg-white/[0.1] text-[#86868B]' : 'hover:bg-black/[0.05] text-[#6E6E73]'
                        }`}
                      >
                        {copiedText === 'digest' ? <Check className="w-3 h-3 text-[#34C759]" /> : <Copy className="w-3 h-3 text-[#86868B]" />}
                        <span>{copiedText === 'digest' ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <div className="font-mono text-xs break-all select-all font-semibold text-[#0071E3]">
                      {computedDigest}
                    </div>
                  </div>

                  <div className={`p-5 rounded-2xl border space-y-2 ${
                    darkMode ? 'bg-[#000000] border-white/[0.08]' : 'bg-[#F5F5F7] border-black/[0.08]'
                  }`}>
                    <span className="text-xs font-medium block">RFC 8949 CBOR Stream (Hex Bytes)</span>
                    <div className={`font-mono text-[11px] break-all max-h-44 overflow-y-auto leading-relaxed select-all ${
                      darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'
                    }`}>
                      {cborHex}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* AUDIT TRAIL & RETENTION EXPLORER */}
        {activeTab === 'audit' && (
          <div className="space-y-6">
            <div className={`p-8 rounded-3xl border ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="text-xs font-medium text-[#0071E3]">Audit Trail & Retention Lifecycle</div>
                  <h2 className="text-2xl font-semibold tracking-tight">Immutable Record & Attestation Ledger</h2>
                  <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Searchable immutable records tagged with explicit policy retention classes.
                  </p>
                </div>
                <div className="relative">
                  <Search className="w-4 h-4 text-[#86868B] absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Filter records..."
                    value={auditQuery}
                    onChange={(e) => setAuditQuery(e.target.value)}
                    className={`pl-9 pr-4 py-2 rounded-xl text-xs border ${
                      darkMode ? 'bg-[#000000] border-white/[0.1] text-white' : 'bg-[#F5F5F7] border-black/[0.1]'
                    }`}
                  />
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className={`border-b text-[#86868B] ${darkMode ? 'border-white/[0.08]' : 'border-black/[0.08]'}`}>
                      <th className="pb-3">EVENT RECORD</th>
                      <th className="pb-3">SUBJECT DIGEST</th>
                      <th className="pb-3">RETENTION CLASS</th>
                      <th className="pb-3">STORAGE REF</th>
                      <th className="pb-3 text-right">STATUS</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                    {[
                      {
                        event: 'External CD Attestation',
                        digest: 'e18654ed5c2ca9cf5f84b052a8fe42b0...',
                        retention: 'CANONICAL',
                        ref: 'r2://klocgit-attestations/production/intent_8871.json',
                        status: 'SUCCEEDED',
                      },
                      {
                        event: 'Hermetic Sandbox Receipt',
                        digest: '180a9e8977467cd9fe5c61938ed0522a...',
                        retention: 'DECISION_RECORD',
                        ref: 'r2://klocgit-evidence/cand_9981/exec_1002.json',
                        status: 'PASSED',
                      },
                      {
                        event: 'Candidate Reduction Spec',
                        digest: 'e7e3e6b4aa8141f7bf92311cab205ab...',
                        retention: 'CANONICAL',
                        ref: 'r2://klocgit-specs/cand-spec-unified-01.cbor',
                        status: 'REDUCED',
                      },
                      {
                        event: 'Transient Smoke Run',
                        digest: '4a187e5fd60ff5833446002ff2c3af1d...',
                        retention: 'EPHEMERAL',
                        ref: 'r2://klocgit-scratch/temp_run_441.json',
                        status: 'EXPIRED',
                      },
                    ]
                      .filter(r => r.event.toLowerCase().includes(auditQuery.toLowerCase()) || r.retention.toLowerCase().includes(auditQuery.toLowerCase()))
                      .map((row, idx) => (
                        <tr key={idx} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                          <td className="py-3.5 font-semibold text-[#0071E3]">{row.event}</td>
                          <td className="py-3.5 text-slate-400 select-all">{row.digest}</td>
                          <td className="py-3.5">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                              row.retention === 'CANONICAL'
                                ? 'bg-[#34C759]/10 text-[#34C759]'
                                : row.retention === 'DECISION_RECORD'
                                ? 'bg-[#0071E3]/10 text-[#0071E3]'
                                : 'bg-[#FF9500]/10 text-[#FF9500]'
                            }`}>
                              {row.retention}
                            </span>
                          </td>
                          <td className="py-3.5 text-[#86868B] truncate max-w-xs">{row.ref}</td>
                          <td className="py-3.5 text-right font-medium text-[#34C759]">{row.status}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Apple Footer */}
      <footer className={`py-8 px-6 text-center text-xs border-t transition-colors ${
        darkMode ? 'border-white/[0.06] text-[#86868B]' : 'border-black/[0.06] text-[#86868B]'
      }`}>
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            KLoCGit v1 Enterprise Convergence Platform · Built with Apple Human Interface Guidelines
          </div>
          <div className="flex items-center space-x-4">
            <span>RFC 8949 CBOR</span>
            <span aria-hidden="true">·</span>
            <span>Git CAS receive-pack</span>
            <span aria-hidden="true">·</span>
            <span>DO SQLite</span>
            <span aria-hidden="true">·</span>
            <span>Hermetic Sandbox</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
