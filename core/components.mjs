import { hash, stable } from './hash.mjs';

const sorted = (values) => [...new Set(values)].sort();
const sameSet = (left, right) => stable(sorted(left)) === stable(sorted(right));
const TERMINAL = new Set(['resolved', 'deferred']);
const BLOCKERS = new Set(['alternative', 'conflicts_with']);
const implementationKey = (revision) =>
  revision.tree_hash
    ? stable({ repo: revision.repo, tree: revision.tree_hash })
    : stable({ revision: revision.id });

function activeFromState(state) {
  const proposals = new Map((state.proposals ?? []).map((proposal) => [proposal.id, proposal]));
  return (state.revisions ?? []).filter((revision) => {
    const proposal = proposals.get(revision.proposal_id);
    return (
      proposal &&
      state.refVersions?.[`${revision.source_repo ?? revision.repo}:${proposal.ref}`] ===
        revision.head_commit
    );
  });
}

function defaultValidity(state, evidence, options) {
  const reasons = [];
  for (const [repo, head] of Object.entries(evidence.validity_heads ?? {})) {
    if (!(state.repositories ?? []).some((item) => item.id === repo && item.head === head))
      reasons.push(`canonical head changed: ${repo}`);
  }
  const constraints = (state.constraints ?? [])
    .filter((constraint) => constraint.active)
    .map((constraint) => constraint.id);
  if (!sameSet(evidence.constraint_versions ?? [], constraints))
    reasons.push('constraint version changed');
  const configHash = options.configHash ?? state.validation_config_hash;
  if (!configHash)
    return {
      status: 'unknown',
      reasons: [...reasons, 'current validation configuration was not supplied'],
    };
  if (evidence.config_hash !== configHash) reasons.push('validation configuration changed');
  return { status: reasons.length ? 'stale' : 'current', reasons };
}

// A failure of a larger tree does not identify this pair as its cause. Exact-pair
// evidence is deliberately required before describing an observed interaction.
function exactSubject(evidence, revisions, state) {
  const ids = revisions.map((revision) => revision.id);
  if (evidence.composition_ref != null) {
    const referenced = (state.compositions ?? []).find(
      (item) => item.id === evidence.composition_ref,
    );
    if (
      !referenced ||
      !sameSet(referenced.proposal_revision_ids ?? [], ids) ||
      !referenced.resulting_tree ||
      referenced.resulting_tree !== evidence.tree_hash
    )
      return false;
  } else if (
    evidence.type === 'composed-interaction' &&
    new Set(revisions.map((revision) => revision.repo)).size === 1
  ) {
    // An interaction inside one repository requires an actual resulting tree.
    return false;
  }
  const composition = (state.compositions ?? []).find((item) => item.id === evidence.subject_ref);
  if (composition) {
    return (
      sameSet(composition.proposal_revision_ids ?? [], ids) &&
      !!composition.resulting_tree &&
      composition.resulting_tree === evidence.tree_hash
    );
  }
  const subjects =
    evidence.subject_revision_ids ??
    (Array.isArray(evidence.subject_ref) ? evidence.subject_ref : []);
  if (!sameSet(subjects, ids)) return false;
  if (Array.isArray(evidence.subject_versions)) {
    return (
      sameSet(
        evidence.subject_versions.map((item) => item.revision_id),
        ids,
      ) &&
      revisions.every((revision) =>
        evidence.subject_versions.some(
          (item) =>
            item.revision_id === revision.id &&
            item.head_commit === revision.head_commit &&
            item.tree_hash === revision.tree_hash,
        ),
      )
    );
  }
  // Repository keys can bind trees only if each subject has its own repository.
  const distinctRepos =
    new Set(revisions.map((revision) => revision.repo)).size === revisions.length;
  return revisions.every(
    (revision) =>
      revision.tree_hash &&
      (evidence.subject_trees?.[revision.id] === revision.tree_hash ||
        (distinctRepos && evidence.subject_trees?.[revision.repo] === revision.tree_hash)),
  );
}

async function explainEdge(relationship, revisions, state, options) {
  const evidence = new Map((state.evidence ?? []).map((item) => [item.id, item]));
  const details = [];
  for (const id of sorted(relationship.evidence_refs ?? [])) {
    const item = evidence.get(id);
    if (!item) {
      details.push({ id, status: 'missing', exact_subject: false, trusted: false });
      continue;
    }
    const validity = await (options.evidenceValidity
      ? options.evidenceValidity(item)
      : defaultValidity(state, item, options));
    const trusted = options.trustedEvidence
      ? !!(await options.trustedEvidence(item))
      : ['platform-owned checks', 'platform-owned interaction checks'].includes(item.source);
    details.push({
      id,
      status: validity?.status ?? 'unknown',
      reasons: validity?.reasons ?? [],
      type: item.type,
      exact_subject: exactSubject(item, revisions, state),
      trusted,
      failed: item.result?.passed === false,
    });
  }
  const observations = details.filter((item) => item.exact_subject && item.trusted && item.failed);
  const currentObservation =
    relationship.basis === 'observed' && observations.some((item) => item.status === 'current');
  const staleObservation =
    relationship.basis === 'observed' && observations.some((item) => item.status === 'stale');
  const textualObservation = observations.some(
    (item) => item.type === 'textual-composition-conflict',
  );
  let claim;
  if (relationship.type === 'alternative') {
    claim = `${relationship.basis ?? 'unknown'} alternative: selecting one outcome defers the competing outcome; validation does not choose the preferred behavior.`;
  } else if (currentObservation && textualObservation) {
    claim =
      'Git could not compose this exact revision pair on the captured base. This establishes a textual merge conflict, not a semantic interaction.';
  } else if (staleObservation && textualObservation) {
    claim =
      'Git previously could not compose this exact pair, but the captured base is stale. Keep the merge conflict in review until Git composition is checked again.';
  } else if (currentObservation) {
    claim =
      'A trusted check failed on this exact composed pair. The listed check establishes an interaction for these versions; it does not establish global correctness.';
  } else if (staleObservation) {
    claim =
      'A trusted check previously failed on this exact pair, but its validation basis is stale. Keep the interaction in review and obtain fresh composed evidence.';
  } else {
    claim = `${relationship.basis ?? 'unknown'} conflict claim lacks current trusted failure evidence bound to this exact pair. It requires review, not an automatic semantic conclusion.`;
  }
  return {
    relationship_id: relationship.id,
    from_revision: relationship.from_revision,
    to_revision: relationship.to_revision,
    type: relationship.type,
    basis: relationship.basis ?? 'unknown',
    evidence_refs: sorted(relationship.evidence_refs ?? []),
    evidence: details,
    observation: String(relationship.observation ?? ''),
    explanation: claim,
    classification:
      relationship.type === 'alternative'
        ? 'alternative'
        : currentObservation && textualObservation
          ? 'textual-conflict'
          : staleObservation && textualObservation
            ? 'stale-textual-conflict'
            : currentObservation
              ? 'observed-interaction'
              : staleObservation
                ? 'stale-interaction'
                : 'unverified-conflict',
    basis_stale:
      staleObservation ||
      details.some((item) => item.status === 'stale' || item.status === 'missing'),
  };
}

/**
 * Enumerate maximal choices, so adding another implementation would introduce
 * a recorded blocker. Maximal independent sets become cliques in the complement
 * graph; Bron–Kerbosch avoids examining every proposal subset.
 * A budget failure discards partial results rather than hiding a human choice.
 *
 * @param {string[]} keys Implementation identities; duplicate keys are collapsed.
 * @param {Array<[string, string]>} blockerPairs Undirected implementation blockers.
 * @param {object} [limits] Bounds on search size, effort, and result count.
 * @param {number} [limits.maxImplementations=18]
 * @param {number} [limits.maxSearchNodes=100000]
 * @param {number} [limits.maxAlternatives=64]
 * @returns {{status: string, subsets: string[][], visited: number, reason?: string}}
 *   Complete deterministic choices, or manual-review with no partial choices.
 */
export function maximalConsistentSubsets(
  keys,
  blockerPairs,
  { maxImplementations = 18, maxSearchNodes = 100000, maxAlternatives = 64 } = {},
) {
  const vertices = sorted(keys);
  if (vertices.length > maxImplementations)
    return {
      status: 'manual-review',
      reason: 'implementation limit exceeded',
      subsets: [],
      visited: 0,
    };
  const blockers = new Map(vertices.map((key) => [key, new Set()]));
  for (const [left, right] of blockerPairs) {
    if (left === right)
      return {
        status: 'manual-review',
        reason: 'a blocking claim targets identical implementations',
        subsets: [],
        visited: 0,
      };
    blockers.get(left)?.add(right);
    blockers.get(right)?.add(left);
  }
  const neighbors = new Map(
    vertices.map((key) => [
      key,
      new Set(vertices.filter((other) => other !== key && !blockers.get(key).has(other))),
    ]),
  );
  let visited = 0,
    reason;
  const subsets = [];
  function search(chosen, possible, excluded) {
    if (reason) return;
    if (++visited > maxSearchNodes) {
      reason = 'search budget exceeded';
      return;
    }
    if (!possible.length && !excluded.length) {
      if (subsets.length >= maxAlternatives) {
        reason = 'alternative limit exceeded';
        return;
      }
      subsets.push([...chosen].sort());
      return;
    }
    const pivot = [...possible, ...excluded].sort((a, b) => {
      const count = (key) => possible.filter((value) => neighbors.get(key).has(value)).length;
      return count(b) - count(a) || a.localeCompare(b);
    })[0];
    const candidates = possible.filter((key) => !neighbors.get(pivot)?.has(key));
    for (const key of candidates) {
      search(
        [...chosen, key],
        possible.filter((value) => neighbors.get(key).has(value)),
        excluded.filter((value) => neighbors.get(key).has(value)),
      );
      possible = possible.filter((value) => value !== key);
      excluded = [...excluded, key];
      if (reason) break;
    }
  }
  search([], vertices, []);
  return reason
    ? { status: 'manual-review', reason, subsets: [], visited }
    : {
        status: 'complete',
        subsets: subsets.sort((a, b) => stable(a).localeCompare(stable(b))),
        visited,
      };
}

/**
 * Group active revisions only through unresolved alternative/conflict edges.
 * Unknown overlap and equivalence cannot manufacture a human decision. Evidence
 * affects the explanation of an edge; a candidate still needs actual composition
 * and validation before the coordinator can advance Git.
 *
 * @param {object} state Coordination snapshot; this derivation does not mutate it.
 * @param {object} [options]
 * @param {object[]} [options.activeRevisions] Authoritative active revisions;
 *   otherwise derived from the snapshot's refVersions.
 * @param {Function} [options.evidenceValidity] Current/stale/unknown assessment
 *   including configuration checks; may return a promise.
 * @param {string} [options.configHash] Current trusted configuration when no
 *   evidenceValidity callback is provided.
 * @param {Function} [options.trustedEvidence] Platform evidence ownership policy;
 *   may return a promise and must not rely on producer trust declarations.
 * @returns {Promise<object>} Components, ungrouped revision IDs, equivalence groups,
 *   historical terminal components, and diagnostics. Alternatives carry per-repo
 *   composition plans; these plans provide no cross-repository atomicity guarantee.
 */
export async function deriveDecisionComponents(state, options = {}) {
  const active = [...(options.activeRevisions ?? activeFromState(state))].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const revisions = new Map(active.map((revision) => [revision.id, revision]));
  const proposals = new Map((state.proposals ?? []).map((proposal) => [proposal.id, proposal]));
  const implementations = new Map();
  for (const revision of active) {
    const key = implementationKey(revision);
    if (!implementations.has(key)) implementations.set(key, []);
    implementations.get(key).push(revision);
  }
  const adjacency = new Map(),
    edges = [],
    diagnostics = [];
  for (const relationship of [...(state.relationships ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (
      !BLOCKERS.has(relationship.type) ||
      TERMINAL.has(relationship.status) ||
      relationship.resolved === true
    )
      continue;
    const from = revisions.get(relationship.from_revision),
      to = revisions.get(relationship.to_revision);
    if (!from || !to) {
      diagnostics.push({ relationship_id: relationship.id, reason: 'inactive revision endpoint' });
      continue;
    }
    const left = implementationKey(from),
      right = implementationKey(to);
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
    edges.push({ ...(await explainEdge(relationship, [from, to], state, options)), left, right });
  }
  const connected = [],
    seen = new Set();
  for (const start of [...adjacency.keys()].sort()) {
    if (seen.has(start)) continue;
    const keys = [],
      pending = [start];
    seen.add(start);
    while (pending.length) {
      const key = pending.pop();
      keys.push(key);
      for (const neighbor of [...adjacency.get(key)].sort())
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          pending.push(neighbor);
        }
    }
    connected.push(keys.sort());
  }
  const components = [],
    grouped = new Set();
  for (const keys of connected) {
    const keySet = new Set(keys),
      members = keys
        .flatMap((key) => implementations.get(key))
        .sort((a, b) => a.id.localeCompare(b.id));
    const componentEdges = edges.filter((edge) => keySet.has(edge.left) && keySet.has(edge.right));
    const revisionIds = members.map((revision) => revision.id),
      proposalIds = sorted(members.map((revision) => revision.proposal_id ?? revision.id));
    // A logical component survives a base-head change, but revised immutable
    // members or changed edges produce a different graph hash and reopen review.
    const signatures = sorted(
      componentEdges.map((edge) =>
        stable({
          proposals: sorted([
            revisions.get(edge.from_revision).proposal_id ?? edge.from_revision,
            revisions.get(edge.to_revision).proposal_id ?? edge.to_revision,
          ]),
          type: edge.type,
        }),
      ),
    );
    const id = `component_${await hash({ proposal_ids: proposalIds, blockers: signatures })}`;
    const graphHash = await hash({
      revision_ids: revisionIds,
      relationships: componentEdges.map((edge) => edge.relationship_id).sort(),
    });
    const previous = (state.decisionComponents ?? []).find((component) => component.id === id);
    const unchanged = previous?.graph_hash === graphHash;
    const planning = maximalConsistentSubsets(
      keys,
      componentEdges.map((edge) => [edge.left, edge.right]),
      options,
    );
    const alternatives = [];
    for (const subset of planning.subsets) {
      const selected = subset
        .flatMap((key) => implementations.get(key))
        .map((revision) => revision.id)
        .sort();
      const deferred = revisionIds.filter((revisionId) => !selected.includes(revisionId));
      const repos = sorted(selected.map((revisionId) => revisions.get(revisionId).repo));
      const alternativeId = `candidate_${await hash({ revision_ids: selected })}`;
      const title = selected
        .map(
          (revisionId) => proposals.get(revisions.get(revisionId).proposal_id)?.title ?? revisionId,
        )
        .join(' + ');
      const prior = unchanged
        ? previous.alternatives?.find((alternative) => alternative.id === alternativeId)
        : undefined;
      alternatives.push({
        ...prior,
        id: alternativeId,
        title,
        description: `Apply ${selected.length} proposal ${selected.length === 1 ? 'history' : 'histories'}; defer ${deferred.length}.`,
        tradeoff:
          'This excludes the recorded competing or interacting implementations. Its actual composed tree still requires validation.',
        revision_ids: selected,
        deferred_revision_ids: deferred,
        compositions: repos.map((repo) => ({
          repo,
          revision_ids: selected.filter((revisionId) => revisions.get(revisionId).repo === repo),
        })),
        ...(repos.length === 1 ? { repo: repos[0] } : {}),
        evidence_ids: prior?.evidence_ids ?? [],
        validation: prior?.validation ?? 'required',
      });
    }
    const hasInteraction = componentEdges.some((edge) => edge.type === 'conflicts_with');
    const onlyTextual = componentEdges.every((edge) =>
      ['textual-conflict', 'stale-textual-conflict'].includes(edge.classification),
    );
    const component = {
      id,
      graph_hash: graphHash,
      derived: true,
      derivation_version: 'blocking-components-v0',
      title: onlyTextual
        ? 'Which changes should advance before resolving the merge conflict?'
        : hasInteraction
          ? 'Which interacting changes should advance?'
          : 'Which competing approach should advance?',
      kind: onlyTextual
        ? 'Merge conflict'
        : hasInteraction
          ? 'Semantic interaction'
          : 'Architectural choice',
      summary: `${members.length} proposal histories form one decision because ${componentEdges.length} unresolved ${componentEdges.length === 1 ? 'relationship connects' : 'relationships connect'} their outcomes. Unrelated work stays outside this decision.`,
      intent: sorted(
        members.map((revision) => proposals.get(revision.proposal_id)?.statement).filter(Boolean),
      ).join(' · '),
      scope: sorted(members.map((revision) => revision.repo)),
      revision_ids: revisionIds,
      status: unchanged && TERMINAL.has(previous.status) ? previous.status : 'open',
      assumptions: [],
      included: [],
      alternatives,
      planning: { ...planning, subsets: undefined },
      edges: componentEdges.map(({ left: _left, right: _right, ...edge }) => edge),
      basis_stale: componentEdges.some((edge) => edge.basis_stale),
      explanation:
        'Every member is reachable through an unresolved alternative or conflict edge. Unknown overlap, compatibility hints, equivalence and dependencies do not connect decisions.',
    };
    if (unchanged) {
      for (const field of ['basis_hash', 'canonical_head_seen', 'selected', 'resolution_id'])
        if (previous[field] !== undefined) component[field] = previous[field];
    }
    components.push(component);
    members.forEach((revision) => grouped.add(revision.id));
  }
  components.sort((a, b) => a.id.localeCompare(b.id));
  return {
    components,
    ungrouped_revision_ids: active
      .filter((revision) => !grouped.has(revision.id))
      .map((revision) => revision.id),
    equivalence_groups: [...implementations.values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map((revision) => revision.id))
      .sort((a, b) => stable(a).localeCompare(stable(b))),
    historical_components: (state.decisionComponents ?? []).filter(
      (component) =>
        TERMINAL.has(component.status) &&
        !components.some((current) => current.id === component.id),
    ),
    diagnostics,
  };
}
