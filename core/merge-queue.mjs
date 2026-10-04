import {hash, record, DomainError} from './hash.mjs';
import {validationPassed} from './evidence.mjs';

const now = () => new Date().toISOString();
const sorted = values => [...new Set(values)].sort();
const equalIds = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const CANCELLABLE = new Set(['queued', 'blocked', 'needs_review']);
const WAITING = new Set(['queued', 'blocked']);
const UNCERTAIN = new Set(['prepared', 'recovery-required']);

function actorRequired(actor) {
  if (typeof actor !== 'string' || !actor.trim()) throw new DomainError('UNAUTHENTICATED', 'Authenticated queue actor required', 401);
}
function requestId(input, required = false) {
  if (input.request_id === undefined && !required) return null;
  if (typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 200) {
    throw new DomainError('QUEUE_REQUEST_ID_REQUIRED', 'A nonempty request_id of at most 200 characters is required');
  }
  return input.request_id;
}

/**
 * A queue is an execution order for already-reviewed immutable decisions. It
 * never composes, refreshes, chooses an alternative, or repeats a Git operation.
 * API handlers must use the workspace serialization boundary; no engine.serial
 * call is made here. process() additionally rejects overlapping local invocations.
 */
export class MergeQueue {
  constructor(engine) {
    this.engine = engine; engine.state.mergeQueue ??= []; engine.state.queueEvents ??= [];
    this._processing = false;
  }
  list() {return structuredClone(this.engine.state.mergeQueue);}
  get(id) {
    const entry = this.engine.state.mergeQueue.find(item => item.id === id);
    if (!entry) throw new DomainError('QUEUE_ENTRY_NOT_FOUND', 'Merge queue entry not found', 404);
    return entry;
  }
  async _event(type, actor, data) {
    const events = this.engine.state.queueEvents;
    const event = await record('queue_event', {type, actor, data, previous: events.at(-1)?.id ?? null, created_at: now()});
    events.push(event); return event;
  }
  async _save() {await this.engine.save(this.engine.state);}
  async _replay(action, input, actor, resource = null) {
    const id = requestId(input);
    if (!id) return {request_id: null, input_hash: null};
    const inputHash = await hash({action, actor, resource, input});
    const receipt = this.engine.state.queueEvents.find(event => event.type === 'queue.request-completed'
      && event.data.action === action && event.data.request_id === id);
    if (receipt) {
      if (receipt.actor !== actor || receipt.data.input_hash !== inputHash) throw new DomainError('QUEUE_REQUEST_REUSED', 'This request_id already names a different authenticated queue action', 409);
      // A prior response save may have failed after its immutable receipt was
      // created in memory. Replaying persists the same state, never new work.
      await this._save();
      return {replayed: true, result: structuredClone(receipt.data.result)};
    }
    const pending = this.engine.state.queueEvents.find(event => event.type === 'queue.processing'
      && event.data.action === action && event.data.request_id === id);
    if (pending && (pending.actor !== actor || pending.data.input_hash !== inputHash)) throw new DomainError('QUEUE_REQUEST_REUSED', 'This request_id already names a different queue attempt', 409);
    return {request_id: id, input_hash: inputHash, pending};
  }
  async _complete(action, receipt, actor, result) {
    if (receipt.request_id) await this._event('queue.request-completed', actor, {action, request_id: receipt.request_id, input_hash: receipt.input_hash, result});
    await this._save(); return structuredClone(result);
  }
  async _mrSnapshot(ids) {
    const mr = this.engine.mr;
    if (!mr) return {basis_hash: null, merge_request_ids: [], dependencies: []};
    const items = mr.list().filter(item => ids.includes(item.revision_id));
    const visited = new Set(), dependencies = [];
    const visit = item => {
      if (!item || visited.has(item.id)) return;
      visited.add(item.id);
      dependencies.push({id: item.id, revision_id: item.revision_id ?? null, event_id: item.event_id ?? null,
        version: item.version ?? null, status: item.status ?? null, draft: !!item.draft,
        dependency_ids: sorted(item.dependency_ids ?? []), declaration_ref: item.declaration_ref ?? null,
        dependency_refs: (item.dependencies ?? []).map(dependency => ({mr_id: dependency.mr_id, revision_id: dependency.revision_id,
          declared_revision_id: dependency.declared_revision_id, event_id: dependency.event_id, declaration_ref: dependency.declaration_ref})).sort((a, b) => a.mr_id.localeCompare(b.mr_id))});
      for (const id of sorted(item.dependency_ids ?? [])) visit(mr.get(id));
    };
    items.forEach(visit);
    return {basis_hash: await mr.basisFor(ids), merge_request_ids: sorted(items.map(item => item.id)), dependencies: dependencies.sort((a, b) => a.id.localeCompare(b.id))};
  }
  async _guard(ids, actor, compositionId = null) {
    if (this.engine.mr) {
      const guard = await this.engine.mr.guardRevisionIds(ids, actor, {composition_id: compositionId});
      if (guard?.allowed !== true) throw new DomainError('MR_BLOCKED', 'Merge-request eligibility was not established', 409, {reasons: guard?.reasons ?? []});
      return guard;
    }
    // Conventional Git work still has an authoritative source-head guard.
    for (const id of ids) {
      const revision = this.engine.revision(id), proposal = this.engine.state.proposals.find(item => item.id === revision.proposal_id);
      if (revision.source_kind === 'retained-candidate') {
        const facts = await this.engine.git.facts(this.engine.repo(revision.repo), revision.head_commit, revision.base_commit);
        if (facts.head !== revision.head_commit || facts.tree !== revision.tree_hash) throw new DomainError('MR_STALE', 'The retained immutable candidate facts differ from the reviewed revision', 409);
        continue;
      }
      if (!proposal?.ref) throw new DomainError('MR_STALE', 'The selected source revision has no authoritative ref', 409);
      const repo = this.engine.repo(revision.repo), source = {...repo, id: revision.source_repo ?? revision.repo};
      let sourceHead;
      try {sourceHead = await this.engine.git.ref(source, proposal.ref);} catch (error) {
        if (error.code === 'REF_NOT_FOUND') throw new DomainError('MR_STALE', 'A selected source branch was deleted after review', 409);
        throw error;
      }
      if (sourceHead !== revision.head_commit) throw new DomainError('MR_STALE', 'A selected source head changed after review', 409);
    }
    return {allowed: true, merge_request_ids: [], basis_hash: null};
  }
  async _trustedSelection(component, alternative) {
    const repo = this.engine.repo(alternative.repo);
    const composition = this.engine.state.compositions.find(item => item.id === alternative.composition_id);
    const expectedIds = alternative.composed_revision_ids ?? sorted([...alternative.revision_ids,
      ...(component.supplemental_revision_ids ?? []).filter(id => this.engine.revision(id).repo === repo.id)]);
    if (alternative.validation !== 'passed' || !composition?.commit || !composition.resulting_tree || composition.repo !== repo.id || composition.base_commit !== repo.head
      || !equalIds(composition.proposal_revision_ids, expectedIds)) throw new DomainError('VALIDATION_REQUIRED', 'The exact reviewed composition requires current trusted passing validation', 422);
    const evidence = (alternative.evidence_ids ?? []).map(id => this.engine.state.evidence.find(item => item.id === id));
    if (!evidence.length || evidence.some(item => !item || item.source !== 'platform-owned checks' || item.type !== 'trusted-validation'
      || !validationPassed(item) || item.subject_ref !== composition.id || item.tree_hash !== composition.resulting_tree
      || this.engine.evidenceValidity(item).status !== 'current')) {
      throw new DomainError('VALIDATION_REQUIRED', 'Producer reports cannot authorize the merge queue; exact current trusted evidence is required', 422);
    }
    return {repo, composition, selected_revision_ids: sorted(composition.proposal_revision_ids), evidence_ids: evidence.map(item => item.id).sort()};
  }
  async enqueue(input, actor) {
    actorRequired(actor); requestId(input, true);
    const receipt = await this._replay('enqueue', input, actor);
    if (receipt.replayed) return receipt.result;
    if (receipt.pending) throw new DomainError('RECOVERY_REQUIRED', 'The prior queue request requires reconciliation', 409);
    await this.engine.syncHeads();
    const component = this.engine.component(input.component_id);
    if (['resolved', 'deferred'].includes(component.status)) throw new DomainError('DECISION_RESOLVED', 'The decision is already settled', 409);
    const alternative = component.alternatives.find(item => item.id === input.alternative_id);
    if (!alternative?.repo) throw new DomainError('INVALID_RESOLUTION', 'Select a validated single-repository alternative');
    const repo = this.engine.repo(alternative.repo);
    if (input.basis_hash !== component.basis_hash || input.basis_hash !== await this.engine.basis(component)
      || input.expected_canonical_head !== repo.head) throw new DomainError('DECISION_STALE', 'Review the current decision basis and canonical head before enqueueing', 409);
    const selected = await this._trustedSelection(component, alternative);
    if (input.selected_revision_ids && !equalIds(input.selected_revision_ids, selected.selected_revision_ids)) throw new DomainError('INVALID_RESOLUTION', 'Selected revisions must match the immutable reviewed composition');
    const mr = await this._mrSnapshot(selected.selected_revision_ids);
    const reviewedMrBasis = input.mr_basis_hash ?? alternative.merge_request_basis_hash ?? (mr.merge_request_ids.length ? component.merge_request_basis_hash : mr.basis_hash);
    if (mr.merge_request_ids.length && reviewedMrBasis == null) throw new DomainError('MR_REVIEW_BASIS_REQUIRED', 'The reviewed alternative must include its merge-request basis', 409);
    if (reviewedMrBasis !== mr.basis_hash) throw new DomainError('MR_STALE', 'Merge-request metadata changed after the displayed review', 409);
    let blockers = [];
    try {await this._guard(selected.selected_revision_ids, actor, selected.composition.id);} catch (error) {
      if (error.code !== 'MR_BLOCKED') throw error;
      blockers = error.details?.reasons ?? [{code: 'MR_BLOCKED', message: error.message}];
    }
    const duplicate = this.engine.state.mergeQueue.find(entry => ['queued', 'blocked', 'processing', 'recovery_required'].includes(entry.status)
      && entry.ticket.component_id === component.id && entry.ticket.alternative_id === alternative.id && entry.ticket.basis_hash === input.basis_hash);
    if (duplicate) throw new DomainError('QUEUE_ALREADY_ENQUEUED', 'This exact reviewed decision is already queued', 409, {entry_id: duplicate.id});
    const ticket = await record('queue_ticket', {request_id: input.request_id, component_id: component.id, alternative_id: alternative.id,
      basis_hash: input.basis_hash, expected_canonical_head: repo.head, repo: repo.id,
      composition_id: selected.composition.id, composition_tree_hash: selected.composition.resulting_tree, composition_commit: selected.composition.commit,
      selected_revision_ids: selected.selected_revision_ids, evidence_ids: selected.evidence_ids,
      mr_basis_hash: mr.basis_hash, merge_request_ids: mr.merge_request_ids, reviewed_dependencies: mr.dependencies,
      rationale: String(input.rationale ?? '').slice(0, 2000), actor, created_at: now()});
    const entry = {...structuredClone(ticket), ticket, status: blockers.length ? 'blocked' : 'queued', blockers: structuredClone(blockers), attempt: null, outcome: null};
    this.engine.state.mergeQueue.push(entry);
    await this._event('queue.enqueued', actor, {entry_id: entry.id, ticket_id: ticket.id, status: entry.status, blockers});
    return this._complete('enqueue', receipt, actor, entry);
  }
  async cancel(id, input = {}, actor) {
    actorRequired(actor); const receipt = await this._replay('cancel', input, actor, id);
    if (receipt.replayed) return receipt.result;
    const entry = this.get(id);
    if (!CANCELLABLE.has(entry.status)) throw new DomainError('QUEUE_NOT_CANCELLABLE', 'Only queued, blocked, or needs-review tickets can be cancelled', 409);
    entry.status = 'cancelled'; entry.blockers = []; entry.cancelled_by = actor; entry.cancelled_at = now();
    await this._event('queue.cancelled', actor, {entry_id: id, ticket_id: entry.ticket.id});
    return this._complete('cancel', receipt, actor, entry);
  }
  async _transition(entry, status, actor, blockers = []) {
    if (entry.status === status && JSON.stringify(entry.blockers) === JSON.stringify(blockers)) return;
    entry.status = status; entry.blockers = structuredClone(blockers);
    await this._event(`queue.${status}`, actor, {entry_id: entry.id, ticket_id: entry.ticket.id, blockers});
  }
  async _eligible(entry) {
    const pin = entry.ticket;
    const component = this.engine.component(pin.component_id), alternative = component.alternatives.find(item => item.id === pin.alternative_id);
    if (!alternative || ['resolved', 'deferred'].includes(component.status) || pin.expected_canonical_head !== this.engine.repo(pin.repo).head
      || pin.basis_hash !== component.basis_hash || pin.basis_hash !== await this.engine.basis(component)) throw new DomainError('DECISION_STALE', 'The pinned decision or canonical head changed; explicitly re-review and enqueue a new ticket', 409);
    const current = await this._trustedSelection(component, alternative);
    if (current.composition.id !== pin.composition_id || current.composition.commit !== pin.composition_commit
      || !equalIds(current.selected_revision_ids, pin.selected_revision_ids) || !equalIds(current.evidence_ids, pin.evidence_ids)) {
      throw new DomainError('DECISION_STALE', 'The reviewed implementation or evidence changed; the queue will not adopt a new composition', 409);
    }
    const mr = await this._mrSnapshot(pin.selected_revision_ids);
    if (mr.basis_hash !== pin.mr_basis_hash) throw new DomainError('MR_STALE', 'The reviewed merge-request or dependency basis changed; explicitly re-review and requeue', 409);
    return this._guard(pin.selected_revision_ids, pin.actor, pin.composition_id);
  }
  _operationFor(entry) {
    const before = new Set(entry.attempt?.before_operation_ids ?? []), pin = entry.ticket;
    return this.engine.state.operations.find(operation => !before.has(operation.id) && operation.repo === pin.repo
      && operation.queue_ticket_id === pin.id && operation.queue_attempt_id === entry.attempt?.id
      && operation.target_commit === pin.composition_commit && operation.expected_head === pin.expected_canonical_head
      && this.engine.state.decisions.some(decision => decision.id === operation.decision_id && decision.component_id === pin.component_id
        && decision.resolution === pin.alternative_id && decision.decision_basis_hash === pin.basis_hash && decision.actor === pin.actor
        && decision.queue_ticket_id === pin.id && decision.queue_attempt_id === entry.attempt?.id
        && equalIds(decision.proposal_revision_ids ?? [], pin.selected_revision_ids)));
  }
  async process(input = {}, actor) {
    actorRequired(actor); requestId(input, true);
    if (this._processing) return {processed: false, entry: null, reason: 'queue_busy'};
    this._processing = true;
    try {
      const receipt = await this._replay('process', input, actor);
      if (receipt.replayed) return receipt.result;
      if (receipt.pending) {
        const prior = this.get(receipt.pending.data.entry_id);
        return this._complete('process', receipt, actor, {processed: prior.status === 'merged', entry: structuredClone(prior),
          reason: prior.status === 'merged' ? 'reconciled' : prior.status === 'needs_review' ? 'needs_review' : 'recovery_required'});
      }
      const uncertainty = this.engine.state.mergeQueue.find(entry => ['processing', 'recovery_required'].includes(entry.status));
      if (uncertainty || this.engine.state.operations.some(operation => UNCERTAIN.has(operation.status))) {
        return this._complete('process', receipt, actor, {processed: false, entry: uncertainty ? structuredClone(uncertainty) : null, reason: 'recovery_required'});
      }
      await this.engine.syncHeads(); const blocked = [];
      // Stable FIFO among eligible entries is a topological order: the MR guard
      // blocks unmerged dependencies unless selected in this same composition.
      for (const entry of this.engine.state.mergeQueue.filter(item => WAITING.has(item.status))) {
        try {await this._eligible(entry);} catch (error) {
          if (error.code === 'MR_BLOCKED') {
            const reasons = error.details?.reasons ?? [{code: 'MR_BLOCKED', message: error.message}];
            await this._transition(entry, 'blocked', actor, reasons); blocked.push(entry.id); continue;
          }
          if (['DECISION_STALE', 'MR_STALE', 'VALIDATION_REQUIRED', 'DECISION_NOT_FOUND', 'MR_NOT_FOUND', 'REVISION_NOT_FOUND', 'REPO_NOT_FOUND'].includes(error.code)) {
            await this._transition(entry, 'needs_review', actor, [{code: error.code, message: error.message}]); blocked.push(entry.id); continue;
          }
          throw error;
        }
        entry.attempt = await record('queue_attempt', {entry_id: entry.id, actor, request_id: receipt.request_id,
          before_operation_ids: this.engine.state.operations.map(operation => operation.id).sort(), created_at: now()});
        entry.status = 'processing'; entry.blockers = [];
        await this._event('queue.processing', actor, {action: 'process', request_id: receipt.request_id, input_hash: receipt.input_hash, entry_id: entry.id, attempt_id: entry.attempt.id});
        await this._save();
        try {
          const outcome = await this.engine.resolve(entry.ticket.component_id, {alternative_id: entry.ticket.alternative_id,
            basis_hash: entry.ticket.basis_hash, expected_canonical_head: entry.ticket.expected_canonical_head, rationale: entry.ticket.rationale}, entry.ticket.actor,
          {queue_ticket_id: entry.ticket.id, queue_attempt_id: entry.attempt.id});
          entry.outcome = structuredClone(outcome);
          await this._transition(entry, 'merged', actor);
          await this._event('queue.merge-result', actor, {entry_id: entry.id, ticket_id: entry.ticket.id, approved_by: entry.ticket.actor, outcome});
          return this._complete('process', receipt, actor, {processed: true, entry, blocked_entries: blocked});
        } catch (error) {
          if (['DECISION_STALE', 'MR_STALE', 'MR_BLOCKED', 'VALIDATION_REQUIRED', 'DECISION_RESOLVED'].includes(error.code)) {
            await this._transition(entry, error.code === 'MR_BLOCKED' ? 'blocked' : 'needs_review', actor, error.details?.reasons ?? [{code: error.code, message: error.message}]);
            return this._complete('process', receipt, actor, {processed: false, entry, reason: error.code, blocked_entries: blocked});
          }
          await this._transition(entry, 'recovery_required', actor, [{code: error.code ?? 'OUTCOME_UNCERTAIN', message: 'Reconcile the prepared Git operation before processing another queue entry.'}]);
          return this._complete('process', receipt, actor, {processed: false, entry, reason: 'recovery_required', blocked_entries: blocked});
        }
      }
      const reason = blocked.some(id => this.get(id).status === 'needs_review') ? 'needs_review' : blocked.length ? 'blocked' : 'empty';
      return this._complete('process', receipt, actor, {processed: false, entry: null, reason, blocked_entries: blocked});
    } finally {this._processing = false;}
  }
  async reconcile(actor = 'coordinator') {
    actorRequired(actor); const reconciled = [];
    for (const entry of this.engine.state.mergeQueue.filter(item => ['processing', 'recovery_required'].includes(item.status))) {
      const operation = this._operationFor(entry);
      if (operation?.status === 'applied') {
        entry.outcome = {decision_id: operation.decision_id, canonical_head: operation.target_commit, resolution: entry.ticket.alternative_id};
        await this._transition(entry, 'merged', actor);
        await this._event('queue.merge-reconciled', actor, {entry_id: entry.id, ticket_id: entry.ticket.id, approved_by: entry.ticket.actor, outcome: entry.outcome});
        reconciled.push(entry.id);
      } else if (!operation || operation.status === 'cas-failed') {
        await this._transition(entry, 'needs_review', actor, [{code: operation ? 'DECISION_STALE' : 'NO_PREPARED_OPERATION', message: 'No applied operation establishes this ticket outcome; review before creating a new ticket.'}]);
        reconciled.push(entry.id);
      }
      // Prepared/uncertain operations remain blocked until engine.recover proves
      // an exact outcome. Reconciliation never repeats engine.resolve or CAS.
    }
    await this._save(); return {reconciled_entry_ids: reconciled, entries: this.list()};
  }
}
