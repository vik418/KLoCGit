// Read-only product scope, shared by the authenticated API and capability dialog.
// Test-file links locate automated coverage; they do not report execution or success.
const registry = {
  version: 1,
  verification_scope:
    'Support describes bounded local behavior. Finite validation does not prove global correctness, production security or a working live Cloudflare deployment.',
  statuses: [
    {
      id: 'SUPPORTED',
      label: 'Supported locally',
      description: 'Implemented and tested within the stated local scope.',
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
      id: 'git.clients',
      category: 'Git interoperability',
      title: 'Ordinary Git clients',
      status: 'SUPPORTED',
      tests: ['tests/workflow-integration.test.mjs', 'tests/acceptance.test.mjs'],
      scope: 'Standard local branch and registered fork pushes, standalone review, clone and fsck.',
      limits:
        'Git remains usable independently. Every hosting protocol and live Cloudflare fork delivery are not verified.',
    },
    {
      id: 'git.revisions',
      category: 'Git interoperability',
      title: 'Immutable source revisions',
      status: 'SUPPORTED',
      tests: ['tests/ingress.test.mjs', 'tests/acceptance.test.mjs'],
      scope:
        'Authoritative branch heads version force-pushes and rebases; duplicate, obsolete and deletion events are gated.',
      limits: 'Dedicated tag metadata and arbitrary non-branch ref coordination are absent.',
    },
    {
      id: 'mr.lifecycle',
      category: 'Review coordination',
      title: 'Native merge requests',
      status: 'SUPPORTED',
      tests: ['tests/merge-requests.test.mjs', 'tests/workflow-integration.test.mjs'],
      scope:
        'Open, draft, ready, close, reopen and merge retain immutable source revisions and lifecycle events.',
      limits:
        'Registered canonical targets only; retargeting and multiple MRs per source identity are absent.',
    },
    {
      id: 'reviews.exact',
      category: 'Review coordination',
      title: 'Revision-specific reviews and discussion',
      status: 'SUPPORTED',
      tests: ['tests/merge-requests.test.mjs'],
      scope:
        'Approvals, requested changes, dismissals, batch reviews and anchored discussion threads retain exact revision pins.',
      limits: 'One configured owner identity; unresolved discussion threads do not gate merging.',
    },
    {
      id: 'dependencies.stacks',
      category: 'Review coordination',
      title: 'Pinned merge-request dependencies',
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
      tests: [
        'tests/evidence-safety.test.mjs',
        'tests/merge-requests.test.mjs',
        'tests/application.test.mjs',
      ],
      scope:
        'Platform-owned checks bind tree, configuration, constraints and canonical head; stale or superseded runs lose eligibility.',
      limits:
        'Configured checkout and policy profiles only. Finite passing tests do not establish global correctness.',
    },
    {
      id: 'evidence.external',
      category: 'Evidence and convergence',
      title: 'Declared producer check reports',
      status: 'SUPPORTED',
      tests: ['tests/merge-requests.test.mjs'],
      scope:
        'External reports retain their declared origin and cannot impersonate trusted platform validation.',
      limits:
        'Producer-supplied tests are never sole verification. General independently verified CI callbacks are absent.',
    },
    {
      id: 'context.retry',
      category: 'Context and provenance',
      title: 'Context before code',
      status: 'SUPPORTED',
      tests: ['tests/context.test.mjs'],
      scope:
        'The retry-response-v1 task retrieves immutable cross-repo policy and prior decisions, asks one material question and binds the answer to code.',
      limits:
        'One task schema. Unanswered questions become explicit assumptions; no general context compiler or automatic user answers.',
    },
    {
      id: 'provenance.binding',
      category: 'Context and provenance',
      title: 'Immutable provenance references',
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
      tests: ['tests/components.test.mjs', 'tests/acceptance.test.mjs'],
      scope:
        'Alternative and conflict edges form deterministic components; actual composed trees receive trusted interaction checks.',
      limits:
        'Unknown work remains separate. Detection uses configured footprints; absent edges are not compatibility proof, and oversized groups require conventional review.',
    },
    {
      id: 'queue.exact',
      category: 'Canonical updates',
      title: 'Reviewed merge queue',
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
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
      status: 'SUPPORTED',
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
      scope:
        'Decisions are primary; merge requests, work, evidence, history, provenance and diffs open as progressive detail.',
      limits: 'No comprehensive automated browser coverage or generic historical search.',
    },
    {
      id: 'metrics.bounded',
      category: 'Product surface',
      title: 'Bounded acceptance metrics',
      status: 'SUPPORTED',
      tests: ['tests/acceptance.test.mjs'],
      scope:
        'Reports decision compression, stale evidence, CAS handling, rationale coverage, analysis latency and avoided comparisons.',
      limits:
        'Demo measurements are finite examples, not representative production error rates or a scalable symbol index.',
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
  ],
};

export function getCapabilities() {
  return structuredClone(registry);
}
