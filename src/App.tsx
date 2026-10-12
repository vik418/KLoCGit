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
  const [inspectorOpen, setInspectorOpen] = useState(true);
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

  // Extractor State
  const [sourceCode, setSourceCode] = useState<string>(
`import express from 'express';
import { z } from 'zod';

export function handleUserLogin(req: Request) {
  return "token_issued";
}

export const API_VERSION = 2;

// Security check
eval("console.log('danger')");`
  );
  const [extractedEffects, setExtractedEffects] = useState<any>(null);

  // CAS Simulator State
  const [casExpected, setCasExpected] = useState('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const [casRemote, setCasRemote] = useState('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const [casTarget, setCasTarget] = useState('c999_promoted_canonical_head');
  const [casResult, setCasResult] = useState<{ status: 'IDLE' | 'SUCCESS' | 'CONFLICT'; message: string }>({
    status: 'IDLE',
    message: 'Ready to assert Compare-And-Swap invariant against remote Git reference.',
  });

  // Search filter
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

  const handleRunExtractor = () => {
    const lines = sourceCode.split('\n');
    const exports: string[] = [];
    const deps: Record<string, string> = {};
    const security: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('export function ')) {
        const name = trimmed.replace('export function ', '').split('(')[0]?.trim();
        if (name) exports.push(name);
      } else if (trimmed.startsWith('export const ')) {
        const name = trimmed.replace('export const ', '').split(/[:=]/)[0]?.trim();
        if (name) exports.push(name);
      }
      if (trimmed.includes("from '") || trimmed.includes('from "')) {
        const pkg = trimmed.split(/from ['"]/)[1]?.split(/['"]/)[0];
        if (pkg && !pkg.startsWith('.')) deps[pkg] = '*';
      }
      if (trimmed.includes('eval(')) security.push('EXEC:eval');
      if (trimmed.includes('crypto')) security.push('CRYPTO:usage');
    }

    const effectSet: CanonicalEffectSet = {
      future_revision_id: 'fut-sample-live',
      extractor_id: 'tree-sitter-structural-v1',
      extractor_version: '1.0.0',
      capability: 'STRUCTURAL',
      status: 'COMPLETE',
      modified_exports: exports.sort(),
      added_dependencies: deps,
      db_migrations_detected: false,
      security_effects: security.sort(),
    };

    setExtractedEffects(effectSet);
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
    <div className={`min-h-screen p-3 md:p-6 flex flex-col justify-center items-center transition-colors duration-200 select-none ${
      darkMode ? 'bg-[#0E0F12]' : 'bg-[#E5E7EB]'
    }`}>
      {/* Authentic macOS Window Container (Apple Design Resources) */}
      <div className={`w-full max-w-[1400px] h-[92vh] max-h-[980px] rounded-2xl shadow-[0_25px_70px_-15px_rgba(0,0,0,0.35)] ring-1 ring-black/10 dark:ring-white/10 flex flex-col overflow-hidden transition-colors ${
        darkMode ? 'bg-[#1E1E20] text-[#F5F5F7]' : 'bg-[#FFFFFF] text-[#1D1D1F]'
      }`}>
        
        {/* macOS Unified Titlebar & Toolbar */}
        <header className={`h-13 px-4 flex items-center justify-between border-b shrink-0 transition-colors ${
          darkMode ? 'bg-[#28282A] border-black/40' : 'bg-[#F6F6F6] border-black/[0.08]'
        }`}>
          {/* Left: Window Controls (Traffic Lights) */}
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 group">
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

            <button
              onClick={() => setInspectorOpen(!inspectorOpen)}
              className={`p-1.5 rounded-md text-xs transition-colors ${
                darkMode ? 'hover:bg-white/[0.08] text-[#86868B]' : 'hover:bg-black/[0.06] text-[#6E6E73]'
              }`}
              title="Toggle Inspector Sidebar"
            >
              <SidebarIcon className="w-4 h-4" />
            </button>

            <div className="flex items-center space-x-2">
              <FolderGit2 className="w-4 h-4 text-[#0071E3]" />
              <span className="font-semibold text-[13px] tracking-tight">KLoCGit v1</span>
              <span className={`text-[11px] ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                — Convergence Platform
              </span>
            </div>
          </div>

          {/* Center: Search Field */}
          <div className="hidden md:flex items-center relative w-72">
            <Search className={`w-3.5 h-3.5 absolute left-2.5 ${darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'}`} />
            <input
              type="text"
              placeholder="Search revisions, DAG, OIDs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full h-7 pl-8 pr-12 rounded-lg text-[12px] border outline-none transition-all ${
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

          {/* Right: Actions & Theme Toggle */}
          <div className="flex items-center space-x-2">
            <div className="flex items-center space-x-1.5 text-[11px] font-medium text-[#34C759] mr-2">
              <span className="w-2 h-2 rounded-full bg-[#34C759]"></span>
              <span>All 7 Gates Passed</span>
            </div>

            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-1.5 rounded-md transition-colors ${
                darkMode ? 'hover:bg-white/[0.08] text-white' : 'hover:bg-black/[0.06] text-black'
              }`}
              title="Toggle Dark / Light Appearance"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5 text-amber-300" /> : <Moon className="w-3.5 h-3.5 text-slate-700" />}
            </button>
          </div>
        </header>

        {/* macOS Three-Pane Layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* PANE 1: Sidebar Navigation (macOS HIG Style) */}
          <nav className={`w-56 border-r shrink-0 p-3 flex flex-col justify-between transition-colors ${
            darkMode ? 'bg-[#18181A] border-black/40' : 'bg-[#F2F2F7]/70 border-black/[0.08]'
          }`}>
            <div className="space-y-4">
              {/* Group 1: CONVERGENCE */}
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
                      className={`w-full px-2.5 py-1.5 rounded-lg text-[13px] flex items-center space-x-2.5 font-medium transition-colors ${
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

              {/* Group 2: ENGINEERING */}
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
                      className={`w-full px-2.5 py-1.5 rounded-lg text-[13px] flex items-center space-x-2.5 font-medium transition-colors ${
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

              {/* Group 3: GOVERNANCE */}
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
                      className={`w-full px-2.5 py-1.5 rounded-lg text-[13px] flex items-center space-x-2.5 font-medium transition-colors ${
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

            {/* Sidebar Bottom Status */}
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

          {/* PANE 2: Center Content Viewport */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* OVERVIEW */}
            {activeTab === 'overview' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">System Overview</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    KLoCGit v1 Enterprise Convergence Platform — 7/7 Phases Shipped & Verified
                  </p>
                </div>

                {/* 7 Verification Gates Matrix */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  {[
                    { phase: 'Phase 1', title: 'Engine Core', status: '8/8 Passed' },
                    { phase: 'Phase 2', title: 'Coordinators', status: 'Zero Races' },
                    { phase: 'Phase 3', title: 'ArtifactFS', status: 'Hermetic' },
                    { phase: 'Phase 4', title: 'Reduction', status: 'Deduplicated' },
                    { phase: 'Phase 5', title: 'Policy Gate', status: 'Verified' },
                    { phase: 'Phase 6', title: 'Apple Console', status: 'HIG Native' },
                    { phase: 'Phase 7', title: 'Full E2E', status: '100% Passed' },
                  ].map((g, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl border transition-all ${
                        darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                      }`}
                    >
                      <div className="text-[10px] font-mono text-[#0071E3] font-semibold">{g.phase}</div>
                      <div className="text-[12px] font-semibold mt-0.5 truncate">{g.title}</div>
                      <div className="text-[11px] text-[#34C759] font-medium flex items-center space-x-1 mt-1">
                        <Check className="w-3 h-3" />
                        <span>{g.status}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Architecture Invariants */}
                <div className="space-y-3">
                  <h2 className="text-[15px] font-semibold tracking-tight">Frozen Architecture Invariants</h2>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[
                      { num: '01', title: 'Canonical Projections', desc: 'Identities bind to immutable RFC 8949 projections.' },
                      { num: '02', title: 'Compare-And-Swap (CAS)', desc: 'Canonical Git mutation asserts expected OID.' },
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
                  <h1 className="text-2xl font-semibold tracking-tight">Convergence DAG Visualizer</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Interactive graph from autonomous agent future revisions to synthesized candidate specs and trunk promotion.
                  </p>
                </div>

                <div className={`p-6 rounded-2xl border ${
                  darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-[#F6F6F6] border-black/[0.08]'
                }`}>
                  <div className="flex flex-col md:flex-row items-center justify-between gap-6 overflow-x-auto py-4">
                    {/* Step 1: Base */}
                    <div
                      onClick={() => setSelectedDagNode('base_trunk')}
                      className={`p-4 rounded-xl border cursor-pointer w-44 transition-all ${
                        selectedDagNode === 'base_trunk'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <GitCommit className="w-4 h-4 text-[#0071E3] mb-1.5" />
                      <div className="text-xs font-semibold">Base Trunk</div>
                      <div className="text-[10px] font-mono text-[#86868B] truncate">c001_core_trunk_head</div>
                    </div>

                    <ChevronRight className="w-4 h-4 text-[#86868B] shrink-0" />

                    {/* Step 2: Futures */}
                    <div className="space-y-2">
                      {['agent-future-01', 'agent-future-02'].map((f) => (
                        <div
                          key={f}
                          onClick={() => setSelectedDagNode(f)}
                          className={`p-2.5 rounded-lg border cursor-pointer w-44 transition-all ${
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

                    <ChevronRight className="w-4 h-4 text-[#86868B] shrink-0" />

                    {/* Step 3: Candidate */}
                    <div
                      onClick={() => setSelectedDagNode('candidate_unified')}
                      className={`p-4 rounded-xl border cursor-pointer w-48 transition-all ${
                        selectedDagNode === 'candidate_unified'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <Layers className="w-4 h-4 text-[#AF52DE] mb-1.5" />
                      <div className="text-xs font-semibold">cand-spec-unified-01</div>
                      <div className="text-[10px] text-[#34C759]">Deduplicated (2 slices)</div>
                    </div>

                    <ChevronRight className="w-4 h-4 text-[#86868B] shrink-0" />

                    {/* Step 4: Promoted Trunk */}
                    <div
                      onClick={() => setSelectedDagNode('promoted_trunk')}
                      className={`p-4 rounded-xl border cursor-pointer w-44 transition-all ${
                        selectedDagNode === 'promoted_trunk'
                          ? 'border-[#0071E3] bg-[#0071E3]/10 ring-2 ring-[#0071E3]/20'
                          : darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      <Lock className="w-4 h-4 text-[#34C759] mb-1.5" />
                      <div className="text-xs font-semibold">CAS Promoted Trunk</div>
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
                  <h1 className="text-2xl font-semibold tracking-tight">Active Repositories</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Multi-repository status board with serialized ref locks and canonical head OIDs.
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className={`border-b font-medium ${darkMode ? 'border-white/[0.08] text-[#86868B]' : 'border-black/[0.08] text-[#86868B]'}`}>
                        <th className="pb-2.5">REPOSITORY</th>
                        <th className="pb-2.5">CANONICAL HEAD OID</th>
                        <th className="pb-2.5">CAS LOCK</th>
                        <th className="pb-2.5">ACTIVE BRANCHES</th>
                        <th className="pb-2.5 text-right">STATUS</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y font-mono ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                      {repos.map((r) => (
                        <tr key={r.id} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                          <td className="py-3 font-semibold text-[#0071E3]">{r.id}</td>
                          <td className="py-3 select-all">{r.head}</td>
                          <td className="py-3 text-[#34C759]">{r.lock}</td>
                          <td className="py-3">{r.branches} active</td>
                          <td className="py-3 text-right text-[#34C759] font-medium">{r.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Compare-And-Swap Simulator */}
                <div className={`p-5 rounded-2xl border space-y-4 ${
                  darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                }`}>
                  <h3 className="text-sm font-semibold">Serialized CAS Git Push Simulator</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium mb-1">Expected OID</label>
                      <input
                        type="text"
                        value={casExpected}
                        onChange={(e) => setCasExpected(e.target.value)}
                        className={`w-full p-2 rounded-lg text-xs font-mono border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1]' : 'bg-white border-black/[0.1]'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium mb-1">Current Remote OID</label>
                      <input
                        type="text"
                        value={casRemote}
                        onChange={(e) => setCasRemote(e.target.value)}
                        className={`w-full p-2 rounded-lg text-xs font-mono border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1]' : 'bg-white border-black/[0.1]'
                        }`}
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium mb-1">Target Mutation OID</label>
                      <input
                        type="text"
                        value={casTarget}
                        onChange={(e) => setCasTarget(e.target.value)}
                        className={`w-full p-2 rounded-lg text-xs font-mono border ${
                          darkMode ? 'bg-[#18181A] border-white/[0.1]' : 'bg-white border-black/[0.1]'
                        }`}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleRunCas}
                      className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-xs font-medium rounded-lg shadow-sm"
                    >
                      Assert CAS Push
                    </button>
                    <button
                      onClick={() => setCasRemote('stale_remote_oid_race')}
                      className={`px-3 py-2 rounded-lg text-xs border ${
                        darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-white border-black/[0.08]'
                      }`}
                    >
                      Simulate Concurrent Race
                    </button>
                  </div>
                  <div className={`p-3 rounded-lg border text-xs font-mono ${
                    casResult.status === 'SUCCESS' ? 'text-[#34C759] border-[#34C759]/30 bg-[#34C759]/10' :
                    casResult.status === 'CONFLICT' ? 'text-[#FF3B30] border-[#FF3B30]/30 bg-[#FF3B30]/10' : ''
                  }`}>
                    {casResult.message}
                  </div>
                </div>
              </div>
            )}

            {/* INSPECTION STUDIO */}
            {activeTab === 'diff' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Candidate Inspection Studio</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Side-by-side unified diff inspection with provenance slice origin annotations.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-semibold text-rose-500 mb-1.5">Base Trunk (repo-core / src/order.ts)</div>
                    <pre className={`p-4 rounded-xl border font-mono text-[11px] leading-relaxed overflow-x-auto ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08] text-rose-400' : 'bg-[#FFF5F5] border-rose-200 text-rose-900'
                    }`}>
{`- export function handleOrder(orderId: string) {
-   const legacy = initLegacy();
-   return legacy.charge(orderId);
- }`}
                    </pre>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-emerald-500 mb-1.5">Synthesized Candidate (Unified Slice)</div>
                    <pre className={`p-4 rounded-xl border font-mono text-[11px] leading-relaxed overflow-x-auto ${
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
                  <h1 className="text-2xl font-semibold tracking-tight">Policy Review & Sign-Off</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Invariant 5 enforcement and authorized human lead sign-off required for CAS lock release.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className={`p-5 rounded-xl border space-y-3 ${
                    darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                  }`}>
                    <h3 className="text-xs font-semibold text-[#0071E3]">TYPED CONDITIONAL PREDICATES</h3>
                    <div className="space-y-2.5">
                      {predicates.map((p) => (
                        <label key={p.id} className="flex items-center space-x-2 text-xs font-mono cursor-pointer">
                          <input
                            type="checkbox"
                            checked={p.checked}
                            onChange={(e) => {
                              setPredicates(predicates.map(item => item.id === p.id ? { ...item, checked: e.target.checked } : item));
                            }}
                            className="w-3.5 h-3.5 rounded text-[#0071E3]"
                          />
                          <span>{p.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className={`p-5 rounded-xl border space-y-4 ${
                    darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-[#F9F9FA] border-black/[0.06]'
                  }`}>
                    <h3 className="text-xs font-semibold text-[#0071E3]">HUMAN PROMOTION SIGN-OFF</h3>
                    <div>
                      <label className="block text-[11px] font-medium mb-1">Authorized Role</label>
                      <select
                        value={policyRole}
                        onChange={(e) => setPolicyRole(e.target.value as any)}
                        className={`w-full p-2 rounded-lg text-xs border ${
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
                      className={`w-full py-2.5 rounded-lg text-xs font-medium text-white shadow-sm ${
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
                  <h1 className="text-2xl font-semibold tracking-tight">Canonical Digest Explorer</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Deterministic RFC 8949 CBOR serializer and SHA-256 hasher matching Rust engine.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <textarea
                      rows={12}
                      value={jsonInput}
                      onChange={(e) => setJsonInput(e.target.value)}
                      className={`w-full p-3.5 rounded-xl border font-mono text-[11px] ${
                        darkMode ? 'bg-[#18181A] border-white/[0.08] text-white' : 'bg-[#F9F9FA] border-black/[0.08]'
                      }`}
                    />
                    <button
                      onClick={handleCalculateDigest}
                      className="px-4 py-2 bg-[#0071E3] text-white text-xs font-medium rounded-lg shadow-sm"
                    >
                      Recompute Digest
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div className={`p-4 rounded-xl border ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-[#F9F9FA] border-black/[0.08]'
                    }`}>
                      <div className="text-[11px] font-semibold text-[#0071E3] mb-1">COMPUTED DIGEST</div>
                      <div className="font-mono text-xs break-all font-semibold select-all text-[#0071E3]">{computedDigest}</div>
                    </div>
                    <div className={`p-4 rounded-xl border ${
                      darkMode ? 'bg-[#18181A] border-white/[0.08]' : 'bg-[#F9F9FA] border-black/[0.08]'
                    }`}>
                      <div className="text-[11px] font-semibold mb-1">CBOR HEX BYTES</div>
                      <div className="font-mono text-[10px] break-all max-h-40 overflow-y-auto">{cborHex}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* AUDIT TRAIL */}
            {activeTab === 'audit' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">Audit Trail & Retention Ledger</h1>
                  <p className={`text-[13px] mt-0.5 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Immutable record ledger tagged with explicit retention classes.
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono">
                    <thead>
                      <tr className={`border-b ${darkMode ? 'border-white/[0.08] text-[#86868B]' : 'border-black/[0.08] text-[#86868B]'}`}>
                        <th className="pb-2.5">EVENT</th>
                        <th className="pb-2.5">SUBJECT DIGEST</th>
                        <th className="pb-2.5">RETENTION</th>
                        <th className="pb-2.5">STORAGE REF</th>
                        <th className="pb-2.5 text-right">STATUS</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                      {[
                        { event: 'External CD Attestation', digest: 'e18654ed5c...', retention: 'CANONICAL', ref: 'r2://attestations/intent_8871.json', status: 'SUCCEEDED' },
                        { event: 'Hermetic Sandbox Receipt', digest: '180a9e8977...', retention: 'DECISION_RECORD', ref: 'r2://evidence/exec_1002.json', status: 'PASSED' },
                        { event: 'Candidate Reduction Spec', digest: 'e7e3e6b4aa...', retention: 'CANONICAL', ref: 'r2://specs/cand-spec-01.cbor', status: 'REDUCED' },
                        { event: 'Transient Smoke Run', digest: '4a187e5fd6...', retention: 'EPHEMERAL', ref: 'r2://scratch/temp_run.json', status: 'EXPIRED' },
                      ].map((row, idx) => (
                        <tr key={idx} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                          <td className="py-3 font-semibold text-[#0071E3]">{row.event}</td>
                          <td className="py-3 text-slate-400 select-all">{row.digest}</td>
                          <td className="py-3">
                            <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#34C759]/10 text-[#34C759]">
                              {row.retention}
                            </span>
                          </td>
                          <td className="py-3 text-[#86868B] truncate max-w-xs">{row.ref}</td>
                          <td className="py-3 text-right text-[#34C759] font-medium">{row.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* PANE 3: macOS Right Inspector Panel (Collapsible) */}
          {inspectorOpen && (
            <aside className={`w-72 border-l shrink-0 p-4 space-y-4 overflow-y-auto transition-colors ${
              darkMode ? 'bg-[#18181A] border-black/40' : 'bg-[#F2F2F7]/50 border-black/[0.08]'
            }`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] font-semibold tracking-wider ${
                  darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'
                }`}>
                  INSPECTOR
                </span>
                <span className="text-[10px] font-mono text-[#0071E3]">
                  RFC 8949
                </span>
              </div>

              {/* Selected Target Card */}
              <div className={`p-3.5 rounded-xl border text-xs space-y-2 ${
                darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.06] shadow-sm'
              }`}>
                <div className="font-semibold text-[12px]">Selected Entity</div>
                <div className="text-[11px] font-mono text-[#0071E3] break-all">{selectedDagNode}</div>
                <div className="text-[10px] text-[#86868B]">Validated via 3-tier digest hierarchy</div>
              </div>

              {/* Identity Breakdown */}
              <div className="space-y-2 text-xs">
                <span className={`text-[10px] font-semibold tracking-wider block ${
                  darkMode ? 'text-[#86868B]' : 'text-[#8E8E93]'
                }`}>
                  PROJECTION PROVENANCE
                </span>

                <div className={`p-3 rounded-xl border text-[11px] font-mono space-y-1.5 ${
                  darkMode ? 'bg-[#28282A] border-white/[0.06]' : 'bg-white border-black/[0.06] shadow-sm'
                }`}>
                  <div className="flex justify-between">
                    <span className="text-[#86868B]">Domain:</span>
                    <span className="truncate max-w-[120px]">klocgit/candidate</span>
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

              {/* Quick Actions */}
              <div className="space-y-1.5 pt-2">
                <button
                  onClick={() => copyToClipboard(computedDigest, 'inspector')}
                  className={`w-full py-2 px-3 rounded-lg text-xs font-medium border flex items-center justify-center space-x-2 transition-colors ${
                    darkMode ? 'bg-[#28282A] border-white/[0.08] hover:bg-[#323235]' : 'bg-white border-black/[0.08] hover:bg-[#F2F2F7]'
                  }`}
                >
                  {copiedText === 'inspector' ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedText === 'inspector' ? 'Copied Digest' : 'Copy Active Digest'}</span>
                </button>
              </div>
            </aside>
          )}
        </div>
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
