import { DomainError, hash, record } from './hash.mjs';
import { validationPassed } from './evidence.mjs';

const oid = /^[a-f0-9]{40}$/;
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
    for (const key of ['selections', 'candidateStates', 'nativeDecisions'])
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
      throw new DomainError('INVALID_SELECTION', 'Whole-Future selections include all repositories');
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
          if (
            (await this.engine.git.ref({ id: entry.source_repo }, entry.ref)) !== entry.head_commit
          )
            return false;
        } catch (error) {
          if (error.code === 'REF_NOT_FOUND') return false;
          throw error;
        }
      }
    }
    return true;
  }

  async createCandidate(input, actor) {
    const ids = list(input.selection_ids, 'Selections');
    ids.forEach((id) => this.object('selections', id));
    return this.engine.native.request(
      'candidate.create',
      { selection_ids: ids, request_id: input.request_id },
      actor,
      async () => {
        await this.engine.syncHeads();
        if (!(await this.sourceValidity(ids)))
          throw new DomainError('SELECTION_STALE', 'Observe the updated Future before composing', 409);
        const selections = ids.map((id) => this.object('selections', id));
        const repoIds = [...new Set(selections.flatMap((selection) =>
          selection.entries.map((entry) => entry.repo_id),
        ))].sort();
        const baseHeads = Object.fromEntries(
          this.state.repositories.map((repo) => [repo.id, repo.head]),
        );
        const repositories = [];
        for (const repoId of repoIds) {
          const repo = this.engine.repo(repoId);
          this.engine.requireCanonical(repo);
          const pieces = selections.flatMap((selection) =>
            selection.entries.filter((entry) => entry.repo_id === repoId).map((entry) => ({
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
            throw new DomainError('INVALID_GIT_FACTS', 'The executor returned an invalid candidate', 503);
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
    return this.state.evidence.filter((entry) =>
      entry.subject_ref === this.subject(candidate, repository) &&
      entry.type === 'trusted-validation' &&
      entry.source === 'platform-owned checks',
    ).at(-1);
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
          evidence.push(await this.engine.validate(
            this.subject(candidate, repository),
            this.engine.repo(repository.repo_id),
            repository.tree,
            repository.commit,
            candidate.base_heads,
            evaluationHeads,
          ));
        await this.engine.native.event('candidate.validated', actor, {
          candidate_id: id,
          evidence_ids: evidence.map((entry) => entry.id),
        });
        return { candidate, evidence };
      },
    );
  }

  async basis(candidate) {
    return hash({
      candidate,
      selections: candidate.selection_ids.map((id) => this.object('selections', id)),
      evidence: candidate.repositories.map((repo) => this.latestEvidence(candidate, repo) ?? null),
      constraints: this.state.constraints.filter((constraint) => constraint.active),
      config_hash: this.engine.git.configHash,
      canonical_heads: this.state.repositories.map((repo) => ({
        repo_id: repo.id,
        head: repo.head,
        unavailable: !!repo.unavailable,
      })).sort((a, b) => a.repo_id.localeCompare(b.repo_id)),
      futures: candidate.selection_ids.map((id) => {
        const revision = this.engine.native.revision(this.object('selections', id).future_revision_id);
        const future = this.engine.native.future(revision.future_id);
        return { id: future.id, revision_id: future.current_revision_id, status: future.status };
      }),
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
    return {
      candidate,
      decision_basis_hash: await this.basis(candidate),
      expected_heads: candidate.base_heads,
      sources_current: sourcesCurrent,
      heads_current: headsCurrent,
      evidence,
      validation_passing: evidence.every((entry) =>
        entry && entry.validity.status === 'current' && validationPassed(entry) &&
        entry.tree_hash === candidate.repositories.find((repo) =>
          this.subject(candidate, repo) === entry.subject_ref,
        )?.tree,
      ),
      promotion_supported: candidate.repositories.filter((repo) => repo.tree !== repo.base_tree).length === 1,
    };
  }

  async promote(id, input, actor) {
    actorIdentity(actor);
    if (typeof input.request_id !== 'string' || !input.request_id || input.request_id.length > 128)
      throw new DomainError('INVALID_REQUEST', 'A bounded request identity is required');
    if (typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 4000)
      throw new DomainError('INVALID_RESOLUTION', 'Record a brief rationale');
    const operationId = 'promotion_' + await hash({ actor, request_id: input.request_id });
    const inputHash = await hash({ candidate_id: id, input });
    const previous = this.state.operations.find((operation) => operation.id === operationId);
    if (previous) {
      if (previous.input_hash !== inputHash)
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'The request identity has different inputs', 409);
      if (previous.status === 'applied')
        return { decision: this.object('nativeDecisions', previous.decision_id), operation: previous };
      if (previous.status === 'not-applied')
        throw new DomainError('PROMOTION_NOT_ISSUED', 'The prior attempt did not issue a Git write; review and submit a new request', 409);
      throw new DomainError('RECOVERY_REQUIRED', 'Reconcile the recorded promotion before retrying', 409);
    }
    if (this.state.operations.some((operation) =>
      ['prepared', 'recovery-required'].includes(operation.status),
    ))
      throw new DomainError('RECOVERY_REQUIRED', 'A prior canonical write needs reconciliation', 409);
    const reviewed = await this.review(id);
    if (
      input.decision_basis_hash !== reviewed.decision_basis_hash ||
      await hash(input.expected_heads) !== await hash(reviewed.expected_heads) ||
      !reviewed.sources_current ||
      !reviewed.heads_current
    )
      throw new DomainError('DECISION_STALE', 'Review the changed candidate basis', 409);
    if (!reviewed.validation_passing)
      throw new DomainError('VALIDATION_REQUIRED', 'Fresh trusted composed-tree validation is required', 409);
    if (!reviewed.promotion_supported)
      throw new DomainError(
        'MULTI_REPO_PROMOTION_UNSUPPORTED',
        'This version promotes exactly one changed repository per decision',
        422,
      );
    const repository = reviewed.candidate.repositories.find((repo) => repo.tree !== repo.base_tree);
    const decision = await record('native-decision', {
      candidate_id: id,
      selection_ids: reviewed.candidate.selection_ids,
      decision_basis_hash: reviewed.decision_basis_hash,
      canonical_heads_seen: reviewed.expected_heads,
      evidence_ids: reviewed.evidence.map((entry) => entry.id),
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
      decision_id: decision.id,
      candidate_id: id,
      repo: repository.repo_id,
      expected_head: repository.base_commit,
      target_commit: repository.commit,
      target_tree: repository.tree,
      status: 'prepared',
      dispatch_state: 'not_started',
    };
    this.state.operations.push(operation);
    await this.engine.audit('canonical.prepared', actor, { operation_id: operation.id, decision_id: decision.id });
    // Persist intent before issuing the only canonical mutation. Ambiguous replies
    // are observed through recovery, never converted into a second push.
    await this.engine.save(this.state);
    operation.dispatch_state = 'issued';
    await this.engine.save(this.state);
    try {
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
    await this.engine.native.event('canonical.updated', actor, {
      repo: operation.repo,
      decision_id: operation.decision_id,
      candidate_id: operation.candidate_id,
      head: operation.target_commit,
    });
    operation.status = 'applied';
  }

  async recoverOperation(operation) {
    const decision = this.object('nativeDecisions', operation.decision_id);
    const candidate = this.object('candidateStates', decision.candidate_id);
    const target = candidate.repositories.find((repo) => repo.repo_id === operation.repo);
    if (
      target?.commit !== operation.target_commit ||
      target.tree !== operation.target_tree ||
      target.base_commit !== operation.expected_head
    )
      throw new DomainError('RECOVERY_REQUIRED', 'The journal differs from its immutable candidate', 503);
    if (operation.dispatch_state === 'not_started') {
      operation.status = 'not-applied';
      await this.engine.audit('canonical.not-issued', 'coordinator', { operation_id: operation.id });
      return;
    }
    const repo = this.engine.repo(operation.repo);
    if (await this.engine.git.ref(repo, repo.canonical_ref) === operation.target_commit)
      await this.complete(operation, 'coordinator');
    else operation.status = 'recovery-required';
  }

  view() {
    return structuredClone({
      selections: this.state.selections,
      candidates: this.state.candidateStates,
      decisions: this.state.nativeDecisions,
      promotions: this.state.operations.filter((operation) => operation.kind === 'native'),
    });
  }
}
