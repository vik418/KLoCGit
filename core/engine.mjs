import { resolveDecision, restoreDispositions, recoverOperations } from './canonical.mjs';
import { applicableRelationships, analyzeWork } from './analysis.mjs';
import {
  decisionBasis,
  buildDecision,
  verifyRevisionHeads,
  prepareReview,
  prepareRevert,
  refreshDecision,
} from './decisions.mjs';
import { hash, record, DomainError } from './hash.mjs';
import { prepareTaskContext, answerTaskContext, assumeTaskContext } from './context.mjs';
import { MergeRequests } from './merge-requests.mjs';
import { MergeQueue } from './merge-queue.mjs';
import { NativePipeline } from './native-pipeline.mjs';
import { NativeState } from './native-state.mjs';
import { validationPassed } from './evidence.mjs';
import { readProducerMetadata } from './metadata.mjs';
const now = () => new Date().toISOString();

/**
 * Trusted adapter boundary used by the coordinator. Git objects and refs remain
 * authoritative; methods return observed facts or platform-owned validation.
 * Adapter-specific optional capabilities (ancestry, forks, reverts and scope
 * suites) are consumed by the feature that needs them.
 *
 * @typedef {object} GitAdapter
 * @property {string} configHash Immutable identity of the validation configuration.
 * @property {(repo: object, ref: string) => Promise<string>} ref Read an authoritative ref.
 * @property {(repo: object, head: string, base: string) => Promise<object>} facts Observe a commit/tree/scope.
 * @property {(repo: object, base: string, revisions: object[]) => Promise<object>} compose Build and retain an actual candidate tree.
 * @property {(repo: object, commit: string, constraints: object[], heads: object) => Promise<object>} validate Run trusted checks on exact inputs.
 * @property {(repo: object, expected: string, target: string) => Promise<boolean>} cas Atomically replace a canonical ref only if its old OID matches.
 * @property {(repo: object, commit: string, path: string) => Promise<string|null>} [file] Read a file from an immutable commit.
 */

/** Create coordination metadata; repository code is stored only in Git. */
export function emptyState() {
  return {
    version: 0,
    refEvents: [],
    tasks: [],
    contextPreparations: [],
    dispositions: [],
    discovery: { ungrouped_revision_ids: [], conventional_review_ids: [], diagnostics: [] },
    analysisCache: {},
    workspace: {
      id: 'klocgit',
      name: 'klocgit',
      description: 'Concurrent Git work and integration decisions',
      mode: 'local',
      producers: [],
    },
    repositories: [],
    forks: [],
    implementations: [],
    operations: [],
    intents: [],
    contexts: [],
    proposals: [],
    revisions: [],
    relationships: [],
    constraints: [],
    evidence: [],
    compositions: [],
    decisionComponents: [],
    decisions: [],
    audit: [],
    events: {},
    refVersions: {},
    metrics: {
      comparisons: 0,
      possibleComparisons: 0,
      casFailures: 0,
      staleEvidenceAccepted: 0,
      duplicateClassifications: 0,
      automaticReversals: 0,
    },
    analysis: { status: 'deterministic', analyzer: 'git-tree-v0', semantic: 'unavailable' },
  };
}

/**
 * Public facade shared by transports, merge requests and the merge queue.
 * Analysis, decision preparation and canonical writes have separate modules;
 * ingress, evidence construction and read projections use the same live state.
 * Local workspace reset replaces state, so collaborators must access engine.state
 * when called rather than retain the state object from construction.
 */
export class Engine {
  /**
   * @param {object} state Persisted records and mutable coordination projections.
   * @param {GitAdapter} git Trusted repository/validation adapter.
   * @param {(state: object) => Promise<void>} save Persist the complete current metadata state.
   */
  constructor(state, git, save = async () => {}) {
    if (state.version !== 0)
      throw new DomainError(
        'UNSUPPORTED_STATE_VERSION',
        'klocgit requires v0 workspace metadata',
        503,
      );
    this.state = state;
    this.git = git;
    this.save = save;
    this._tail = Promise.resolve();
    this.mr = new MergeRequests(this);
    this.queue = new MergeQueue(this);
    this.native = new NativeState(this);
    this.pipeline = new NativePipeline(this);
  }

  // Transports serialize a whole operation here. Delegated helpers do not enqueue
  // another serial call, which would wait behind the operation that invoked them.
  serial(fn) {
    const pending = this._tail.then(fn);
    this._tail = pending.catch(() => {});
    return pending;
  }
  async audit(type, actor, data) {
    const previous = this.state.audit.at(-1)?.id ?? null;
    this.state.audit.push(
      await record('audit', { type, actor, data, previous, created_at: now() }),
    );
  }
  repo(id) {
    const r = this.state.repositories.find((r) => r.id === id);
    if (!r) throw new DomainError('REPO_NOT_FOUND', 'Repository not found', 404);
    return r;
  }
  revision(id) {
    const r = this.state.revisions.find((r) => r.id === id);
    if (!r) throw new DomainError('REVISION_NOT_FOUND', 'Revision not found', 404);
    return r;
  }
  component(id) {
    const c = this.state.decisionComponents.find((c) => c.id === id);
    if (!c) throw new DomainError('DECISION_NOT_FOUND', 'Decision not found', 404);
    return c;
  }
  async ingest(event, metadata = {}) {
    if (!event.repo || !event.ref || !event.after)
      throw new DomainError('INVALID_EVENT', 'Repository, ref and immutable head are required');
    const repo = this.repo(event.repo);
    if (
      event.source_repo &&
      event.source_repo !== repo.id &&
      !this.state.forks.some((f) => f.id === event.source_repo && f.repo === repo.id)
    )
      throw new DomainError(
        'UNREGISTERED_FORK',
        'Producer repository is not registered for this canonical repository',
        403,
      );
    const sourceRepo = event.source_repo
      ? { ...repo, id: event.source_repo, canonical_repo: repo.id }
      : repo;
    // Trusted compositions retain Git objects under this namespace. Their push
    // events are persistence receipts, not new producer work. Canonical tracking
    // still takes precedence if the registered canonical ref uses this prefix.
    if (
      typeof event.ref === 'string' &&
      event.ref.startsWith('refs/klocgit/candidates/') &&
      !(sourceRepo.id === repo.id && event.ref === repo.canonical_ref)
    )
      return { ignored: true, reason: 'INTERNAL_CANDIDATE_REF' };
    if (
      /^0{40,64}$/.test(event.after) &&
      !(sourceRepo.id === repo.id && event.ref === repo.canonical_ref)
    )
      return this.withdrawRef(event, sourceRepo);
    if (sourceRepo.id === repo.id && event.ref === repo.canonical_ref) {
      await this.syncHeads();
      return { canonical: true, head: repo.head };
    }
    const eventId = await hash({
      repo: event.repo,
      source_repo: sourceRepo.id,
      ref: event.ref,
      before: event.before ?? null,
      after: event.after,
    });
    if (this.state.events[eventId]) {
      const head = await this.git.ref(sourceRepo, event.ref);
      if (head === event.after) this.state.refVersions[`${sourceRepo.id}:${event.ref}`] = head;
      await this.save(this.state);
      return { duplicate: true, revision_id: this.state.events[eventId] };
    }
    // Ref freshness comes from authoritative Git. Timestamps are never used as version counters.
    const authoritative = await this.git.ref(sourceRepo, event.ref);
    if (authoritative !== event.after)
      return { ignored: true, reason: 'OUT_OF_ORDER_EVENT', head: authoritative };
    await this.syncHeads();
    let base = repo.baseline;
    let baseState = 'registered-baseline';
    if (this.git.mergeBase) {
      try {
        base = await this.git.mergeBase(sourceRepo, event.after, repo.head);
        baseState = 'observed-merge-base';
      } catch (error) {
        if (
          ![
            'NO_COMMON_ANCESTOR',
            'AMBIGUOUS_MERGE_BASE',
            'GIT_EXECUTOR_UNAVAILABLE',
            'ANCESTRY_UNAVAILABLE',
          ].includes(error.code)
        )
          throw error;
        baseState = 'merge-base-unavailable';
      }
    }
    const facts = await this.git.facts(sourceRepo, event.after, base);
    const declared = await this.readDeclaration(sourceRepo, event.after);
    const safeMeta = {
      title: String(metadata.title ?? declared.title ?? event.ref.split('/').at(-1)).slice(0, 200),
      statement: String(metadata.statement ?? declared.statement ?? 'Intent not supplied').slice(
        0,
        1000,
      ),
      producer: String(metadata.producer ?? declared.producer ?? 'Git client').slice(0, 100),
      provenance_state:
        metadata.provenance_state === 'declared' || declared.present ? 'declared' : 'unknown',
    };
    const proposalId = await hash({ repo: repo.id, source_repo: sourceRepo.id, ref: event.ref });
    let proposal = this.state.proposals.find((p) => p.id === proposalId);
    if (!this.state.workspace.producers.includes(safeMeta.producer))
      this.state.workspace.producers.push(safeMeta.producer);
    if (!proposal) {
      const intent = await record('intent', {
        statement: safeMeta.statement,
        scope: facts.scope,
        source: safeMeta.producer,
        basis: safeMeta.provenance_state === 'unknown' ? 'inferred' : 'declared',
        created_at: now(),
      });
      this.state.intents.push(intent);
      proposal = {
        intent_id: intent.id,
        id: proposalId,
        repo: repo.id,
        source_repo: sourceRepo.id,
        ref: event.ref,
        ...safeMeta,
        created_at: now(),
      };
      this.state.proposals.push(proposal);
    }
    let context = await record('ctx', {
      items: [
        {
          type: 'intent',
          value: safeMeta.statement,
          basis: safeMeta.provenance_state === 'unknown' ? 'inferred' : 'declared',
          source: safeMeta.producer,
          validity_scope: facts.scope,
        },
      ],
      constraints: this.state.constraints.map((c) => c.id),
      canonical_heads: this.state.repositories.map((r) => ({ repo: r.id, head: r.head })),
    });
    const binding = await this.bindContext(sourceRepo, event.after, repo.id);
    if (binding.snapshot) context = binding.snapshot;
    if (!this.state.contexts.some((c) => c.id === context.id)) this.state.contexts.push(context);
    const implementation = await record('impl', { repo: repo.id, tree_hash: facts.tree });
    if (!this.state.implementations.some((i) => i.id === implementation.id))
      this.state.implementations.push(implementation);
    const revision = await record('rev', {
      proposal_id: proposalId,
      implementation_ref: implementation.id,
      repo: repo.id,
      source_repo: sourceRepo.id,
      base_commit: facts.base,
      base_state: baseState,
      head_commit: facts.head,
      tree_hash: facts.tree,
      context_version: context.id,
      affected_scope: facts.scope,
      symbol_footprint: facts.symbols ?? [],
      provenance_state: safeMeta.provenance_state,
      decision_key: declared.decision_key ?? null,
      declared_choice: declared.choice ?? null,
      context_binding_state: binding.state,
      context_task_id: binding.task_id ?? null,
      context_answer_ref: binding.snapshot?.answer_ref ?? null,
      context_binding_reason: binding.reason ?? null,
    });
    if (!this.state.revisions.some((r) => r.id === revision.id))
      this.state.revisions.push(revision);
    this.state.events[eventId] = revision.id;
    this.state.refVersions[`${sourceRepo.id}:${event.ref}`] = facts.head;
    const others = this.state.revisions.filter((r) => r.repo === repo.id && r.id !== revision.id);
    this.state.metrics.possibleComparisons += others.length;
    for (const other of others.filter(
      (r) =>
        r.affected_scope.some((p) => facts.scope.includes(p)) ||
        r.tree_hash === facts.tree ||
        (r.decision_key && r.decision_key === revision.decision_key),
    )) {
      this.state.metrics.comparisons++;
      const identical = other.tree_hash === facts.tree;
      const alternative =
        !!revision.decision_key &&
        revision.decision_key === other.decision_key &&
        revision.declared_choice !== other.declared_choice;
      const rel = await record('rel', {
        from_revision: other.id,
        to_revision: revision.id,
        type: identical ? 'implementation_equivalent' : alternative ? 'alternative' : 'unknown',
        confidence: identical ? 1 : null,
        basis: alternative ? 'declared' : 'observed',
        analyzer_version: alternative ? 'declared-choice-v0' : 'git-tree-v0',
        evidence_refs: [],
        observation: identical
          ? 'Identical complete Git tree; proposal histories remain separate.'
          : alternative
            ? `Producer declarations identify mutually exclusive choices for ${revision.decision_key}; no preference is inferred.`
            : 'Affected paths overlap; no semantic conclusion.',
      });
      if (!this.state.relationships.some((r) => r.id === rel.id)) {
        this.state.relationships.push(rel);
        if (identical) this.state.metrics.duplicateClassifications++;
      }
    }
    await this.mr.observeRevision(revision);
    await this.audit('proposal.ingested', 'git-ingress', {
      revision_id: revision.id,
      event_id: eventId,
    });
    await this.save(this.state);
    return { revision_id: revision.id, duplicate: false };
  }
  async withdrawRef(event, sourceRepo) {
    const eventId = await hash({
      repo: event.repo,
      source_repo: sourceRepo.id,
      ref: event.ref,
      before: event.before ?? null,
      after: event.after,
    });
    if (this.state.events[eventId]) return { duplicate: true, deleted: true };
    try {
      const current = await this.git.ref(sourceRepo, event.ref);
      return { ignored: true, reason: 'OUT_OF_ORDER_EVENT', head: current };
    } catch (error) {
      if (error.code !== 'REF_NOT_FOUND') throw error;
    }
    const receipt = await record('ref_event', {
      type: 'deleted',
      repo: event.repo,
      source_repo: sourceRepo.id,
      ref: event.ref,
      before: event.before ?? null,
      created_at: now(),
    });
    this.state.refEvents.push(receipt);
    this.state.refVersions[`${sourceRepo.id}:${event.ref}`] = null;
    this.state.events[eventId] = receipt.id;
    if (this.mr.observeDeletion) await this.mr.observeDeletion(sourceRepo.id, event.ref);
    await this.audit('proposal.source-deleted', 'git-ingress', {
      event_id: eventId,
      receipt_id: receipt.id,
    });
    await this.save(this.state);
    return { deleted: true, receipt_id: receipt.id };
  }
  activeRevisions() {
    return this.state.revisions.filter(
      (r) =>
        this.state.refVersions[
          `${r.source_repo ?? r.repo}:${this.state.proposals.find((p) => p.id === r.proposal_id)?.ref}`
        ] === r.head_commit,
    );
  }
  evidenceValidity(e) {
    const reasons = [];
    for (const [repo, head] of Object.entries(e.validity_heads ?? {}))
      if (this.repo(repo).head !== head || this.repo(repo).unavailable)
        reasons.push('canonical head changed or is unavailable');
    const currentConstraints = this.state.constraints
      .filter((c) => c.active)
      .map((c) => c.id)
      .sort();
    if (
      JSON.stringify([...(e.constraint_versions ?? [])].sort()) !==
      JSON.stringify(currentConstraints)
    )
      reasons.push('constraint version changed');
    if (e.config_hash !== this.git.configHash) reasons.push('validation configuration changed');
    return { status: reasons.length ? 'stale' : 'current', reasons };
  }
  /** Apply one observed immutable head/tree pair without rereading a mutable ref. */
  async observeCanonical(repo, head, tree) {
    const previous = repo.head;
    const changed = previous !== head || !!repo.unavailable;
    if (changed) {
      // Retaining the old head makes an interrupted reconciliation retryable.
      await this.mr.reconcileCanonical(repo, previous, head);
      await this.audit('canonical.observed', 'git', { repo: repo.id, previous, head });
    }
    Object.assign(repo, { head, unavailable: false, ...(tree === undefined ? {} : { tree }) });
    return changed;
  }
  async syncHeads() {
    let changed = false;
    for (const repo of this.state.repositories) {
      let head;
      try {
        head = await this.git.ref(repo, repo.canonical_ref);
      } catch (error) {
        if (error.code !== 'REF_NOT_FOUND') throw error;
        if (!repo.unavailable) {
          repo.unavailable = true;
          changed = true;
          await this.audit('canonical.unavailable', 'git', { repo: repo.id, last_head: repo.head });
        }
        continue;
      }
      if (head !== repo.head || repo.unavailable) {
        let tree;
        // Native projections must never pair a fresh head with the previous tree.
        if (this.state.nativeRepositories?.some((registered) => registered.id === repo.id)) {
          const facts = await this.git.facts(repo, head, head);
          if (facts.head !== head)
            throw new DomainError(
              'INVALID_GIT_FACTS',
              'Git did not establish the observed canonical tree',
              503,
            );
          tree = facts.tree;
        }
        if (await this.observeCanonical(repo, head, tree)) changed = true;
      }
    }
    if (changed) await this.save(this.state);
    return changed;
  }
  requireCanonical(repo) {
    if (repo.unavailable)
      throw new DomainError(
        'CANONICAL_UNAVAILABLE',
        'Restore the canonical Git branch before preparing or applying a change.',
        409,
      );
  }
  async validate(subject, repo, tree, commit, validityHeads = {}) {
    const configHash = this.git.configHash;
    const constraints = this.state.constraints.filter((c) => c.active);
    const constraintVersions = constraints.map((c) => c.id);
    const result = await this.git.validate(
      repo,
      commit,
      constraints.filter((c) => c.kind === 'checkable'),
      validityHeads,
    );
    const evidence = await record('ev', {
      subject_ref: subject,
      tree_hash: tree,
      type: 'trusted-validation',
      config_hash: configHash,
      result,
      source: 'platform-owned checks',
      created_at: now(),
      validity_heads: validityHeads,
      constraint_versions: constraintVersions,
      claim: 'Establishes only the listed checks for this exact tree and configuration.',
    });
    this.state.evidence.push(evidence);
    return evidence;
  }
  async contextValidity(snapshot) {
    for (const source of snapshot?.sources ?? []) {
      const repo = this.repo(source.repo),
        head = await this.git.ref(repo, source.ref_seen ?? repo.canonical_ref);
      const content = await this.git.file(repo, head, source.path);
      if (typeof content !== 'string' || (await hash(content)) !== source.content_hash)
        return {
          status: 'stale',
          reason: 'Retrieved policy content changed; prepare and review a new context.',
        };
    }
    return { status: 'current' };
  }
  async compose(repoId, revisionIds) {
    const repo = this.repo(repoId);
    this.requireCanonical(repo);
    const revisions = revisionIds.map((id) => this.revision(id));
    if (revisions.some((r) => r.repo !== repoId))
      throw new DomainError(
        'CROSS_REPO_COMPOSITION',
        'A Git composition belongs to one repository',
      );
    const baseHead = repo.head;
    const validityHeads = Object.fromEntries(this.state.repositories.map((r) => [r.id, r.head]));
    const result = await this.git.compose(repo, baseHead, revisions);
    if (result.conflict)
      throw new DomainError(
        'COMPOSITION_CONFLICT',
        'Candidate cannot be applied because the Git merge failed',
        422,
      );
    const composition = await record('comp', {
      repo: repoId,
      proposal_revision_ids: [...revisionIds].sort(),
      base_commit: baseHead,
      base_tree: result.baseTree,
      resulting_tree: result.tree,
      commit: result.commit,
    });
    if (!this.state.compositions.some((c) => c.id === composition.id))
      this.state.compositions.push(composition);
    let evidence = await this.validate(
      composition.id,
      repo,
      result.tree,
      result.commit,
      validityHeads,
    );
    const contextChecks = [];
    for (const r of revisions.filter(
      (r) => r.context_binding_state === 'bound' || r.context_binding_state === 'invalid',
    )) {
      const snapshot = this.state.contexts.find((c) => c.id === r.context_version),
        validity = await this.contextValidity(snapshot);
      const expected = snapshot?.parameter_values?.retry_failed_response,
        observed = evidence.result.observations?.lostResponse?.attempts;
      const passed =
        r.context_binding_state === 'bound' &&
        validity.status === 'current' &&
        typeof expected === 'boolean' &&
        observed === (expected ? 2 : 1);
      contextChecks.push({
        name: 'Bound retry answer matches observed behavior',
        passed,
        detail:
          validity.status === 'stale'
            ? validity.reason
            : `Immutable answer expects ${expected ? 2 : 1} attempt(s); trusted transport observed ${observed ?? 'unavailable'}.`,
      });
    }
    if (contextChecks.length) {
      evidence = await record('ev', {
        ...Object.fromEntries(Object.entries(evidence).filter(([k]) => k !== 'id')),
        result: {
          ...evidence.result,
          passed: evidence.result.passed && contextChecks.every((c) => c.passed),
          checks: [...evidence.result.checks, ...contextChecks],
        },
        created_at: now(),
      });
      this.state.evidence.push(evidence);
    }
    return {
      composition_id: composition.id,
      evidence_ids: [evidence.id],
      validation: result.conflict ? 'conflict' : validationPassed(evidence) ? 'passed' : 'failed',
    };
  }
  async readDeclaration(repo, head) {
    if (!this.git.file) return {};
    const raw = await readProducerMetadata(this.git, repo, head, 'proposal.json');
    if (!raw || raw.length > 32768) return {};
    try {
      const d = JSON.parse(raw);
      return {
        present: true,
        title: typeof d.title === 'string' ? d.title.slice(0, 200) : undefined,
        statement: typeof d.statement === 'string' ? d.statement.slice(0, 1000) : undefined,
        producer: typeof d.producer === 'string' ? d.producer.slice(0, 100) : undefined,
        decision_key: typeof d.decision_key === 'string' ? d.decision_key.slice(0, 100) : null,
        choice: typeof d.choice === 'string' ? d.choice.slice(0, 100) : null,
      };
    } catch {
      return {};
    }
  }
  async bindContext(repo, head, targetRepo = repo.id) {
    if (!this.git.file) return { state: 'unknown' };
    const raw = await readProducerMetadata(this.git, repo, head, 'context.json');
    if (!raw) return { state: 'unknown' };
    try {
      const artifact = JSON.parse(raw);
      const task = this.state.tasks.find((t) => t.task.id === artifact.task_id);
      if (!task?.authorization || !task.snapshot)
        return {
          state: 'invalid',
          task_id: artifact.task_id,
          reason: 'Task has no answered or explicitly assumed authorization.',
        };
      if (task.task.target_repo !== targetRepo)
        return {
          state: 'invalid',
          task_id: artifact.task_id,
          reason: 'The task targets another canonical repository.',
        };
      if (
        (artifact.context_snapshot_id ?? artifact.context_version) !== task.snapshot.id ||
        artifact.authorization_ref !== task.authorization.id ||
        artifact.answer_ref !== task.snapshot.answer_ref
      )
        return {
          state: 'invalid',
          task_id: artifact.task_id,
          reason: 'Code context identifiers differ from the immutable authorization.',
        };
      const parsed = this.git.trailers ? await this.git.trailers(repo, head) : '';
      const trailers = Array.isArray(parsed)
        ? parsed.map((t) => `${t.key}: ${t.value}`)
        : parsed.split('\n');
      const required = [
        `Decision-Task: ${task.task.id}`,
        `Decision-Context: ${task.snapshot.id}`,
        `Decision-Authorization: ${task.authorization.id}`,
        ...(task.snapshot.answer_ref ? [`Decision-Answer: ${task.snapshot.answer_ref}`] : []),
      ];
      if (required.some((t) => !trailers.includes(t)))
        return {
          state: 'invalid',
          task_id: task.task.id,
          reason: 'The commit does not carry the exact trailing authorization references.',
        };
      if ((await this.contextValidity(task.snapshot)).status !== 'current')
        return {
          state: 'invalid',
          task_id: task.task.id,
          reason: 'The retrieved policy content has changed.',
        };
      return { state: 'bound', task_id: task.task.id, snapshot: task.snapshot };
    } catch {
      return { state: 'invalid', reason: 'Context artifact cannot be verified.' };
    }
  }
  async prepareTask(input, actor) {
    const task = await prepareTaskContext({
      task: input,
      repositories: this.state.repositories,
      git: this.git,
      actor,
    });
    this.state.tasks.push(task);
    this.state.contextPreparations.push(task);
    if (task.snapshot) this.state.contexts.push(task.snapshot);
    for (const c of this.state.constraints) {
      const prior = this.state.contextPreparations.find((p) => p.source.id === c.source_ref);
      if (
        prior &&
        prior.source.repo === task.source.repo &&
        prior.source.path === task.source.path &&
        c.id !== task.constraint.id
      )
        c.active = false;
    }
    if (!this.state.constraints.some((c) => c.id === task.constraint.id))
      this.state.constraints.push({
        ...task.constraint.value,
        id: task.constraint.id,
        source_ref: task.source.id,
        active: true,
      });
    await this.audit('context.prepared', actor, {
      task_id: task.task.id,
      question_id: task.question?.id ?? null,
      source: task.source.id,
    });
    await this.save(this.state);
    return task;
  }
  async resolveTask(id, input, actor, assumption = false) {
    const i = this.state.tasks.findIndex((t) => t.task.id === id);
    if (i < 0) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    const prior = this.state.tasks[i];
    if ((await this.contextValidity({ sources: [prior.source] })).status !== 'current')
      throw new DomainError(
        'CONTEXT_STALE',
        'The retrieved policy changed. Prepare a new task before answering.',
        409,
      );
    if (prior.authorization) {
      const item = prior.snapshot.items.find(
        (i) => i.type === (assumption ? 'assumption' : 'parameter'),
      );
      if (
        item?.source?.actor === actor &&
        prior.snapshot.parameter_values.retry_failed_response === input.value &&
        (!assumption || item.value.rationale === input.rationale)
      )
        return prior;
      throw new DomainError(
        'CONTEXT_ALREADY_RESOLVED',
        'This task has a different immutable answer or assumption.',
        409,
      );
    }
    const task = await (assumption ? assumeTaskContext : answerTaskContext)(prior, {
      value: input.value,
      rationale: input.rationale,
      actor,
      created_at: now(),
    });
    this.state.tasks[i] = task;
    this.state.contextPreparations.push(task);
    this.state.contexts.push(task.snapshot);
    await this.audit(assumption ? 'context.assumed' : 'context.answered', actor, {
      task_id: id,
      context_version: task.snapshot.id,
      answer_ref: task.snapshot.answer_ref,
      source: task.source.id,
    });
    await this.save(this.state);
    return task;
  }
  settled(id) {
    return this.state.dispositions.some((d) => d.revision_id === id);
  }
  currentEvidence(subject) {
    return this.state.evidence
      .filter(
        (e) =>
          e.subject_ref === subject &&
          e.type === 'trusted-validation' &&
          e.source === 'platform-owned checks' &&
          this.evidenceValidity(e).status === 'current',
      )
      .at(-1);
  }
  applicableRelationships() {
    return applicableRelationships(this);
  }
  async analyzeWork(options = {}) {
    return analyzeWork(this, options);
  }
  async basis(component) {
    return decisionBasis(this, component);
  }
  async buildDecision(c) {
    return buildDecision(this, c);
  }
  async validateRevision(id, { actor = 'coordinator' } = {}) {
    await this.syncHeads();
    const revision = this.revision(id);
    const candidate = await this.compose(revision.repo, [id]),
      evidence = this.state.evidence.find((e) => e.id === candidate.evidence_ids[0]);
    const single = await record('ev', {
      ...Object.fromEntries(Object.entries(evidence).filter(([k]) => k !== 'id')),
      subject_ref: id,
      composition_ref: candidate.composition_id,
      subject_versions: [
        { revision_id: id, head_commit: revision.head_commit, tree_hash: revision.tree_hash },
      ],
      created_at: now(),
    });
    this.state.evidence.push(single);
    await this.audit('validation.completed', actor, {
      revision_id: id,
      evidence_id: single.id,
      composition_id: candidate.composition_id,
    });
    await this.save(this.state);
    return {
      revision_id: id,
      composition_id: candidate.composition_id,
      evidence_id: single.id,
      passed: single.result.passed,
      result: single.result,
      validity: this.evidenceValidity(single),
      claim: single.claim,
    };
  }
  async verifyRevisionHeads(ids) {
    return verifyRevisionHeads(this, ids);
  }
  async prepareReview(input, actor) {
    return prepareReview(this, input, actor);
  }
  async prepareRevert(input, actor) {
    return prepareRevert(this, input, actor);
  }
  async refreshDecision(id) {
    return refreshDecision(this, id);
  }
  async resolve(id, input, actor, execution = {}) {
    return resolveDecision(this, id, input, actor, execution);
  }
  async restoreDispositions(decision, commit) {
    return restoreDispositions(this, decision, commit);
  }
  async recover() {
    return recoverOperations(this);
  }
  async view() {
    await this.syncHeads();
    const evidence = this.state.evidence.map((e) => ({ ...e, validity: this.evidenceValidity(e) }));
    const decisions = await Promise.all(
      this.state.decisionComponents.map(async (c) => ({
        ...c,
        stale:
          !['resolved', 'deferred'].includes(c.status) && c.basis_hash !== (await this.basis(c)),
      })),
    );
    const active = this.activeRevisions(),
      total = active.length,
      pending = new Set(
        active
          .filter((r) => !this.settled(r.id) && this.mr.analysisEligible(r.id))
          .map((r) => r.id),
      );
    const open = decisions.filter(
      (d) =>
        !['resolved', 'deferred'].includes(d.status) &&
        d.revision_ids.some((id) => pending.has(id)),
    );
    const covered = new Set(
      open.flatMap((d) => [...d.revision_ids, ...(d.supplemental_revision_ids ?? [])]),
    );
    const conventional = [...pending].filter((id) => !covered.has(id));
    const discovery = { ...this.state.discovery, conventional_review_ids: conventional },
      required = open.length + conventional.length;
    const presented = decisions.map((c) => ({ ...c, actionable: open.some((d) => d.id === c.id) }));
    return {
      ...this.state,
      nativeState: { ...this.native.view(), ...this.pipeline.view() },
      discovery,
      mergeRequests: this.mr.list(),
      mergeQueue: this.queue.list(),
      revisions: this.state.revisions.map((r) => ({ ...r, stale: !active.includes(r) })),
      evidence,
      decisionComponents: presented,
      summary: {
        proposals: total,
        decisionsRequired: required,
        contextAnswersRecorded: this.state.tasks.filter((t) => t.question && t.authorization)
          .length,
        pendingClarifications: this.state.tasks.filter((t) => t.question && !t.authorization)
          .length,
        initialDecisions: this.state.decisionComponents.length,
        compressionRatio: total
          ? (this.state.decisionComponents.length + conventional.length) / total
          : 0,
        graphDecisions: this.state.decisionComponents.length,
        conventionalReview: conventional.length,
        independentWork: this.state.discovery.ungrouped_revision_ids?.length ?? 0,
        comparisonsAvoided: Math.max(
          0,
          this.state.metrics.possibleComparisons - this.state.metrics.comparisons,
        ),
        traceableRationale: total
          ? active.filter((r) => r.provenance_state !== 'unknown').length / total
          : 0,
        mergeRequestsOpen: this.mr.list().filter((m) => m.status === 'open').length,
        queuePending: this.queue
          .list()
          .filter((q) =>
            ['queued', 'blocked', 'needs_review', 'recovery_required'].includes(q.status),
          ).length,
        humanReverts: this.state.operations.filter(
          (o) =>
            o.status === 'applied' &&
            this.state.decisions.some(
              (d) => d.id === o.decision_id && d.operation_kind === 'revert',
            ),
        ).length,
        staleEvidence: evidence.filter((e) => e.validity.status === 'stale').length,
      },
    };
  }
}
