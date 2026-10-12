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
  Sliders,
  Maximize2,
  Minus,
  X,
  Sidebar as SidebarIcon,
  HardDrive,
  FolderTree,
  FileText,
  Clock,
  KeyRound,
  ShieldAlert,
  SlidersHorizontal,
  FolderGit2,
  Menu,
  Info,
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
  const [inspectorOpen, setInspectorOpen] = useState(false); // collapsed by default on mobile, toggled on desktop
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Selected DAG Node
  const [selectedDagNode, setSelectedDagNode] = useState<string>('candidate_unified');

  // Repositories
  const [repos] = useState([
    { id: 'repo-core', head: 'c999_promoted_canonical_head', lock: 'RELEASED', branches: 3, status: 'CONVERGED', desc: 'Core orchestration & API services' },
    { id: 'repo-auth', head: 'a001_auth_trunk_head', lock: 'RELEASED', branches: 2, status: 'CONVERGED', desc: 'Identity, capability tokens & JWT verification' },
    { id: 'repo-billing', head: 'b001_billing_trunk_head', lock: 'RELEASED', branches: 1, status: 'CONVERGED', desc: 'Ledger, invoices & settlement contracts' },
  ]);

  // Policy Review State
  const [policyRole, setPolicyRole] = useState<'TECH_LEAD' | 'AGENT' | 'OBSERVER'>('TECH_LEAD');
  const [decisionState, setDecisionState] = useState<'REVIEWABLE' | 'RESOLVED'>('REVIEWABLE');
  const [predicates, setPredicates] = useState([
    { id: 'p1', label: 'ANALYSIS_COMPLETE (AST & SAST)', checked: true },
    { id: 'p2', label: 'EVIDENCE_PASSED (Hermetic Sandbox 42/42)', checked: true },
    { id: 'p3', label: 'CANDIDATE_UNCHANGED (Digest Match)', checked: true },
    { id: 'p4', label: 'NO_DEPENDENCY_SKEW (Unified Semver)', checked: true },
  ]);

  // Digest Calculator State
  const [schemaType, setSchemaType] = useState<'future_state' | 'effect_set' | 'payload'>('future_state');
  const [jsonInput, setJsonInput] = useState<string>(JSON.stringify(SAMPLE_REVISION_STATE, null, 2));
  const [computedDigest, setComputedDigest] = useState<string>(() => computeFutureRevisionStateDigest(SAMPLE_REVISION_STATE));
  const [cborHex, setCborHex] = useState<string>(() => {
    const bytes = encodeCBOR(SAMPLE_REVISION_STATE);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
  });

  // CAS Simulator State
  const [casExpected, setCasExpected] = useState('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const [casRemote, setCasRemote] = useState('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const [casTarget, setCasTarget] = useState('c999_promoted_canonical_head');
  const [casResult, setCasResult] = useState<{ status: 'IDLE' | 'SUCCESS' | 'CONFLICT'; message: string }>({
    status: 'IDLE',
    message: 'Ready to assert Compare-And-Swap invariant against remote Git reference.',
  });

  const [searchQuery, setSearchQuery] = useState('');

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

  const handleRunCas = () => {
    if (casExpected === casRemote) {
      setCasResult({
        status: 'SUCCESS',
        message: `CAS Assertion PASSED: Remote ref equals expected OID ${casExpected}. Target mutation ${casTarget} safely applied via receive-pack.`,
      });
    } else {
      setCasResult({
        status: 'CONFLICT',
        message: `CAS CONFLICT (Blocked): Remote ref has moved to ${casRemote}, which differs from expected OID ${casExpected}. Promotion rejected to prevent race condition.`,
      });
    }
  };

  const allPredicatesPassing = predicates.every(p => p.checked);

  return (
    <div className={`min-h-screen flex flex-col justify-start md:justify-center items-center transition-colors duration-200 ${
      darkMode ? 'bg-[#0E0F12]' : 'bg-[#E5E7EB]'
    } p-0 md:p-6 pb-20 md:pb-6`}>
      
      {/* Universal Container (Adapts from Full-Bleed iOS on Mobile to Floating Window on macOS) */}
      <div className={`w-full max-w-[1440px] min-h-screen md:min-h-0 md:h-[92vh] md:max-h-[980px] md:rounded-2xl shadow-none md:shadow-[0_25px_70px_-15px_rgba(0,0,0,0.35)] ring-0 md:ring-1 ring-black/10 dark:ring-white/10 flex flex-col overflow-hidden transition-colors ${
        darkMode ? 'bg-[#1E1E20] text-[#F5F5F7]' : 'bg-[#FFFFFF] text-[#1D1D1F]'
      }`}>
        
        {/* Titlebar / Navigation Header */}
        <header className={`h-14 px-4 flex items-center justify-between border-b shrink-0 z-20 sticky top-0 transition-colors ${
          darkMode ? 'bg-[#28282A] border-black/40' : 'bg-[#F6F6F6] border-black/[0.08]'
        }`}>
          {/* Left: Window Controls on Desktop, Menu toggle on Mobile */}
          <div className="flex items-center space-x-3">
            {/* Desktop Traffic Lights */}
            <div className="hidden md:flex items-center space-x-2 group">
              <span className="w-3 h-3 rounded-full bg-[#FF5F56] border border-[#E0443E] flex items-center justify-center cursor-pointer shadow-sm">
                <X className="w-2 h-2 text-[#7F1713] opacity-0 group-hover:opacity-100 transition-opacity" />
              </span>
              <span className="w-3 h-3 rounded-full bg-[#FFBD2E] border border-[#DEA123] flex items-center justify-center cursor-pointer shadow-sm">
                <Minus className="w-2 h-2 text-[#8A5808] opacity-0 group-hover:opacity-100 transition-opacity" />
              </span>
              <span className="w-3 h-3 rounded-full bg-[#27C93F] border border-[#1AAB29] flex items-center justify-center cursor-pointer shadow-sm">
                <Maximize2 className="w-2 h-2 text-[#0D6318] opacity-0 group-hover:opacity-100 transition-opacity" />
              </span>
            </div>

            {/* Mobile Drawer Trigger (min 44px touch target) */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className={`md:hidden min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg ${
                darkMode ? 'text-white' : 'text-black'
              }`}
              aria-label="Toggle Navigation Menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Title / App Brand */}
            <div className="flex items-center space-x-2">
              <FolderGit2 className="w-4 h-4 text-[#0071E3] shrink-0" />
              <span className="font-semibold text-[14px] tracking-tight whitespace-nowrap">KLoCGit v1</span>
              <span className="hidden sm:inline text-[11px] text-[#86868B] truncate">
                — Convergence Platform
              </span>
            </div>
          </div>

          {/* Center Search (Hidden on small mobile screens to prevent overflow) */}
          <div className="hidden lg:flex items-center relative w-64">
            <Search className={`w-3.5 h-3.5 absolute left-2.5 ${darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'}`} />
            <input
              type="text"
              placeholder="Search DAG, OIDs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full h-7 pl-8 pr-12 rounded-lg text-[12px] border outline-none ${
                darkMode
                  ? 'bg-[#18181A] border-white/[0.08] text-white focus:border-[#0071E3]'
                  : 'bg-white border-black/[0.12] text-black focus:border-[#0071E3]'
              }`}
            />
            <span className={`absolute right-2 text-[10px] font-mono px-1 rounded ${
              darkMode ? 'bg-white/[0.08] text-[#86868B]' : 'bg-black/[0.06] text-[#8E8E93]'
            }`}>
              ⌘K
            </span>
          </div>

          {/* Right Header Controls */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-[#34C759]/10 text-[#34C759] border border-[#34C759]/20 font-medium">
              P1–P7
            </span>

            {/* Inspector Toggle Trigger */}
            <button
              onClick={() => setInspectorOpen(!inspectorOpen)}
              className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg transition-colors ${
                darkMode ? 'text-[#AEAEB2] hover:text-white' : 'text-[#6E6E73] hover:text-black'
              }`}
              title="Toggle Inspector"
            >
              <Info className="w-4 h-4" />
            </button>

            {/* Dark Mode Toggle */}
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg transition-colors ${
                darkMode ? 'text-amber-300' : 'text-slate-700'
              }`}
              title="Toggle Appearance"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Mobile Navigation Dropdown Drawer */}
        {mobileMenuOpen && (
          <div className={`md:hidden border-b px-4 py-3 z-30 transition-all ${
            darkMode ? 'bg-[#28282A] border-black/40' : 'bg-[#F2F2F7] border-black/[0.08]'
          }`}>
            <div className="grid grid-cols-2 gap-2 text-xs font-medium">
              {[
                { id: 'overview', label: 'Overview' },
                { id: 'dag', label: 'Convergence DAG' },
                { id: 'repos', label: 'Repositories' },
                { id: 'diff', label: 'Diff Studio' },
                { id: 'policy', label: 'Policy Portal' },
                { id: 'digest', label: 'Digest Engine' },
                { id: 'audit', label: 'Audit Trail' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id as any);
                    setMobileMenuOpen(false);
                  }}
                  className={`min-h-[44px] px-3 py-2 rounded-xl text-left flex items-center justify-between ${
                    activeTab === tab.id
                      ? 'bg-[#0071E3] text-white'
                      : darkMode ? 'bg-white/[0.06] text-slate-200' : 'bg-white text-slate-800'
                  }`}
                >
                  <span>{tab.label}</span>
                  {activeTab === tab.id && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Main Body (Split View on Desktop, Stack on Mobile) */}
        <div className="flex-1 flex overflow-hidden relative">
          
          {/* Desktop Left Sidebar (hidden on mobile, uses bottom nav / drawer instead) */}
          <nav className={`hidden md:flex w-56 border-r shrink-0 p-3 flex-col justify-between transition-colors ${
            darkMode ? 'bg-[#18181A] border-black/40' : 'bg-[#F2F2F7]/70 border-black/[0.08]'
          }`}>
            <div className="space-y-4">
              <div>
                <span className={`px-2 text-[10px] font-semibold tracking-wider ${
                  darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'
                }`}>
                  CONVERGENCE
                </span>
                <div className="mt-1 space-y-0.5">
                  {[
                    { id: 'overview', label: 'Overview', icon: LayoutDashboardIcon },
                    { id: 'dag', label: 'Convergence DAG', icon: GitBranch },
                    { id: 'repos', label: 'Repositories', icon: Database },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id as any)}
                      className={`w-full min-h-[40px] px-2.5 py-1.5 rounded-lg text-[13px] flex items-center space-x-2.5 font-medium transition-colors ${
                        activeTab === item.id
                          ? 'bg-[#0071E3] text-white shadow-sm'
                          : darkMode
                          ? 'text-[#AEAEB2] hover:bg-white/[0.06] hover:text-white'
                          : 'text-[#48484A] hover:bg-black/[0.05] hover:text-black'
                      }`}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className={`px-2 text-[10px] font-semibold tracking-wider ${
                  darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'
                }`}>
                  ENGINEERING
                </span>
                <div className="mt-1 space-y-0.5">
                  {[
                    { id: 'diff', label: 'Inspection Studio', icon: FileCode2 },
                    { id: 'digest', label: 'Digest Engine', icon: Cpu },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id as any)}
                      className={`w-full min-h-[40px] px-2.5 py-1.5 rounded-lg text-[13px] flex items-center space-x-2.5 font-medium transition-colors ${
                        activeTab === item.id
                          ? 'bg-[#0071E3] text-white shadow-sm'
                          : darkMode
                          ? 'text-[#AEAEB2] hover:bg-white/[0.06] hover:text-white'
                          : 'text-[#48484A] hover:bg-black/[0.05] hover:text-black'
                      }`}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className={`px-2 text-[10px] font-semibold tracking-wider ${
                  darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'
                }`}>
                  GOVERNANCE
                </span>
                <div className="mt-1 space-y-0.5">
                  {[
                    { id: 'policy', label: 'Policy Portal', icon: ShieldCheck },
                    { id: 'audit', label: 'Audit Trail', icon: FileText },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id as any)}
                      className={`w-full min-h-[40px] px-2.5 py-1.5 rounded-lg text-[13px] flex items-center space-x-2.5 font-medium transition-colors ${
                        activeTab === item.id
                          ? 'bg-[#0071E3] text-white shadow-sm'
                          : darkMode
                          ? 'text-[#AEAEB2] hover:bg-white/[0.06] hover:text-white'
                          : 'text-[#48484A] hover:bg-black/[0.05] hover:text-black'
                      }`}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className={`p-2.5 rounded-xl border text-[11px] font-mono ${
              darkMode ? 'bg-black/30 border-white/[0.06] text-[#86868B]' : 'bg-white border-black/[0.06] text-[#6E6E73]'
            }`}>
              <div className="flex items-center justify-between">
                <span>CAS LOCK</span>
                <span className="text-[#34C759] font-semibold">ONLINE</span>
              </div>
              <div className="text-[10px] truncate mt-1">refs/heads/main</div>
            </div>
          </nav>

          {/* Center Scrollable Work Area */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
            
            {/* OVERVIEW */}
            {activeTab === 'overview' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">System Overview</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    KLoCGit v1 Enterprise Convergence Platform — 7/7 Phases Shipped & Verified
                  </p>
                </div>

                {/* Verification Gates (Responsive Grid) */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5 md:gap-3">
                  {[
                    { phase: 'Phase 1', title: 'Engine Core', status: '8/8 Passed' },
                    { phase: 'Phase 2', title: 'Coordinators', status: 'Zero Races' },
                    { phase: 'Phase 3', title: 'ArtifactFS', status: 'Hermetic' },
                    { phase: 'Phase 4', title: 'Reduction', status: 'Deduplicated' },
                    { phase: 'Phase 5', title: 'Policy Gate', status: 'Verified' },
                    { phase: 'Phase 6', title: 'Apple HIG', status: 'Mobile Ready' },
                    { phase: 'Phase 7', title: 'Full E2E', status: '100% Passed' },
                  ].map((g, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl border ${
                        darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                      }`}
                    >
                      <div className="text-[10px] font-mono text-[#0071E3] font-semibold">{g.phase}</div>
                      <div className="text-[12px] font-semibold mt-0.5 truncate">{g.title}</div>
                      <div className="text-[11px] text-[#34C759] font-medium flex items-center space-x-1 mt-1">
                        <Check className="w-3 h-3 shrink-0" />
                        <span className="truncate">{g.status}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 6 Invariants Highlights */}
                <div className="space-y-3">
                  <h2 className="text-[14px] md:text-[15px] font-semibold tracking-tight">Core Invariants</h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {[
                      { num: '01', title: 'Canonical Projections', desc: 'Identities bind to immutable RFC 8949 projections.' },
                      { num: '02', title: 'Compare-And-Swap (CAS)', desc: 'Canonical Git mutation asserts expected remote OID.' },
                      { num: '03', title: 'Review Validity', desc: 'Material input change revokes prior review.' },
                      { num: '04', title: 'Inferred AI Output', desc: 'AI suggestions are inferred; never trusted authorization.' },
                      { num: '05', title: 'Strict Resolution Gate', desc: 'PARTIAL, FAILED analysis blocks promotion.' },
                      { num: '06', title: 'Scratch Isolation', desc: 'Candidates synthesize in ArtifactFS scratch space.' },
                    ].map((inv) => (
                      <div
                        key={inv.num}
                        className={`p-4 rounded-xl border ${
                          darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.06] shadow-sm'
                        }`}
                      >
                        <span className="text-[10px] font-mono text-[#0071E3] font-semibold block">{inv.num}</span>
                        <h3 className="text-[13px] font-semibold mt-0.5">{inv.title}</h3>
                        <p className={`text-[11px] mt-1 leading-relaxed ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>{inv.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* CONVERGENCE DAG */}
            {activeTab === 'dag' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Convergence DAG</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Flow from autonomous agent future revisions to synthesized candidate specs and trunk promotion.
                  </p>
                </div>

                <div className={`p-4 md:p-6 rounded-2xl border ${
                  darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-[#F6F6F6] border-black/[0.08]'
                }`}>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 overflow-x-auto py-2">
                    <div
                      onClick={() => setSelectedDagNode('base_trunk')}
                      className={`p-3.5 rounded-xl border cursor-pointer w-full sm:w-44 transition-all min-h-[44px] ${
                        selectedDagNode === 'base_trunk'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <GitCommit className="w-4 h-4 text-[#0071E3] mb-1" />
                      <div className="text-xs font-semibold">1. Base Trunk</div>
                      <div className="text-[10px] font-mono text-[#86868B] truncate">c001_core_trunk_head</div>
                    </div>

                    <ChevronRight className="hidden sm:block w-4 h-4 text-[#86868B] shrink-0" />

                    <div className="space-y-2 w-full sm:w-44">
                      {['agent-future-01', 'agent-future-02'].map((f) => (
                        <div
                          key={f}
                          onClick={() => setSelectedDagNode(f)}
                          className={`p-2.5 rounded-lg border cursor-pointer transition-all min-h-[44px] ${
                            selectedDagNode === f
                              ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                              : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                          }`}
                        >
                          <div className="text-[11px] font-semibold">{f}</div>
                          <div className="text-[9px] font-mono text-[#86868B]">handleOrder slice</div>
                        </div>
                      ))}
                    </div>

                    <ChevronRight className="hidden sm:block w-4 h-4 text-[#86868B] shrink-0" />

                    <div
                      onClick={() => setSelectedDagNode('candidate_unified')}
                      className={`p-3.5 rounded-xl border cursor-pointer w-full sm:w-48 transition-all min-h-[44px] ${
                        selectedDagNode === 'candidate_unified'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <Layers className="w-4 h-4 text-[#AF52DE] mb-1" />
                      <div className="text-xs font-semibold">3. Candidate Spec</div>
                      <div className="text-[10px] text-[#34C759]">Deduplicated (2 slices)</div>
                    </div>

                    <ChevronRight className="hidden sm:block w-4 h-4 text-[#86868B] shrink-0" />

                    <div
                      onClick={() => setSelectedDagNode('promoted_trunk')}
                      className={`p-3.5 rounded-xl border cursor-pointer w-full sm:w-44 transition-all min-h-[44px] ${
                        selectedDagNode === 'promoted_trunk'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <Lock className="w-4 h-4 text-[#34C759] mb-1" />
                      <div className="text-xs font-semibold">4. Promoted Head</div>
                      <div className="text-[10px] font-mono text-[#34C759] truncate">c999_promoted_head</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* REPOSITORIES */}
            {activeTab === 'repos' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Repositories</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Multi-repository status board with serialized ref locks.
                  </p>
                </div>

                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full text-left text-xs min-w-[500px]">
                    <thead>
                      <tr className={`border-b font-medium ${darkMode ? 'border-white/[0.08] text-[#86868B]' : 'border-black/[0.08] text-[#86868B]'}`}>
                        <th className="pb-2.5">REPOSITORY</th>
                        <th className="pb-2.5">CANONICAL HEAD OID</th>
                        <th className="pb-2.5">CAS LOCK</th>
                        <th className="pb-2.5 text-right">STATUS</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y font-mono ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                      {repos.map((r) => (
                        <tr key={r.id} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                          <td className="py-3 font-semibold text-[#0071E3]">{r.id}</td>
                          <td className="py-3 select-all truncate max-w-[140px]">{r.head}</td>
                          <td className="py-3 text-[#34C759]">{r.lock}</td>
                          <td className="py-3 text-right text-[#34C759] font-medium">{r.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* CAS Test Panel */}
                <div className={`p-4 md:p-5 rounded-2xl border space-y-3 ${
                  darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                }`}>
                  <h3 className="text-xs md:text-sm font-semibold">Serialized CAS Git Push Simulator</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[10px] font-medium mb-1">Expected OID</label>
                      <input
                        type="text"
                        value={casExpected}
                        onChange={(e) => setCasExpected(e.target.value)}
                        className={`w-full min-h-[44px] p-2 rounded-lg text-xs font-mono border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1]' : 'bg-white border-black/[0.1]'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium mb-1">Current Remote OID</label>
                      <input
                        type="text"
                        value={casRemote}
                        onChange={(e) => setCasRemote(e.target.value)}
                        className={`w-full min-h-[44px] p-2 rounded-lg text-xs font-mono border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1]' : 'bg-white border-black/[0.1]'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium mb-1">Target Mutation OID</label>
                      <input
                        type="text"
                        value={casTarget}
                        onChange={(e) => setCasTarget(e.target.value)}
                        className={`w-full min-h-[44px] p-2 rounded-lg text-xs font-mono border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1]' : 'bg-white border-black/[0.1]'
                        }`}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      onClick={handleRunCas}
                      className="min-h-[44px] px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-medium rounded-lg shadow-sm"
                    >
                      Assert CAS Push
                    </button>
                    <button
                      onClick={() => setCasRemote('stale_remote_oid_race')}
                      className={`min-h-[44px] px-3 py-2 rounded-lg text-xs border ${
                        darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      Inject Concurrent Race
                    </button>
                  </div>
                  <div className={`p-3 rounded-lg border text-xs font-mono break-all ${
                    casResult.status === 'SUCCESS' ? 'text-[#34C759] border-[#34C759]/30 bg-[#34C759]/10' :
                    casResult.status === 'CONFLICT' ? 'text-[#FF3B30] border-[#FF3B30]/30 bg-[#FF3B30]/10' : ''
                  }`}>
                    {casResult.message}
                  </div>
                </div>
              </div>
            )}

            {/* DIFF STUDIO */}
            {activeTab === 'diff' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Inspection Studio</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Side-by-side unified diff inspection with provenance origin annotations.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-semibold text-rose-500 mb-1">Base Trunk (repo-core)</div>
                    <pre className={`p-3.5 rounded-xl border font-mono text-[11px] leading-relaxed overflow-x-auto ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08] text-rose-400' : 'bg-[#FFF5F5] border-rose-200 text-rose-900'
                    }`}>
{`- export function handleOrder(orderId: string) {
-   const legacy = initLegacy();
-   return legacy.charge(orderId);
- }`}
                    </pre>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-emerald-500 mb-1">Synthesized Candidate</div>
                    <pre className={`p-3.5 rounded-xl border font-mono text-[11px] leading-relaxed overflow-x-auto ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08] text-emerald-400' : 'bg-[#F0FDF4] border-emerald-200 text-emerald-900'
                    }`}>
{`+ export async function handleOrder(orderId: string) {
+   const payment = await getPaymentCluster();
+   return await payment.authorize(orderId);
+ }`}
                    </pre>
                  </div>
                </div>
              </div>
            )}

            {/* POLICY PORTAL */}
            {activeTab === 'policy' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Policy Review</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Invariant 5 enforcement and authorized human lead sign-off.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`p-4 md:p-5 rounded-xl border space-y-3 ${
                    darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                  }`}>
                    <h3 className="text-xs font-semibold text-[#0071E3]">TYPED PREDICATES</h3>
                    <div className="space-y-2">
                      {predicates.map((p) => (
                        <label key={p.id} className="flex items-center space-x-2.5 text-xs font-mono cursor-pointer min-h-[36px]">
                          <input
                            type="checkbox"
                            checked={p.checked}
                            onChange={(e) => {
                              setPredicates(predicates.map(item => item.id === p.id ? { ...item, checked: e.target.checked } : item));
                            }}
                            className="w-4 h-4 rounded text-[#0071E3]"
                          />
                          <span>{p.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className={`p-4 md:p-5 rounded-xl border space-y-3 ${
                    darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                  }`}>
                    <h3 className="text-xs font-semibold text-[#0071E3]">PROMOTION SIGN-OFF</h3>
                    <div>
                      <label className="block text-[11px] font-medium mb-1">Authorized Role</label>
                      <select
                        value={policyRole}
                        onChange={(e) => setPolicyRole(e.target.value as any)}
                        className={`w-full min-h-[44px] p-2 rounded-lg text-xs border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1] text-white' : 'bg-white border-black/[0.1]'
                        }`}
                      >
                        <option value="TECH_LEAD">TECH_LEAD (Authorized)</option>
                        <option value="AGENT">AGENT (Autonomous Bot - Blocked)</option>
                        <option value="OBSERVER">OBSERVER (Read-Only - Blocked)</option>
                      </select>
                    </div>

                    <button
                      onClick={() => {
                        if (!allPredicatesPassing) {
                          alert('BLOCKED by Invariant 5: Incomplete predicates!');
                          return;
                        }
                        if (policyRole !== 'TECH_LEAD') {
                          alert('BLOCKED: Only TECH_LEAD human role can sign off!');
                          return;
                        }
                        setDecisionState('RESOLVED');
                      }}
                      className={`w-full min-h-[44px] py-2.5 rounded-lg text-xs font-medium text-white shadow-sm ${
                        allPredicatesPassing && policyRole === 'TECH_LEAD'
                          ? 'bg-[#34C759] hover:bg-[#2FB350]'
                          : 'bg-slate-400 cursor-not-allowed'
                      }`}
                    >
                      {decisionState === 'RESOLVED' ? 'Sign-Off Verified' : 'Authorize & Sign-Off Promotion'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* DIGEST ENGINE */}
            {activeTab === 'digest' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Digest Explorer</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    RFC 8949 CBOR serialization and SHA-256 digest engine.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="space-y-3">
                    <textarea
                      rows={10}
                      value={jsonInput}
                      onChange={(e) => setJsonInput(e.target.value)}
                      className={`w-full p-3 rounded-xl border font-mono text-[11px] ${
                        darkMode ? 'bg-[#18181A] border-white/[0.08] text-white' : 'bg-[#F9F9FA] border-black/[0.08]'
                      }`}
                    />
                    <button
                      onClick={handleCalculateDigest}
                      className="min-h-[44px] px-4 py-2 bg-[#0071E3] text-white text-xs font-medium rounded-lg shadow-sm"
                    >
                      Recompute Digest
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className={`p-3.5 rounded-xl border ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-[#F9F9FA] border-black/[0.08]'
                    }`}>
                      <div className="text-[10px] font-semibold text-[#0071E3] mb-1">DIGEST HASH</div>
                      <div className="font-mono text-xs break-all font-semibold select-all text-[#0071E3]">{computedDigest}</div>
                    </div>
                    <div className={`p-3.5 rounded-xl border ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-[#F9F9FA] border-black/[0.08]'
                    }`}>
                      <div className="text-[10px] font-semibold mb-1">CBOR HEX BYTES</div>
                      <div className="font-mono text-[10px] break-all max-h-36 overflow-y-auto">{cborHex}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* AUDIT TRAIL */}
            {activeTab === 'audit' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Audit Trail</h1>
                  <p className={`text-[12px] md:text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Immutable records tagged with explicit policy retention classes.
                  </p>
                </div>

                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full text-left text-xs font-mono min-w-[500px]">
                    <thead>
                      <tr className={`border-b ${darkMode ? 'border-white/[0.08] text-[#86868B]' : 'border-black/[0.08] text-[#86868B]'}`}>
                        <th className="pb-2.5">EVENT</th>
                        <th className="pb-2.5">RETENTION</th>
                        <th className="pb-2.5 text-right">STATUS</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                      {[
                        { event: 'External CD Attestation', retention: 'CANONICAL', status: 'SUCCEEDED' },
                        { event: 'Hermetic Sandbox Receipt', retention: 'DECISION_RECORD', status: 'PASSED' },
                        { event: 'Candidate Reduction Spec', retention: 'CANONICAL', status: 'REDUCED' },
                        { event: 'Transient Smoke Run', retention: 'EPHEMERAL', status: 'EXPIRED' },
                      ].map((row, idx) => (
                        <tr key={idx} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                          <td className="py-3 font-semibold text-[#0071E3]">{row.event}</td>
                          <td className="py-3">
                            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#34C759]/10 text-[#34C759]">
                              {row.retention}
                            </span>
                          </td>
                          <td className="py-3 text-right text-[#34C759] font-medium">{row.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Right Inspector Panel (Collapsible Drawer on Mobile, Side Panel on Desktop) */}
          {inspectorOpen && (
            <aside className={`absolute md:static top-0 right-0 bottom-0 z-30 w-72 md:w-64 border-l p-4 space-y-4 overflow-y-auto transition-all shadow-xl md:shadow-none ${
              darkMode ? 'bg-[#18181A] border-black/40' : 'bg-[#F2F2F7] md:bg-[#F2F2F7]/50 border-black/[0.08]'
            }`}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold tracking-wider text-[#86868B]">
                  INSPECTOR
                </span>
                <button
                  onClick={() => setInspectorOpen(false)}
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-md md:hidden"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.06] shadow-sm'
              }`}>
                <div className="font-semibold text-[11px]">Selected Node</div>
                <div className="text-[11px] font-mono text-[#0071E3] break-all">{selectedDagNode}</div>
              </div>

              <div className="space-y-1.5 text-xs">
                <span className="text-[10px] font-semibold tracking-wider block text-[#86868B]">
                  PROJECTION PROVENANCE
                </span>
                <div className={`p-3 rounded-xl border text-[10px] font-mono space-y-1 ${
                  darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.06] shadow-sm'
                }`}>
                  <div className="flex justify-between">
                    <span className="text-[#86868B]">Domain:</span>
                    <span>klocgit/candidate</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#86868B]">Schema:</span>
                    <span>v1</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#86868B]">Retention:</span>
                    <span className="text-[#34C759]">CANONICAL</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => copyToClipboard(computedDigest, 'inspector')}
                className={`w-full min-h-[44px] py-2 px-3 rounded-lg text-xs font-medium border flex items-center justify-center space-x-2 transition-colors ${
                  darkMode ? 'bg-[#28282A] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                }`}
              >
                {copiedText === 'inspector' ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedText === 'inspector' ? 'Copied' : 'Copy Active Digest'}</span>
              </button>
            </aside>
          )}
        </div>

        {/* Mobile Fixed Bottom Navigation Bar (iOS 18 HIG Pattern) */}
        <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-40 border-t backdrop-blur-xl flex items-center justify-around h-16 pb-safe transition-colors ${
          darkMode ? 'bg-[#1E1E20]/90 border-white/[0.08]' : 'bg-white/90 border-black/[0.08]'
        }`}>
          {[
            { id: 'overview', label: 'Overview', icon: LayoutDashboardIcon },
            { id: 'dag', label: 'DAG', icon: GitBranch },
            { id: 'repos', label: 'Repos', icon: Database },
            { id: 'diff', label: 'Diff', icon: FileCode2 },
            { id: 'policy', label: 'Policy', icon: ShieldCheck },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as any)}
              className={`flex-1 min-h-[44px] flex flex-col items-center justify-center transition-colors ${
                activeTab === item.id
                  ? 'text-[#0071E3]'
                  : darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'
              }`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              <span className="text-[10px] font-medium tracking-tight mt-1">{item.label}</span>
            </button>
          ))}
        </nav>

      </div>
    </div>
  );
}

function LayoutDashboardIcon(props: any) {
  return (
    <svg {...props} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </svg>
  );
}
