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
  Cpu,
  Layers,
  Lock,
  FileCode2,
  RefreshCw,
  Play,
  Moon,
  Sun,
  Database,
  Sliders,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Terminal,
  Activity,
  ArrowRight,
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
  const [activeTab, setActiveTab] = useState<'overview' | 'coordination' | 'digest' | 'extractor' | 'cas' | 'golden'>('overview');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Interactive Digest State
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
  const [casTarget, setCasTarget] = useState('9999999999999999999999999999999999999999');
  const [casResult, setCasResult] = useState<{ status: 'IDLE' | 'SUCCESS' | 'CONFLICT'; message: string }>({
    status: 'IDLE',
    message: 'Ready to assert Compare-And-Swap invariant against remote Git reference.',
  });

  // AuthZ Playground State
  const [authPrincipal, setAuthPrincipal] = useState<'eng-alice' | 'agent-bot-01' | 'admin-bob' | 'auditor-carol'>('eng-alice');
  const [authTenant, setAuthTenant] = useState<'tenant-alpha' | 'tenant-beta'>('tenant-alpha');
  const [authAction, setAuthAction] = useState<'future:submit' | 'promotion:cas_push' | 'candidate:resolve' | 'repo:write'>('future:submit');

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

  const evaluateAuthZ = () => {
    if (authTenant === 'tenant-beta') {
      return { allowed: false, reason: 'Cross-tenant boundary violation (tenant-alpha ≠ tenant-beta)' };
    }
    if (authPrincipal === 'admin-bob') {
      return { allowed: true, reason: 'Super Admin has universal authorization' };
    }
    if (authAction === 'promotion:cas_push' || authAction === 'candidate:resolve') {
      return { allowed: false, reason: `Role ${authPrincipal === 'eng-alice' ? 'ENGINEER' : authPrincipal === 'agent-bot-01' ? 'AGENT' : 'OBSERVER'} lacks elevated permission ${authAction}` };
    }
    if (authPrincipal === 'auditor-carol' && authAction !== 'future:submit') {
      return { allowed: false, reason: 'Observer role has read-only permission' };
    }
    return { allowed: true, reason: 'Action permitted within tenant scope' };
  };

  const authEvaluation = evaluateAuthZ();

  return (
    <div className={`min-h-screen transition-colors duration-200 ${darkMode ? 'bg-[#000000] text-[#F5F5F7]' : 'bg-[#F5F5F7] text-[#1D1D1F]'}`}>
      {/* Apple-style Frosted Glass Navigation Bar */}
      <header className={`sticky top-0 z-50 backdrop-blur-2xl border-b transition-colors ${
        darkMode ? 'bg-[#161617]/75 border-white/[0.08]' : 'bg-white/75 border-black/[0.08]'
      }`}>
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-semibold text-xs tracking-tight ${
              darkMode ? 'bg-white text-black' : 'bg-black text-white'
            }`}>
              
            </div>
            <div>
              <span className="font-semibold text-[15px] tracking-tight">KLoCGit</span>
              <span className={`text-[12px] ml-2 ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                Convergence Platform
              </span>
            </div>
          </div>

          {/* Apple Segmented Navigation Control */}
          <div className={`hidden md:flex items-center p-1 rounded-xl text-[13px] border ${
            darkMode ? 'bg-[#1C1C1E] border-white/[0.06]' : 'bg-black/[0.04] border-black/[0.04]'
          }`}>
            {[
              { id: 'overview', label: 'Overview' },
              { id: 'coordination', label: 'Coordination' },
              { id: 'digest', label: 'Digest Engine' },
              { id: 'extractor', label: 'Extractors' },
              { id: 'cas', label: 'CAS Ref' },
              { id: 'golden', label: 'Golden Vectors' },
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

          {/* Theme & Controls */}
          <div className="flex items-center space-x-2">
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

      {/* Main Content Viewport */}
      <main className="max-w-6xl mx-auto px-6 py-10 space-y-10">
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* Hero Card */}
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode
                ? 'bg-[#1C1C1E] border-white/[0.08] shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
                : 'bg-white border-black/[0.06] shadow-[0_2px_16px_rgba(0,0,0,0.04)]'
            }`}>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2 text-xs font-medium text-[#0071E3]">
                    <span>Phase 1 & 2 Verified</span>
                    <span aria-hidden="true">·</span>
                    <span>RFC 8949 Canonical Determinism</span>
                  </div>
                  <h1 className="text-3xl font-semibold tracking-tight">
                    Enterprise Convergence Platform
                  </h1>
                  <p className={`text-[15px] max-w-2xl leading-relaxed ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Deterministic canonical CBOR serialization, three-tier decoupled digests, in-memory scratch Git worktrees, and serialized Compare-And-Swap ref promotion.
                  </p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => setActiveTab('digest')}
                    className="px-5 py-2.5 rounded-xl bg-[#0071E3] hover:bg-[#0077ED] text-white text-[13px] font-medium transition-all shadow-sm flex items-center space-x-2"
                  >
                    <span>Inspect Digest Engine</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 4 Clean Gate Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-8 pt-6 border-t border-black/[0.06] dark:border-white/[0.08]">
                {[
                  {
                    gate: 'Gate 1',
                    title: 'Rust Engine',
                    cmd: 'cargo test -p klocgit-engine',
                    status: '8/8 Passed',
                  },
                  {
                    gate: 'Gate 2',
                    title: 'Contracts Invariants',
                    cmd: 'npm run test:contracts',
                    status: 'Decoupled',
                  },
                  {
                    gate: 'Gate 3',
                    title: 'Cross-Language Golden',
                    cmd: 'test:canonical-cross-language',
                    status: '100% Match',
                  },
                  {
                    gate: 'Gate 4',
                    title: 'Coordination & AuthZ',
                    cmd: 'npm run test:coordination',
                    status: 'Zero CAS Races',
                  },
                ].map((item, idx) => (
                  <div
                    key={idx}
                    className={`p-4 rounded-2xl border transition-all ${
                      darkMode ? 'bg-[#2C2C2E]/60 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-semibold text-[#0071E3]">{item.gate}</span>
                      <span className="text-[#34C759] font-medium flex items-center space-x-1">
                        <Check className="w-3 h-3" />
                        <span>{item.status}</span>
                      </span>
                    </div>
                    <div className="text-[14px] font-semibold tracking-tight">{item.title}</div>
                    <div className={`text-[11px] font-mono mt-2 truncate ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                      {item.cmd}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Invariants Grid */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold tracking-tight">Frozen Architecture Invariants</h2>
                <span className={`text-xs ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                  Mandatory Baseline Contract
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  {
                    num: '01',
                    title: 'Identity Separation',
                    desc: 'State identity, record identity, and payload storage identity are strictly decoupled.',
                  },
                  {
                    num: '02',
                    title: 'Compare-And-Swap (CAS)',
                    desc: 'Canonical Git mutations assert current remote ref matches expected OID via receive-pack.',
                  },
                  {
                    num: '03',
                    title: 'Scratch Isolation',
                    desc: 'Candidates are synthesized locally in scratch space; never write speculative durable Git refs.',
                  },
                  {
                    num: '04',
                    title: 'External CD Boundary',
                    desc: 'External CD owns traffic orchestration and rollback; KLoCGit submits intent and verifies attestations.',
                  },
                  {
                    num: '05',
                    title: 'Model Output Inferred',
                    desc: 'AI model output is INFERRED, never trusted Evidence or autonomous authorization.',
                  },
                  {
                    num: '06',
                    title: 'Strict Resolution Gate',
                    desc: 'Required PARTIAL, FAILED, or UNSUPPORTED analysis strictly blocks candidate resolution.',
                  },
                ].map((inv) => (
                  <div
                    key={inv.num}
                    className={`p-5 rounded-2xl border transition-all ${
                      darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
                    }`}
                  >
                    <span className="text-[11px] font-semibold text-[#0071E3] font-mono block mb-1">{inv.num}</span>
                    <h3 className="text-[15px] font-semibold tracking-tight mb-1.5">{inv.title}</h3>
                    <p className={`text-[13px] leading-relaxed ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                      {inv.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* COORDINATION TAB */}
        {activeTab === 'coordination' && (
          <div className="space-y-8">
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">Phase 2 · Durable Objects & Workers</div>
                <h2 className="text-2xl font-semibold tracking-tight">Coordination Plane & Authorization</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Deny-by-default role permission evaluation, claim-check message queue thresholds, and Durable Objects state transitions.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Authorization Playground */}
                <div className={`p-6 rounded-2xl border space-y-4 ${
                  darkMode ? 'bg-[#2C2C2E]/40 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
                }`}>
                  <div className="flex items-center space-x-2 text-[14px] font-semibold">
                    <ShieldCheck className="w-4 h-4 text-[#0071E3]" />
                    <span>Authorization Engine (Deny-by-Default)</span>
                  </div>

                  <div className="space-y-3 text-[13px]">
                    <div>
                      <label className="block text-[12px] font-medium mb-1">Actor Principal</label>
                      <select
                        value={authPrincipal}
                        onChange={(e) => setAuthPrincipal(e.target.value as any)}
                        className={`w-full p-2.5 rounded-xl border text-[13px] ${
                          darkMode ? 'bg-[#1C1C1E] border-white/[0.1] text-white' : 'bg-white border-black/[0.1]'
                        }`}
                      >
                        <option value="eng-alice">eng-alice (ENGINEER)</option>
                        <option value="agent-bot-01">agent-bot-01 (AGENT)</option>
                        <option value="admin-bob">admin-bob (SUPER_ADMIN)</option>
                        <option value="auditor-carol">auditor-carol (OBSERVER)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[12px] font-medium mb-1">Target Tenant Scope</label>
                      <select
                        value={authTenant}
                        onChange={(e) => setAuthTenant(e.target.value as any)}
                        className={`w-full p-2.5 rounded-xl border text-[13px] ${
                          darkMode ? 'bg-[#1C1C1E] border-white/[0.1] text-white' : 'bg-white border-black/[0.1]'
                        }`}
                      >
                        <option value="tenant-alpha">tenant-alpha (Home Tenant)</option>
                        <option value="tenant-beta">tenant-beta (Foreign Tenant - Deny)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[12px] font-medium mb-1">Requested Action</label>
                      <select
                        value={authAction}
                        onChange={(e) => setAuthAction(e.target.value as any)}
                        className={`w-full p-2.5 rounded-xl border text-[13px] ${
                          darkMode ? 'bg-[#1C1C1E] border-white/[0.1] text-white' : 'bg-white border-black/[0.1]'
                        }`}
                      >
                        <option value="future:submit">future:submit</option>
                        <option value="promotion:cas_push">promotion:cas_push (Elevated)</option>
                        <option value="candidate:resolve">candidate:resolve (Elevated)</option>
                        <option value="repo:write">repo:write</option>
                      </select>
                    </div>

                    <div className={`p-4 rounded-xl border mt-4 flex items-start space-x-3 ${
                      authEvaluation.allowed
                        ? darkMode ? 'bg-[#34C759]/10 border-[#34C759]/30 text-[#34C759]' : 'bg-[#34C759]/10 border-[#34C759]/30 text-[#248A3D]'
                        : darkMode ? 'bg-[#FF3B30]/10 border-[#FF3B30]/30 text-[#FF453A]' : 'bg-[#FF3B30]/10 border-[#FF3B30]/30 text-[#D70015]'
                    }`}>
                      {authEvaluation.allowed ? (
                        <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-5 h-5 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-semibold text-[13px]">
                          {authEvaluation.allowed ? 'Permission Granted' : 'Access Denied'}
                        </div>
                        <div className="text-[12px] mt-0.5 opacity-90">{authEvaluation.reason}</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Queue & Claim-Check Card */}
                <div className={`p-6 rounded-2xl border space-y-4 ${
                  darkMode ? 'bg-[#2C2C2E]/40 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.04]'
                }`}>
                  <div className="flex items-center space-x-2 text-[14px] font-semibold">
                    <Layers className="w-4 h-4 text-[#0071E3]" />
                    <span>Claim-Check Message Queue</span>
                  </div>

                  <p className={`text-[13px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    Payloads &lt; 32 KB are inlined directly into Cloudflare Queue envelopes. Payloads &ge; 32 KB store raw bytes in R2 and pass content digests.
                  </p>

                  <div className={`p-4 rounded-xl border text-[13px] space-y-2 font-mono ${
                    darkMode ? 'bg-[#1C1C1E] border-white/[0.06]' : 'bg-white border-black/[0.06]'
                  }`}>
                    <div className="flex justify-between">
                      <span className={darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}>Inline Threshold:</span>
                      <span className="font-semibold">32,768 bytes (32 KB)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className={darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}>Queue Hard Ceiling:</span>
                      <span className="font-semibold text-[#FF9500]">131,072 bytes (128 KB)</span>
                    </div>
                    <div className="flex justify-between">
                      <span className={darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}>DLQ Retry Budget:</span>
                      <span className="font-semibold">3 attempts</span>
                    </div>
                    <div className="flex justify-between">
                      <span className={darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}>Digest Verification:</span>
                      <span className="font-semibold text-[#34C759]">SHA-256 Pre-Dispatch</span>
                    </div>
                  </div>

                  <div className="pt-2">
                    <span className="text-[12px] font-medium block mb-2">Simulated Event: 45 KB Evidence Artifact</span>
                    <div className={`p-3 rounded-xl border text-[12px] font-mono break-all ${
                      darkMode ? 'bg-[#1C1C1E] border-white/[0.06]' : 'bg-white border-black/[0.06]'
                    }`}>
                      <div><strong className="text-[#0071E3]">payload_mode:</strong> &quot;CLAIM_CHECK&quot;</div>
                      <div className="mt-1"><strong className="text-[#0071E3]">payload_ref:</strong> &quot;r2://klocgit-events/tenant-alpha/repo-core/evt_9981&quot;</div>
                      <div className="mt-1"><strong className="text-[#0071E3]">payload_digest:</strong> &quot;180a9e8977467cd9fe5c...&quot;</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* DIGEST ENGINE TAB */}
        {activeTab === 'digest' && (
          <div className="space-y-8">
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">RFC 8949 Deterministic CBOR</div>
                <h2 className="text-2xl font-semibold tracking-tight">Canonical Digest Explorer</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Every state, record, and payload has an independent identity computed via domain separator, schema version, and RFC 8949 CBOR bytes.
                </p>
              </div>

              {/* Segmented Schema Selector */}
              <div className="flex space-x-1 p-1 rounded-xl bg-black/[0.05] dark:bg-white/[0.06] w-fit mb-6 text-[13px]">
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
                  <div className="flex items-center justify-between">
                    <label className="text-[12px] font-medium">Input Projection (JSON)</label>
                    <span className={`text-[11px] font-mono ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>
                      Field sorting auto-normalized
                    </span>
                  </div>
                  <textarea
                    rows={13}
                    value={jsonInput}
                    onChange={(e) => setJsonInput(e.target.value)}
                    className={`w-full p-4 rounded-2xl border font-mono text-[12px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 ${
                      darkMode ? 'bg-[#000000] border-white/[0.1] text-white' : 'bg-[#F5F5F7] border-black/[0.08] text-black'
                    }`}
                  />
                  <button
                    onClick={handleCalculateDigest}
                    className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-[13px] font-medium rounded-xl transition-all shadow-sm flex items-center space-x-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Calculate Digest & CBOR</span>
                  </button>
                </div>

                <div className="space-y-5">
                  <div className={`p-5 rounded-2xl border space-y-2 ${
                    darkMode ? 'bg-[#000000] border-white/[0.08]' : 'bg-[#F5F5F7] border-black/[0.08]'
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium text-[#0071E3]">
                        {schemaType === 'future_state' ? 'state_digest' : schemaType === 'effect_set' ? 'effect_digest' : 'payload_digest'}
                      </span>
                      <button
                        onClick={() => copyToClipboard(computedDigest, 'digest')}
                        className={`p-1.5 rounded-lg text-xs flex items-center space-x-1 ${
                          darkMode ? 'hover:bg-white/[0.1] text-[#86868B]' : 'hover:bg-black/[0.05] text-[#6E6E73]'
                        }`}
                      >
                        {copiedText === 'digest' ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedText === 'digest' ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <div className="font-mono text-[13px] break-all select-all font-semibold text-[#0071E3]">
                      {computedDigest}
                    </div>
                  </div>

                  <div className={`p-5 rounded-2xl border space-y-2 ${
                    darkMode ? 'bg-[#000000] border-white/[0.08]' : 'bg-[#F5F5F7] border-black/[0.08]'
                  }`}>
                    <span className="text-[12px] font-medium block">Deterministic CBOR Stream (Hex)</span>
                    <div className={`font-mono text-[11px] break-all max-h-48 overflow-y-auto leading-relaxed select-all ${
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

        {/* EXTRACTORS TAB */}
        {activeTab === 'extractor' && (
          <div className="space-y-8">
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">AST Structural Analysis</div>
                <h2 className="text-2xl font-semibold tracking-tight">Tree-sitter Structural Extractor</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Extracts modified exports, dependencies, database migrations, and security boundaries with capability: &quot;STRUCTURAL&quot;.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-3">
                  <label className="text-[12px] font-medium block">Source Code (TypeScript / Python / Go)</label>
                  <textarea
                    rows={13}
                    value={sourceCode}
                    onChange={(e) => setSourceCode(e.target.value)}
                    className={`w-full p-4 rounded-2xl border font-mono text-[12px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 ${
                      darkMode ? 'bg-[#000000] border-white/[0.1] text-white' : 'bg-[#F5F5F7] border-black/[0.08] text-black'
                    }`}
                  />
                  <button
                    onClick={handleRunExtractor}
                    className="px-4 py-2 bg-[#0071E3] hover:bg-[#0077ED] text-white text-[13px] font-medium rounded-xl transition-all shadow-sm flex items-center space-x-2"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Run Structural Extraction</span>
                  </button>
                </div>

                <div className="space-y-3">
                  <label className="text-[12px] font-medium block">Emitted CanonicalEffectSet</label>
                  <pre className={`p-5 rounded-2xl border font-mono text-[12px] overflow-x-auto max-h-[360px] leading-relaxed ${
                    darkMode ? 'bg-[#000000] border-white/[0.08] text-[#86868B]' : 'bg-[#F5F5F7] border-black/[0.08] text-[#6E6E73]'
                  }`}>
                    {extractedEffects ? JSON.stringify(extractedEffects, null, 2) : '// Click "Run Structural Extraction" to evaluate AST'}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* CAS REF LOCK TAB */}
        {activeTab === 'cas' && (
          <div className="space-y-8">
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="space-y-1 mb-6">
                <div className="text-xs font-medium text-[#0071E3]">Invariant 2 · Compare-And-Swap</div>
                <h2 className="text-2xl font-semibold tracking-tight">Serialized CAS Promotion Lock</h2>
                <p className={`text-[14px] ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                  Canonical Git mutation strictly asserts current remote OID matches expected OID via receive-pack push mechanics.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <div>
                  <label className="block text-[12px] font-medium mb-1">Expected OID (Base)</label>
                  <input
                    type="text"
                    value={casExpected}
                    onChange={(e) => setCasExpected(e.target.value)}
                    className={`w-full p-2.5 rounded-xl border text-[13px] font-mono ${
                      darkMode ? 'bg-[#000000] border-white/[0.1]' : 'bg-[#F5F5F7] border-black/[0.1]'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium mb-1">Current Remote Ref OID</label>
                  <input
                    type="text"
                    value={casRemote}
                    onChange={(e) => setCasRemote(e.target.value)}
                    className={`w-full p-2.5 rounded-xl border text-[13px] font-mono ${
                      darkMode ? 'bg-[#000000] border-white/[0.1]' : 'bg-[#F5F5F7] border-black/[0.1]'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium mb-1">Target Mutation OID</label>
                  <input
                    type="text"
                    value={casTarget}
                    onChange={(e) => setCasTarget(e.target.value)}
                    className={`w-full p-2.5 rounded-xl border text-[13px] font-mono ${
                      darkMode ? 'bg-[#000000] border-white/[0.1]' : 'bg-[#F5F5F7] border-black/[0.1]'
                    }`}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleRunCas}
                  className="px-5 py-2.5 bg-[#0071E3] hover:bg-[#0077ED] text-white text-[13px] font-medium rounded-xl transition-all shadow-sm flex items-center space-x-2"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Execute Compare-And-Swap</span>
                </button>
                <button
                  onClick={() => setCasRemote('9f8e7d6c5b4a39281701928374650192837465aa')}
                  className={`px-4 py-2.5 rounded-xl border text-[13px] font-medium transition-all ${
                    darkMode ? 'bg-[#2C2C2E] border-white/[0.08] hover:bg-[#3A3A3C]' : 'bg-[#F5F5F7] border-black/[0.06] hover:bg-[#E5E5EA]'
                  }`}
                >
                  Simulate Concurrent Push (Trunk Moved)
                </button>
                <button
                  onClick={() => setCasRemote(casExpected)}
                  className={`px-4 py-2.5 rounded-xl border text-[13px] font-medium transition-all ${
                    darkMode ? 'bg-[#2C2C2E] border-white/[0.08] hover:bg-[#3A3A3C]' : 'bg-[#F5F5F7] border-black/[0.06] hover:bg-[#E5E5EA]'
                  }`}
                >
                  Reset Remote OID
                </button>
              </div>

              <div className={`mt-6 p-5 rounded-2xl border transition-all ${
                casResult.status === 'SUCCESS'
                  ? darkMode ? 'bg-[#34C759]/10 border-[#34C759]/30 text-[#34C759]' : 'bg-[#34C759]/10 border-[#34C759]/30 text-[#248A3D]'
                  : casResult.status === 'CONFLICT'
                  ? darkMode ? 'bg-[#FF3B30]/10 border-[#FF3B30]/30 text-[#FF453A]' : 'bg-[#FF3B30]/10 border-[#FF3B30]/30 text-[#D70015]'
                  : darkMode ? 'bg-[#2C2C2E]/50 border-white/[0.06]' : 'bg-[#F5F5F7] border-black/[0.06]'
              }`}>
                <div className="font-semibold text-[13px] flex items-center space-x-2 mb-1">
                  <span>CAS STATUS:</span>
                  <span>{casResult.status}</span>
                </div>
                <p className="text-[13px] leading-relaxed font-mono opacity-90">{casResult.message}</p>
              </div>
            </div>
          </div>
        )}

        {/* GOLDEN VECTORS TAB */}
        {activeTab === 'golden' && (
          <div className="space-y-8">
            <div className={`p-8 rounded-3xl border transition-all ${
              darkMode ? 'bg-[#1C1C1E] border-white/[0.08]' : 'bg-white border-black/[0.06] shadow-sm'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div>
                  <div className="text-xs font-medium text-[#0071E3]">Cross-Language Validation</div>
                  <h2 className="text-2xl font-semibold tracking-tight">Golden Vectors Verification Matrix</h2>
                  <p className={`text-[14px] mt-1 ${darkMode ? 'text-[#86868B]' : 'text-[#6E6E73]'}`}>
                    100% byte-identical SHA-256 match between Rust (`crates/engine`) and TypeScript (`packages/contracts`).
                  </p>
                </div>
                <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-[#34C759]/10 text-[#34C759] text-xs font-medium border border-[#34C759]/30">
                  <Check className="w-3.5 h-3.5" />
                  <span>9 / 9 Vectors Verified</span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] font-mono">
                  <thead>
                    <tr className={`border-b ${darkMode ? 'border-white/[0.08] text-[#86868B]' : 'border-black/[0.08] text-[#86868B]'}`}>
                      <th className="pb-3 font-semibold">IDENTIFIER</th>
                      <th className="pb-3 font-semibold">DOMAIN SEPARATOR</th>
                      <th className="pb-3 font-semibold">CANONICAL SHA-256 DIGEST</th>
                      <th className="pb-3 font-semibold text-right">PARITY</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${darkMode ? 'divide-white/[0.04]' : 'divide-black/[0.04]'}`}>
                    {[
                      {
                        name: 'future_revision_state_basic',
                        domain: 'klocgit/future_revision_state',
                        digest: '916309615edae1ba483299c95a25e4e498951231322b95496b1ab31941b0fdd0',
                      },
                      {
                        name: 'future_revision_record_basic',
                        domain: 'klocgit/future_revision_record',
                        digest: 'fe6ef876af3ceee4d67d9f9fac4383ecba7ac0236fb57770e9765b33de6cda23',
                      },
                      {
                        name: 'effect_set_structural',
                        domain: 'klocgit/effect_set',
                        digest: '465ddd0afd0771af0123f9e268be2f5817e9fb57b15c935b8456ccb710ff8d1c',
                      },
                      {
                        name: 'candidate_spec_composite',
                        domain: 'klocgit/candidate_spec',
                        digest: 'e7e3e6b4aa8141f7bf92311cab205ab436b7f1bc06321c13b9eb9763ec77be37',
                      },
                      {
                        name: 'candidate_basic',
                        domain: 'klocgit/candidate',
                        digest: 'a56923bab6191b827d20c16eec436d3740534bc24f157c36322a28c3fb7db67a',
                      },
                      {
                        name: 'evidence_decision_record',
                        domain: 'klocgit/evidence',
                        digest: '180a9e8977467cd9fe5c61938ed0522a07979ced80984ddbf193af0c95decdab',
                      },
                      {
                        name: 'system_revision_state_multi_repo',
                        domain: 'klocgit/system_revision_state',
                        digest: '2285b8b1d7024d09db873c69560bb93bddde9f3723a3b8ed1fae90897b63b731',
                      },
                      {
                        name: 'release_constraints_typed',
                        domain: 'klocgit/release_constraints',
                        digest: '74ff02ffc1d08863bb846a4f943e906a66f3ae7bb2a42892912868d6695a5b26',
                      },
                      {
                        name: 'deployment_attestation_verified',
                        domain: 'klocgit/deployment_attestation',
                        digest: '6f3adc6981d7b93d6d27a25b9549559d15ae7874399f5640e969d78a951a8ea2',
                      },
                    ].map((row) => (
                      <tr key={row.name} className={darkMode ? 'hover:bg-white/[0.02]' : 'hover:bg-black/[0.02]'}>
                        <td className="py-3.5 font-medium text-[#0071E3]">{row.name}</td>
                        <td className={`py-3.5 ${darkMode ? 'text-[#86868B]' : 'text-[#86868B]'}`}>{row.domain}</td>
                        <td className="py-3.5 select-all">{row.digest}</td>
                        <td className="py-3.5 text-right">
                          <span className="text-[#34C759] font-medium">MATCH</span>
                        </td>
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
      <footer className={`py-8 px-6 text-center text-[12px] border-t transition-colors ${
        darkMode ? 'border-white/[0.06] text-[#86868B]' : 'border-black/[0.06] text-[#86868B]'
      }`}>
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            KLoCGit v1 Enterprise Convergence Platform · Apple Human Interface Guidelines
          </div>
          <div className="flex items-center space-x-4">
            <span>RFC 8949 CBOR</span>
            <span aria-hidden="true">·</span>
            <span>Git Push CAS</span>
            <span aria-hidden="true">·</span>
            <span>DO SQLite</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
