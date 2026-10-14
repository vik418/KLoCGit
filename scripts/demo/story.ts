export type Focus =
  | "overview"
  | "repositories"
  | "alternatives"
  | "blast"
  | "evidence"
  | "basis"
  | "blocked";
export type Beat = {
  id: string;
  title: string;
  caption: string;
  narration: string;
  focus: Focus;
};

/** Narration explains the observed result; the recorder supplies the actual state. */
export function submissionStory(measured: {
  futures: number;
  groups: number;
  alternatives: number;
}): Beat[] {
  return [
    {
      id: "problem",
      title: "The problem",
      caption: "More generated work does not mean more meaningful decisions.",
      focus: "overview",
      narration:
        "More agents can generate more code, but humans still have to integrate it. Producers duplicate work, choose competing approaches, and introduce hidden interactions. KLoCGit surfaces the meaningful decisions and the evidence needed to make them.",
    },
    {
      id: "live.home",
      title: "Isolated work",
      caption: "Workers serves the application. Artifacts stores ordinary Git.",
      focus: "repositories",
      narration:
        "This is the live application on Cloudflare Workers, with Git repositories stored in Artifacts. We will create isolated workspaces here, then demonstrate convergence using the real Rust engine locally. The two environments are clearly labeled throughout.",
    },
    {
      id: "live.import",
      title: "Git interoperability",
      caption: "Import a repository without changing how producers use Git.",
      focus: "repositories",
      narration:
        "Import an ordinary Git repository. Humans, agents, and CI can continue using their existing Git clients. KLoCGit records the coordination around their work without requiring a particular model, coding agent, or proprietary patch format.",
    },
    {
      id: "live.create",
      title: "Durable source",
      caption: "Creation produces a real, inspectable Git repository.",
      focus: "repositories",
      narration:
        "The create action produces a real Artifacts repository. After import completes, the browser reads its history and tree. Git remains the source of truth, so coordination metadata is never the only way to access the code.",
    },
    {
      id: "live.browse",
      title: "Source inspection",
      caption: "Inspect files and commits beneath the coordination layer.",
      focus: "repositories",
      narration:
        "Open a source file and inspect the commit history beneath it. File requests are pinned to an exact commit. A later push cannot silently replace the content being inspected. Deeper code access remains available when needed.",
    },
    {
      id: "live.fork",
      title: "Producer isolation",
      caption:
        "Fork from the same baseline; work without sharing a mutable checkout.",
      focus: "repositories",
      narration:
        "Fork a workspace from the same baseline. Each producer gets an isolated Git repository, so one session cannot overwrite another session's working state. Artifacts makes repository-level isolation a practical default for concurrent work.",
    },
    {
      id: "live.objective",
      title: "Intent before implementation",
      caption: "Record the objective that the work should satisfy.",
      focus: "repositories",
      narration:
        "Create an objective that records what the work should achieve. This preserves why the implementations exist before we compare them. It is a starting point for intent, not a claim that the system understands every requirement.",
    },
    {
      id: "live.five",
      title: "Concurrent producers",
      caption: "Multiple isolated repositories share a known starting point.",
      focus: "repositories",
      narration:
        "The same authenticated API creates the remaining isolated forks. Multiple producers can work from a known baseline. Their results should be compared as possible outcomes, rather than turning every producer session into a separate human approval task.",
    },
    {
      id: "live.boundary",
      title: "Convergence demonstration",
      caption:
        "Real engine and Git; local service adapters are explicitly labeled.",
      focus: "overview",
      narration:
        "We now switch to local convergence. Seeded Git changes reproduce the problem reliably; we are not claiming to launch five commercial agents. The application, Rust engine, composed trees, container checks, and Git promotions are real.",
    },
    {
      id: "native.sources",
      title: "What arrived",
      caption:
        "Two duplicates, a competing retry strategy, and two independent changes.",
      focus: "overview",
      narration:
        "Two producers supplied identical retry trees. Another chose a different retry strategy. Telemetry and auth-file changes are independent. The engine derives candidates from these revisions; the demo does not insert a predefined decision object.",
    },
    {
      id: "native.queue",
      title: "Attention queue",
      caption: `${measured.futures} futures → ${measured.groups} decision groups → ${measured.alternatives} alternatives`,
      focus: "alternatives",
      narration: `The result is visible in the attention queue: ${measured.futures} source futures, ${measured.groups} unresolved decision groups, and ${measured.alternatives} candidate alternatives. These counts come from the returned engine records. The queue asks which validated state to accept, rather than presenting a separate approval task for every source revision.`,
    },
    {
      id: "native.duplicate",
      title: "Deterministic reduction",
      caption: "Identical implementation does not erase intent or history.",
      focus: "alternatives",
      narration:
        "Byte-identical trees share an implementation choice, while their source histories remain separate. This is deterministic reduction, not a model guessing that code looks similar. The materially different retry strategy remains an alternative that requires judgment.",
    },
    {
      id: "native.alternative",
      title: "Compare the futures",
      caption: "Choose the retry approach; retain independent improvements.",
      focus: "alternatives",
      narration:
        "Select the other candidate and inspect its effects. Each candidate combines independent improvements with a retry approach. It is an exact possible Git state. Individual green checks cannot establish that this new combination will also pass.",
    },
    {
      id: "native.blast",
      title: "Blast-radius inspection",
      caption:
        "Public APIs, dependencies, migrations, and security-sensitive paths.",
      focus: "blast",
      narration:
        "The blast-radius inspector surfaces public exports, dependency additions, migrations, and security-sensitive effects before raw code. The auth-file change remains visible here. These are structural observations, not a claim that the whole program is semantically correct.",
    },
    {
      id: "native.provenance",
      title: "Slice attribution",
      caption: "Each composed path retains its source revision and commit.",
      focus: "blast",
      narration:
        "Open source attribution to see which future and commit supplied each path. Composition retains useful work from several producers without erasing its origin. This view provides path-level attribution, rather than promising a complete prompt-to-line provenance explorer.",
    },
    {
      id: "native.evidence",
      title: "Exact-state validation",
      caption: "Evaluate the combination, not just its ingredients.",
      focus: "evidence",
      narration:
        "Inspect evidence for the selected candidate. Checks ran against its exact composed tree in an isolated container. The trusted suite is supplied separately from producer-controlled files. Producer claims alone do not authorize acceptance.",
    },
    {
      id: "native.receipt",
      title: "Inspectable evidence",
      caption:
        "Candidate, evaluator, configuration, environment, and result stay bound.",
      focus: "evidence",
      narration:
        "The receipt exposes the candidate, evaluator, configuration, environment, and observed results. An engineer can inspect how the passing result was obtained. Finite tests establish what they measured; they do not prove correctness for every possible input.",
    },
    {
      id: "native.basis",
      title: "The reviewed basis",
      caption: "Review binds an exact candidate and current decision inputs.",
      focus: "basis",
      narration:
        "The state panel shows the candidate tree and reviewed basis. These identities distinguish what the human inspected from a later replacement. Changing material inputs requires re-evaluation, rather than silently carrying approval to a different state.",
    },
    {
      id: "native.promote",
      title: "Canonical promotion",
      caption: "One decision accepts an evaluated state through Git CAS.",
      focus: "overview",
      narration:
        "Approve and promote the chosen candidate. The service checks the current basis and expected Git head. The recorder reads Git back to verify the promoted tree matches a reviewed candidate. The resolved item leaves the attention queue.",
    },
    {
      id: "payment.alone",
      title: "The conflict Git cannot see",
      caption: "Retry passes alone. Ledger passes alone.",
      focus: "overview",
      narration:
        "One producer adds retries for uncertain delivery. Another records every charge attempt instead of suppressing duplicates. They modify different files. Each isolated state passes the trusted payment check, so neither starts as an independently failing change.",
    },
    {
      id: "payment.composed",
      title: "Compose and observe",
      caption: "A clean textual composition fails the payment constraint.",
      focus: "overview",
      narration:
        "Git composes both changes without a textual conflict. The exact combined state fails the payment check: retries now repeat a non-idempotent charge. These pass, pass, fail results come from actual container receipts generated for this recording.",
    },
    {
      id: "payment.failure",
      title: "Behavioral evidence",
      caption:
        "Two charges for one payment; the failing receipt belongs to A+B.",
      focus: "overview",
      narration:
        "This failing log belongs to the composed candidate. The problem is the interaction between two individually valid behaviors. KLoCGit exposes that evidence instead of reusing either isolated green check as permission to accept the combination.",
    },
    {
      id: "payment.decision",
      title: "Why judgment remains",
      caption:
        "Reject the invalid combination; preserve materially different approaches.",
      focus: "overview",
      narration:
        "The at-most-once payment constraint rejects this combination. It does not decide which retry architecture the product should use. Materially different approaches remain visible for human judgment. Decision compression must preserve important choices, not simply maximize automated merging.",
    },
    {
      id: "race.external",
      title: "Work keeps arriving",
      caption: "An external producer advances main after review.",
      focus: "alternatives",
      narration:
        "Work keeps arriving during review. In this separate scenario, a review is recorded before another Git producer advances main with an overlapping change. KLoCGit must reconcile the repository it observes, rather than assuming it is the only writer.",
    },
    {
      id: "race.stale",
      title: "Stale-review detection",
      caption: "The live attention stream invalidates the old review.",
      focus: "blocked",
      narration:
        "The live stream marks the decision as needing an updated review. An attempted old promotion returns HTTP four-oh-nine. Old approval cannot authorize a changed basis, and the service does not fix the race by overwriting the external push.",
    },
    {
      id: "race.reject",
      title: "Safe failure",
      caption: "The raced promotion has no canonical effect.",
      focus: "blocked",
      narration:
        "The external change remains authoritative in Git. Compare-and-swap turns the race into an explicit, recoverable conflict instead of a silent integration mistake. The recording preserves the rejection result alongside the earlier successful promotion.",
    },
    {
      id: "policy.required",
      title: "Required capabilities",
      caption: "Unavailable required analysis blocks resolution.",
      focus: "blocked",
      narration:
        "This policy requires semantic analysis, but the available extractor provides structural analysis. The interface explains that missing capability. Required partial, failed, or unsupported analysis must not be treated as complete just to unblock a decision.",
    },
    {
      id: "policy.disabled",
      title: "Explain the blocker",
      caption: "Inspect the reason; approval remains disabled.",
      focus: "blocked",
      narration:
        "Approval stays disabled. Engineers can inspect the work and evidence without being allowed to promote through the missing requirement. A decision can be useful to review before it is safe to resolve. The blocker makes that distinction visible.",
    },
    {
      id: "cloud.arch",
      title: "Why Cloudflare",
      caption:
        "Artifacts + Workers + Durable Objects + Queues + R2 + Rust containers.",
      focus: "overview",
      narration:
        "Artifacts holds isolated repositories. Workers handles the API. Durable Objects persist coordination and serialize ref operations. Queues move jobs, R2 holds evidence, and Rust containers perform heavy analysis and execution outside the edge coordinator.",
    },
    {
      id: "cloud.scope",
      title: "What this demonstrates",
      caption:
        "Live repository operations; real local convergence and validation.",
      focus: "overview",
      narration:
        "The live section shows import, browsing, objectives, and forks. Local convergence shows candidate discovery, exact-state evidence, provenance, promotion, and safety gates. Full live convergence remains unfinished. Large-scale performance and reduced reviewer effort still need measurement.",
    },
    {
      id: "closing",
      title: "The product thesis",
      caption: "Make human attention proportional to meaningful choices.",
      focus: "overview",
      narration:
        "Human attention should follow meaningful choices, not the volume of generated work. Producers explore isolated futures. KLoCGit evaluates combinations and exposes the decisions that remain. The accepted result stays ordinary Git, with inspectable evidence and rationale.",
    },
  ];
}
