import { hash, record, DomainError } from './hash.mjs';

const now = () => new Date().toISOString();

// Review preparation and basis construction share the exact records shown to the
// reviewer. Read live engine.state because local reset can replace the state object.

/** Hash exact review inputs, including the newest trusted proof for each candidate. */
export async function decisionBasis(engine, component) {
  const ids = [...component.revision_ids, ...(component.supplemental_revision_ids ?? [])];
  const relationships = engine
    .applicableRelationships()
    .filter((r) => ids.includes(r.from_revision) || ids.includes(r.to_revision));
  const alternatives = component.alternatives.map((a) => ({
    ...a,
    latest_subject_evidence_ref: a.composition_id
      ? (engine.currentEvidence(a.composition_id)?.id ?? null)
      : null,
    evidence: (a.evidence_ids ?? []).map((id) => {
      const e = engine.state.evidence.find((e) => e.id === id);
      return { id, validity: e ? engine.evidenceValidity(e) : { status: 'missing' } };
    }),
  }));
  return hash({
    component_id: component.id,
    graph_hash: component.graph_hash,
    membership: engine
      .activeRevisions()
      .filter((r) => component.scope.includes(r.repo))
      .map((r) => r.id)
      .sort(),
    revisions: ids.sort(),
    relationships: relationships.map((r) => r.id).sort(),
    constraints: engine.state.constraints
      .filter((c) => c.active)
      .map((c) => c.id)
      .sort(),
    alternatives,
    heads: engine.state.repositories
      .map((r) => ({ repo: r.id, head: r.head }))
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    assumptions: component.assumptions ?? [],
    contexts: ids.map((id) => engine.revision(id).context_version).sort(),
    merge_request_basis: await engine.mr.basisFor(ids),
    review_kind: component.review_kind ?? null,
    revert: component.revert ?? null,
    canonical_availability: engine.state.repositories.map((r) => ({
      repo: r.id,
      unavailable: !!r.unavailable,
    })),
  });
}

/** Construct and validate each offered composition before computing its review basis. */
export async function buildDecision(engine, c) {
  for (const a of c.alternatives) {
    if (!a.repo) {
      a.validation = 'cross-repo-review';
      continue;
    }
    const revisionIds = [
      ...new Set([
        ...a.revision_ids,
        ...(c.supplemental_revision_ids ?? []).filter((id) => engine.revision(id).repo === a.repo),
      ]),
    ];
    a.composed_revision_ids = revisionIds;
    a.merge_request_basis_hash = await engine.mr.basisFor(revisionIds);
    try {
      Object.assign(a, await engine.compose(a.repo, revisionIds));
    } catch (e) {
      if (e.code !== 'COMPOSITION_CONFLICT') throw e;
      a.validation = 'conflict';
      a.evidence_ids = [];
      a.error = e.message;
    }
  }
  for (const a of c.alternatives)
    a.merge_request_basis_hash = await engine.mr.basisFor(
      a.composed_revision_ids ?? a.revision_ids,
    );
  c.merge_request_basis_hash = await engine.mr.basisFor([
    ...c.revision_ids,
    ...(c.supplemental_revision_ids ?? []),
  ]);
  c.basis_hash = await engine.basis(c);
  c.canonical_head_seen = c.alternatives[0]?.repo ? engine.repo(c.alternatives[0].repo).head : null;
}

// Git events can arrive late: a source-ref read protects reviews from unseen pushes.
export async function verifyRevisionHeads(engine, ids) {
  for (const id of ids) {
    const revision = engine.revision(id);
    if (revision.source_kind === 'retained-candidate') continue;
    const proposal = engine.state.proposals.find((p) => p.id === revision.proposal_id);
    const source = {
      ...engine.repo(revision.repo),
      id: revision.source_repo ?? revision.repo,
      canonical_repo: revision.repo,
    };
    let head;
    try {
      head = await engine.git.ref(source, proposal.ref);
    } catch (error) {
      if (error.code === 'REF_NOT_FOUND')
        throw new DomainError(
          'DECISION_STALE',
          'A selected producer branch was deleted. Review current work.',
          409,
        );
      throw error;
    }
    if (head !== revision.head_commit)
      throw new DomainError(
        'DECISION_STALE',
        'A producer head changed before its event arrived. Review the new revision.',
        409,
      );
  }
}

/** Prepare one explicitly selected, single-repository human review. */
export async function prepareReview(engine, input, actor) {
  if (!actor)
    throw new DomainError('UNAUTHENTICATED', 'An authenticated reviewer is required', 401);
  await engine.syncHeads();
  const ids = [...new Set(input.revision_ids ?? [])].sort();
  if (!ids.length || ids.length > 64)
    throw new DomainError('INVALID_REVIEW', 'Select between one and 64 immutable revisions');
  const revisions = ids.map((id) => engine.revision(id));
  if (new Set(revisions.map((r) => r.repo)).size !== 1)
    throw new DomainError(
      'CROSS_REPO_REVIEW',
      'Prepare one reviewed composition per repository; cross-repository dependencies must be satisfied separately',
      422,
    );
  if (revisions.some((r) => engine.settled(r.id)))
    throw new DomainError(
      'REVISION_SETTLED',
      'Selected work already has an applied or deferred disposition.',
      409,
    );
  await engine.verifyRevisionHeads(ids);
  const repo = revisions[0].repo,
    proposalIds = revisions.map((r) => r.proposal_id).sort();
  const id = 'review_' + (await hash({ proposal_ids: proposalIds }));
  const alternative = {
    id: 'selected_' + (await hash(ids)),
    title: 'Apply selected changes',
    description: 'Apply the listed exact revisions together.',
    tradeoff: 'The reviewed composition must pass current trusted checks and configured MR policy.',
    repo,
    revision_ids: ids,
    deferred_revision_ids: [],
    evidence_ids: [],
    validation: 'required',
  };
  const c = {
    id,
    graph_hash: await hash({ revisions: ids }),
    manual_review: true,
    review_kind: input.review_kind ?? 'explicit-selection',
    derived: false,
    title: String(
      input.title ??
        (ids.length === 1
          ? engine.state.proposals.find((p) => p.id === proposalIds[0]).title
          : 'Review selected changes'),
    ).slice(0, 200),
    summary: `${ids.length} explicitly selected proposal histories; unrelated work remains open.`,
    kind:
      input.review_kind === 'revert' ? 'Revert' : ids.length > 1 ? 'Batch review' : 'Merge request',
    scope: [repo],
    revision_ids: ids,
    status: 'open',
    assumptions: [],
    included: [],
    supplemental_revision_ids: [],
    alternatives: [alternative],
    ...(input.revert ? { revert: input.revert } : {}),
  };
  const snapshots = ids
    .map((id) => engine.state.contexts.find((c) => c.id === engine.revision(id).context_version))
    .filter(Boolean);
  c.assumptions = snapshots
    .flatMap((s) => s.items ?? [])
    .filter((i) => i.type === 'assumption')
    .map((i) => ({ id: i.id, value: i.value.rationale, basis: i.basis, unresolved: true }));
  await engine.buildDecision(c);
  const index = engine.state.decisionComponents.findIndex((v) => v.id === id);
  if (index < 0) engine.state.decisionComponents.push(c);
  else engine.state.decisionComponents[index] = c;
  await engine.audit('review.prepared', actor, {
    component_id: id,
    revision_ids: ids,
    basis_hash: c.basis_hash,
  });
  await engine.save(engine.state);
  return c;
}

// A revert is an actual inverse candidate. It goes through the same review and
// validation path as other work, with its applied target pinned in the basis.
export async function prepareRevert(engine, input, actor) {
  if (!actor)
    throw new DomainError('UNAUTHENTICATED', 'An authenticated reviewer is required', 401);
  await engine.syncHeads();
  const decision = input.decision_id
    ? engine.state.decisions.find((d) => d.id === input.decision_id)
    : null;
  if (input.decision_id && !decision)
    throw new DomainError('DECISION_NOT_FOUND', 'Revert decision is unavailable', 404);
  const operation = decision
    ? engine.state.operations.find((o) => o.decision_id === decision.id && o.status === 'applied')
    : null;
  if (decision && !operation)
    throw new DomainError('REVERT_NOT_APPLIED', 'Only an applied decision can be reverted', 409);
  const repo = engine.repo(input.repo ?? operation?.repo);
  engine.requireCanonical(repo);
  const target = input.target_commit ?? operation?.target_commit;
  if (operation && target !== operation.target_commit)
    throw new DomainError(
      'INVALID_REVERT_TARGET',
      'The target does not match the applied decision',
      409,
    );
  const mainline = input.mainline ?? (operation ? 1 : undefined);
  if (!engine.git.revert)
    throw new DomainError(
      'REVERT_UNAVAILABLE',
      'The trusted Git adapter cannot construct inverse changes',
      503,
    );
  const candidate = await engine.git.revert(repo, repo.head, target, mainline);
  const facts = await engine.git.facts(repo, candidate.commit, repo.head),
    proposalId = await hash({ repo: repo.id, reverts: target, base: repo.head });
  let proposal = engine.state.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    const intent = await record('intent', {
      statement: String(input.rationale ?? 'Undo the selected applied change.'),
      scope: facts.scope,
      source: actor,
      basis: 'declared',
      created_at: now(),
    });
    engine.state.intents.push(intent);
    proposal = {
      id: proposalId,
      intent_id: intent.id,
      repo: repo.id,
      source_repo: repo.id,
      ref: candidate.retention_ref ?? `refs/klocgit/candidates/${candidate.commit}`,
      title: String(input.title ?? 'Revert reviewed change').slice(0, 200),
      statement: intent.statement,
      producer: actor,
      provenance_state: 'declared',
      created_at: now(),
    };
    engine.state.proposals.push(proposal);
  }
  const context = await record('ctx', {
    items: [
      {
        type: 'revert',
        value: {
          target_commit: target,
          decision_id: decision?.id ?? null,
          mainline: candidate.mainline,
        },
        basis: 'declared',
        source: actor,
        validity_scope: facts.scope,
      },
    ],
    constraints: engine.state.constraints.filter((c) => c.active).map((c) => c.id),
    canonical_heads: engine.state.repositories.map((r) => ({ repo: r.id, head: r.head })),
  });
  engine.state.contexts.push(context);
  const implementation = await record('impl', { repo: repo.id, tree_hash: facts.tree });
  if (!engine.state.implementations.some((i) => i.id === implementation.id))
    engine.state.implementations.push(implementation);
  const revision = await record('rev', {
    proposal_id: proposalId,
    implementation_ref: implementation.id,
    repo: repo.id,
    source_repo: repo.id,
    source_kind: 'retained-candidate',
    base_commit: repo.head,
    base_state: 'observed-canonical',
    head_commit: candidate.commit,
    tree_hash: facts.tree,
    context_version: context.id,
    affected_scope: facts.scope,
    provenance_state: 'declared',
    context_binding_state: 'unknown',
  });
  engine.state.revisions.push(revision);
  engine.state.refVersions[`${repo.id}:${proposal.ref}`] = candidate.commit;
  return engine.prepareReview(
    {
      revision_ids: [revision.id],
      title: proposal.title,
      review_kind: 'revert',
      revert: {
        repo: repo.id,
        target_commit: target,
        decision_id: decision?.id ?? null,
        mainline: candidate.mainline,
      },
    },
    actor,
  );
}

/** Re-present current work rather than carry a previous approval across new inputs. */
export async function refreshDecision(engine, id) {
  const old = engine.component(id);
  if (['resolved', 'deferred'].includes(old.status)) return old;
  if (old.manual_review) {
    if (old.revert)
      return engine.prepareRevert(
        {
          repo: old.revert.repo,
          target_commit: old.revert.target_commit,
          mainline: old.revert.mainline,
          decision_id: old.revert.decision_id,
          title: old.title,
        },
        'coordinator',
      );
    const revisions = old.revision_ids.map((id) => engine.revision(id)),
      active = engine.activeRevisions();
    const current = revisions
      .map((r) => active.find((v) => v.proposal_id === r.proposal_id && !engine.settled(v.id))?.id)
      .filter(Boolean);
    if (current.length !== revisions.length)
      throw new DomainError(
        'DECISION_STALE',
        'This review contains withdrawn or settled work. Prepare the current selection.',
        409,
      );
    return engine.prepareReview({ revision_ids: current, title: old.title }, 'coordinator');
  }
  await engine.analyzeWork({ refresh: true });
  const current = engine.state.decisionComponents.find((c) => c.id === id);
  if (!current)
    throw new DomainError(
      'DECISION_STALE',
      'The decision graph changed. Review the newly derived components.',
      409,
    );
  return current;
}
