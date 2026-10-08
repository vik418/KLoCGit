import { DomainError, hash, record } from './hash.mjs';
import { validationPassed } from './evidence.mjs';

const oid = /^(?!0{40}$)[a-f0-9]{40}$/;
const now = () => new Date().toISOString();

function list(value, label, limit = 100) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > limit ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 200) ||
    new Set(value).size !== value.length
  )
    throw new DomainError('INVALID_SELECTION', label + ' must be a bounded, unique list');
  return [...value];
}

function actorIdentity(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 200)
    throw new DomainError('UNAUTHENTICATED', 'An authenticated actor is required', 401);
}

/**
 * Native selections and candidates remain independent of PR/MR history.
 * Candidate construction only retains Git objects. Promotion shares the existing
 * write-ahead journal so native and compatibility writes cannot race each other.
 */
export class NativePipeline {
  constructor(engine) {
    this.engine = engine;
  }

  get state() {
    for (const key of [
      'selections',
      'candidateStates',
      'nativeDecisions',
      'nativeSettlements',
      'nativeDispositions',
    ])
      this.engine.state[key] ??= [];
    return this.engine.state;
  }

  object(collection, id) {
    const value = this.state[collection].find((item) => item.id === id);
    if (!value) throw new DomainError('NOT_FOUND', 'Native pipeline object not found', 404);
    return value;
  }

  async createSelection(input, actor) {
    const revision = this.engine.native.revision(input.future_revision_id);
    const kind = input.kind ?? 'future';
    if (!['future', 'commits'].includes(kind))
      throw new DomainError('INVALID_SELECTION', 'Select a whole Future or explicit commits');
    const commits = kind === 'commits' ? list(input.commits, 'Commits', 50) : [];
    if (commits.some((commit) => !oid.test(commit)))
      throw new DomainError('INVALID_COMMIT', 'Full immutable commit hashes are required');
    if (kind === 'future' && (input.commits !== undefined || input.repo_id !== undefined))
      throw new DomainError(
        'INVALID_SELECTION',
        'Whole-Future selections include all repositories',
      );
    const heads = revision.repository_heads.filter(
      (head) => kind === 'future' || head.repo_id === input.repo_id,
    );
    if (!heads.length)
      throw new DomainError('INVALID_SELECTION', 'The repository is not part of this revision');
    const value = {
      future_revision_id: revision.id,
      kind,
      ...(kind === 'commits' ? { repo_id: input.repo_id, commits } : {}),
      request_id: input.request_id,
    };
    return this.engine.native.request('selection.create', value, actor, async () => {
      const entries = [];
      for (const head of heads) {
        const baseline = revision.baseline_refs.find((entry) => entry.repo_id === head.repo_id);
        const tree = revision.tree_hashes.find((entry) => entry.repo_id === head.repo_id)?.tree;
        if (!baseline || !oid.test(tree))
          throw new DomainError('INVALID_REVISION', 'An immutable baseline and tree are required');
        const source = { id: head.source_repo_id, canonical_repo: head.repo_id };
        for (const commit of commits) {
          if (
            commit === baseline.commit ||
            !(await this.engine.git.isAncestor(source, baseline.commit, commit)) ||
            !(await this.engine.git.isAncestor(source, commit, head.commit))
          )
            throw new DomainError(
              'COMMIT_OUTSIDE_REVISION',
              'Selected commits must be descendants of the baseline within the pinned revision',
              422,
            );
        }
        entries.push({
          repo_id: head.repo_id,
          source_repo: head.source_repo_id,
          ref: head.ref,
          base_commit: baseline.commit,
          head_commit: head.commit,
          tree_hash: tree,
          ...(head.object_id ? { object_id: head.object_id, object_type: head.object_type } : {}),
          commits,
        });
      }
      const selection = await record('selection', {
        future_revision_id: revision.id,
        kind,
        entries,
      });
      if (!this.state.selections.some((entry) => entry.id === selection.id))
        this.state.selections.push(selection);
      await this.engine.native.event('selection.created', actor, { selection_id: selection.id });
      return { selection };
    });
  }

  async sourceValidity(selectionIds) {
    for (const id of selectionIds) {
      const selection = this.object('selections', id);
      const revision = this.engine.native.revision(selection.future_revision_id);
      const future = this.engine.native.future(revision.future_id);
      if (future.status !== 'active' || future.current_revision_id !== revision.id) return false;
      // An unprocessed push still invalidates review; metadata freshness is insufficient.
      for (const entry of selection.entries) {
        try {
          if (typeof this.engine.git.readRef === 'function') {
            const observed = await this.engine.git.readRef(
              { id: entry.source_repo, canonical_repo: entry.repo_id },
              entry.ref,
            );
            if (
              observed.commit !== entry.head_commit ||
              observed.object_id !== (entry.object_id ?? entry.head_commit)
            )
              return false;
          } else if (
            (entry.object_id && entry.object_id !== entry.head_commit) ||
            (await this.engine.git.ref(
              { id: entry.source_repo, canonical_repo: entry.repo_id },
              entry.ref,
            )) !== entry.head_commit
          )
            return false;
        } catch (error) {
          if (error.code === 'REF_NOT_FOUND') return false;
          throw error;
        }
      }
    }
    if (this.engine.objectiveContext) {
      const revisionIds = selectionIds.map(
        (id) => this.object('selections', id).future_revision_id,
      );
      if ((await this.engine.objectiveContext.revisionsValidity(revisionIds)).status !== 'current')
        return false;
    }
    return true;
  }

  async createCandidate(input, actor) {
    const ids = list(input.selection_ids, 'Selections');
    const expectedHeads =
      input.expected_heads === undefined ? undefined : structuredClone(input.expected_heads);
    if (
      expectedHeads !== undefined &&
      (!expectedHeads ||
        typeof expectedHeads !== 'object' ||
        Array.isArray(expectedHeads) ||
        Object.keys(expectedHeads).length > 1000 ||
        Object.values(expectedHeads).some((head) => !oid.test(head)))
    )
      throw new DomainError('INVALID_REQUEST', 'Expected heads must be immutable commit hashes');
    ids.forEach((id) => this.object('selections', id));
    return this.engine.native.request(
      'candidate.create',
      {
        selection_ids: ids,
        ...(expectedHeads === undefined ? {} : { expected_heads: expectedHeads }),
        request_id: input.request_id,
      },
      actor,
      async () => {
        await this.engine.syncHeads();
        if (!(await this.sourceValidity(ids)))
          throw new DomainError(
            'SELECTION_STALE',
            'Observe the updated Future before composing',
            409,
          );
        const selections = ids.map((id) => this.object('selections', id));
        const repoIds = [
          ...new Set(
            selections.flatMap((selection) => selection.entries.map((entry) => entry.repo_id)),
          ),
        ].sort();
        const baseHeads = Object.fromEntries(
          this.state.repositories.map((repo) => [repo.id, repo.head]),
        );
        if (expectedHeads !== undefined && (await hash(expectedHeads)) !== (await hash(baseHeads)))
          throw new DomainError('CANONICAL_CHANGED', 'The composition baseline changed', 409);
        const repositories = [];
        for (const repoId of repoIds) {
          const repo = this.engine.repo(repoId);
          this.engine.requireCanonical(repo);
          const pieces = selections.flatMap((selection) =>
            selection.entries
              .filter((entry) => entry.repo_id === repoId)
              .map((entry) => ({
                ...entry,
                id: selection.id,
                future_revision_id: selection.future_revision_id,
                kind: selection.kind,
              })),
          );
          const result = await this.engine.git.composeSelections(repo, baseHeads[repoId], pieces);
          if (
            !oid.test(result.commit) ||
            !oid.test(result.tree) ||
            !oid.test(result.baseTree) ||
            result.canonical_parent !== baseHeads[repoId]
          )
            throw new DomainError(
              'INVALID_GIT_FACTS',
              'The executor returned an invalid candidate',
              503,
            );
          repositories.push({
            repo_id: repoId,
            base_commit: baseHeads[repoId],
            base_tree: result.baseTree,
            commit: result.commit,
            tree: result.tree,
          });
        }
        const candidate = await record('candidate', {
          selection_ids: ids,
          base_heads: baseHeads,
          repositories,
          limitations: [
            'Commit selection applies patches; it does not prove semantic dependency closure.',
            'Passing checks establish only their stated scope.',
          ],
        });
        if (!this.state.candidateStates.some((entry) => entry.id === candidate.id))
          this.state.candidateStates.push(candidate);
        await this.engine.native.event('candidate.created', actor, { candidate_id: candidate.id });
        return { candidate };
      },
    );
  }

  subject(candidate, repository) {
    return candidate.id + ':' + repository.repo_id;
  }

  latestEvidence(candidate, repository) {
    return this.state.evidence
      .filter(
        (entry) =>
          entry.subject_ref === this.subject(candidate, repository) &&
          entry.type === 'trusted-validation' &&
          entry.source === 'platform-owned checks',
      )
      .at(-1);
  }

  async validateCandidate(id, input, actor) {
    const candidate = this.object('candidateStates', id);
    return this.engine.native.request(
      'candidate.validate',
      { candidate_id: id, request_id: input.request_id },
      actor,
      async () => {
        await this.engine.syncHeads();
        // Runtime dependencies use composed commits. Their evidence still becomes
        // stale when the reviewed canonical base vector changes.
        const evaluationHeads = {
          ...candidate.base_heads,
          ...Object.fromEntries(candidate.repositories.map((repo) => [repo.repo_id, repo.commit])),
        };
        const evidence = [];
        for (const repository of candidate.repositories)
          evidence.push(
            await this.engine.validate(
              this.subject(candidate, repository),
              this.engine.repo(repository.repo_id),
              repository.tree,
              repository.commit,
              candidate.base_heads,
              evaluationHeads,
            ),
          );
        await this.engine.native.event('candidate.validated', actor, {
          candidate_id: id,
          evidence_ids: evidence.map((entry) => entry.id),
        });
        return { candidate, evidence };
      },
    );
  }

  async reviewInputs(candidate, options = {}) {
    const context = this.engine.objectiveContext
      ? await this.engine.objectiveContext.revisionsValidity(
          candidate.selection_ids.map((id) => this.object('selections', id).future_revision_id),
        )
      : null;
    const evaluations = this.engine.evaluators
      ? await this.engine.evaluators.eligibility(candidate.id, options)
      : null;
    return {
      context,
      access_version: this.state.access?.version ?? null,
      evaluations: evaluations
        ? {
            configured: evaluations.configured,
            passing: evaluations.passing,
            basis: evaluations.basis,
          }
        : null,
      candidate,
      selections: candidate.selection_ids.map((id) => this.object('selections', id)),
      evidence: candidate.repositories.map((repo) => this.latestEvidence(candidate, repo) ?? null),
      constraints: this.state.constraints.filter((constraint) => constraint.active),
      config_hash: this.engine.git.configHash,
      futures: candidate.selection_ids.map((id) => {
        const revision = this.engine.native.revision(
          this.object('selections', id).future_revision_id,
        );
        const future = this.engine.native.future(revision.future_id);
        return { id: future.id, revision_id: future.current_revision_id, status: future.status };
      }),
    };
  }

  async basis(candidate) {
    return hash({
      ...(await this.reviewInputs(candidate)),
      canonical_heads: this.state.repositories
        .map((repo) => ({ repo_id: repo.id, head: repo.head, unavailable: !!repo.unavailable }))
        .sort((a, b) => a.repo_id.localeCompare(b.repo_id)),
    });
  }

  async review(id) {
    const candidate = this.object('candidateStates', id);
    await this.engine.syncHeads();
    const sourcesCurrent = await this.sourceValidity(candidate.selection_ids);
    const headsCurrent = Object.entries(candidate.base_heads).every(([repoId, head]) => {
      const repo = this.engine.repo(repoId);
      return repo.head === head && !repo.unavailable;
    });
    const evidence = candidate.repositories.map((repo) => {
      const entry = this.latestEvidence(candidate, repo);
      return entry ? { ...entry, validity: this.engine.evidenceValidity(entry) } : null;
    });
    const context = this.engine.objectiveContext
      ? await this.engine.objectiveContext.revisionsValidity(
          candidate.selection_ids.map((id) => this.object('selections', id).future_revision_id),
        )
      : null;
    const externalEvaluations = this.engine.evaluators
      ? await this.engine.evaluators.eligibility(candidate.id)
      : null;
    return {
      candidate,
      context,
      access_version: this.state.access?.version ?? null,
      external_evaluations: externalEvaluations,
      decision_basis_hash: await this.basis(candidate),
      expected_heads: candidate.base_heads,
      sources_current: sourcesCurrent,
      heads_current: headsCurrent,
      evidence,
      validation_passing: externalEvaluations?.configured
        ? externalEvaluations.passing
        : evidence.every(
            (entry) =>
              entry &&
              entry.validity.status === 'current' &&
              validationPassed(entry) &&
              entry.tree_hash ===
                candidate.repositories.find(
                  (repo) => this.subject(candidate, repo) === entry.subject_ref,
                )?.tree,
          ),
      promotion_supported: candidate.repositories.some((repo) => repo.tree !== repo.base_tree),
    };
  }

  async promote(id, input, actor, execution = {}) {
    actorIdentity(actor);
    if (typeof input.request_id !== 'string' || !input.request_id || input.request_id.length > 128)
      throw new DomainError('INVALID_REQUEST', 'A bounded request identity is required');
    if (
      typeof input.rationale !== 'string' ||
      !input.rationale.trim() ||
      input.rationale.length > 4000
    )
      throw new DomainError('INVALID_RESOLUTION', 'Record a brief rationale');
    const correlation =
      execution.group_decision_id || execution.group_request_id
        ? {
            group_decision_id: execution.group_decision_id,
            group_request_id: execution.group_request_id,
          }
        : {};
    if (
      Object.keys(correlation).length &&
      Object.values(correlation).some(
        (value) => typeof value !== 'string' || !value || value.length > 200,
      )
    )
      throw new DomainError(
        'INVALID_REQUEST',
        'Internal group correlation requires both immutable IDs',
      );
    const operationId = 'promotion_' + (await hash({ actor, request_id: input.request_id }));
    const inputHash = await hash({
      candidate_id: id,
      input,
      ...correlation,
      ...(execution.continuation_of ? { continuation_of: execution.continuation_of } : {}),
    });
    const previous = this.state.operations.find((operation) => operation.id === operationId);
    if (previous) {
      if (previous.input_hash !== inputHash)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'The request identity has different inputs',
          409,
        );
      if (previous.status === 'applied')
        return {
          decision: this.object('nativeDecisions', previous.decision_id),
          operation: previous,
        };
      if (previous.status === 'settled')
        throw new DomainError(
          'PROMOTION_SETTLED',
          'The prior attempt was settled; review and submit a new request',
          409,
        );
      if (previous.status === 'not-applied')
        throw new DomainError(
          'PROMOTION_NOT_ISSUED',
          'The prior attempt did not issue a Git write; review and submit a new request',
          409,
        );
      throw new DomainError(
        'RECOVERY_REQUIRED',
        'Reconcile the recorded promotion before retrying',
        409,
      );
    }
    if (
      this.state.operations.some(
        (operation) =>
          ['prepared', 'recovery-required'].includes(operation.status) &&
          operation.id !== execution.continuation_of,
      )
    )
      throw new DomainError(
        'RECOVERY_REQUIRED',
        'A prior canonical write needs reconciliation',
        409,
      );
    const reviewed = execution.continuation_of
      ? await this.reviewContinuation(execution.continuation_of, id)
      : await this.review(id);
    if (
      input.decision_basis_hash !== reviewed.decision_basis_hash ||
      (await hash(input.expected_heads)) !== (await hash(reviewed.expected_heads)) ||
      !reviewed.sources_current ||
      !reviewed.heads_current
    )
      throw new DomainError('DECISION_STALE', 'Review the changed candidate basis', 409);
    if (!reviewed.validation_passing)
      throw new DomainError(
        'VALIDATION_REQUIRED',
        'Fresh trusted composed-tree validation is required',
        409,
      );
    if (!reviewed.promotion_supported)
      throw new DomainError(
        'NO_CANONICAL_CHANGE',
        'This candidate does not change canonical code',
        422,
      );
    const changed = reviewed.candidate.repositories.filter((repo) => repo.tree !== repo.base_tree);
    const repository = changed[0];
    const prior =
      execution.continuation_of &&
      this.state.operations.find((entry) => entry.id === execution.continuation_of);
    if (execution.continuation_of) await this.guardContinuation(prior, reviewed.candidate);
    const decision = await record('native-decision', {
      candidate_id: id,
      ...correlation,
      selection_ids: reviewed.candidate.selection_ids,
      decision_basis_hash: reviewed.decision_basis_hash,
      canonical_heads_seen: reviewed.expected_heads,
      evidence_ids: reviewed.evidence.filter(Boolean).map((entry) => entry.id),
      evaluator_run_ids: (reviewed.external_evaluations?.runs ?? [])
        .map((entry) => entry.run?.id ?? entry.id)
        .filter(Boolean),
      context_snapshot_refs: (reviewed.context?.snapshots ?? []).map((entry) => entry.id),
      ...(prior ? { continues_operation_id: prior.id } : {}),
      resolution: 'accept',
      rationale: input.rationale.trim(),
      actor,
      created_at: now(),
    });
    this.state.nativeDecisions.push(decision);
    const operation = {
      id: operationId,
      kind: 'native',
      input_hash: inputHash,
      ...correlation,
      decision_id: decision.id,
      candidate_id: id,
      repo: repository.repo_id,
      expected_head: repository.base_commit,
      target_commit: repository.commit,
      target_tree: repository.tree,
      status: 'prepared',
      dispatch_state: 'not_started',
      review_guard_hash: await hash(await this.reviewInputs(reviewed.candidate)),
      ...(prior ? { continuation_of: prior.id } : {}),
      ...(changed.length > 1 || prior
        ? {
            non_atomic: true,
            reviewed_heads: reviewed.expected_heads,
            stages: changed.map((entry) => ({
              repo: entry.repo_id,
              expected_head: entry.base_commit,
              target_commit: entry.commit,
              target_tree: entry.tree,
              status: 'prepared',
              dispatch_state: 'not_started',
            })),
          }
        : {}),
    };
    this.state.operations.push(operation);
    if (prior) {
      prior.status = 'continued';
      prior.continued_by = operation.id;
    }
    await this.engine.audit('canonical.prepared', actor, {
      operation_id: operation.id,
      decision_id: decision.id,
    });
    // Persist intent before issuing the only canonical mutation. Ambiguous replies
    // are observed through recovery, never converted into a second push.
    await this.engine.save(this.state);
    if (operation.stages) return this.runRollout(operation, decision, actor);
    operation.dispatch_state = 'issued';
    await this.engine.save(this.state);
    try {
      await this.guardSingle(operation);
      const repo = this.engine.repo(operation.repo);
      if (!(await this.engine.git.cas(repo, operation.expected_head, operation.target_commit))) {
        operation.status = 'cas-failed';
        await this.engine.save(this.state);
        throw new DomainError('DECISION_STALE', 'Canonical Git changed during promotion', 409);
      }
      await this.complete(operation, actor);
      await this.engine.save(this.state);
      return { decision, operation };
    } catch (error) {
      if (operation.status !== 'cas-failed') {
        operation.status = 'recovery-required';
        await this.engine.save(this.state);
      }
      throw error;
    }
  }

  async complete(operation, actor) {
    await this.engine.observeCanonical(
      this.engine.repo(operation.repo),
      operation.target_commit,
      operation.target_tree,
    );
    const alreadyRecorded = this.state.nativeEvents.some(
      (event) =>
        event.type === 'io.klocgit.canonical.updated' && event.data.operation_id === operation.id,
    );
    if (!alreadyRecorded)
      await this.engine.native.event('canonical.updated', actor, {
        operation_id: operation.id,
        repo: operation.repo,
        decision_id: operation.decision_id,
        candidate_id: operation.candidate_id,
        head: operation.target_commit,
      });
    operation.status = 'applied';
    await this.recordDispositions(operation);
  }

  /**
   * Settle an issued write from an explicit operator attestation. A current ref
   * cannot prove historical non-application; retain the claim as declared data.
   * This releases the journal block without issuing, undoing or repeating Git.
   */
  async settleOperation(id, input, actor) {
    actorIdentity(actor);
    const rollout = this.state.operations.find(
      (entry) => entry.id === id && entry.kind === 'native' && entry.stages,
    );
    if (rollout) return this.settleRollout(rollout, input, actor);
    if (
      input.confirmed !== true ||
      !['not_applied', 'applied_then_moved'].includes(input.outcome) ||
      !oid.test(input.expected_head ?? '') ||
      typeof input.rationale !== 'string' ||
      !input.rationale.trim() ||
      input.rationale.length > 4000
    )
      throw new DomainError('INVALID_SETTLEMENT', 'Confirm the inspected outcome and rationale');
    const operation = this.state.operations.find(
      (entry) => entry.id === id && entry.kind === 'native',
    );
    if (!operation) throw new DomainError('NOT_FOUND', 'Native promotion not found', 404);
    const value = {
      expected_head: input.expected_head,
      outcome: input.outcome,
      confirmed: input.confirmed,
      rationale: input.rationale,
      request_id: input.request_id,
    };
    return this.engine.native.request(
      'promotion.settle',
      {
        operation_id: id,
        expected_head: value.expected_head,
        outcome: value.outcome,
        confirmed: value.confirmed,
        rationale: value.rationale,
        request_id: value.request_id,
      },
      actor,
      async () => {
        if (operation.status !== 'recovery-required' || operation.dispatch_state !== 'issued')
          throw new DomainError(
            'OPERATION_NOT_UNCERTAIN',
            'Reconcile the operation before settlement',
            409,
          );
        const repo = this.engine.repo(operation.repo);
        const observed = await this.engine.git.ref(repo, repo.canonical_ref);
        if (observed !== value.expected_head)
          throw new DomainError(
            'SETTLEMENT_STALE',
            'Git changed; reopen and review the settlement',
            409,
          );
        if (observed === operation.target_commit)
          throw new DomainError(
            'RECOVERY_TARGET_PRESENT',
            'The exact target is present; run reconciliation',
            409,
          );
        const settlement = await record('settlement', {
          operation_id: id,
          decision_id: operation.decision_id,
          outcome: value.outcome,
          basis: 'declared',
          observed_ref: {
            repo_id: repo.id,
            ref: repo.canonical_ref,
            commit: observed,
            basis: 'observed',
          },
          rationale: value.rationale.trim(),
          actor,
          created_at: now(),
        });
        this.state.nativeSettlements.push(settlement);
        operation.status = 'settled';
        operation.settlement_id = settlement.id;
        await this.engine.native.event('promotion.settled', actor, {
          operation_id: id,
          settlement_id: settlement.id,
          repo: repo.id,
        });
        return { settlement, operation };
      },
    );
  }

  async recoverOperation(operation) {
    if (operation.stages) return this.recoverRollout(operation);
    const decision = this.object('nativeDecisions', operation.decision_id);
    const candidate = this.object('candidateStates', decision.candidate_id);
    const target = candidate.repositories.find((repo) => repo.repo_id === operation.repo);
    if (
      target?.commit !== operation.target_commit ||
      target.tree !== operation.target_tree ||
      target.base_commit !== operation.expected_head
    )
      throw new DomainError(
        'RECOVERY_REQUIRED',
        'The journal differs from its immutable candidate',
        503,
      );
    if (operation.dispatch_state === 'not_started') {
      operation.status = 'not-applied';
      await this.engine.audit('canonical.not-issued', 'coordinator', {
        operation_id: operation.id,
      });
      return;
    }
    const repo = this.engine.repo(operation.repo);
    if ((await this.engine.git.ref(repo, repo.canonical_ref)) === operation.target_commit)
      await this.complete(operation, 'coordinator');
    else operation.status = 'recovery-required';
  }

  /**
   * A rollout validates one immutable future state but advances refs separately.
   * Each dispatch is persisted before Git; uncertainty never authorizes replay.
   */
  async runRollout(operation, decision, actor) {
    let active;
    try {
      for (const stage of operation.stages) {
        active = stage;
        await this.guardRollout(operation);
        stage.dispatch_state = 'issued';
        operation.dispatch_state = 'issued';
        await this.engine.save(this.state);
        try {
          await this.guardRollout(operation);
        } catch (error) {
          // This process has not called Git. Unlike recovery of a persisted issued
          // stage, this control-flow observation establishes a non-dispatch.
          stage.status = 'not-issued';
          stage.dispatch_state = 'not_started';
          throw error;
        }
        const updated = await this.engine.git.cas(
          this.engine.repo(stage.repo),
          stage.expected_head,
          stage.target_commit,
        );
        if (!updated) {
          stage.status = 'rejected';
          throw new DomainError('DECISION_STALE', 'A canonical ref changed during rollout', 409);
        }
        stage.status = 'applied';
        await this.completeStage(operation, stage, actor);
        await this.engine.save(this.state);
      }
      // Another producer may have moved an earlier ref while a later CAS ran.
      // The rollout can only claim completion while its exact vector is observed.
      active = undefined;
      await this.guardRollout(operation);
      operation.status = 'applied';
      await this.recordDispositions(operation);
      await this.engine.save(this.state);
      return { decision, operation };
    } catch (error) {
      if (active?.dispatch_state === 'issued' && active.status === 'prepared')
        active.status = 'uncertain';
      for (const stage of operation.stages)
        if (stage.status === 'prepared' && stage.dispatch_state === 'not_started')
          stage.status = 'not-issued';
      const hasEffect =
        !!operation.continuation_of ||
        operation.stages.some((stage) => ['applied', 'uncertain'].includes(stage.status));
      operation.status = hasEffect ? 'recovery-required' : 'cas-failed';
      operation.stop_reason = error.code ?? 'ROLLOUT_INTERRUPTED';
      await this.recordDispositions(operation);
      await this.engine.save(this.state);
      throw error;
    }
  }

  async guardSingle(operation) {
    const candidate = this.object('candidateStates', operation.candidate_id);
    await this.engine.syncHeads();
    if (
      operation.review_guard_hash !== (await hash(await this.reviewInputs(candidate))) ||
      !(await this.sourceValidity(candidate.selection_ids)) ||
      Object.entries(candidate.base_heads).some(([repoId, head]) => {
        const repo = this.engine.repo(repoId);
        return repo.head !== head || repo.unavailable;
      })
    )
      throw new DomainError('DECISION_STALE', 'The reviewed promotion basis changed', 409);
  }

  async guardRollout(operation) {
    const candidate = this.object('candidateStates', operation.candidate_id);
    await this.engine.syncHeads();
    const expected = {
      ...operation.reviewed_heads,
      ...Object.fromEntries(
        operation.stages
          .filter((stage) => stage.status === 'applied')
          .map((stage) => [stage.repo, stage.target_commit]),
      ),
    };
    for (const stage of operation.stages.filter((entry) => entry.status === 'applied')) {
      const repo = this.engine.repo(stage.repo);
      stage.observed_head = repo.head;
      stage.current = repo.head === stage.target_commit && !repo.unavailable;
    }
    if (
      operation.review_guard_hash !==
        (await hash(await this.reviewInputs(candidate, { canonical_heads: expected }))) ||
      !(await this.sourceValidity(candidate.selection_ids))
    )
      throw new DomainError('DECISION_STALE', 'Rollout evidence or source basis changed', 409);
    for (const [repoId, head] of Object.entries(expected)) {
      const repo = this.engine.repo(repoId);
      if (repo.head !== head || repo.unavailable)
        throw new DomainError('DECISION_STALE', 'The reviewed rollout vector changed', 409);
    }
  }

  async completeStage(operation, stage, actor) {
    await this.engine.observeCanonical(
      this.engine.repo(stage.repo),
      stage.target_commit,
      stage.target_tree,
    );
    const recorded = this.state.nativeEvents.some(
      (event) =>
        event.type === 'io.klocgit.canonical.updated' &&
        event.data.operation_id === operation.id &&
        event.data.repo === stage.repo,
    );
    if (!recorded)
      await this.engine.native.event('canonical.updated', actor, {
        operation_id: operation.id,
        repo: stage.repo,
        decision_id: operation.decision_id,
        candidate_id: operation.candidate_id,
        head: stage.target_commit,
        non_atomic: true,
      });
  }

  async recordDispositions(operation) {
    const candidate = this.object('candidateStates', operation.candidate_id);
    const byRevision = new Map();
    for (const id of candidate.selection_ids) {
      const selection = this.object('selections', id);
      const ids = byRevision.get(selection.future_revision_id) ?? [];
      ids.push(id);
      byRevision.set(selection.future_revision_id, ids);
    }
    for (const [revisionId, selectionIds] of byRevision) {
      const revision = this.engine.native.revision(revisionId);
      const entries = selectionIds.flatMap((id) => this.object('selections', id).entries);
      const outcomes = [...new Set(entries.map((entry) => entry.repo_id))].map((repoId) => {
        const stage = operation.stages?.find((entry) => entry.repo === repoId);
        const target = candidate.repositories.find((entry) => entry.repo_id === repoId);
        return {
          repo_id: repoId,
          status: stage?.status ?? (operation.repo === repoId ? operation.status : 'unchanged'),
          commit: target.commit,
          ...(stage ? { current: stage.current !== false } : {}),
        };
      });
      const applied = outcomes.some((entry) => entry.status === 'applied');
      const uncertain = outcomes.some((entry) => entry.status === 'uncertain');
      const status =
        operation.status === 'applied'
          ? 'applied'
          : uncertain
            ? 'uncertain'
            : applied
              ? 'partially_applied'
              : 'not_applied';
      const content = {
        operation_id: operation.id,
        decision_id: operation.decision_id,
        future_id: revision.future_id,
        future_revision_id: revisionId,
        selection_ids: selectionIds,
        scope: 'selected_material',
        status,
        repository_outcomes: outcomes,
      };
      const disposition = await record('native-disposition', content);
      if (!this.state.nativeDispositions.some((entry) => entry.id === disposition.id))
        this.state.nativeDispositions.push(disposition);
    }
  }

  async recoverRollout(operation) {
    const decision = this.object('nativeDecisions', operation.decision_id);
    const candidate = this.object('candidateStates', decision.candidate_id);
    if ((await hash(operation.reviewed_heads)) !== (await hash(candidate.base_heads)))
      throw new DomainError('RECOVERY_REQUIRED', 'Rollout journal basis is invalid', 503);
    for (const stage of operation.stages) {
      const target = candidate.repositories.find((entry) => entry.repo_id === stage.repo);
      if (
        target?.commit !== stage.target_commit ||
        target.tree !== stage.target_tree ||
        target.base_commit !== stage.expected_head
      )
        throw new DomainError('RECOVERY_REQUIRED', 'Rollout stage differs from its candidate', 503);
      if (stage.dispatch_state === 'not_started') {
        stage.status = 'not-issued';
        continue;
      }
      if (['rejected', 'settled'].includes(stage.status)) continue;
      const repo = this.engine.repo(stage.repo);
      const observed = await this.engine.git.ref(repo, repo.canonical_ref);
      stage.observed_head = observed;
      stage.current = observed === stage.target_commit;
      if (stage.current) {
        stage.status = 'applied';
        await this.completeStage(operation, stage, 'coordinator');
      } else if (stage.status !== 'applied') stage.status = 'uncertain';
    }
    const complete = operation.stages.every((stage) => stage.status === 'applied' && stage.current);
    const hasEffect =
      !!operation.continuation_of ||
      operation.stages.some((stage) => ['applied', 'uncertain', 'settled'].includes(stage.status));
    operation.status = complete ? 'applied' : hasEffect ? 'recovery-required' : 'not-applied';
    await this.recordDispositions(operation);
    // Recovery records observations only. It never dispatches an unfinished stage.
    await this.engine.save(this.state);
  }

  async guardContinuation(operation, candidate) {
    if (!operation?.stages || operation.status !== 'recovery-required')
      throw new DomainError(
        'CONTINUATION_UNAVAILABLE',
        'A reconciled partial rollout is required',
        409,
      );
    if (
      operation.stages.some(
        (stage) =>
          stage.status === 'uncertain' ||
          (stage.dispatch_state === 'issued' && stage.status === 'prepared'),
      )
    )
      throw new DomainError('RECOVERY_REQUIRED', 'Settle uncertain stages before continuing', 409);
    const remaining = new Set(
      operation.stages.filter((stage) => stage.status !== 'applied').map((stage) => stage.repo),
    );
    const changed = candidate.repositories.filter((repo) => repo.tree !== repo.base_tree);
    if (!changed.length || changed.some((repo) => !remaining.has(repo.repo_id)))
      throw new DomainError(
        'INVALID_CONTINUATION',
        'Continue only the remaining repository stages',
        422,
      );
    for (const stage of operation.stages.filter((entry) => entry.status === 'applied'))
      if (
        this.engine.repo(stage.repo).head !== stage.target_commit ||
        candidate.base_heads[stage.repo] !== stage.target_commit
      )
        throw new DomainError(
          'DECISION_STALE',
          'An applied rollout ref moved; review recovery first',
          409,
        );
  }

  async reviewContinuation(id, candidateId) {
    const operation = this.state.operations.find(
      (entry) => entry.id === id && entry.kind === 'native',
    );
    if (!operation?.stages)
      throw new DomainError('NOT_FOUND', 'Multi-repository rollout not found', 404);
    const review = await this.review(candidateId);
    await this.guardContinuation(operation, review.candidate);
    return {
      ...review,
      continuation_of: operation.id,
      decision_basis_hash: await hash({
        candidate_basis: review.decision_basis_hash,
        partial_operation: operation,
      }),
    };
  }

  /** Continue with a newly composed, validated and reviewed candidate; never reuse approval. */
  async continuePromotion(id, input, actor) {
    actorIdentity(actor);
    const previous = this.state.operations.find(
      (entry) => entry.id === id && entry.kind === 'native',
    );
    if (!previous?.stages)
      throw new DomainError('NOT_FOUND', 'Multi-repository rollout not found', 404);
    const candidate = this.object('candidateStates', input.candidate_id);
    const value = {
      request_id: input.request_id,
      decision_basis_hash: input.decision_basis_hash,
      expected_heads: input.expected_heads,
      rationale: input.rationale,
    };
    return this.promote(candidate.id, value, actor, { continuation_of: previous.id });
  }

  async settleRollout(operation, input, actor) {
    if (
      input.confirmed !== true ||
      typeof input.rationale !== 'string' ||
      !input.rationale.trim() ||
      input.rationale.length > 4000
    )
      throw new DomainError('INVALID_SETTLEMENT', 'Confirm the inspected outcome and rationale');
    const value = {
      operation_id: operation.id,
      request_id: input.request_id,
      confirmed: true,
      rationale: input.rationale,
      ...(input.abandon === true
        ? { abandon: true, expected_heads: input.expected_heads }
        : {
            repo_id: input.repo_id,
            expected_head: input.expected_head,
            outcome: input.outcome,
          }),
    };
    return this.engine.native.request('promotion.settle', value, actor, async () => {
      if (operation.status !== 'recovery-required')
        throw new DomainError(
          'OPERATION_NOT_UNCERTAIN',
          'Reconcile the rollout before settlement',
          409,
        );
      await this.engine.syncHeads();
      let observedRefs, outcome;
      if (value.abandon) {
        if (
          operation.stages.some(
            (stage) =>
              stage.status === 'uncertain' ||
              (stage.dispatch_state === 'issued' && stage.status === 'prepared'),
          )
        )
          throw new DomainError(
            'RECOVERY_REQUIRED',
            'Settle uncertain stages before abandonment',
            409,
          );
        const heads = Object.fromEntries(
          this.state.repositories.map((repo) => [repo.id, repo.head]),
        );
        if (
          (await hash(value.expected_heads)) !== (await hash(heads)) ||
          this.state.repositories.some((repo) => repo.unavailable)
        )
          throw new DomainError('SETTLEMENT_STALE', 'Git changed; review the partial rollout', 409);
        observedRefs = this.state.repositories.map((repo) => ({
          repo_id: repo.id,
          ref: repo.canonical_ref,
          commit: repo.head,
          basis: 'observed',
        }));
        outcome = 'abandon_remaining';
      } else {
        if (
          !['not_applied', 'applied_then_moved'].includes(value.outcome) ||
          !oid.test(value.expected_head ?? '')
        )
          throw new DomainError('INVALID_SETTLEMENT', 'Select a repository outcome and exact head');
        const stage = operation.stages.find((entry) => entry.repo === value.repo_id);
        if (!stage || stage.status !== 'uncertain')
          throw new DomainError(
            'OPERATION_NOT_UNCERTAIN',
            'The selected stage is not uncertain',
            409,
          );
        const repo = this.engine.repo(stage.repo);
        if (repo.head !== value.expected_head || repo.unavailable)
          throw new DomainError('SETTLEMENT_STALE', 'Git changed; reopen the settlement', 409);
        if (repo.head === stage.target_commit)
          throw new DomainError(
            'RECOVERY_TARGET_PRESENT',
            'The exact target is present; reconcile it',
            409,
          );
        observedRefs = [
          { repo_id: repo.id, ref: repo.canonical_ref, commit: repo.head, basis: 'observed' },
        ];
        outcome = value.outcome;
      }
      const settlement = await record('settlement', {
        operation_id: operation.id,
        decision_id: operation.decision_id,
        ...(value.abandon ? {} : { repo_id: value.repo_id }),
        outcome,
        basis: 'declared',
        observed_refs: observedRefs,
        rationale: value.rationale.trim(),
        actor,
        created_at: now(),
      });
      this.state.nativeSettlements.push(settlement);
      if (value.abandon) {
        operation.status = 'settled';
        operation.settlement_id = settlement.id;
      } else {
        const stage = operation.stages.find((entry) => entry.repo === value.repo_id);
        stage.status = 'settled';
        stage.settlement_id = settlement.id;
      }
      await this.recordDispositions(operation);
      await this.engine.native.event('promotion.settled', actor, {
        operation_id: operation.id,
        settlement_id: settlement.id,
        ...(value.abandon ? { abandoned: true } : { repo: value.repo_id }),
      });
      return { settlement, operation };
    });
  }

  view() {
    return structuredClone({
      selections: this.state.selections,
      candidates: this.state.candidateStates,
      decisions: this.state.nativeDecisions,
      settlements: this.state.nativeSettlements,
      promotions: this.state.operations.filter((operation) => operation.kind === 'native'),
      dispositions: this.state.nativeDispositions,
    });
  }
}
