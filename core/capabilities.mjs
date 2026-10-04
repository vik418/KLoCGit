// Single source for authenticated API, product status and generated documentation.
const registry = {
  "version": 1,
  "verification_scope": "SUPPORTED means the named local behavior has automated test witnesses. It does not certify live Cloudflare, every Git workflow, production security or global semantic correctness.",
  "statuses": [
    {
      "id": "SUPPORTED",
      "label": "Supported locally",
      "description": "Implemented bounded local behavior with automated witnesses."
    },
    {
      "id": "PARTIAL",
      "label": "Partial",
      "description": "Implemented subset with explicit remaining boundaries."
    },
    {
      "id": "EXPERIMENTAL",
      "label": "Experimental",
      "description": "Implemented path with limited deployment evidence."
    },
    {
      "id": "UNSUPPORTED",
      "label": "Unsupported",
      "description": "No delivered operational workflow; planned where applicable."
    }
  ],
  "capabilities": [
    {
      "id": "git.clients",
      "category": "Git interoperability",
      "title": "Ordinary local Git clients",
      "status": "SUPPORTED",
      "scope": "Local branch pushes, standalone review, clone and fsck use standard Git.",
      "limits": "No claim about every hosting protocol or live Cloudflare.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "standalone conventional work without an MR can be prepared and applied while task clarification stays unanswered"
        },
        {
          "file": "tests/remote-git.test.mjs",
          "title": "real Git lease rejects an external canonical push without overwriting it"
        }
      ]
    },
    {
      "id": "git.revisions",
      "category": "Git interoperability",
      "title": "Force-push, deletion and event ordering",
      "status": "SUPPORTED",
      "scope": "Authoritative refs gate immutable source versions, duplicate and obsolete events.",
      "limits": "Tag lifecycle and arbitrary non-branch ref coordination are absent.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/acceptance.test.mjs",
          "title": "duplicate and out-of-order Git events cannot replace the authoritative producer head"
        },
        {
          "file": "tests/acceptance.test.mjs",
          "title": "force push produces a new immutable revision; ABA restores the old pointer without deleting history"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "external true-ancestor merges, force pushes and source deletion preserve native MR and revision history"
        }
      ]
    },
    {
      "id": "git.forks",
      "category": "Git interoperability",
      "title": "Registered producer fork pushes",
      "status": "SUPPORTED",
      "scope": "Local native MRs preserve exact fork source versions and stale reviews/checks on updates.",
      "limits": "Registered forks only; actual Cloudflare fork events remain unverified.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "direct and registered fork MR pushes create exact revisions and stale earlier approval/check eligibility"
        },
        {
          "file": "tests/revert.test.mjs",
          "title": "true stacked fork histories compose once, preserve every proposal trailer, and remain Git ancestors"
        }
      ]
    },
    {
      "id": "git.tags-rebase",
      "category": "Git interoperability",
      "title": "Tags, cherry-picks and rebases",
      "status": "PARTIAL",
      "scope": "Ordinary Git retains these operations; branch head replacements are versioned.",
      "limits": "No dedicated tag metadata or full cherry-pick/rebase integration matrix.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/acceptance.test.mjs",
          "title": "force push produces a new immutable revision; ABA restores the old pointer without deleting history"
        }
      ]
    },
    {
      "id": "git.protected-import",
      "category": "Git interoperability",
      "title": "Host protected refs and repository import/export",
      "status": "UNSUPPORTED",
      "scope": "Planned hosting enforcement and migration workflows.",
      "limits": "Coordinator CAS exists; host protected refs and generic import/export do not.",
      "phase": "Production",
      "tests": []
    },
    {
      "id": "mr.lifecycle",
      "category": "Merge requests",
      "title": "Open, draft, ready, close, reopen and merge",
      "status": "SUPPORTED",
      "scope": "Native lifecycle with immutable source revisions and events targets registered canonical Git.",
      "limits": "One active source identity and canonical-target scope.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "native MR lifecycle, reviews and line threads are immutable metadata over ordinary Git"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "draft and closed requests are excluded from analysis until explicitly made ready or reopened"
        },
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "decision receipts mark exact selected revisions merged and deferred revisions closed, with idempotent recovery"
        }
      ]
    },
    {
      "id": "mr.extended",
      "category": "Merge requests",
      "title": "Retarget, abandon, supersede and multiple MRs per proposal",
      "status": "UNSUPPORTED",
      "scope": "Planned target changes and one-to-many associations.",
      "limits": "Close is not rejection; these extra lifecycle transitions are not delivered.",
      "phase": "Coordination",
      "tests": []
    },
    {
      "id": "reviews.exact",
      "category": "Reviews",
      "title": "Revision-specific and batch reviews",
      "status": "SUPPORTED",
      "scope": "Approval, requested changes, comments, dismissal and batch preflight retain exact pins.",
      "limits": "One configured identity; assignment and ownership are separate future workflows.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "requested changes block a passing revision until the request is dismissed or replaced by approval"
        },
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "batch review preflights every immutable revision and fails without recording a partial review"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "an unnotified source push cannot consume old approval or a previously reviewed canonical composition"
        }
      ]
    },
    {
      "id": "reviews.threads",
      "category": "Reviews",
      "title": "General and file/line discussion threads",
      "status": "SUPPORTED",
      "scope": "Verified anchors, replies, resolution, reopen and historical attachment.",
      "limits": "Unresolved threads do not currently gate merging.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "file-anchored discussion threads preserve their immutable revision across push, resolution and reopen"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "native MR lifecycle, reviews and line threads are immutable metadata over ordinary Git"
        }
      ]
    },
    {
      "id": "reviews.owners",
      "category": "Reviews",
      "title": "Assignments, required reviewers and CODEOWNERS",
      "status": "UNSUPPORTED",
      "scope": "Planned pinned ownership and reviewer policies.",
      "limits": "Minimum approval counts exist; named reviewer and ownership rules do not.",
      "phase": "Production",
      "tests": []
    },
    {
      "id": "evidence.trusted",
      "category": "Validation and evidence",
      "title": "Finite platform validation",
      "status": "SUPPORTED",
      "scope": "Exact tree/configuration/constraint/head checks observe external simulated effects.",
      "limits": "Only configured checkout and policy profiles; finite checks do not prove correctness globally.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/application.test.mjs",
          "title": "real HTTP app: baseline, A and B pass alone; textually clean A+B duplicates a trusted external effect"
        },
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "canonical, configuration and constraint advances invalidate earlier merge-request evidence"
        }
      ]
    },
    {
      "id": "evidence.reruns",
      "category": "Validation and evidence",
      "title": "Latest trusted run and stale eligibility",
      "status": "SUPPORTED",
      "scope": "Current failed/pending/cancelled proofs cannot revive an older pass; new passing proof requires fresh review.",
      "limits": "Eligibility rules exist; generalized asynchronous run/cancel scheduling does not.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "failed cancelled and pending exact platform runs block applicable resolution until fresh passing proof"
        },
        {
          "file": "tests/evidence-safety.test.mjs",
          "title": "new trusted composition results stale standalone decisions and cannot revive a pinned historical pass"
        }
      ]
    },
    {
      "id": "evidence.external",
      "category": "Validation and evidence",
      "title": "Declared external CI reports",
      "status": "SUPPORTED",
      "scope": "Reported states cannot impersonate platform checks or override trusted proof.",
      "limits": "No independently verified generic CI callback service.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a declared passing CI report never satisfies platform-owned required validation"
        },
        {
          "file": "tests/workflow-api.test.mjs",
          "title": "MR declarations cannot replace authenticated actor, event time or server trust"
        }
      ]
    },
    {
      "id": "evidence.types",
      "category": "Validation and evidence",
      "title": "Build, lint, security, benchmark, deployment and human adapters",
      "status": "UNSUPPORTED",
      "scope": "Planned versioned evidence producers for these kinds.",
      "limits": "Only the configured trusted profiles and declared reports run today.",
      "phase": "Scale",
      "tests": []
    },
    {
      "id": "context.retry",
      "category": "Context and intent",
      "title": "One context-before-code task schema",
      "status": "SUPPORTED",
      "scope": "Immutable cross-repo policy, reliable prior decision, material question and explicit assumptions bind code.",
      "limits": "Only retry-response-v1; test actors never answer for the real user.",
      "phase": "Understanding",
      "tests": [
        {
          "file": "tests/context.test.mjs",
          "title": "before code: exactly one material question after immutable retrieval from another registered Git repository"
        },
        {
          "file": "tests/context.test.mjs",
          "title": "a reliable retrieved existing decision supplies the answer without asking any question"
        },
        {
          "file": "tests/context.test.mjs",
          "title": "unanswered questions stay pending until an explicit unresolved assumption authorizes reviewed work"
        }
      ]
    },
    {
      "id": "context.general",
      "category": "Context and intent",
      "title": "General task understanding and repository discovery",
      "status": "UNSUPPORTED",
      "scope": "Planned issue/spec/task retrieval and ambiguity analysis.",
      "limits": "No arbitrary intent extraction, repo discovery or broad context compiler.",
      "phase": "Understanding",
      "tests": []
    },
    {
      "id": "relationships.exact",
      "category": "Proposal relationships",
      "title": "Exact implementation identity and declared alternatives",
      "status": "SUPPORTED",
      "scope": "Exact trees share implementation references while proposal histories remain separate.",
      "limits": "No semantic equivalence inferred from text similarity or model confidence.",
      "phase": "Coordination",
      "tests": [
        {
          "file": "tests/components.test.mjs",
          "title": "same-tree implementation histories remain separate while candidate search deduplicates implementation"
        },
        {
          "file": "tests/components.test.mjs",
          "title": "arbitrary shuffled Git work yields the same two connected decisions and excludes unknown overlap"
        }
      ]
    },
    {
      "id": "relationships.typed",
      "category": "Proposal relationships",
      "title": "Typed requires, blocks, supersedes and conflicts",
      "status": "PARTIAL",
      "scope": "Dependency DAGs and exact observed composed-pair failures are implemented.",
      "limits": "No complete public typed-edge lifecycle for blocks/supersedes or broad semantic detector.",
      "phase": "Coordination",
      "tests": [
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "dependency declarations reject cycles and cannot unblock a pending unselected dependency"
        },
        {
          "file": "tests/application.test.mjs",
          "title": "real HTTP app: baseline, A and B pass alone; textually clean A+B duplicates a trusted external effect"
        }
      ]
    },
    {
      "id": "decisions.groups",
      "category": "Decision layer",
      "title": "Several proposals or MRs become one decision",
      "status": "SUPPORTED",
      "scope": "Derived connected groups and explicit checked batches preserve constituent histories.",
      "limits": "Fixture compression is bounded; arbitrary unknown semantics are not discovered automatically.",
      "phase": "Coordination",
      "tests": [
        {
          "file": "tests/acceptance.test.mjs",
          "title": "five concurrent producers derive two decisions from eight ordinary Git proposals without predefined groups"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a batch composition requires current review of every included MR before one Git CAS"
        }
      ]
    },
    {
      "id": "decisions.dispositions",
      "category": "Decision layer",
      "title": "Individual applied and deferred dispositions",
      "status": "SUPPORTED",
      "scope": "One decision retains each selected/deferred revision disposition and rationale.",
      "limits": "Rejected and superseded outcomes are not operational transitions.",
      "phase": "Coordination",
      "tests": [
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "decision receipts mark exact selected revisions merged and deferred revisions closed, with idempotent recovery"
        },
        {
          "file": "tests/acceptance.test.mjs",
          "title": "crash after Git CAS restores exact dispositions idempotently and never reopens applied work"
        }
      ]
    },
    {
      "id": "decisions.extra",
      "category": "Decision layer",
      "title": "Rejected and superseded dispositions",
      "status": "UNSUPPORTED",
      "scope": "Planned explicit outcomes preserving individual histories.",
      "limits": "Close/defer must not be advertised as reject/supersede.",
      "phase": "Coordination",
      "tests": []
    },
    {
      "id": "convergence.composed",
      "category": "Convergence",
      "title": "Actual composition and interaction validation",
      "status": "SUPPORTED",
      "scope": "Clean Git merges can fail finite composed behavior checks and require review.",
      "limits": "Only configured trusted footprints detect interactions; absent edges are not compatibility proof.",
      "phase": "Coordination",
      "tests": [
        {
          "file": "tests/application.test.mjs",
          "title": "real HTTP app: baseline, A and B pass alone; textually clean A+B duplicates a trusted external effect"
        },
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "failed selected composition blocks convergence even when each individual revision passed trusted validation"
        }
      ]
    },
    {
      "id": "convergence.semantic",
      "category": "Convergence",
      "title": "General semantic conflict hints",
      "status": "UNSUPPORTED",
      "scope": "Optional future human-reviewed probabilistic hints.",
      "limits": "No LLM analyzer or AI code reviewer; hints cannot authorize irreversible writes.",
      "phase": "Understanding",
      "tests": []
    },
    {
      "id": "dependencies.stacks",
      "category": "Dependencies and stacked work",
      "title": "Revision-pinned stacks and current prerequisite presence",
      "status": "SUPPORTED",
      "scope": "Updates, cycles, removed/reverted dependencies and selected stacks use exact refs.",
      "limits": "No silent following of updated dependency revisions.",
      "phase": "Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a stacked native MR updated under its dependent requires redeclaration and checked current batch"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a historical merged dependency removed by canonical force-push cannot authorize dependent application"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "reverted dependency remains historical ancestry but cannot authorize dependent application"
        }
      ]
    },
    {
      "id": "queue.exact",
      "category": "Dependencies and stacked work",
      "title": "Reviewed exact-composition merge queue",
      "status": "SUPPORTED",
      "scope": "Pins tree, evidence, basis and head; changed targets stop canonical advancement.",
      "limits": "No automatic candidate rebase or throughput-optimized merge train.",
      "phase": "Scale",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "merge queue target movement while exact platform validation runs preserves the reviewed ticket and stops CAS"
        },
        {
          "file": "tests/merge-queue.test.mjs",
          "title": "processing executes one FIFO canonical operation and exact process replay never merges the next ticket"
        },
        {
          "file": "tests/merge-queue.test.mjs",
          "title": "a later direct resolution cannot be attributed to an interrupted queue attempt"
        }
      ]
    },
    {
      "id": "queue.rebase",
      "category": "Dependencies and stacked work",
      "title": "Automatic candidate rebasing and merge trains",
      "status": "UNSUPPORTED",
      "scope": "Planned scheduling and rebuilding with preserved authorization semantics.",
      "limits": "Current stale tickets stop for renewed human review.",
      "phase": "Scale",
      "tests": []
    },
    {
      "id": "canonical.cas",
      "category": "Canonical-state safety",
      "title": "Reviewed basis and canonical Git CAS",
      "status": "SUPPORTED",
      "scope": "Authenticated head/basis checks, serialized write-ahead operations and real old-OID protection.",
      "limits": "One repository advances per operation; no distributed ref transaction.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/acceptance.test.mjs",
          "title": "external Git push during write-ahead persistence defeats canonical CAS against the captured OID"
        },
        {
          "file": "tests/acceptance.test.mjs",
          "title": "serialized concurrent resolution requests advance Git at most once"
        },
        {
          "file": "tests/remote-git.test.mjs",
          "title": "real Git lease rejects an external canonical push without overwriting it"
        }
      ]
    },
    {
      "id": "canonical.revert",
      "category": "Canonical-state safety",
      "title": "Reviewed inverses with preserved history",
      "status": "SUPPORTED",
      "scope": "Validate retained inverse candidates linked to original decisions/merge commits against current Git.",
      "limits": "External merge mainline is explicit; inverse conflicts escalate.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "reviewed inverse code exists before CAS, preserves later work and rejects a raced canonical head"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "shared API validates native revisions, pins batch reviews and prepares a real decision revert"
        },
        {
          "file": "tests/revert.test.mjs",
          "title": "merge revert requires an explicit real parent and mainline one preserves independent canonical work"
        }
      ]
    },
    {
      "id": "provenance.binding",
      "category": "Provenance",
      "title": "Exact context, decision, evidence and code references",
      "status": "SUPPORTED",
      "scope": "Immutable bindings distinguish declared/retrieved/observed origins while unknown producers ingest.",
      "limits": "Supplied intent is not independently verified; no aggregate confidence score.",
      "phase": "Understanding",
      "tests": [
        {
          "file": "tests/context.test.mjs",
          "title": "declared answer carries actor, time, scope and exact source through snapshot, authorization, artifact and Git trailers"
        },
        {
          "file": "tests/context.test.mjs",
          "title": "substring suffixes and body-only references cannot impersonate exact Git authorization trailers"
        },
        {
          "file": "tests/acceptance.test.mjs",
          "title": "unknown provenance stays outside blocking components and is included only in explicit reviewed compositions"
        }
      ]
    },
    {
      "id": "provenance.explorer",
      "category": "Provenance",
      "title": "Bidirectional provenance explorer",
      "status": "PARTIAL",
      "scope": "Records and progressive details expose immutable references.",
      "limits": "Full code-to-requirement/intent-to-code navigation and search are absent.",
      "phase": "Understanding",
      "tests": [
        {
          "file": "tests/context.test.mjs",
          "title": "producer Git artifact and trailers bind the stored immutable answer to the ingested revision"
        }
      ]
    },
    {
      "id": "crossrepo.context",
      "category": "Cross-repository coordination",
      "title": "Shared constraints and pinned context inputs",
      "status": "SUPPORTED",
      "scope": "Retrieve immutable other-repo policy; changed source versions invalidate eligibility.",
      "limits": "Shared context is not a coordinated multi-repo release.",
      "phase": "Understanding",
      "tests": [
        {
          "file": "tests/context.test.mjs",
          "title": "historical bound code survives a source-policy change but cannot obtain current composition validation"
        },
        {
          "file": "tests/context.test.mjs",
          "title": "changed source constraint invalidates an unanswered question, and refreshed preparation retires its prior version"
        }
      ]
    },
    {
      "id": "crossrepo.release",
      "category": "Cross-repository coordination",
      "title": "Contracts and recoverable multi-repo releases",
      "status": "UNSUPPORTED",
      "scope": "Planned coordinated validation and non-atomic release recovery.",
      "limits": "No coordinated release operation or atomic multi-repo update.",
      "phase": "Scale",
      "tests": []
    },
    {
      "id": "security.runner",
      "category": "Security",
      "title": "Untrusted producer isolation",
      "status": "SUPPORTED",
      "scope": "Read-only isolated candidates, scrubbed secrets and bounded trusted effects fail closed.",
      "limits": "Host Linux tested; deployed Container isolation and full security audit remain unverified.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/application.test.mjs",
          "title": "candidate cannot inherit a secret, read host files or reach a non-loopback network"
        },
        {
          "file": "tests/application.test.mjs",
          "title": "symlinks are rejected before candidate execution and the ordinary repository remains usable"
        },
        {
          "file": "tests/revert.test.mjs",
          "title": "inverse construction cannot execute producer repository hooks, external diffs, filters or inherited Git configuration"
        }
      ]
    },
    {
      "id": "security.identity",
      "category": "Security",
      "title": "Single owner and separated service authority",
      "status": "PARTIAL",
      "scope": "Server-selected actors and authenticated API/executor boundaries strip producer authority claims.",
      "limits": "No organizational membership, multi-user auth or repository RBAC.",
      "phase": "Production",
      "tests": [
        {
          "file": "tests/workflow-api.test.mjs",
          "title": "MR declarations cannot replace authenticated actor, event time or server trust"
        },
        {
          "file": "tests/workflow-api.test.mjs",
          "title": "shared dispatcher leaves unrelated routes untouched and requires authenticated actors for workflows"
        }
      ]
    },
    {
      "id": "security.rbac",
      "category": "Security",
      "title": "Organization RBAC and supply-chain enforcement",
      "status": "UNSUPPORTED",
      "scope": "Planned repository roles, credential lifecycle and trusted scan policy.",
      "limits": "No operational organizational authorization or supply-chain enforcement.",
      "phase": "Production",
      "tests": []
    },
    {
      "id": "audit.journal",
      "category": "Audit and recovery",
      "title": "Hash-linked journal and exact uncertain recovery",
      "status": "SUPPORTED",
      "scope": "Prepared/applied history reconciles actual refs and restores native outcomes without repeating CAS.",
      "limits": "Aggregate storage is app managed; independent retention and signed roots are absent.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/acceptance.test.mjs",
          "title": "all audit records remain content addressed and chained through concurrent work"
        },
        {
          "file": "tests/acceptance.test.mjs",
          "title": "crash after Git CAS restores exact dispositions idempotently and never reopens applied work"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "lost CAS response recovers MR and queue exactly once after reload without repeating Git writes"
        }
      ]
    },
    {
      "id": "audit.anchors",
      "category": "Audit and recovery",
      "title": "Independent retention and signed anchoring",
      "status": "UNSUPPORTED",
      "scope": "Planned append-only persistence enforcement and external/signed anchors.",
      "limits": "Deep freezing/chained hashes do not establish an independent immutable database.",
      "phase": "Production",
      "tests": []
    },
    {
      "id": "integrations.api",
      "category": "Notifications and workflow integration",
      "title": "Authenticated APIs and native event adapters",
      "status": "PARTIAL",
      "scope": "Shared local/Worker workflow API and native push/analysis adapter code.",
      "limits": "Live event delivery unverified; no general outgoing webhook/notification service.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/workflow-api.test.mjs",
          "title": "shared dispatcher leaves unrelated routes untouched and requires authenticated actors for workflows"
        },
        {
          "file": "tests/artifacts.test.mjs",
          "title": "native push ingestion is acknowledged only after separate analysis is queued"
        }
      ]
    },
    {
      "id": "integrations.external",
      "category": "Notifications and workflow integration",
      "title": "Provider connectors and notifications",
      "status": "UNSUPPORTED",
      "scope": "Planned GitHub/GitLab, Slack/Jira/Linear, CI callbacks and decision notifications.",
      "limits": "No external connector or notification service delivered.",
      "phase": "Production",
      "tests": []
    },
    {
      "id": "ui.decisions",
      "category": "Interface",
      "title": "Minimal decisions and secondary detail views",
      "status": "PARTIAL",
      "scope": "Decisions stay primary; work/evidence/history/diff/capabilities are progressively exposed.",
      "limits": "Recorded desktop/mobile browser scenarios passed. The cited Node witness verifies registry/API delivery; a committed comprehensive automated UI suite is absent.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/capabilities.test.mjs",
          "title": "authenticated capability API exposes read-only scoped status without producer authority"
        }
      ]
    },
    {
      "id": "search.memory",
      "category": "Search and organizational memory",
      "title": "Historical decision reuse and general search",
      "status": "PARTIAL",
      "scope": "One supported context schema can reuse a reliable prior decision.",
      "limits": "No generic search engine or organizational memory index/knowledge graph.",
      "phase": "Understanding",
      "tests": [
        {
          "file": "tests/context.test.mjs",
          "title": "a reliable retrieved existing decision supplies the answer without asking any question"
        }
      ]
    },
    {
      "id": "metrics.bounded",
      "category": "Observability",
      "title": "Bounded decision and evidence metrics",
      "status": "SUPPORTED",
      "scope": "Fixture compression, latency, staleness, rationale coverage and filtered comparisons are reported.",
      "limits": "Zero fixture errors are not production rates; prior clarification is counted separately.",
      "phase": "Scale",
      "tests": [
        {
          "file": "tests/acceptance.test.mjs",
          "title": "five concurrent producers derive two decisions from eight ordinary Git proposals without predefined groups"
        },
        {
          "file": "tests/acceptance.test.mjs",
          "title": "canonical movement makes previous evidence stale and rejects an obsolete decision with 409"
        }
      ]
    },
    {
      "id": "metrics.production",
      "category": "Observability",
      "title": "Production metrics and scalable indexes",
      "status": "UNSUPPORTED",
      "scope": "Planned symbol indexes, assumption/time-to-decision and representative operational metrics.",
      "limits": "Array metadata filtering is not a production symbol index or error study.",
      "phase": "Scale",
      "tests": []
    },
    {
      "id": "capabilities.registry",
      "category": "Capability registry",
      "title": "Scoped statuses and automated witnesses",
      "status": "SUPPORTED",
      "scope": "One read-only product/API/docs source maps claims to actual test declarations.",
      "limits": "Witnesses prove named finite behavior; this is not a live-service certificate.",
      "phase": "Foundation",
      "tests": [
        {
          "file": "tests/capabilities.test.mjs",
          "title": "supported capability claims have bounded scope and real automated test witnesses"
        }
      ]
    },
    {
      "id": "cloudflare.live",
      "category": "Hosting",
      "title": "Live Artifacts, Worker, Queue, Durable Object and executor",
      "status": "EXPERIMENTAL",
      "scope": "Integration code, mocked boundaries, local remote Git leases, built image and dry-run bundles.",
      "limits": "Credentials absent; actual native events, live races/recovery and Container isolation unverified.",
      "phase": "Production",
      "tests": [
        {
          "file": "tests/artifacts.test.mjs",
          "title": "native push ingestion is acknowledged only after separate analysis is queued"
        },
        {
          "file": "tests/remote-git.test.mjs",
          "title": "a lost reply after real successful Git lease remains an uncertain outcome for exact-target recovery"
        }
      ]
    }
  ],
  "acceptance_gate": [
    {
      "id": "gate.1",
      "title": "Direct branch and fork push",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "direct and registered fork MR pushes create exact revisions and stale earlier approval/check eligibility"
        }
      ]
    },
    {
      "id": "gate.2",
      "title": "Draft to ready",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "native MR lifecycle, reviews and line threads are immutable metadata over ordinary Git"
        }
      ]
    },
    {
      "id": "gate.3",
      "title": "Head update versions code and stales reviews/checks",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "an unnotified source push cannot consume old approval or a previously reviewed canonical composition"
        },
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "direct and registered fork MR pushes create exact revisions and stale earlier approval/check eligibility"
        }
      ]
    },
    {
      "id": "gate.4",
      "title": "Close and reopen",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "native MR lifecycle, reviews and line threads are immutable metadata over ordinary Git"
        }
      ]
    },
    {
      "id": "gate.5",
      "title": "Failed, cancelled and pending checks block application",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "failed cancelled and pending exact platform runs block applicable resolution until fresh passing proof"
        },
        {
          "file": "tests/evidence-safety.test.mjs",
          "title": "new trusted composition results stale standalone decisions and cannot revive a pinned historical pass"
        }
      ]
    },
    {
      "id": "gate.6",
      "title": "Stacked prerequisite changes beneath dependent MR",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a stacked native MR updated under its dependent requires redeclaration and checked current batch"
        }
      ]
    },
    {
      "id": "gate.7",
      "title": "Queue target moves while validation runs",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "merge queue target movement while exact platform validation runs preserves the reviewed ticket and stops CAS"
        }
      ]
    },
    {
      "id": "gate.8",
      "title": "Clean textual composition fails behavior validation",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/application.test.mjs",
          "title": "real HTTP app: baseline, A and B pass alone; textually clean A+B duplicates a trusted external effect"
        },
        {
          "file": "tests/merge-requests.test.mjs",
          "title": "failed selected composition blocks convergence even when each individual revision passed trusted validation"
        }
      ]
    },
    {
      "id": "gate.9",
      "title": "External merge races approved decision",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a real external branch merge after native MR review defeats captured canonical CAS without overwriting merged code"
        }
      ]
    },
    {
      "id": "gate.10",
      "title": "Crash after Git update before persistence",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a native MR crash after Git update before final persistence recovers its exact disposition once without repeating CAS"
        }
      ]
    },
    {
      "id": "gate.11",
      "title": "Revert an already resolved MR",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "shared API validates native revisions, pins batch reviews and prepares a real decision revert"
        }
      ]
    },
    {
      "id": "gate.12",
      "title": "Several MRs share a decision and retain dispositions",
      "status": "SUPPORTED",
      "scope": "The exact finite local workflow has automated witnesses.",
      "limits": "Local Git and configured trusted validators; live Cloudflare is unverified.",
      "phase": "Foundation / Coordination",
      "tests": [
        {
          "file": "tests/workflow-integration.test.mjs",
          "title": "a batch composition requires current review of every included MR before one Git CAS"
        }
      ]
    }
  ]
};
export function getCapabilities() {return structuredClone(registry);}
