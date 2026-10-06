// Read-only product scope, shared by the authenticated API and capability dialog.
// Test-file links locate automated coverage; they do not report execution or success.
const registry = {
  version: 0,
  verification_scope:
    'VERIFIED describes only the stated local runtime and test coverage. Finite validation does not prove global correctness, production security or a working live Cloudflare deployment.',
  statuses: [
    {
      id: 'VERIFIED',
      label: 'Verified locally',
      description:
        'Defined state, authorization, audit and failure behavior covered by automated tests in the stated local runtime. Infrastructure-dependent claims also require a live run.',
    },
    { id: 'PARTIAL', label: 'Partial', description: 'An implemented subset with explicit limits.' },
    {
      id: 'EXPERIMENTAL',
      label: 'Experimental',
      description: 'Integration code whose live deployment remains unverified.',
    },
    { id: 'UNSUPPORTED', label: 'Unsupported', description: 'No delivered operational workflow.' },
  ],
  capabilities: [
    {
      id: 'state.systems',
      category: 'Native state',
      title: 'Systems and Objectives',
      status: 'PARTIAL',
      tests: ['tests/native-state.test.mjs', 'tests/native-api.test.mjs'],
      scope:
        'Systems retain repository membership; optional Objectives record requested outcomes without requiring setup forms.',
      limits:
        'Repository state and Future observation are the delivered slice. General context discovery and Objective-driven decisions are not delivered.',
    },
    {
      id: 'git.repositories',
      category: 'Native state',
      title: 'Create, import and observe repositories',
      status: 'PARTIAL',
      tests: ['tests/native-state.test.mjs', 'tests/native-api.test.mjs'],
      scope:
        'Authenticated operations create empty repositories, import accepted public HTTPS sources and observe authoritative Git refs through the configured provider.',
      limits:
        'Empty repositories have no invented initial commit. Private imports and live Artifacts lifecycle verification are absent; token-free remotes do not grant Git access.',
    },
    {
      id: 'state.futures',
      category: 'Native state',
      title: 'Isolated Futures',
      status: 'PARTIAL',
      tests: ['tests/native-state.test.mjs', 'tests/native-api.test.mjs'],
      scope:
        'A Future forks ready repositories from pinned commit/tree baselines and retains producer identity or unknown provenance.',
      limits:
        'Native composition, evaluation and promotion are not delivered. New repositories require an operator-configured trusted validation profile and scoped credentials.',
    },
    {
      id: 'state.observation',
      category: 'Native state',
      title: 'Immutable Future observations',
      status: 'PARTIAL',
      tests: ['tests/native-state.test.mjs', 'tests/native-api.test.mjs'],
      scope:
        'Observed repository heads, trees and baselines form immutable revision vectors; changed or rewound heads create new revisions.',
      limits:
        'Git observations establish code identity, not behavior, semantic compatibility or trusted validation. Missing context remains unresolved.',
    },
    {
      id: 'git.clients',
      category: 'Git interoperability',
      title: 'Ordinary Git clients',
      status: 'VERIFIED',
      tests: ['tests/workflow-integration.test.mjs', 'tests/acceptance.test.mjs'],
      scope: 'Standard local branch and registered fork pushes, standalone review, clone and fsck.',
      limits:
        'Git remains usable independently. Every hosting protocol and live Cloudflare fork delivery are not verified.',
    },
    {
      id: 'git.revisions',
      category: 'Git interoperability',
      title: 'Immutable source revisions',
      status: 'VERIFIED',
      tests: ['tests/ingress.test.mjs', 'tests/acceptance.test.mjs'],
      scope:
        'Authoritative branch heads version force-pushes and rebases; duplicate, obsolete and deletion events are gated.',
      limits: 'Dedicated tag metadata and arbitrary non-branch ref coordination are absent.',
    },
    {
      id: 'mr.lifecycle',
      category: 'Compatibility adapters',
      title: 'Merge-request lifecycle adapter',
      status: 'VERIFIED',
      tests: ['tests/merge-requests.test.mjs', 'tests/workflow-integration.test.mjs'],
      scope:
        'Open, draft, ready, close, reopen and merge retain immutable source revisions and lifecycle events.',
      limits:
        'Registered canonical targets only; retargeting and multiple MRs per source identity are absent.',
    },
    {
      id: 'reviews.exact',
      category: 'Compatibility adapters',
      title: 'Revision-specific reviews and discussion',
      status: 'VERIFIED',
      tests: ['tests/merge-requests.test.mjs'],
      scope:
        'Approvals, requested changes, dismissals, batch reviews and anchored discussion threads retain exact revision pins.',
      limits: 'One configured owner identity; unresolved discussion threads do not gate merging.',
    },
    {
      id: 'dependencies.stacks',
      category: 'Compatibility adapters',
      title: 'Revision-pinned adapter dependencies',
      status: 'VERIFIED',
      tests: ['tests/merge-requests.test.mjs', 'tests/workflow-integration.test.mjs'],
      scope:
        'Dependency cycles, source updates and removed prerequisites are checked; current same-repo stacks can be reviewed together.',
      limits:
        'Updated dependencies require explicit declarations and review. There is no atomic cross-repo release.',
    },
    {
      id: 'evidence.trusted',
      category: 'Evidence and convergence',
      title: 'Exact trusted validation',
      status: 'VERIFIED',
      tests: [
        'tests/evidence-safety.test.mjs',
        'tests/merge-requests.test.mjs',
        'tests/application.test.mjs',
      ],
      scope:
        'Platform-owned checks bind tree, configuration, constraints and canonical head; stale or superseded runs lose eligibility.',
      limits:
        'Configured checkout and policy profiles only. New repositories do not inherit these profiles. Finite passing tests do not establish global correctness.',
    },
    {
      id: 'evidence.external',
      category: 'Evidence and convergence',
      title: 'Declared producer check reports',
      status: 'VERIFIED',
      tests: ['tests/merge-requests.test.mjs'],
      scope:
        'External reports retain their declared origin and cannot impersonate trusted platform validation.',
      limits:
        'Producer-supplied tests are never sole verification. General independently verified CI callbacks are absent.',
    },
    {
      id: 'context.retry',
      category: 'Context and provenance',
      title: 'Configured context before code',
      status: 'VERIFIED',
      tests: ['tests/context.test.mjs'],
      scope:
        'The retry-response-v0 task retrieves immutable cross-repo policy and prior decisions, asks one material question and binds the answer to code.',
      limits:
        'One task schema. Unanswered questions become explicit assumptions; no general context compiler or automatic user answers.',
    },
    {
      id: 'provenance.binding',
      category: 'Context and provenance',
      title: 'Immutable provenance references',
      status: 'VERIFIED',
      tests: ['tests/context.test.mjs', 'tests/acceptance.test.mjs'],
      scope:
        'Intent, context, proposals, decisions, evidence and code retain separate declared, retrieved, observed and inferred origins.',
      limits:
        'Unknown provenance is accepted at ingress and remains unknown. Producer claims are not verified facts or authorization to converge.',
    },
    {
      id: 'relationships.exact',
      category: 'Evidence and convergence',
      title: 'Exact identity and declared alternatives',
      status: 'VERIFIED',
      tests: ['tests/components.test.mjs', 'tests/merge-requests.test.mjs'],
      scope:
        'Byte-identical trees share implementation references while preserving separate proposal and intent histories.',
      limits:
        'Declared alternatives remain declarations. Similar text or high model confidence never establishes semantic equivalence.',
    },
    {
      id: 'decisions.groups',
      category: 'Evidence and convergence',
      title: 'Derived decisions and checked compositions',
      status: 'PARTIAL',
      tests: ['tests/components.test.mjs', 'tests/acceptance.test.mjs'],
      scope:
        'Alternative and conflict edges form deterministic components; actual composed trees receive trusted interaction checks.',
      limits:
        'Unknown work remains separate. Detection uses configured footprints; absent edges are not compatibility proof, and oversized groups require conventional review.',
    },
    {
      id: 'queue.exact',
      category: 'Compatibility adapters',
      title: 'Reviewed adapter queue',
      status: 'VERIFIED',
      tests: ['tests/merge-queue.test.mjs', 'tests/workflow-integration.test.mjs'],
      scope:
        'Tickets pin the reviewed composition, evidence, MR basis and canonical head; one guarded update runs at a time.',
      limits:
        'Changed pins require fresh review and a new ticket. No automatic rebase, silent approval refresh or uncertain-write retry.',
    },
    {
      id: 'canonical.cas',
      category: 'Canonical updates',
      title: 'Reviewed Git compare-and-set',
      status: 'VERIFIED',
      tests: ['tests/acceptance.test.mjs', 'tests/remote-git.test.mjs'],
      scope:
        'Authenticated serialized updates compare both canonical Git head and the decision basis before applying a selected composition.',
      limits:
        'Stale decisions return 409 and require review. Each operation advances one repository, with no distributed ref transaction.',
    },
    {
      id: 'canonical.revert',
      category: 'Canonical updates',
      title: 'Reviewed reverts',
      status: 'VERIFIED',
      tests: ['tests/revert.test.mjs'],
      scope:
        'Inverse candidates link to their original decision or Git commit and receive validation and fresh review against current Git.',
      limits:
        'Merge mainline selection is explicit; inverse conflicts require judgment. History is retained.',
    },
    {
      id: 'audit.journal',
      category: 'Canonical updates',
      title: 'Audit journal and uncertain recovery',
      status: 'VERIFIED',
      tests: ['tests/acceptance.test.mjs', 'tests/workflow-integration.test.mjs'],
      scope:
        'Hash-linked records reconcile prepared operations with actual Git refs and recover exact applied or deferred dispositions.',
      limits:
        'Recovery does not repeat uncertain CAS. Storage is app-managed, without independent immutable retention or signed anchors.',
    },
    {
      id: 'security.runner',
      category: 'Trust boundaries',
      title: 'Isolated producer execution',
      status: 'VERIFIED',
      tests: ['tests/application.test.mjs'],
      scope:
        'Local trusted validation uses read-only candidate trees, restricted network and scrubbed credentials with bounded external effects.',
      limits:
        'Tested local Linux configuration only; deployed Container isolation and a comprehensive security audit remain unverified.',
    },
    {
      id: 'security.identity',
      category: 'Trust boundaries',
      title: 'Owner and service authentication',
      status: 'PARTIAL',
      tests: ['tests/workflow-api.test.mjs', 'tests/artifacts.test.mjs'],
      scope:
        'One configured owner identity and separate authenticated service boundaries select actors independently of producer input.',
      limits: 'No multi-user authentication, organizational membership or repository RBAC.',
    },
    {
      id: 'ui.decisions',
      category: 'Product surface',
      title: 'Decision-focused review',
      status: 'PARTIAL',
      tests: ['tests/browser-native.smoke.mjs'],
      scope:
        'Attention is primary; native repositories and Futures coexist with the existing decision, work, evidence and history views.',
      limits:
        'Local desktop/mobile smoke coverage only; comprehensive accessibility, all legacy workflows, generic historical search and live Cloudflare UI behavior are not verified.',
    },
    {
      id: 'metrics.bounded',
      category: 'Product surface',
      title: 'Bounded acceptance metrics',
      status: 'VERIFIED',
      tests: ['tests/acceptance.test.mjs'],
      scope:
        'Reports decision compression, stale evidence, CAS handling, rationale coverage, analysis latency and avoided comparisons.',
      limits:
        'Demo measurements are finite examples. Convergence counts do not include upstream clarification; no representative review-time, false-grouping or scale benchmark exists.',
    },
    {
      id: 'cloudflare.lifecycle',
      category: 'Deployment',
      title: 'Artifacts repository and Future lifecycle',
      status: 'EXPERIMENTAL',
      tests: [
        'tests/artifacts.test.mjs',
        'tests/native-state.test.mjs',
        'tests/native-api.test.mjs',
      ],
      scope:
        'Provider adapters create, import, inspect and fork repositories while returning token-free descriptors.',
      limits:
        'API and executor tests do not verify live Artifacts lifecycle, scoped credential provisioning, imports, native push delivery or recovery.',
    },
    {
      id: 'cloudflare.live',
      category: 'Deployment',
      title: 'Cloudflare integration',
      status: 'EXPERIMENTAL',
      tests: ['tests/artifacts.test.mjs', 'tests/remote-git.test.mjs', 'tests/executor.test.mjs'],
      scope:
        'Artifacts, Worker, Queue, Durable Object and trusted Git executor adapters are implemented.',
      limits:
        'Live provisioning, native push delivery, races, recovery and Container isolation remain unverified without account credentials.',
    },
    {
      id: 'composition.native',
      category: 'Native state',
      title: 'Native selection, composition and promotion',
      status: 'PARTIAL',
      tests: ['tests/native-pipeline.test.mjs', 'tests/browser-native.smoke.mjs'],
      scope:
        'Pinned whole-Future and ordered non-merge commit selections produce retained Git candidates. Exact-tree trusted validation gates single-repository promotion through the shared basis/head CAS and recovery journal.',
      limits:
        'No file/hunk selection, proven semantic dependency closure or multi-repository promotion. Live Artifacts execution requires operator-admitted source repositories and trusted validation profiles.',
    },
    {
      id: 'evaluation.general',
      category: 'Undelivered product capabilities',
      title: 'General evaluation and executable previews',
      status: 'UNSUPPORTED',
      scope:
        'The specified evaluation stages include builds, security checks, external attestations, runtime previews and targeted experiments.',
      limits:
        'Configured local application checks exist. General evaluator registration, arbitrary toolchains and Worker Preview lifecycle integration are not delivered.',
    },
    {
      id: 'context.general',
      category: 'Undelivered product capabilities',
      title: 'General context and architectural memory',
      status: 'UNSUPPORTED',
      scope:
        'Relevant historical constraints, existing capabilities and cross-repository context should inform material clarification.',
      limits:
        'Only the configured retry task exists. General retrieval, duplicate-work prevention and organizational decision search are not delivered.',
    },
    {
      id: 'decisions.semantic',
      category: 'Undelivered product capabilities',
      title: 'General decision discovery',
      status: 'UNSUPPORTED',
      scope:
        'Unseen concurrent work should expose material alternatives and interactions without hand-authored grouping.',
      limits:
        'Configured deterministic grouping exists. General semantic discovery, symbol analysis and measured grouping precision or recall are not delivered.',
    },
    {
      id: 'canonical.multi',
      category: 'Undelivered product capabilities',
      title: 'Coordinated multi-repository promotion',
      status: 'UNSUPPORTED',
      scope:
        'The specified rollout model includes explicit partial application and recovery across repository vectors.',
      limits:
        'Existing canonical operations advance one repository. A multi-repository Future does not provide atomic or coordinated multi-repository promotion.',
    },
    {
      id: 'providers.sync',
      category: 'Undelivered product capabilities',
      title: 'External provider synchronization',
      status: 'UNSUPPORTED',
      scope:
        'Forge, CI, task-tracker and agent adapters should preserve native states and decision provenance.',
      limits:
        'No GitHub, GitLab, Gerrit or external CI synchronization workflow is delivered. Ordinary Git and the existing local MR adapter remain usable.',
    },
    {
      id: 'platform.protocol',
      category: 'Undelivered product capabilities',
      title: 'Stable protocol and SDKs',
      status: 'UNSUPPORTED',
      scope:
        'The specification calls for versioned schemas, OpenAPI, CloudEvents and optional ecosystem SDKs.',
      limits:
        'OpenAPI 3.1 documents the current v0 native HTTP subset. A stable Futures Protocol, SDK distribution and versioned native CloudEvents are not delivered.',
    },
    {
      id: 'enterprise.governance',
      category: 'Undelivered product capabilities',
      title: 'Organizational governance',
      status: 'UNSUPPORTED',
      scope:
        'Organizations, SSO, repository authorization, policy, quotas, retention and audit export belong to the product plan.',
      limits:
        'The current single-owner trust model does not provide these workflows or independently enforced immutable audit storage.',
    },
    {
      id: 'scale.benchmarks',
      category: 'Undelivered product capabilities',
      title: 'Representative scale and product benchmarks',
      status: 'UNSUPPORTED',
      scope:
        'Compare real histories and conventional workflows across repository sizes, event bursts, review effort, decision quality and compute cost.',
      limits:
        'Bounded adversarial tests exist. Production-scale scheduling, cost budgets and representative performance or product comparison results are not delivered.',
    },
  ],
};

export function getCapabilities() {
  return structuredClone(registry);
}
