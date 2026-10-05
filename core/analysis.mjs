import { hash, record } from './hash.mjs';
import { deriveDecisionComponents } from './components.mjs';
import { validationPassed } from './evidence.mjs';

const now = () => new Date().toISOString();

// Deterministic analysis owns relationship discovery and decision-graph projection.
// It reads live engine.state so local reset can replace the state object.

/** Superseding analyzer versions replace applicability, never historical records. */
export function applicableRelationships(engine) {
  const latest = new Map();
  for (const r of engine.state.relationships) if (r.version_key) latest.set(r.version_key, r.id);
  return engine.state.relationships.filter(
    (r) => !r.version_key || latest.get(r.version_key) === r.id,
  );
}

/** Validate exact inputs, discover bounded interactions, then prepare review candidates. */
export async function analyzeWork(engine, { actor = 'coordinator', refresh = false } = {}) {
  await engine.syncHeads();
  const start = performance.now();
  const active = engine
    .activeRevisions()
    .filter((r) => !engine.settled(r.id) && engine.mr.analysisEligible(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const validityHeads = Object.fromEntries(engine.state.repositories.map((r) => [r.id, r.head]));
  // Establish baseline proof before attributing any composed failure to two changes.
  const baselines = new Map();
  for (const repo of engine.state.repositories.filter((repo) =>
    active.some((r) => r.repo === repo.id),
  )) {
    const subject = 'baseline:' + repo.id + ':' + repo.head;
    let e = engine.currentEvidence(subject);
    if (!e) {
      const facts = await engine.git.facts(repo, repo.head, repo.head);
      e = await engine.validate(subject, repo, facts.tree, repo.head, validityHeads);
    }
    baselines.set(repo.id, e);
  }
  // Singles and pairs are rebased/composed onto the same captured canonical heads.
  for (const r of active) {
    if (engine.currentEvidence(r.id)) continue;
    try {
      const candidate = await engine.compose(r.repo, [r.id]),
        e = engine.state.evidence.find((e) => e.id === candidate.evidence_ids[0]);
      const single = await record('ev', {
        ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'id')),
        subject_ref: r.id,
        composition_ref: candidate.composition_id,
        subject_versions: [
          { revision_id: r.id, head_commit: r.head_commit, tree_hash: r.tree_hash },
        ],
        created_at: now(),
      });
      engine.state.evidence.push(single);
    } catch (e) {
      if (e.code !== 'COMPOSITION_CONFLICT') throw e;
      const failure = await record('ev', {
        subject_ref: r.id,
        tree_hash: r.tree_hash,
        type: 'git-composition',
        config_hash: engine.git.configHash,
        result: {
          passed: false,
          checks: [{ name: 'Apply to current canonical base', passed: false, detail: e.message }],
        },
        source: 'platform-owned checks',
        created_at: now(),
        validity_heads: validityHeads,
        constraint_versions: engine.state.constraints.filter((c) => c.active).map((c) => c.id),
        claim:
          'Git application failed on the captured base; this is not a semantic correctness claim.',
      });
      engine.state.evidence.push(failure);
    }
  }
  const unique = [...new Map(active.map((r) => [`${r.repo}:${r.tree_hash}`, r])).values()].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  // Compare only distinct implementations that share a path or trusted suite.
  // A failure becomes an observed interaction only after baseline and singletons pass.
  for (let i = 0; i < unique.length; i++)
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i],
        b = unique[j];
      if (a.repo !== b.repo) continue;
      if (
        engine
          .applicableRelationships()
          .some(
            (r) =>
              r.type === 'alternative' &&
              [r.from_revision, r.to_revision].includes(a.id) &&
              [r.from_revision, r.to_revision].includes(b.id),
          )
      )
        continue;
      const footprintA = engine.git.suitesForScope?.(engine.repo(a.repo), a.affected_scope) ?? [],
        footprintB = engine.git.suitesForScope?.(engine.repo(b.repo), b.affected_scope) ?? [];
      const overlaps = a.affected_scope.some((path) => b.affected_scope.includes(path));
      if (!overlaps && !footprintA.some((suite) => footprintB.includes(suite))) continue;
      if (
        !validationPassed(baselines.get(a.repo)) ||
        !validationPassed(engine.currentEvidence(a.id)) ||
        !validationPassed(engine.currentEvidence(b.id))
      )
        continue;
      const versions = [a.id, b.id].sort(),
        key = await hash({
          versions,
          heads: validityHeads,
          constraints: engine.state.constraints
            .filter((c) => c.active)
            .map((c) => c.id)
            .sort(),
          config: engine.git.configHash,
        });
      if (engine.state.analysisCache[key]) continue;
      engine.state.metrics.interactionComparisons =
        (engine.state.metrics.interactionComparisons ?? 0) + 1;
      let composed,
        evidence,
        textual = false;
      try {
        composed = await engine.compose(a.repo, versions);
        evidence = engine.state.evidence.find((e) => e.id === composed.evidence_ids[0]);
      } catch (e) {
        if (e.code !== 'COMPOSITION_CONFLICT') throw e;
        textual = true;
        evidence = {
          tree_hash: null,
          result: {
            passed: false,
            checks: [{ name: 'Git composition', passed: false, detail: e.message }],
          },
          config_hash: engine.git.configHash,
          constraint_versions: engine.state.constraints.filter((c) => c.active).map((c) => c.id),
        };
      }
      engine.state.analysisCache[key] = {
        composition_id: composed?.composition_id ?? null,
        textual_conflict: textual,
        evidence_id: evidence.id ?? null,
      };
      if (!evidence.result.passed) {
        const proof = await record('ev', {
          subject_ref: versions,
          subject_revision_ids: versions,
          subject_versions: [a, b]
            .map((r) => ({ revision_id: r.id, head_commit: r.head_commit, tree_hash: r.tree_hash }))
            .sort((x, y) => x.revision_id.localeCompare(y.revision_id)),
          composition_ref: composed?.composition_id ?? null,
          tree_hash: evidence.tree_hash,
          type: textual ? 'textual-composition-conflict' : 'composed-interaction',
          config_hash: evidence.config_hash,
          result: evidence.result,
          source: 'platform-owned interaction checks',
          created_at: now(),
          validity_heads: validityHeads,
          constraint_versions: evidence.constraint_versions,
          baseline_evidence_id: baselines.get(a.repo).id,
          individual_evidence_ids: [
            engine.currentEvidence(a.id).id,
            engine.currentEvidence(b.id).id,
          ],
          claim: textual
            ? 'Each singleton applies and passes on the same base; their Git composition fails.'
            : 'Baseline and each singleton passed on the same captured canonical base; this exact textually merged pair failed the listed trusted check.',
        });
        engine.state.evidence.push(proof);
        const rel = await record('rel', {
          from_revision: versions[0],
          to_revision: versions[1],
          type: 'conflicts_with',
          version_key: await hash({ versions, analyzer: 'trusted-pair-v0' }),
          confidence: 1,
          basis: 'observed',
          analyzer_version: 'trusted-pair-v0',
          evidence_refs: [proof.id],
          observation: proof.result.checks
            .filter((c) => !c.passed)
            .map((c) => c.detail)
            .join(' '),
        });
        engine.state.relationships.push(rel);
      }
    }
  // Preserve explicit manual reviews while rebuilding the derived graph projection.
  const manual = engine.state.decisionComponents.filter(
    (c) => c.manual_review && c.status === 'open',
  );
  const result = await deriveDecisionComponents(
    { ...engine.state, relationships: engine.applicableRelationships() },
    { activeRevisions: active, evidenceValidity: (e) => engine.evidenceValidity(e) },
  );
  engine.state.decisionComponents = [
    ...result.components,
    ...manual.filter((c) => !result.components.some((d) => d.id === c.id)),
    ...result.historical_components,
  ];
  const safeIndependent = result.ungrouped_revision_ids.filter((id) => {
    const r = engine.revision(id);
    return (
      validationPassed(engine.currentEvidence(id)) &&
      r.context_binding_state !== 'invalid' &&
      (r.provenance_state !== 'unknown' || r.affected_scope.every((path) => /\.md$/i.test(path)))
    );
  });
  // An unattached change still needs an explicit human review, even if checks pass.
  const attached = safeIndependent.filter((id) =>
    result.components.some(
      (c) => c.status === 'open' && c.scope.includes(engine.revision(id).repo),
    ),
  );
  const explicitlySelected = new Set(manual.flatMap((c) => c.revision_ids));
  engine.state.discovery = {
    ...result,
    components: undefined,
    historical_components: undefined,
    supplemental_revision_ids: attached,
    conventional_review_ids: result.ungrouped_revision_ids.filter(
      (id) => !attached.includes(id) && !explicitlySelected.has(id),
    ),
    explanation:
      'Only unresolved alternative/conflict edges connect decision groups. Independent work remains separate and can be included in an explicitly reviewed, validated composition. Unattached and unknown executable work remain conventional review.',
  };
  for (const c of engine.state.decisionComponents.filter(
    (c) => c.status === 'open' && !c.manual_review,
  )) {
    c.supplemental_revision_ids = attached.filter((id) =>
      c.scope.includes(engine.revision(id).repo),
    );
    c.included = c.supplemental_revision_ids.map((id) => {
      const r = engine.revision(id),
        p = engine.state.proposals.find((p) => p.id === r.proposal_id);
      return `${p.title} · independent of the decision graph · ${r.provenance_state === 'unknown' ? 'unknown provenance; explicit review' : 'declared intent'}`;
    });
    const snapshots = [...c.revision_ids, ...(c.supplemental_revision_ids ?? [])]
      .map((id) =>
        engine.state.contexts.find((ctx) => ctx.id === engine.revision(id).context_version),
      )
      .filter(Boolean);
    c.assumptions = snapshots
      .flatMap((ctx) => ctx.items ?? [])
      .filter((i) => i.type === 'assumption')
      .map((i) => ({
        id: i.id,
        value: i.value.rationale,
        basis: i.basis,
        source: i.source,
        unresolved: true,
      }));
    if (refresh || !c.basis_hash || c.basis_hash !== (await engine.basis(c)))
      await engine.buildDecision(c);
  }
  engine.state.metrics.analysisLatencyMs = Math.round(performance.now() - start);
  await engine.audit('analysis.completed', actor, {
    active_revisions: active.length,
    derived_components: result.components.length,
    independent_revisions: result.ungrouped_revision_ids,
    conventional_review_ids: engine.state.discovery.conventional_review_ids,
  });
  await engine.save(engine.state);
  return engine.view();
}
