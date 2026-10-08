import { DomainError, hash, record } from './hash.mjs';
import { validationPassed } from './evidence.mjs';
import { readProducerMetadata } from './metadata.mjs';

const now = () => new Date().toISOString();
const kinds = new Set(['alternative', 'conflicts_with', 'unknown', 'compatible_candidate', 'depends_on', 'supersedes', 'implementation_equivalent']);
const sorted = (values) => [...new Set(values)].sort();
const sameHeads = (left, right) => JSON.stringify(Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const pairKey = (a, b) => sorted([a, b]).join(':');
const fail = (code, message, status = 400) => { throw new DomainError(code, message, status); };
function identity(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 200)
    fail('UNAUTHENTICATED', 'An authenticated actor is required', 401);
}
function requestIdentity(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 128)
    fail('INVALID_REQUEST', 'A bounded request identity is required');
}
function maximalChoices(ids, edges, implementations) {
  // Bound exponential work; an oversized component stays visible for conventional review.
  if (ids.length > 12) return [];
  const result = [];
  for (let mask = 1; mask < 2 ** ids.length; mask++) {
    const selected = ids.filter((_, index) => mask & (2 ** index));
    if (edges.some((edge) => selected.includes(edge.from_revision) && selected.includes(edge.to_revision))) continue;
    if (ids.some((id) => !selected.includes(id) && !edges.some((edge) =>
      (edge.from_revision === id && selected.includes(edge.to_revision)) ||
      (edge.to_revision === id && selected.includes(edge.from_revision))))) continue;
    result.push({ revision_ids: selected, implementation_ids: sorted(selected.map((id) => implementations.get(id))) });
  }
  return result;
}

/**
 * Derive review components from native Future revisions, never compatibility MRs.
 * Mutations run within the transport's Engine.serial boundary. Discovery retains
 * actual candidate trees and finite observations; it never approves canonical code.
 */
export class NativeDiscovery {
  constructor(engine) { this.engine = engine; this.state; }
  get state() {
    for (const key of ['nativeRelationships', 'nativeImplementations', 'nativeDecisionGroups',
      'nativeGroupVersions', 'nativeGroupDecisions', 'nativeGroupDispositions',
      'nativeDiscoveryRequests', 'nativeDiscoveryValidations', 'nativeDiscoveryRuns'])
      this.engine.state[key] ??= [];
    return this.engine.state;
  }
  future(revision) { return this.engine.native.future(revision.future_id); }
  revision(id) { return this.engine.native.revision(id); }
  heads() {
    return Object.fromEntries(this.state.repositories.map((repo) => [repo.id, repo.head]).sort(([a], [b]) => a.localeCompare(b)));
  }
  active() {
    const settled = new Set(this.state.nativeGroupDispositions.map((entry) => entry.future_revision_id));
    for (const disposition of this.state.nativeDispositions ?? []) {
      if (disposition.status !== 'applied') continue;
      const selections = (disposition.selection_ids ?? []).map((id) => this.state.selections?.find((entry) => entry.id === id));
      if (selections.length && selections.every((selection) => selection?.kind === 'future'))
        settled.add(disposition.future_revision_id);
    }
    return this.state.futures.filter((future) => future.status === 'active' && future.current_revision_id &&
      !settled.has(future.current_revision_id)).map((future) => this.revision(future.current_revision_id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async put(collection, prefix, value) {
    const entry = await record(prefix, value);
    if (!this.state[collection].some((existing) => existing.id === entry.id)) this.state[collection].push(entry);
    return entry;
  }
  async addRelationship(input, actor) {
    identity(actor);
    if (!kinds.has(input.type) || input.from_revision === input.to_revision)
      fail('INVALID_RELATIONSHIP', 'Choose a relationship between distinct immutable revisions');
    const left = this.revision(input.from_revision), right = this.revision(input.to_revision);
    if (this.future(left).system_id !== this.future(right).system_id)
      fail('RELATIONSHIP_SYSTEM_MISMATCH', 'Related revisions must belong to the same System');
    if (typeof input.statement !== 'string' || !input.statement.trim() || input.statement.length > 1000)
      fail('INVALID_RELATIONSHIP', 'Record the declared relationship rationale');
    return this.engine.native.request('discovery.relationship', {
      request_id: input.request_id, from_revision: left.id, to_revision: right.id,
      type: input.type, statement: input.statement.trim(),
    }, actor, async () => {
      const relationship = await this.put('nativeRelationships', 'native-relationship', {
        from_revision: left.id, to_revision: right.id, type: input.type, basis: 'declared',
        analyzer_version: 'native-declaration-v0', evidence_refs: [], actor,
        observation: input.statement.trim(),
      });
      await this.derive();
      await this.engine.native.event('relationship.declared', actor, { relationship_id: relationship.id });
      return { relationship };
    });
  }
  async declarations(revisions) {
    const declarations = [];
    if (!this.engine.git.file) return declarations;
    for (const revision of revisions) for (const head of revision.repository_heads) {
      const raw = await readProducerMetadata(this.engine.git, { id: head.source_repo_id, canonical_repo: head.repo_id }, head.commit, 'proposal.json');
      if (typeof raw !== 'string' || raw.length > 32768) continue;
      let value;
      try { value = JSON.parse(raw); } catch { continue; }
      if (typeof value?.decision_key !== 'string' || !value.decision_key.trim() || value.decision_key.length > 100 ||
        typeof value.choice !== 'string' || !value.choice.trim() || value.choice.length > 100) continue;
      declarations.push({ revision, key: value.decision_key, choice: value.choice, source: {
        repo_id: head.source_repo_id, commit: head.commit, path: '.klocgit/proposal.json',
      } });
    }
    const buckets = new Map();
    for (const entry of declarations) {
      const key = this.future(entry.revision).system_id + ':' + entry.key;
      const bucket = buckets.get(key) ?? []; bucket.push(entry); buckets.set(key, bucket);
    }
    // A declaration bucket needs only a spanning graph, not all pair edges.
    for (const entries of buckets.values()) {
      const ordered = entries.sort((a, b) => a.revision.id.localeCompare(b.revision.id));
      const first = ordered[0], different = ordered.find((entry) => entry.choice !== first.choice);
      if (!different) continue;
      const pairs = ordered.length <= 12 ? ordered.flatMap((entry, index) => ordered.slice(index + 1)
        .filter((other) => other.choice !== entry.choice).map((other) => [entry, other])) :
        ordered.map((entry) => [entry, entry.choice === first.choice ? different : first]);
      for (const [entry, other] of pairs) {
        if (entry.revision.id === other.revision.id) continue;
        await this.put('nativeRelationships', 'native-relationship', {
          from_revision: entry.revision.id, to_revision: other.revision.id, type: 'alternative',
          basis: 'declared', analyzer_version: 'native-git-declaration-v0', evidence_refs: [],
          declarations: [{ choice: entry.choice, source: entry.source }, { choice: other.choice, source: other.source }],
          observation: 'Immutable producer declarations name competing choices for ' + entry.key + '; no preference is inferred.',
        });
      }
    }
    return declarations;
  }
  async implementationIndex(revisions) {
    const buckets = new Map(), byRevision = new Map();
    for (const revision of revisions) {
      const vector = [...revision.tree_hashes].sort((a, b) => a.repo_id.localeCompare(b.repo_id));
      const content = { system_id: this.future(revision).system_id, tree_hashes: vector };
      const key = await hash(content);
      const entries = buckets.get(key) ?? []; entries.push(revision); buckets.set(key, entries);
      byRevision.set(revision.id, 'native-implementation_' + key);
    }
    this.state.nativeImplementations = [];
    for (const entries of buckets.values()) {
      const first = entries[0], content = { system_id: this.future(first).system_id,
        tree_hashes: [...first.tree_hashes].sort((a, b) => a.repo_id.localeCompare(b.repo_id)) };
      this.state.nativeImplementations.push({ id: 'native-implementation_' + await hash(content),
        ...content, revision_ids: entries.map((entry) => entry.id).sort() });
      for (const entry of entries.slice(1)) await this.put('nativeRelationships', 'native-relationship', {
        from_revision: first.id, to_revision: entry.id, type: 'implementation_equivalent',
        basis: 'observed', analyzer_version: 'native-tree-v0', evidence_refs: [],
        observation: 'Identical complete Git tree vectors; separate objectives, rationale and provenance histories remain.',
      });
    }
    return byRevision;
  }
  comparisonPairs(revisions, budget) {
    const buckets = new Map();
    const add = (key, revision) => { const entries = buckets.get(key) ?? new Map(); entries.set(revision.id, revision); buckets.set(key, entries); };
    for (const revision of revisions) {
      const future = this.future(revision);
      for (const scope of revision.affected_scope) {
        if (!scope.paths.length) continue;
        if (future.objective_id) add(future.system_id + ':objective:' + future.objective_id + ':' + scope.repo_id, revision);
        for (const path of scope.paths) {
          add(future.system_id + ':path:' + scope.repo_id + ':' + path, revision);
          const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          if (directory) add(future.system_id + ':directory:' + scope.repo_id + ':' + directory, revision);
        }
        const suites = this.engine.git.suitesForScope?.(this.engine.repo(scope.repo_id), scope.paths) ?? [];
        for (const suite of suites) add(future.system_id + ':suite:' + scope.repo_id + ':' + suite, revision);
      }
    }
    const pairs = new Map();
    for (const key of [...buckets.keys()].sort()) {
      const entries = [...buckets.get(key).values()].sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        pairs.set(pairKey(entries[i].id, entries[j].id), [entries[i], entries[j]]);
        if (pairs.size > budget) return { pairs: [...pairs.values()].slice(0, budget), exhausted: true };
      }
    }
    return { pairs: [...pairs.values()], exhausted: false };
  }
  latestRelationships() {
    const latest = new Map(), retained = [];
    for (const relation of this.state.nativeRelationships) {
      if (relation.version_key) latest.set(relation.version_key, relation);
      else retained.push(relation);
    }
    return [...retained, ...latest.values()];
  }
  candidateRevisionIds(candidate) {
    return sorted(candidate.selection_ids.map((id) => this.engine.pipeline.object('selections', id).future_revision_id));
  }
  proofEvidence(candidate, evidenceIds, passing, baseHeads, revisionIds) {
    if (!candidate || JSON.stringify(this.candidateRevisionIds(candidate)) !== JSON.stringify(sorted(revisionIds))) return false;
    if (!sameHeads(candidate.base_heads, baseHeads)) return false;
    if (evidenceIds.length !== candidate.repositories.length) return false;
    return candidate.repositories.every((repository) => {
      const evidence = evidenceIds.map((id) => this.state.evidence.find((entry) => entry.id === id))
        .find((entry) => entry?.subject_ref === candidate.id + ':' + repository.repo_id);
      return evidence && evidence.source === 'platform-owned checks' && evidence.type === 'trusted-validation' &&
        evidence.tree_hash === repository.tree && sameHeads(evidence.validity_heads, baseHeads) &&
        validationPassed(evidence) === passing;
    });
  }
  observedConflict(relation) {
    const proof = relation.proof;
    if (relation.type !== 'conflicts_with' || relation.basis !== 'observed' || proof?.kind !== 'isolated-composed-interaction') return false;
    const ids = sorted([relation.from_revision, relation.to_revision]);
    if (JSON.stringify(ids) !== JSON.stringify(proof.revision_ids)) return false;
    if (!Array.isArray(proof.baseline_evidence_ids) || !proof.baseline_evidence_ids.length || !Array.isArray(proof.isolated) || proof.isolated.length !== 2 || !proof.composed || !proof.baseline_trees) return false;
    const repoIds = sorted(ids.flatMap((id) => this.revision(id).repository_heads.map((head) => head.repo_id)));
    if (!repoIds.every((repoId) => proof.baseline_evidence_ids.some((id) => {
      const evidence = this.state.evidence.find((entry) => entry.id === id);
      return evidence?.source === 'platform-owned checks' && evidence.type === 'trusted-validation' &&
        evidence.subject_ref === proof.baseline_subject + ':' + repoId && validationPassed(evidence) &&
        sameHeads(evidence.validity_heads, proof.base_heads) &&
        evidence.tree_hash === proof.baseline_trees[repoId];
    }))) return false;
    for (const id of ids) {
      const control = proof.isolated.find((entry) => entry.revision_id === id);
      const candidate = (this.state.candidateStates ?? []).find((entry) => entry.id === control?.candidate_id);
      if (!control || !this.proofEvidence(candidate, control.evidence_ids, true, proof.base_heads, [id])) return false;
    }
    const candidate = (this.state.candidateStates ?? []).find((entry) => entry.id === proof.composed.candidate_id);
    // Multi-repository candidates can have a mix of passing and failing checks.
    if (!candidate || JSON.stringify(this.candidateRevisionIds(candidate)) !== JSON.stringify(ids) ||
      !sameHeads(candidate.base_heads, proof.base_heads)) return false;
    const evidence = proof.composed.evidence_ids.map((id) => this.state.evidence.find((entry) => entry.id === id));
    return evidence.length === candidate.repositories.length && evidence.every((entry) => entry &&
      entry.source === 'platform-owned checks' && entry.type === 'trusted-validation' &&
      candidate.repositories.some((repo) => entry.subject_ref === candidate.id + ':' + repo.repo_id && entry.tree_hash === repo.tree) &&
      sameHeads(entry.validity_heads, proof.base_heads)) && evidence.some((entry) => !validationPassed(entry));
  }
  relationStale(relation) {
    if (!relation.evidence_refs.length) return false;
    return relation.evidence_refs.some((id) => {
      const evidence = this.state.evidence.find((entry) => entry.id === id);
      if (!evidence || this.engine.evidenceValidity(evidence).status !== 'current') return true;
      const latest = this.state.evidence.filter((entry) => entry.subject_ref === evidence.subject_ref &&
        entry.type === 'trusted-validation' && entry.source === 'platform-owned checks').at(-1);
      return latest && latest.id !== evidence.id && validationPassed(latest) !== validationPassed(evidence);
    });
  }
  async derive() {
    const revisions = this.active(), ids = new Set(revisions.map((entry) => entry.id));
    const edges = this.latestRelationships().filter((relation) => ids.has(relation.from_revision) && ids.has(relation.to_revision) &&
      (relation.type === 'alternative' && relation.basis === 'declared' || this.observedConflict(relation)));
    const parent = new Map(revisions.map((entry) => [entry.id, entry.id]));
    const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
    for (const edge of edges) {
      const left = find(edge.from_revision), right = find(edge.to_revision);
      if (left !== right) parent.set(left < right ? right : left, left < right ? left : right);
    }
    const groups = new Map();
    for (const revision of revisions) {
      const id = find(revision.id), group = groups.get(id) ?? [];
      group.push(revision.id); groups.set(id, group);
    }
    const current = new Set(), implementationIds = new Map(this.state.nativeImplementations.flatMap((entry) => entry.revision_ids.map((id) => [id, entry.id])));
    for (const revisionIds of [...groups.values()].filter((entries) => entries.length > 1)) {
      const componentEdges = edges.filter((edge) => revisionIds.includes(edge.from_revision) && revisionIds.includes(edge.to_revision));
      const systemId = this.future(this.revision(revisionIds[0])).system_id;
      const id = 'decision-group_' + await hash({ system_id: systemId, revision_ids: revisionIds.sort() });
      const version = await this.put('nativeGroupVersions', 'native-group-version', {
        group_id: id, system_id: systemId, revision_ids: revisionIds, relationship_ids: componentEdges.map((edge) => edge.id).sort(),
      });
      const alternativeOnly = componentEdges.every((edge) => edge.type === 'alternative');
      const choices = maximalChoices(revisionIds, componentEdges, implementationIds);
      const projection = { id, version_id: version.id, system_id: systemId, revision_ids: revisionIds,
        relationship_ids: version.relationship_ids, status: 'open', kind: alternativeOnly ? 'Alternatives' : 'Interaction',
        title: alternativeOnly ? 'Choose between declared alternatives' : 'Resolve an interaction between changes',
        stale: componentEdges.some((edge) => this.relationStale(edge)),
        conventional_review_required: !choices.length, alternatives: choices };
      const old = this.state.nativeDecisionGroups.find((entry) => entry.id === id);
      if (old) Object.assign(old, projection); else this.state.nativeDecisionGroups.push(projection);
      current.add(id);
    }
    for (const group of this.state.nativeDecisionGroups)
      if (group.status === 'open' && !current.has(group.id)) group.status = 'superseded';
    return this.state.nativeDecisionGroups.filter((group) => current.has(group.id));
  }
  async controls(revisions, heads, runId, stats) {
    const controls = new Map(), baseline = new Map();
    for (const repoId of sorted(revisions.flatMap((revision) => revision.repository_heads.map((head) => head.repo_id)))) {
      const repo = this.engine.repo(repoId), facts = await this.engine.git.facts(repo, heads[repoId], heads[repoId]);
      if (facts.head !== heads[repoId] || typeof facts.tree !== 'string') fail('INVALID_GIT_FACTS', 'The canonical baseline tree was not established', 503);
      const subject = 'native-baseline_' + runId;
      const evidence = await this.engine.validate(subject + ':' + repoId, repo, facts.tree, heads[repoId], heads);
      stats.validation_runs++; baseline.set(repoId, { evidence, tree: facts.tree, subject });
    }
    for (const revision of revisions) {
      const selection = (await this.engine.pipeline.createSelection({
        future_revision_id: revision.id, request_id: 'discovery-selection-' + await hash({ runId, revision: revision.id }),
      }, 'discovery-engine')).selection;
      const candidate = (await this.engine.pipeline.createCandidate({
        selection_ids: [selection.id], expected_heads: heads, request_id: 'discovery-single-' + await hash({ runId, revision: revision.id }),
      }, 'discovery-engine')).candidate;
      stats.compositions++; stats.candidate_ids.push(candidate.id);
      const { evidence } = await this.engine.pipeline.validateCandidate(candidate.id, {
        request_id: 'discovery-check-' + await hash({ runId, candidate: candidate.id }),
      }, 'discovery-engine');
      stats.validation_runs += evidence.length;
      const control = await this.put('nativeDiscoveryValidations', 'native-isolation', {
        revision_id: revision.id, candidate_id: candidate.id, evidence_ids: evidence.map((entry) => entry.id), base_heads: heads,
      });
      controls.set(revision.id, { control, candidate, evidence, selection });
    }
    return { controls, baseline };
  }
  async analyze(input, actor) {
    identity(actor); requestIdentity(input.request_id);
    const budget = input.max_comparisons ?? 200;
    if (!Number.isInteger(budget) || budget < 0 || budget > 1000)
      fail('INVALID_DISCOVERY_BUDGET', 'Comparison budget must be between zero and one thousand');
    if (input.system_id !== undefined) this.engine.native.system(input.system_id);
    return this.engine.native.request('discovery.analyze', {
      request_id: input.request_id, system_id: input.system_id ?? null, max_comparisons: budget,
    }, actor, async () => {
      await this.reconcile(); await this.engine.syncHeads();
      const revisions = this.active().filter((revision) => !input.system_id || this.future(revision).system_id === input.system_id);
      if (revisions.length > 500) fail('DISCOVERY_BUDGET_EXCEEDED', 'Analyze smaller Systems; every Future remains available for conventional review', 429);
      await this.declarations(revisions);
      const implementations = await this.implementationIndex(this.state.futureRevisions);
      const index = this.comparisonPairs(revisions, budget), heads = this.heads();
      const runId = await hash({ actor, request_id: input.request_id });
      const counts = new Map();
      for (const revision of revisions) counts.set(this.future(revision).system_id, (counts.get(this.future(revision).system_id) ?? 0) + 1);
      const stats = { comparisons: 0, possible_comparisons: [...counts.values()].reduce((n, count) => n + count * (count - 1) / 2, 0),
        comparisons_avoided: 0, validation_runs: 0, compositions: 0, candidate_ids: [], diagnostics: [] };
      if (index.exhausted) stats.diagnostics.push({ code: 'COMPARISON_BUDGET_EXHAUSTED', message: 'Some interactions were not examined. Unclassified work requires conventional review.' });
      const eligible = index.pairs.filter(([left, right]) => implementations.get(left.id) !== implementations.get(right.id) &&
        !this.latestRelationships().some((relation) => relation.type === 'alternative' && relation.basis === 'declared' &&
          pairKey(relation.from_revision, relation.to_revision) === pairKey(left.id, right.id)));
      const needed = [...new Map(eligible.flat().map((revision) => [revision.id, revision])).values()].sort((a, b) => a.id.localeCompare(b.id));
      let controls, baseline;
      if (needed.length) ({ controls, baseline } = await this.controls(needed, heads, runId, stats));
      for (const [left, right] of eligible) {
        stats.comparisons++;
        const ids = sorted([left.id, right.id]), isolated = ids.map((id) => controls.get(id));
        const repoIds = sorted(ids.flatMap((id) => this.revision(id).repository_heads.map((head) => head.repo_id)));
        const versionKey = 'native-pair:' + pairKey(left.id, right.id);
        if (!isolated.every((entry) => entry.evidence.every(validationPassed)) ||
          !repoIds.every((id) => validationPassed(baseline.get(id).evidence))) {
          stats.diagnostics.push({ code: 'ISOLATION_NOT_PASSING', revision_ids: ids, message: 'Baseline or isolated checks failed; a composed failure would not establish an interaction.' });
          continue;
        }
        let candidate;
        try {
          candidate = (await this.engine.pipeline.createCandidate({
            selection_ids: isolated.map((entry) => entry.selection.id).sort(), expected_heads: heads,
            request_id: 'discovery-pair-' + await hash({ runId, ids }),
          }, 'discovery-engine')).candidate; stats.compositions++; stats.candidate_ids.push(candidate.id);
        } catch (error) {
          if (error.code !== 'COMPOSITION_CONFLICT') throw error;
          stats.diagnostics.push({ code: 'TEXTUAL_MERGE_CONFLICT', revision_ids: ids, message: 'Git could not compose these revisions; conventional merge review is required.' }); continue;
        }
        const { evidence } = await this.engine.pipeline.validateCandidate(candidate.id, {
          request_id: 'discovery-pair-check-' + await hash({ runId, candidate: candidate.id }),
        }, 'discovery-engine'); stats.validation_runs += evidence.length;
        const passed = evidence.every(validationPassed);
        const proof = {
          kind: 'isolated-composed-interaction', revision_ids: ids, base_heads: heads,
          baseline_subject: baseline.get(repoIds[0]).subject,
          baseline_trees: Object.fromEntries(repoIds.map((id) => [id, baseline.get(id).tree])),
          baseline_evidence_ids: repoIds.map((id) => baseline.get(id).evidence.id),
          isolated: isolated.map((entry) => ({ revision_id: entry.control.revision_id, candidate_id: entry.candidate.id, evidence_ids: entry.control.evidence_ids })),
          composed: { candidate_id: candidate.id, evidence_ids: evidence.map((entry) => entry.id) },
        };
        await this.put('nativeRelationships', 'native-relationship', {
          from_revision: ids[0], to_revision: ids[1], type: passed ? 'compatible_candidate' : 'conflicts_with',
          basis: 'observed', analyzer_version: 'native-composed-controls-v0', version_key: versionKey, proof,
          evidence_refs: sorted([...proof.baseline_evidence_ids, ...proof.isolated.flatMap((entry) => entry.evidence_ids), ...proof.composed.evidence_ids]),
          observation: passed ? 'This exact composition passed the listed finite checks; global compatibility is not established.' :
            'The baseline and each change pass alone on the same canonical base; their clean Git composition fails a trusted check.',
        });
      }
      stats.comparisons_avoided = Math.max(0, stats.possible_comparisons - stats.comparisons);
      const run = await this.put('nativeDiscoveryRuns', 'native-discovery-run', {
        system_id: input.system_id ?? null, revision_ids: revisions.map((entry) => entry.id), base_heads: heads, ...stats, created_at: now(),
      });
      await this.derive();
      await this.engine.native.event('discovery.completed', actor, { run_id: run.id, comparisons: stats.comparisons, validation_runs: stats.validation_runs });
      return { ...this.view(), run };
    });
  }
  async sourcesCurrent(revisions) {
    for (const revision of revisions) {
      const future = this.future(revision);
      if (future.status !== 'active' || future.current_revision_id !== revision.id) return false;
      for (const head of revision.repository_heads) {
        try {
          if (typeof this.engine.git.readRef === 'function') {
            const observed = await this.engine.git.readRef({ id: head.source_repo_id }, head.ref);
            if (observed.commit !== head.commit || observed.object_id !== (head.object_id ?? head.commit)) return false;
          } else if ((head.object_id && head.object_id !== head.commit) ||
            (await this.engine.git.ref({ id: head.source_repo_id }, head.ref)) !== head.commit) return false;
          const facts = await this.engine.git.facts({ id: head.source_repo_id }, head.commit, head.commit);
          if (facts.head !== head.commit || facts.tree !== revision.tree_hashes.find((entry) => entry.repo_id === head.repo_id)?.tree) return false;
        } catch (error) { if (error.code === 'REF_NOT_FOUND') return false; throw error; }
      }
    }
    return true;
  }
  async review(id) {
    await this.reconcile(); await this.engine.syncHeads(); await this.derive();
    const group = this.state.nativeDecisionGroups.find((entry) => entry.id === id);
    if (!group) fail('DECISION_GROUP_NOT_FOUND', 'Decision group not found', 404);
    const revisions = group.revision_ids.map((revisionId) => this.revision(revisionId));
    const relationships = this.latestRelationships().filter((entry) => group.revision_ids.includes(entry.from_revision) || group.revision_ids.includes(entry.to_revision));
    const evidenceIds = sorted(relationships.flatMap((entry) => entry.evidence_refs));
    const evidence = evidenceIds.map((evidenceId) => this.state.evidence.find((entry) => entry.id === evidenceId))
      .filter(Boolean).map((entry) => ({ ...entry, validity: this.engine.evidenceValidity(entry) }));
    const latestEvidence = sorted(evidence.map((entry) => entry.subject_ref)).map((subject) =>
      this.state.evidence.filter((entry) => entry.subject_ref === subject && entry.type === 'trusted-validation' && entry.source === 'platform-owned checks').at(-1));
    const context = this.engine.objectiveContext ? await this.engine.objectiveContext.revisionsValidity(group.revision_ids) : null;
    const sourcesCurrent = await this.sourcesCurrent(revisions), expectedHeads = this.heads();
    const staleReasons = [];
    if (group.status !== 'open') staleReasons.push('This component is resolved or superseded.');
    if (!sourcesCurrent) staleReasons.push('A Future source ref or current revision changed.');
    if (group.stale) staleReasons.push('Interaction evidence is stale or has conflicting later results; repeat analysis and review.');
    if (context && context.status !== 'current') staleReasons.push('Bound context is no longer current.');
    const basis = {
      group, revisions, relationships, evidence, latest_evidence: latestEvidence, context,
      canonical_heads: expectedHeads, constraints: this.state.constraints.filter((entry) => entry.active),
      config_hash: this.engine.git.configHash,
      access_policy_version: this.engine.access?.state?.version_id ?? this.engine.access?.state?.version ?? null,
      presentation: revisions.map((revision) => { const future = this.future(revision); return {
        id: revision.id, name: future.name, producer: revision.producer ?? future.producer,
        objective_statement: this.state.objectives.find((objective) => objective.id === future.objective_id)?.statement ?? null,
      }; }),
      system_futures: this.state.futures.filter((future) => future.system_id === group.system_id)
        .map((future) => ({ id: future.id, revision_id: future.current_revision_id, status: future.status })).sort((a, b) => a.id.localeCompare(b.id)),
    };
    return structuredClone({ group, revisions: revisions.map((revision) => ({ ...revision,
      ...basis.presentation.find((entry) => entry.id === revision.id) })), relationships, evidence, context,
      decision_basis_hash: await hash(basis), expected_heads: expectedHeads, sources_current: sourcesCurrent,
      stale_reasons: staleReasons, alternatives: group.alternatives });
  }
  linkedOperation(receipt) {
    const decision = this.state.nativeGroupDecisions.find((entry) => entry.id === receipt.decision_id);
    const operation = this.state.operations.find((entry) => entry.id === receipt.operation_id);
    const promotionDecision = (this.state.nativeDecisions ?? []).find((entry) => entry.id === operation?.decision_id);
    if (!decision || !operation || !promotionDecision || operation.kind !== 'native' ||
      operation.candidate_id !== decision.candidate_id || operation.input_hash !== receipt.promotion_input_hash ||
      operation.group_decision_id !== decision.id || operation.group_request_id !== receipt.id ||
      promotionDecision.group_decision_id !== decision.id || promotionDecision.group_request_id !== receipt.id ||
      promotionDecision.actor !== decision.actor || promotionDecision.candidate_id !== decision.candidate_id ||
      promotionDecision.decision_basis_hash !== decision.candidate_basis_hash ||
      !sameHeads(promotionDecision.canonical_heads_seen, decision.canonical_heads_seen)) return null;
    return operation;
  }
  async complete(receipt) {
    if (receipt.operation_id && this.linkedOperation(receipt)?.status !== 'applied')
      fail('RECOVERY_REQUIRED', 'The exact reviewed group promotion is not established as applied', 409);
    const decision = this.state.nativeGroupDecisions.find((entry) => entry.id === receipt.decision_id);
    for (const item of decision.dispositions) await this.put('nativeGroupDispositions', 'native-group-disposition', {
      decision_id: decision.id, future_id: this.revision(item.future_revision_id).future_id,
      future_revision_id: item.future_revision_id, outcome: item.outcome, scope: 'whole_future',
      status: item.outcome === 'accept' ? 'applied' : item.outcome === 'defer' ? 'deferred' : 'rejected',
      ...(receipt.operation_id ? { operation_id: receipt.operation_id } : {}),
    });
    const group = this.state.nativeDecisionGroups.find((entry) => entry.id === decision.group_id);
    if (group) Object.assign(group, { status: 'resolved', decision_id: decision.id, candidate_id: decision.candidate_id });
    receipt.status = 'applied';
    receipt.result = { decision, group: structuredClone(group), ...(receipt.operation_id ? {
      promotion: { operation: this.state.operations.find((entry) => entry.id === receipt.operation_id) },
    } : {}) };
    await this.engine.save(this.state);
    return structuredClone(receipt.result);
  }
  async reconcile() {
    for (const receipt of this.state.nativeDiscoveryRequests.filter((entry) => entry.status !== 'applied')) {
      const observed = receipt.operation_id && this.state.operations.find((entry) => entry.id === receipt.operation_id);
      const operation = receipt.operation_id && this.linkedOperation(receipt);
      if (observed && !operation) { receipt.status = 'linkage_mismatch'; continue; }
      if (!receipt.operation_id || operation?.status === 'applied') await this.complete(receipt);
      else if (operation) receipt.status = ['prepared', 'recovery-required'].includes(operation.status) ? 'recovery_required' : 'needs_review';
    }
  }
  async resolve(id, input, actor) {
    identity(actor); requestIdentity(input.request_id); await this.reconcile();
    const requestId = 'native-group-request_' + await hash({ actor, request_id: input.request_id });
    const inputHash = await hash({ group_id: id, input });
    const previous = this.state.nativeDiscoveryRequests.find((entry) => entry.id === requestId);
    if (previous) {
      if (previous.input_hash !== inputHash) fail('IDEMPOTENCY_CONFLICT', 'The request identity has different inputs', 409);
      if (previous.status === 'applied') return structuredClone(previous.result);
      fail('RECOVERY_REQUIRED', 'Inspect the linked promotion before submitting another decision', 409);
    }
    if (typeof input.rationale !== 'string' || !input.rationale.trim() || input.rationale.length > 4000)
      fail('INVALID_RESOLUTION', 'Record a bounded decision rationale');
    const reviewed = await this.review(id), ids = reviewed.group.revision_ids;
    if (input.decision_basis_hash !== reviewed.decision_basis_hash ||
      await hash(input.expected_heads) !== await hash(reviewed.expected_heads) || !reviewed.sources_current ||
      reviewed.group.status !== 'open' || reviewed.context && reviewed.context.status !== 'current')
      fail('DECISION_STALE', 'Review the changed group basis', 409);
    if (!Array.isArray(input.dispositions) || input.dispositions.length !== ids.length ||
      new Set(input.dispositions.map((entry) => entry?.future_revision_id)).size !== ids.length ||
      input.dispositions.some((entry) => !ids.includes(entry?.future_revision_id) || !['accept', 'defer', 'reject'].includes(entry?.outcome)))
      fail('INVALID_RESOLUTION', 'Record an explicit outcome for every immutable revision in the group');
    const accepted = sorted(input.dispositions.filter((entry) => entry.outcome === 'accept').map((entry) => entry.future_revision_id));
    let candidateReview = null;
    if (accepted.length) {
      const operationId = 'promotion_' + await hash({ actor, request_id: input.request_id });
      if (this.state.operations.some((operation) => operation.id === operationId))
        fail('IDEMPOTENCY_CONFLICT', 'This identity already belongs to a different promotion', 409);
      if (!input.candidate_id || !input.candidate_basis_hash) fail('VALIDATION_REQUIRED', 'Review an actual composed candidate for the accepted revisions', 409);
      const candidate = this.engine.pipeline.object('candidateStates', input.candidate_id);
      const selections = candidate.selection_ids.map((selectionId) => this.engine.pipeline.object('selections', selectionId));
      if (selections.some((selection) => selection.kind !== 'future') ||
        JSON.stringify(this.candidateRevisionIds(candidate)) !== JSON.stringify(accepted) || selections.length !== accepted.length)
        fail('CANDIDATE_SELECTION_MISMATCH', 'The candidate must contain exactly the accepted whole-Future revisions', 409);
      candidateReview = await this.engine.pipeline.review(candidate.id);
      if (candidateReview.decision_basis_hash !== input.candidate_basis_hash ||
        await hash(candidateReview.expected_heads) !== await hash(reviewed.expected_heads))
        fail('DECISION_STALE', 'Review the changed selected candidate', 409);
      if (!candidateReview.validation_passing) fail('VALIDATION_REQUIRED', 'The selected composition requires current trusted passing evidence', 409);
      // Even a passing composition does not authorize accepting both sides of an explicit alternative.
      if (reviewed.relationships.some((relation) => relation.type === 'alternative' && relation.basis === 'declared' &&
        accepted.includes(relation.from_revision) && accepted.includes(relation.to_revision)))
        fail('INVALID_RESOLUTION', 'Declared alternatives require a choice');
    } else if (input.candidate_id || input.candidate_basis_hash) fail('INVALID_RESOLUTION', 'A metadata-only decision does not apply a candidate');
    const decision = await this.put('nativeGroupDecisions', 'native-group-decision', {
      group_id: id, group_version_id: reviewed.group.version_id, decision_basis_hash: input.decision_basis_hash,
      canonical_heads_seen: reviewed.expected_heads, dispositions: [...input.dispositions].sort((a, b) => a.future_revision_id.localeCompare(b.future_revision_id)),
      candidate_id: input.candidate_id ?? null, candidate_basis_hash: input.candidate_basis_hash ?? null,
      resolution: 'explicit_dispositions', rationale: input.rationale.trim(), actor, created_at: now(),
    });
    const receipt = { id: requestId, input_hash: inputHash, decision_id: decision.id, status: 'prepared',
      ...(accepted.length ? { operation_id: 'promotion_' + await hash({ actor, request_id: input.request_id }) } : {}) };
    const promotionInput = accepted.length ? {
      request_id: input.request_id, decision_basis_hash: input.candidate_basis_hash,
      expected_heads: input.expected_heads, rationale: input.rationale.trim(),
    } : null;
    const execution = { group_decision_id: decision.id, group_request_id: requestId };
    if (accepted.length) receipt.promotion_input_hash = await hash({ candidate_id: input.candidate_id, input: promotionInput, ...execution });
    this.state.nativeDiscoveryRequests.push(receipt);
    await this.engine.native.event('decision-group.reviewed', actor, { group_id: id, decision_id: decision.id });
    await this.engine.save(this.state);
    if (accepted.length) {
      try {
        await this.engine.pipeline.promote(input.candidate_id, promotionInput, actor, execution);
      } catch (error) {
        const operation = this.state.operations.find((entry) => entry.id === receipt.operation_id);
        receipt.status = operation && ['prepared', 'recovery-required'].includes(operation.status) ? 'recovery_required' : 'needs_review';
        await this.engine.save(this.state); throw error;
      }
    }
    return this.complete(receipt);
  }
  view() {
    const revisions = this.active(), revisionIds = new Set(revisions.map((entry) => entry.id));
    const groups = this.state.nativeDecisionGroups.map((group) => {
      const receipt = this.state.nativeDiscoveryRequests.filter((entry) =>
        this.state.nativeGroupDecisions.find((decision) => decision.id === entry.decision_id)?.group_id === group.id).at(-1);
      const operation = receipt?.operation_id && this.linkedOperation(receipt);
      return { ...group, ...(operation?.status === 'applied' ? { status: 'resolved', decision_id: receipt.decision_id } : {}),
        ...(receipt?.status === 'recovery_required' ? { recovery_required: true } : {}) };
    });
    const open = groups.filter((group) => group.status === 'open' && group.revision_ids.every((id) => revisionIds.has(id)));
    const classified = new Set(open.flatMap((group) => group.revision_ids));
    const ungrouped = revisions.filter((revision) => !classified.has(revision.id));
    const run = this.state.nativeDiscoveryRuns.at(-1);
    return structuredClone({ decisionGroups: groups, implementations: this.state.nativeImplementations,
      relationships: this.state.nativeRelationships, groupDecisions: this.state.nativeGroupDecisions,
      discovery: { ...(run ?? {}), classified_revision_ids: [...classified].sort(),
        ungrouped_revision_ids: ungrouped.map((entry) => entry.id),
        unknown_revision_ids: ungrouped.filter((entry) => entry.provenance_state === 'unknown').map((entry) => entry.id),
        blocking_decision_count: open.length, conventional_review_count: ungrouped.length,
        human_attention_count: open.length + ungrouped.length,
        comparisons: run?.comparisons ?? 0, possible_comparisons: run?.possible_comparisons ?? 0,
        comparisons_avoided: run?.comparisons_avoided ?? 0, validation_runs: run?.validation_runs ?? 0,
        compositions: run?.compositions ?? 0, diagnostics: run?.diagnostics ?? [],
        analysis_candidate_ids: sorted(this.state.nativeDiscoveryRuns.flatMap((entry) => entry.candidate_ids ?? [])),
        limitations: ['Unknown work requires separate review. Finite checks and indexed comparisons do not prove global compatibility.'] } });
  }
}
