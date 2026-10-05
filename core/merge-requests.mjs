import { hash, record, DomainError } from './hash.mjs';
import { validationPassed } from './evidence.mjs';

const now = () => new Date().toISOString();
const branches = /^refs\/heads\/[a-zA-Z0-9._/-]+$/;
const checkStatuses = ['pending', 'running', 'passed', 'failed', 'cancelled'];
const ancestryUnavailable = new Set([
  'MISSING_COMMIT',
  'ANCESTRY_UNAVAILABLE',
  'GIT_EXECUTOR_UNAVAILABLE',
  'REPO_NOT_CONFIGURED',
  'REMOTE_GIT_FAILED',
  'CONFIG_STALE',
]);
const terminalSuccess = new Set(['passing', 'passed', 'completed', 'success', 'succeeded']);
function resultPassed(result, status) {
  return (
    result?.passed === true &&
    [status, result.status, result.state].every(
      (value) => value == null || terminalSuccess.has(value),
    )
  );
}
function validationStatus(evidence) {
  const statuses = [
    evidence.status,
    evidence.state,
    evidence.result?.status,
    evidence.result?.state,
    ...(evidence.result?.checks ?? []).flatMap((check) => [check.status, check.state]),
  ];
  const blocker = statuses.find((status) => status != null && !terminalSuccess.has(status));
  return (
    blocker ??
    (validationPassed(evidence)
      ? 'passed'
      : evidence.result?.passed === false ||
          evidence.result?.checks?.some((check) => check.passed === false)
        ? 'failed'
        : 'unknown')
  );
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
function actorRequired(actor) {
  if (typeof actor !== 'string' || !actor.trim())
    throw new DomainError('UNAUTHENTICATED', 'An authenticated actor is required', 401);
}
function text(value, limit, required = false) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit)
    throw new DomainError('INVALID_MR_INPUT', 'A bounded text field is required');
  return value;
}
function pathValid(value) {
  return (
    typeof value === 'string' &&
    value &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}
function normalizePolicy(value = {}) {
  const policy = {
    minApprovals: value.minApprovals ?? 0,
    allowSelfApproval: value.allowSelfApproval ?? true,
    requiredChecks: value.requiredChecks ?? ['trusted-validation'],
  };
  if (
    !Number.isInteger(policy.minApprovals) ||
    policy.minApprovals < 0 ||
    policy.minApprovals > 20 ||
    typeof policy.allowSelfApproval !== 'boolean' ||
    !Array.isArray(policy.requiredChecks) ||
    policy.requiredChecks.some((check) => typeof check !== 'string' || !check || check.length > 200)
  )
    throw new DomainError(
      'INVALID_MR_POLICY',
      'Approval and platform check requirements are invalid',
    );
  return { ...policy, requiredChecks: [...new Set(policy.requiredChecks)].sort() };
}

/** Native review metadata. Git writes remain exclusively in the coordinator. */
export class MergeRequests {
  constructor(engine) {
    this.engine = engine;
    for (const key of [
      'mergeRequests',
      'mrEvents',
      'reviews',
      'comments',
      'checkRuns',
      'mrDependencies',
      'mrPolicies',
    ])
      engine.state[key] ??= [];
    // Public metadata writes can also be used outside Engine.serial. Internal
    // ingress/reconciliation hooks use the coordinator's boundary to avoid an
    // open -> ingest -> observe deadlock.
    this._tail = Promise.resolve();
    for (const name of [
      'open',
      'transition',
      'review',
      'reviewBatch',
      'comment',
      'check',
      'dependencies',
      'setPolicy',
    ]) {
      const method = this[name].bind(this);
      this[name] = (...args) => {
        const pending = this._tail.then(() => method(...args));
        this._tail = pending.catch(() => {});
        return pending;
      };
    }
  }
  get state() {
    return this.engine.state;
  }
  _mr(id) {
    const mr = this.state.mergeRequests.find((item) => item.id === id);
    if (!mr) throw new DomainError('MR_NOT_FOUND', 'Merge request not found', 404);
    return mr;
  }
  _forRevision(id) {
    const revision = this.engine.revision(id);
    return this.state.mergeRequests
      .filter(
        (mr) =>
          mr.proposal_id === revision.proposal_id &&
          (mr.revision_id === id || mr.status !== 'merged'),
      )
      .at(-1);
  }
  _pin(mr, input, revision = false) {
    const expected = input.expected_event_id ?? input.expected_version;
    if (expected !== mr.version && expected !== mr.event_id)
      throw new DomainError(
        'MR_STALE',
        'The merge request changed. Review its current version.',
        409,
        { version: mr.version, event_id: mr.event_id, revision_id: mr.revision_id },
      );
    if (revision && input.expected_revision_id !== mr.revision_id)
      throw new DomainError('MR_STALE', 'The reviewed source revision changed.', 409, {
        revision_id: mr.revision_id,
      });
  }
  async _replay(operation, target, input, actor) {
    if (!input.request_id) return null;
    text(input.request_id, 200, true);
    const payload_hash = await hash({
      operation,
      target,
      input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'request_id')),
    });
    const receipt = this.state.mrEvents.find(
      (event) => event.type === 'request.receipt' && event.request_id === input.request_id,
    );
    if (receipt) {
      if (receipt.actor !== actor || receipt.payload_hash !== payload_hash)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'This request ID was used for a different actor or payload',
          409,
        );
      await this.engine.save(this.state);
      return { replayed: true, response: receipt.response };
    }
    return { replayed: false, payload_hash };
  }
  async _event(mr, type, actor, data) {
    const event = await record('mr_event', {
      mr_id: mr.id,
      type,
      revision_id: mr.revision_id,
      actor,
      data,
      previous_event: mr.event_id ?? null,
      version: mr.version + 1,
      created_at: now(),
    });
    this.state.mrEvents.push(event);
    mr.version = event.version;
    mr.event_id = event.id;
    mr.updated_at = event.created_at;
    return event;
  }
  async _finish(mr, operation, input, actor, replay) {
    const response = this.get(mr.id);
    if (input.request_id)
      this.state.mrEvents.push(
        await record('mr_receipt', {
          type: 'request.receipt',
          mr_id: mr.id,
          request_id: input.request_id,
          actor,
          payload_hash: replay.payload_hash,
          response,
          created_at: now(),
        }),
      );
    await this.engine.audit('merge-request.' + operation, actor, {
      mr_id: mr.id,
      event_id: mr.event_id,
      revision_id: mr.revision_id,
    });
    await this.engine.save(this.state);
    return response;
  }
  getPolicy(repoId) {
    const repo = this.engine.repo(typeof repoId === 'string' ? repoId : repoId.id);
    const latest = this.state.mrPolicies.filter((policy) => policy.repo === repo.id).at(-1);
    return {
      ...normalizePolicy(latest?.policy ?? repo.merge_request_policy),
      version: latest?.version ?? 0,
      event_id: latest?.id ?? null,
      owner_id: repo.owner_id ?? this.state.workspace.owner_id ?? null,
    };
  }
  _trustedEvidence(revision, compositionId = null) {
    const composition = compositionId
      ? this.state.compositions.find((candidate) => candidate.id === compositionId)
      : null;
    const latest = new Map();
    // The trusted append order versions each exact subject/tree/config lineage.
    // Select its current record before checking outcome, so an old pass cannot
    // hide a failed or unfinished rerun. Producer timestamps never order proof.
    for (const evidence of this.state.evidence) {
      if (
        evidence.type !== 'trusted-validation' ||
        evidence.source !== 'platform-owned checks' ||
        this.engine.evidenceValidity(evidence).status !== 'current'
      )
        continue;
      const relevant = compositionId
        ? !!composition &&
          composition.repo === revision.repo &&
          composition.base_commit === this.engine.repo(revision.repo).head &&
          composition.proposal_revision_ids.includes(revision.id) &&
          evidence.subject_ref === composition.id &&
          evidence.tree_hash === composition.resulting_tree
        : evidence.subject_ref === revision.id &&
          (evidence.tree_hash === revision.tree_hash ||
            evidence.subject_versions?.some(
              (version) =>
                version.revision_id === revision.id &&
                version.head_commit === revision.head_commit &&
                version.tree_hash === revision.tree_hash,
            ));
      if (relevant)
        latest.set(
          JSON.stringify([evidence.subject_ref, evidence.tree_hash, evidence.config_hash]),
          evidence,
        );
    }
    return [...latest.values()];
  }
  _checks(mr, policy, compositionId = null) {
    const revision = this.engine.revision(mr.revision_id),
      evidence = this._trustedEvidence(revision, compositionId);
    const passed = policy.requiredChecks.filter(
      (check) =>
        evidence.length &&
        evidence.every(
          (item) =>
            validationPassed(item) &&
            (check === 'trusted-validation' ||
              item.check_ref === check ||
              item.result.check_ref === check ||
              item.result.checks?.some(
                (result) => result.check_ref === check && resultPassed(result),
              )),
        ),
    );
    const evidence_states = evidence.map((item) => ({
      id: item.id,
      subject_ref: item.subject_ref,
      tree_hash: item.tree_hash,
      config_hash: item.config_hash,
      passed: validationPassed(item),
      status: validationStatus(item),
    }));
    return {
      required: policy.requiredChecks,
      passed,
      missing: policy.requiredChecks.filter((check) => !passed.includes(check)),
      evidence_ids: evidence.map((item) => item.id),
      evidence_states,
      basis: 'observed',
      composition_ref: compositionId,
      claim: compositionId
        ? 'The latest current checks ran on this exact selected composed tree; this does not establish an isolated revision result.'
        : 'Only the latest current platform-owned checks can satisfy required validation; external CI reports remain declarations.',
    };
  }
  get(id) {
    const mr = this._mr(id),
      policy = this.getPolicy(mr.repo);
    const history = this.state.reviews.filter((review) => review.mr_id === id);
    const dismissed = new Set(
      history.filter((review) => review.action === 'dismiss').map((review) => review.review_id),
    );
    const latest = new Map();
    for (const review of history)
      if (
        review.revision_id === mr.revision_id &&
        ['approve', 'request_changes'].includes(review.action)
      )
        latest.set(review.actor, review);
    const current = [...latest.values()].filter((review) => !dismissed.has(review.id));
    const approvals = current.filter(
      (review) =>
        review.action === 'approve' && (policy.allowSelfApproval || review.actor !== mr.author),
    );
    const changes = current.filter((review) => review.action === 'request_changes');
    const comments = this.state.comments.filter((comment) => comment.mr_id === id);
    const threadIds = [...new Set(comments.map((comment) => comment.thread_id))];
    const threads = threadIds.map((threadId) => {
      const events = comments.filter((comment) => comment.thread_id === threadId),
        first = events[0],
        last = events.at(-1);
      return {
        id: threadId,
        revision_id: first.revision_id,
        file: first.file,
        line: first.line,
        resolved:
          [...events].reverse().find((comment) => ['resolve', 'reopen'].includes(comment.action))
            ?.action === 'resolve',
        comment_ids: events.map((comment) => comment.id),
        last_event_id: last.id,
        stale: first.revision_id !== mr.revision_id,
      };
    });
    const dependency = this.state.mrDependencies.filter((item) => item.mr_id === id).at(-1);
    const dependencies = (dependency?.dependency_ids ?? []).map((dependencyId) => {
      const target = this._mr(dependencyId);
      return {
        mr_id: target.id,
        revision_id: target.revision_id,
        declared_revision_id: dependency.revision_refs.find((ref) => ref.mr_id === target.id)
          ?.revision_id,
        status: target.status,
        draft: target.draft,
        reverted_by_decision: target.reverted_by_decision ?? null,
        event_id: target.event_id,
        declaration_ref: dependency.id,
      };
    });
    return structuredClone({
      ...mr,
      policy,
      events: this.state.mrEvents.filter(
        (event) => event.mr_id === id && event.type !== 'request.receipt',
      ),
      reviews: history.map((review) => ({
        ...review,
        stale: review.revision_id !== mr.revision_id,
        dismissed: dismissed.has(review.id),
      })),
      comments: comments.map((comment) => ({
        ...comment,
        stale: comment.revision_id !== mr.revision_id,
      })),
      threads,
      check_runs: this.state.checkRuns
        .filter((check) => check.mr_id === id)
        .map((check) => ({ ...check, stale: check.revision_id !== mr.revision_id })),
      dependency_ids: dependency?.dependency_ids ?? [],
      dependencies,
      review_state: {
        approvals: approvals.length,
        approval_refs: approvals.map((review) => review.id),
        changes_requested: changes.length,
        changes_requested_refs: changes.map((review) => review.id),
      },
      checks_state: this._checks(mr, policy),
    });
  }
  list() {
    return this.state.mergeRequests.map((mr) => this.get(mr.id));
  }
  async open(input, actor) {
    actorRequired(actor);
    const replay = await this._replay('open', null, input, actor);
    if (replay?.replayed) return replay.response;
    const repo = this.engine.repo(input.repo),
      sourceRepo = input.source_repo ?? repo.id,
      sourceRef = input.source_ref;
    if (!branches.test(sourceRef ?? '') || sourceRef.includes('..'))
      throw new DomainError('INVALID_REF', 'A valid source branch is required');
    const targetRef = input.target_ref ?? repo.canonical_ref;
    if (targetRef !== repo.canonical_ref)
      throw new DomainError(
        'INVALID_MR_TARGET',
        'This version supports the registered canonical target branch',
      );
    if (sourceRepo === repo.id && sourceRef === targetRef)
      throw new DomainError(
        'INVALID_MR_SOURCE',
        'The canonical branch cannot propose changes to itself',
      );
    if (
      sourceRepo !== repo.id &&
      !this.state.forks.some((fork) => fork.id === sourceRepo && fork.repo === repo.id)
    )
      throw new DomainError(
        'UNREGISTERED_FORK',
        'Source repository is not registered for this target',
        403,
      );
    const title = text(input.title, 200, true),
      description = input.description === undefined ? '' : text(input.description, 4000);
    if (
      this.state.mergeRequests.some(
        (mr) =>
          mr.repo === repo.id &&
          mr.source_repo === sourceRepo &&
          mr.source_ref === sourceRef &&
          mr.status !== 'merged',
      )
    )
      throw new DomainError(
        'MR_ALREADY_EXISTS',
        'Reopen the existing merge request for this source branch',
        409,
      );
    const source = { ...repo, id: sourceRepo },
      head = await this.engine.git.ref(source, sourceRef);
    const ingress = await this.engine.ingest({
      repo: repo.id,
      source_repo: sourceRepo,
      ref: sourceRef,
      after: head,
    });
    if (!ingress.revision_id)
      throw new DomainError('MR_STALE', 'The source moved during merge request creation', 409);
    const revision = this.engine.revision(ingress.revision_id);
    const created_at = now(),
      id =
        'mr_' +
        (await hash({
          repo: repo.id,
          source_repo: sourceRepo,
          source_ref: sourceRef,
          head,
          author: actor,
          created_at,
        }));
    const mr = {
      id,
      repo: repo.id,
      source_repo: sourceRepo,
      source_ref: sourceRef,
      target_ref: targetRef,
      proposal_id: revision.proposal_id,
      revision_id: revision.id,
      head_commit: head,
      title,
      description,
      author: actor,
      status: 'open',
      draft: input.draft === true,
      version: 0,
      event_id: null,
      created_at,
    };
    this.state.mergeRequests.push(mr);
    await this._event(mr, 'opened', actor, { draft: mr.draft, source_commit: head });
    return this._finish(mr, 'opened', input, actor, replay);
  }
  async transition(id, input, actor) {
    actorRequired(actor);
    const replay = await this._replay('transition', id, input, actor);
    if (replay?.replayed) return replay.response;
    const mr = this._mr(id);
    this._pin(mr, input);
    if (mr.status === 'merged')
      throw new DomainError('MR_TERMINAL', 'A merged request cannot be reopened or edited', 409);
    const action = input.action === 'edit' ? 'update' : input.action;
    if (action === 'policy') {
      const policy = this.getPolicy(mr.repo);
      if (actor !== policy.owner_id)
        throw new DomainError(
          'FORBIDDEN',
          'Only the repository owner can change review policy',
          403,
        );
      await this._setPolicy(mr.repo, input.policy, actor);
    } else if (action === 'update') {
      if (!own(input, 'title') && !own(input, 'description'))
        throw new DomainError('INVALID_MR_INPUT', 'Supply a title or description to update');
      const title = own(input, 'title') ? text(input.title, 200, true) : mr.title;
      const description = own(input, 'description')
        ? text(input.description, 4000)
        : mr.description;
      mr.title = title;
      mr.description = description;
    } else if (['draft', 'ready'].includes(action)) {
      if (mr.status !== 'open')
        throw new DomainError('MR_CLOSED', 'Reopen the request before changing draft status', 409);
      mr.draft = action === 'draft';
    } else if (action === 'close') {
      mr.status = 'closed';
      mr.resolution = 'closed';
    } else if (action === 'reopen') {
      mr.status = 'open';
      mr.resolution = null;
    } else throw new DomainError('INVALID_MR_ACTION', 'Unsupported merge request transition');
    await this._event(mr, action, actor, {
      title: mr.title,
      description: mr.description,
      status: mr.status,
      draft: mr.draft,
      policy: action === 'policy' ? this.getPolicy(mr.repo) : undefined,
    });
    return this._finish(mr, action, input, actor, replay);
  }
  async review(id, input, actor) {
    actorRequired(actor);
    const replay = await this._replay('review', id, input, actor);
    if (replay?.replayed) return replay.response;
    const mr = this._mr(id);
    await this._reviewPreflight(mr, input, actor);
    const review = await record('mr_review', {
      mr_id: id,
      revision_id: mr.revision_id,
      head_commit: mr.head_commit,
      actor,
      action: input.action,
      body: input.body === undefined ? '' : text(input.body, 4000),
      review_id: input.action === 'dismiss' ? input.review_id : null,
      basis: 'declared',
      created_at: now(),
    });
    this.state.reviews.push(review);
    await this._event(mr, 'review.' + input.action, actor, { review_ref: review.id });
    return this._finish(mr, 'review.' + input.action, input, actor, replay);
  }
  async _reviewPreflight(mr, input, actor) {
    this._pin(mr, input, true);
    if (mr.status !== 'open')
      throw new DomainError('MR_CLOSED', 'Only open merge requests can be reviewed', 409);
    if (!['approve', 'request_changes', 'comment', 'dismiss'].includes(input.action))
      throw new DomainError('INVALID_MR_ACTION', 'Unsupported review action');
    if (input.body !== undefined) text(input.body, 4000);
    const source = { ...this.engine.repo(mr.repo), id: mr.source_repo };
    if (mr.source_deleted || (await this.engine.git.ref(source, mr.source_ref)) !== mr.head_commit)
      throw new DomainError(
        'MR_STALE',
        'The authoritative source head changed before review',
        409,
        { mr_id: mr.id, revision_id: mr.revision_id },
      );
    if (input.action === 'dismiss') {
      const prior = this.state.reviews.find(
        (review) =>
          review.id === input.review_id &&
          review.mr_id === mr.id &&
          review.revision_id === mr.revision_id,
      );
      if (!prior || !['approve', 'request_changes'].includes(prior.action))
        throw new DomainError(
          'REVIEW_NOT_FOUND',
          'The current review to dismiss was not found',
          404,
        );
      if (actor !== prior.actor && actor !== this.getPolicy(mr.repo).owner_id)
        throw new DomainError(
          'FORBIDDEN',
          'Only the reviewer or repository owner can dismiss a review',
          403,
        );
    }
  }
  async reviewBatch(items, actor) {
    actorRequired(actor);
    items = Array.isArray(items) ? items : items?.items;
    if (!Array.isArray(items) || !items.length || items.length > 100)
      throw new DomainError('INVALID_MR_INPUT', 'A bounded batch of exact reviews is required');
    const unique = new Set(),
      plans = [];
    for (const item of items) {
      const id = item.mr_id ?? item.id;
      if (unique.has(id))
        throw new DomainError('INVALID_MR_INPUT', 'A batch must contain distinct merge requests');
      unique.add(id);
      const replay = await this._replay('review', id, item, actor);
      if (replay?.replayed) {
        plans.push({ replayed: replay.response });
        continue;
      }
      const mr = this._mr(id);
      await this._reviewPreflight(mr, item, actor);
      plans.push({ mr, input: item, replay });
    }
    // Preflight every exact head and version before appending any new review.
    for (const plan of plans.filter((plan) => plan.mr)) {
      const { mr, input } = plan;
      const review = await record('mr_review', {
        mr_id: mr.id,
        revision_id: mr.revision_id,
        head_commit: mr.head_commit,
        actor,
        action: input.action,
        body: input.body ?? '',
        review_id: input.action === 'dismiss' ? input.review_id : null,
        basis: 'declared',
        created_at: now(),
      });
      this.state.reviews.push(review);
      await this._event(mr, 'review.' + input.action, actor, { review_ref: review.id });
    }
    const responses = [];
    for (const plan of plans) {
      if (plan.replayed) {
        responses.push(plan.replayed);
        continue;
      }
      const response = this.get(plan.mr.id);
      responses.push(response);
      if (plan.input.request_id)
        this.state.mrEvents.push(
          await record('mr_receipt', {
            type: 'request.receipt',
            mr_id: plan.mr.id,
            request_id: plan.input.request_id,
            actor,
            payload_hash: plan.replay.payload_hash,
            response,
            created_at: now(),
          }),
        );
      await this.engine.audit('merge-request.review.' + plan.input.action, actor, {
        mr_id: plan.mr.id,
        event_id: plan.mr.event_id,
        revision_id: plan.mr.revision_id,
        batch: true,
      });
    }
    await this.engine.save(this.state);
    return responses;
  }
  async comment(id, input, actor) {
    actorRequired(actor);
    const replay = await this._replay('comment', id, input, actor);
    if (replay?.replayed) return replay.response;
    const mr = this._mr(id);
    this._pin(mr, input, true);
    const action = input.action ?? 'comment';
    if (!['comment', 'resolve', 'reopen'].includes(action))
      throw new DomainError('INVALID_MR_ACTION', 'Unsupported thread action');
    const thread = input.thread_id
      ? this.get(id).threads.find((thread) => thread.id === input.thread_id)
      : null;
    if (input.thread_id && (!thread || thread.revision_id !== mr.revision_id))
      throw new DomainError(
        'THREAD_STALE',
        'The thread does not belong to this source revision',
        409,
      );
    if (action !== 'comment' && !thread)
      throw new DomainError('THREAD_NOT_FOUND', 'A thread is required', 404);
    const file = thread?.file ?? input.file ?? null,
      line = thread?.line ?? input.line ?? null;
    if (
      file !== null &&
      (!pathValid(file) || (line !== null && (!Number.isInteger(line) || line < 1)))
    )
      throw new DomainError(
        'INVALID_COMMENT_LOCATION',
        'A relative path and positive line number are required',
      );
    if (line !== null && file === null)
      throw new DomainError('INVALID_COMMENT_LOCATION', 'A line comment requires a file');
    if (file !== null) {
      const content = await this.engine.git.file(
        { ...this.engine.repo(mr.repo), id: mr.source_repo },
        mr.head_commit,
        file,
      );
      if (typeof content !== 'string' || (line !== null && line > content.split('\n').length))
        throw new DomainError(
          'INVALID_COMMENT_LOCATION',
          'The file or line is unavailable in the pinned source commit',
        );
    }
    const body = action === 'comment' ? text(input.body, 4000, true) : '';
    const created_at = now(),
      threadId =
        thread?.id ??
        'thread_' +
          (await hash({
            mr_id: id,
            revision_id: mr.revision_id,
            actor,
            file,
            line,
            body,
            created_at,
            request_id: input.request_id,
          }));
    const comment = await record('mr_comment', {
      mr_id: id,
      revision_id: mr.revision_id,
      head_commit: mr.head_commit,
      thread_id: threadId,
      actor,
      action,
      body,
      file,
      line,
      created_at,
    });
    this.state.comments.push(comment);
    await this._event(mr, 'thread.' + action, actor, {
      comment_ref: comment.id,
      thread_id: threadId,
    });
    return this._finish(mr, 'thread.' + action, input, actor, replay);
  }
  async check(id, input, actor) {
    actorRequired(actor);
    const replay = await this._replay('check', id, input, actor);
    if (replay?.replayed) return replay.response;
    const mr = this._mr(id);
    this._pin(mr, input, true);
    if (!checkStatuses.includes(input.status))
      throw new DomainError('INVALID_CHECK_STATUS', 'Unsupported check status');
    const check = await record('mr_check', {
      mr_id: id,
      revision_id: mr.revision_id,
      head_commit: mr.head_commit,
      actor,
      name: text(input.name, 200, true),
      status: input.status,
      details: input.details === undefined ? '' : text(input.details, 4000),
      url: input.url === undefined ? null : text(input.url, 1000),
      basis: 'declared',
      source: 'external-ci',
      created_at: now(),
    });
    this.state.checkRuns.push(check);
    await this._event(mr, 'check.reported', actor, { check_ref: check.id });
    return this._finish(mr, 'check.reported', input, actor, replay);
  }
  reportCheck(id, input, actor) {
    return this.check(id, input, actor);
  }
  async dependencies(id, input, actor) {
    actorRequired(actor);
    const replay = await this._replay('dependencies', id, input, actor);
    if (replay?.replayed) return replay.response;
    const mr = this._mr(id);
    this._pin(mr, input);
    if (
      !Array.isArray(input.dependency_ids) ||
      input.dependency_ids.some((value) => typeof value !== 'string')
    )
      throw new DomainError('INVALID_DEPENDENCIES', 'Dependency IDs are required');
    const dependencyIds = [...new Set(input.dependency_ids)].sort();
    dependencyIds.forEach((value) => this._mr(value));
    const graph = new Map(
      this.state.mergeRequests.map((item) => [
        item.id,
        item.id === id
          ? dependencyIds
          : (this.state.mrDependencies.filter((dependency) => dependency.mr_id === item.id).at(-1)
              ?.dependency_ids ?? []),
      ]),
    );
    const visiting = new Set(),
      visited = new Set();
    function visit(node) {
      if (visiting.has(node))
        throw new DomainError(
          'DEPENDENCY_CYCLE',
          'Merge request dependencies must form a DAG',
          409,
        );
      if (visited.has(node)) return;
      visiting.add(node);
      for (const next of graph.get(node) ?? []) visit(next);
      visiting.delete(node);
      visited.add(node);
    }
    for (const node of graph.keys()) visit(node);
    const dependency = await record('mr_dependency', {
      mr_id: id,
      revision_id: mr.revision_id,
      dependency_ids: dependencyIds,
      revision_refs: dependencyIds.map((dependencyId) => ({
        mr_id: dependencyId,
        revision_id: this._mr(dependencyId).revision_id,
      })),
      actor,
      created_at: now(),
    });
    this.state.mrDependencies.push(dependency);
    await this._event(mr, 'dependencies.updated', actor, { dependency_ref: dependency.id });
    return this._finish(mr, 'dependencies.updated', input, actor, replay);
  }
  async _setPolicy(repoId, value, actor) {
    const current = this.getPolicy(repoId);
    if (actor !== current.owner_id)
      throw new DomainError('FORBIDDEN', 'Only the repository owner can change review policy', 403);
    const policy = await record('mr_policy', {
      repo: repoId,
      policy: normalizePolicy(value),
      version: current.version + 1,
      previous: current.event_id,
      actor,
      created_at: now(),
    });
    this.state.mrPolicies.push(policy);
    return policy;
  }
  async setPolicy(repoId, input, actor) {
    actorRequired(actor);
    const replay = await this._replay('policy', repoId, input, actor);
    if (replay?.replayed) return replay.response;
    const current = this.getPolicy(repoId);
    if (input.expected_version !== current.version && input.expected_version !== current.event_id)
      throw new DomainError('MR_STALE', 'Repository review policy changed', 409);
    const policy = await this._setPolicy(repoId, input.policy, actor);
    const response = this.getPolicy(repoId);
    if (input.request_id)
      this.state.mrEvents.push(
        await record('mr_receipt', {
          type: 'request.receipt',
          mr_id: null,
          request_id: input.request_id,
          actor,
          payload_hash: replay.payload_hash,
          response,
          created_at: now(),
        }),
      );
    await this.engine.audit('merge-request.policy.updated', actor, {
      repo: repoId,
      policy_ref: policy.id,
    });
    await this.engine.save(this.state);
    return response;
  }
  async observeRevision(revision) {
    const proposal = this.state.proposals.find((proposal) => proposal.id === revision.proposal_id);
    if (!proposal) return [];
    const source = {
      ...this.engine.repo(revision.repo),
      id: revision.source_repo ?? revision.repo,
    };
    if ((await this.engine.git.ref(source, proposal.ref)) !== revision.head_commit) return [];
    const changed = [];
    for (const mr of this.state.mergeRequests.filter(
      (mr) =>
        mr.proposal_id === revision.proposal_id &&
        mr.status !== 'merged' &&
        (mr.revision_id !== revision.id || mr.source_deleted),
    )) {
      const previous = mr.revision_id;
      mr.revision_id = revision.id;
      mr.head_commit = revision.head_commit;
      mr.source_deleted = false;
      await this._event(mr, 'source.updated', 'git-ingress', {
        previous_revision: previous,
        revision_id: revision.id,
      });
      changed.push(this.get(mr.id));
    }
    return changed;
  }
  async observeDeletion(sourceRepoId, ref) {
    const changed = [];
    for (const mr of this.state.mergeRequests.filter(
      (mr) =>
        mr.source_repo === sourceRepoId &&
        mr.source_ref === ref &&
        mr.status !== 'merged' &&
        !mr.source_deleted,
    )) {
      mr.source_deleted = true;
      await this._event(mr, 'source.deleted', 'git-ingress', { source_repo: sourceRepoId, ref });
      changed.push(this.get(mr.id));
    }
    return changed;
  }
  analysisEligible(revisionId) {
    const mr = this._forRevision(revisionId);
    return (
      !mr ||
      (mr.status === 'open' && !mr.draft && !mr.source_deleted && mr.revision_id === revisionId)
    );
  }
  async basisFor(revisionIds) {
    const requests = new Map();
    const add = (mr) => {
      if (!mr || requests.has(mr.id)) return;
      requests.set(mr.id, this.get(mr.id));
      for (const id of requests.get(mr.id).dependency_ids) add(this._mr(id));
    };
    for (const id of [...new Set(revisionIds)].sort()) add(this._forRevision(id));
    return hash({
      revision_ids: [...new Set(revisionIds)].sort(),
      requests: [...requests.values()].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  async guardRevisionIds(ids, actor = 'coordinator', { composition_id = null } = {}) {
    actorRequired(actor);
    const selected = new Set(ids),
      reasons = [],
      merge_request_ids = [];
    if (composition_id) {
      const composition = this.state.compositions.find(
        (candidate) => candidate.id === composition_id,
      );
      if (
        !composition ||
        JSON.stringify([...new Set(composition.proposal_revision_ids)].sort()) !==
          JSON.stringify([...selected].sort())
      )
        throw new DomainError(
          'MR_STALE',
          'Required composed validation must cover this exact selected revision set',
          409,
        );
    }
    for (const id of selected) {
      const revision = this.engine.revision(id),
        proposal = this.state.proposals.find((proposal) => proposal.id === revision.proposal_id);
      const source = {
        ...this.engine.repo(revision.repo),
        id: revision.source_repo ?? revision.repo,
      };
      if (revision.source_kind === 'retained-candidate') {
        let facts;
        try {
          facts = await this.engine.git.facts(source, revision.head_commit, revision.head_commit);
        } catch {}
        if (!facts || facts.tree !== revision.tree_hash || facts.head !== revision.head_commit)
          throw new DomainError(
            'MR_STALE',
            'The platform-retained immutable candidate is unavailable or changed',
            409,
            { revision_id: id },
          );
      } else {
        let sourceHead;
        try {
          sourceHead = proposal ? await this.engine.git.ref(source, proposal.ref) : null;
        } catch {
          sourceHead = null;
        }
        if (!proposal || sourceHead !== revision.head_commit)
          throw new DomainError(
            'MR_STALE',
            'An authoritative source Git head changed or was deleted',
            409,
            { revision_id: id },
          );
      }
      const mr = this._forRevision(id);
      if (!mr) continue;
      merge_request_ids.push(mr.id);
      if (mr.revision_id !== id)
        throw new DomainError('MR_STALE', 'The merge request source revision changed', 409, {
          mr_id: mr.id,
          revision_id: mr.revision_id,
        });
      const view = this.get(mr.id),
        reason = (code, message) => reasons.push({ mr_id: mr.id, code, message });
      if (mr.status !== 'open') reason('MR_NOT_OPEN', 'The merge request is ' + mr.status);
      if (mr.draft) reason('MR_DRAFT', 'Publish the draft before canonical review');
      if (mr.source_deleted) reason('SOURCE_DELETED', 'The source branch was deleted');
      if (view.review_state.changes_requested)
        reason('CHANGES_REQUESTED', 'A current review requests changes');
      if (view.review_state.approvals < view.policy.minApprovals)
        reason('APPROVAL_REQUIRED', `${view.policy.minApprovals} current approval(s) required`);
      const checks = composition_id
        ? this._checks(mr, view.policy, composition_id)
        : view.checks_state;
      if (checks.missing.length)
        reason('REQUIRED_CHECKS', 'Missing current platform checks: ' + checks.missing.join(', '));
      for (const dependency of view.dependencies) {
        const target = this._mr(dependency.mr_id);
        if (dependency.declared_revision_id !== dependency.revision_id) {
          reason(
            'DEPENDENCY_STALE',
            'Review and redeclare the changed dependency revision: ' + dependency.mr_id,
          );
          continue;
        }
        if (target.reverted_by_decision) {
          reason(
            'DEPENDENCY_REVERTED',
            'The declared dependency was reverted: ' + dependency.mr_id,
          );
          continue;
        }
        if (target.status === 'merged') {
          const dependencyRepo = this.engine.repo(target.repo);
          let present = false;
          try {
            if (
              this.engine.git.isAncestor &&
              (await this.engine.git.ref(dependencyRepo, dependencyRepo.canonical_ref)) ===
                dependencyRepo.head
            )
              present =
                (await this.engine.git.isAncestor(
                  { ...dependencyRepo, source_repo: target.source_repo },
                  target.head_commit,
                  dependencyRepo.head,
                )) === true;
          } catch {}
          if (!present)
            reason(
              'DEPENDENCY_NOT_PRESENT',
              'Current canonical Git ancestry does not establish the exact dependency commit is present: ' +
                dependency.mr_id,
            );
          continue;
        }
        const selectedReady =
          target.status === 'open' &&
          !target.draft &&
          !target.source_deleted &&
          target.repo === mr.repo &&
          selected.has(dependency.revision_id);
        if (!selectedReady)
          reason(
            'DEPENDENCY_REQUIRED',
            'Dependency must be present in canonical Git or ready in this checked composition: ' +
              dependency.mr_id,
          );
      }
    }
    const basis_hash = await this.basisFor(ids),
      details = { merge_request_ids: [...new Set(merge_request_ids)].sort(), basis_hash, reasons };
    if (reasons.length)
      throw new DomainError(
        'MR_BLOCKED',
        'Merge request requirements are not satisfied',
        409,
        details,
      );
    return { allowed: true, ...details };
  }
  guard(ids, actor, options) {
    return this.guardRevisionIds(ids, actor, options);
  }
  async reconcileDecision(decision, commit) {
    const changed = [];
    if (decision.reverts_decision_id || decision.reverts_commit)
      for (const mr of this.state.mergeRequests.filter(
        (mr) =>
          (decision.reverts_decision_id
            ? mr.resolution_decision_id === decision.reverts_decision_id
            : mr.merge_commit === decision.reverts_commit) &&
          mr.status === 'merged' &&
          mr.reverted_by_decision !== decision.id,
      )) {
        mr.reverted_by_decision = decision.id;
        await this._event(mr, 'decision.reverted', decision.actor ?? 'coordinator', {
          decision_id: decision.id,
          original_decision_id: decision.reverts_decision_id ?? null,
          original_merge_commit: mr.merge_commit,
          reverts_commit: decision.reverts_commit ?? mr.merge_commit,
          commit,
        });
        changed.push(this.get(mr.id));
      }
    for (const [ids, status, resolution] of [
      [decision.proposal_revision_ids ?? [], 'merged', 'selected'],
      [decision.deferred_revision_ids ?? [], 'closed', 'deferred'],
    ])
      for (const id of ids) {
        const mr = this._forRevision(id);
        if (
          !mr ||
          mr.revision_id !== id ||
          (mr.resolution_decision_id === decision.id && mr.status === status)
        )
          continue;
        if (mr.status === 'merged') continue;
        mr.status = status;
        mr.resolution = resolution;
        mr.resolution_decision_id = decision.id;
        if (status === 'merged') mr.merge_commit = commit;
        await this._event(mr, 'decision.' + resolution, decision.actor ?? 'coordinator', {
          decision_id: decision.id,
          revision_id: id,
          commit: status === 'merged' ? commit : null,
        });
        changed.push(this.get(mr.id));
      }
    return changed;
  }
  async reconcileCanonical(repoInput, previous, head) {
    const repo = this.engine.repo(typeof repoInput === 'string' ? repoInput : repoInput.id),
      changed = [];
    if (previous === head || !this.engine.git.isAncestor) return changed;
    for (const mr of this.state.mergeRequests.filter(
      (mr) => mr.repo === repo.id && mr.status === 'open',
    )) {
      // Identity/ancestry is observed Git evidence. Matching trees, patches or a
      // squash message alone cannot establish that this source was merged.
      let present;
      try {
        present = await this.engine.git.isAncestor(
          { ...repo, source_repo: mr.source_repo },
          mr.head_commit,
          head,
        );
      } catch (error) {
        if (!ancestryUnavailable.has(error.code)) throw error;
        // Canonical Git observation remains usable when an old source object or
        // trusted transport is unavailable. This establishes no merge result.
        if (
          !this.state.audit.some(
            (event) =>
              event.type === 'mr.ancestry-unavailable' &&
              event.data?.mr_id === mr.id &&
              event.data?.canonical_head === head,
          )
        )
          await this.engine.audit('mr.ancestry-unavailable', 'git-ingress', {
            mr_id: mr.id,
            repo: repo.id,
            source_repo: mr.source_repo,
            source_commit: mr.head_commit,
            canonical_head: head,
            code: error.code,
            claim:
              'Ancestry could not be established for these immutable inputs; merge status is unchanged.',
          });
        continue;
      }
      if (!present) continue;
      mr.status = 'merged';
      mr.resolution = 'external-ancestry';
      mr.merge_commit = head;
      await this._event(mr, 'canonical.merged', 'git-ingress', {
        previous,
        head,
        source_commit: mr.head_commit,
        basis: 'observed-commit-ancestry',
      });
      changed.push(this.get(mr.id));
    }
    return changed;
  }
}
