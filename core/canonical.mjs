import { record, DomainError } from './hash.mjs';
import { validationPassed } from './evidence.mjs';

const now = () => new Date().toISOString();

// Canonical writes and crash reconciliation share the same persisted operation journal.
// Helpers read engine.state at call time so a local workspace reset cannot retain old state.

/** Apply an exact reviewed composition through the write-ahead/CAS protocol. */
export async function resolveDecision(engine, id, input, actor, execution = {}) {
  if (!actor) throw new DomainError('UNAUTHENTICATED', 'Authenticated actor required', 401);
  if (engine.state.operations.some((d) => ['prepared', 'recovery-required'].includes(d.status)))
    throw new DomainError(
      'RECOVERY_REQUIRED',
      'A prior Git operation must be reconciled before advancing canonical state',
      409,
    );
  const c = engine.component(id);
  await engine.syncHeads();
  const currentBasis = await engine.basis(c);
  const option = c.alternatives.find((a) => a.id === input.alternative_id);
  if (!option) throw new DomainError('INVALID_RESOLUTION', 'Select a listed alternative');
  if (!option.repo)
    throw new DomainError(
      'MANUAL_REVIEW_REQUIRED',
      'Cross-repository or bounded review requires a conventional resolution.',
      422,
    );
  const repo = engine.repo(option.repo);
  engine.requireCanonical(repo);
  if (['resolved', 'deferred'].includes(c.status))
    throw new DomainError('DECISION_RESOLVED', 'This decision is already resolved', 409);
  // The reviewed basis and observed canonical OID are separate gates. A current
  // head alone cannot authorize changed constraints, membership or evidence.
  if (
    input.basis_hash !== c.basis_hash ||
    input.basis_hash !== currentBasis ||
    input.expected_canonical_head !== repo.head
  ) {
    engine.state.metrics.casFailures++;
    await engine.audit('decision.stale-rejected', actor, { decision_id: id });
    await engine.save(engine.state);
    throw new DomainError(
      'DECISION_STALE',
      'The canonical head or reviewed decision basis changed. Review fresh evidence before applying.',
      409,
      { current_basis_hash: currentBasis, canonical_head: repo.head },
    );
  }
  const composition = engine.state.compositions.find((x) => x.id === option.composition_id);
  if (option.validation !== 'passed' || !composition || composition.base_commit !== repo.head)
    throw new DomainError(
      'DECISION_STALE',
      'Composition requires rebuilding against canonical head',
      409,
    );
  const checks = option.evidence_ids.map((x) => engine.state.evidence.find((e) => e.id === x));
  if (
    !checks.length ||
    checks.some(
      (e) =>
        !e ||
        engine.evidenceValidity(e).status !== 'current' ||
        !validationPassed(e) ||
        e.id !== engine.currentEvidence(composition.id)?.id ||
        e.tree_hash !== composition.resulting_tree ||
        e.subject_ref !== composition.id ||
        e.type !== 'trusted-validation' ||
        e.source !== 'platform-owned checks',
    )
  )
    throw new DomainError(
      'VALIDATION_REQUIRED',
      'Fresh passing validation of the composed tree is required',
      422,
    );
  await engine.mr.guardRevisionIds(composition.proposal_revision_ids, actor, {
    composition_id: composition.id,
  });
  await engine.verifyRevisionHeads(composition.proposal_revision_ids);
  // Persistence may run arbitrary asynchronous work, including observing an
  // external Git push. Capture this OID now so CAS still rejects that later race.
  const expectedHead = repo.head;
  // Queue attribution comes only from the internal scheduler, never request-body fields.
  const queueLink =
    execution.queue_ticket_id && execution.queue_attempt_id
      ? { queue_ticket_id: execution.queue_ticket_id, queue_attempt_id: execution.queue_attempt_id }
      : {};
  const resolution = await record('decision', {
    component_id: id,
    ...queueLink,
    operation_kind: c.revert ? 'revert' : 'merge',
    reverts_commit: c.revert?.target_commit ?? null,
    reverts_decision_id: c.revert?.decision_id ?? null,
    proposal_revision_ids: composition.proposal_revision_ids,
    decision_basis_hash: currentBasis,
    canonical_head_seen: repo.head,
    resolution: option.id,
    rationale: String(input.rationale ?? '').slice(0, 2000),
    actor,
    reviewed_context_refs: [
      ...new Set(c.revision_ids.map((id) => engine.revision(id).context_version)),
    ],
    reviewed_context_answer_refs: [
      ...new Set(
        c.revision_ids.map((id) => engine.revision(id).context_answer_ref).filter(Boolean),
      ),
    ],
    context_refs: composition.proposal_revision_ids.map(
      (id) => engine.revision(id).context_version,
    ),
    context_answer_refs: composition.proposal_revision_ids
      .map((id) => engine.revision(id).context_answer_ref)
      .filter(Boolean),
    deferred_revision_ids: option.deferred_revision_ids ?? [],
    created_at: now(),
  });
  // Persist write-ahead intent before the external Git CAS. Recovery reconciles only this exact commit.
  engine.state.decisions.push(resolution);
  const operation = {
    id: 'operation_' + resolution.id,
    decision_id: resolution.id,
    ...queueLink,
    status: 'prepared',
    target_commit: composition.commit,
    expected_head: expectedHead,
    repo: repo.id,
  };
  engine.state.operations.push(operation);
  await engine.audit('canonical.prepared', actor, {
    decision_id: resolution.id,
    expected: repo.head,
    target: composition.commit,
  });
  await engine.save(engine.state);
  let updated;
  try {
    updated = await engine.git.cas(repo, expectedHead, composition.commit);
  } catch {
    operation.status = 'recovery-required';
    await engine.audit('canonical.recovery-required', actor, { decision_id: resolution.id });
    await engine.save(engine.state);
    throw new DomainError(
      'RECOVERY_REQUIRED',
      'Git outcome is uncertain. Reconcile the prepared operation before another canonical update.',
      503,
    );
  }
  if (!updated) {
    operation.status = 'cas-failed';
    engine.state.metrics.casFailures++;
    await engine.audit('canonical.cas-failed', actor, { decision_id: resolution.id });
    await engine.save(engine.state);
    throw new DomainError(
      'DECISION_STALE',
      'Git compare-and-set rejected canonical advancement',
      409,
    );
  }
  await engine.restoreDispositions(resolution, composition.commit);
  repo.head = composition.commit;
  c.status = 'resolved';
  c.selected = option.id;
  c.resolution_id = resolution.id;
  operation.status = 'applied';
  await engine.audit('canonical.updated', actor, {
    repo: repo.id,
    head: repo.head,
    decision_id: resolution.id,
    tree: composition.resulting_tree,
  });
  await engine.save(engine.state);
  return { decision_id: resolution.id, canonical_head: repo.head, resolution: option.id };
}

/** Replay exact decision dispositions without duplicating per-proposal history. */
export async function restoreDispositions(engine, decision, commit) {
  for (const [status, ids] of [
    ['applied', decision.proposal_revision_ids],
    ['deferred', decision.deferred_revision_ids ?? []],
  ])
    for (const id of ids) {
      if (
        engine.state.dispositions.some(
          (d) => d.revision_id === id && d.decision_id === decision.id && d.status === status,
        )
      )
        continue;
      engine.state.dispositions.push(
        await record('disposition', {
          revision_id: id,
          status,
          decision_id: decision.id,
          ...(status === 'applied' ? { commit } : {}),
        }),
      );
    }
  await engine.mr.reconcileDecision(decision, commit);
}

/** Reconcile an uncertain write using Git observation; never issue another CAS. */
export async function recoverOperations(engine) {
  for (const operation of engine.state.operations.filter((d) =>
    ['prepared', 'recovery-required'].includes(d.status),
  )) {
    const decision = engine.state.decisions.find((d) => d.id === operation.decision_id);
    if (!decision)
      throw new DomainError(
        'RECOVERY_REQUIRED',
        'Prepared operation has no immutable decision',
        503,
      );
    const repo = engine.repo(operation.repo);
    const observed = await engine.git.ref(repo, repo.canonical_ref);
    // Only the exact prepared target proves this write completed. A different
    // head remains uncertain, including a later descendant or the expected base.
    if (observed === operation.target_commit) {
      await engine.restoreDispositions(decision, operation.target_commit);
      operation.status = 'applied';
      repo.head = observed;
      const c = engine.component(decision.component_id);
      c.status = 'resolved';
      c.selected = decision.resolution;
      c.resolution_id = decision.id;
      await engine.audit('canonical.recovered', 'coordinator', {
        decision_id: decision.id,
        head: observed,
      });
    } else {
      operation.status = 'recovery-required';
      await engine.audit('canonical.recovery-required', 'coordinator', {
        decision_id: decision.id,
        observed,
      });
    }
  }
  await engine.queue.reconcile('coordinator');
  await engine.save(engine.state);
}
