import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionFormulator } from '../../core/v1/decision-formulation.mjs';
import { buildCandidateSpec } from '../../core/v1/reduction.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';
import { buildEffectSet } from '../../core/v1/extractors.mjs';
import { buildEvidence, candidateEvidenceSubject } from '../../core/v1/evidence.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { verifyDecisionBasis } from '../../core/v1/decisions.mjs';
import { objectId } from '../../core/v1/conventions.mjs';

async function fixture(count = 3) {
  const base_revision = objectId(
    'system-revision',
    await digestCanonical('object-system-revision', { baseline: true }),
  );
  const policy_digest = await digestCanonical('policy', { checks: ['behavior'] });
  const configuration = await digestCanonical('evaluation-config', { behavior: 'registered' });
  const environment_digest = await digestCanonical('evaluation-environment', { image: 'pinned' });
  const revisions = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      digestCanonical('object-future-revision', { producer: index }).then((digest) =>
        objectId('future-revision', digest),
      ),
    ),
  );
  const specs = [],
    candidates = [],
    effects = [],
    targets = {};
  for (const [index, id] of revisions.entries()) {
    const effect = await buildEffectSet({
      schema_version: 1,
      future_revision_id: id,
      extractor_id: 'paths',
      extractor_version: '1',
      capability: 'PATH',
      status: 'COMPLETE',
      effects: [
        {
          schema_version: 1,
          kind: 'path-modified',
          target: index < 2 ? 'service/retry.ts' : 'docs/usage.md',
          operation: 'modified',
          references: [],
          attributes: { basis: 'OBSERVED' },
        },
      ],
      security_effects: [],
    });
    effects.push(effect);
    targets[id] = 'repo';
    const spec = await buildCandidateSpec({
      schema_version: 1,
      base_revision,
      selected_future_revisions: [id],
      selections: [
        { schema_version: 1, future_revision_id: id, target_repo_id: 'repo', kind: 'future' },
      ],
      required_dependencies: [],
      effect_summary_digest: await digestCanonical('material-effect', { effect: effect.digest }),
      creation_reason: 'isolated candidate',
    });
    specs.push(spec);
    candidates.push(
      await materializedCandidate(
        spec.id,
        { repo: (index + 2).toString(16).padStart(40, '0') },
        {
          schema_version: 1,
          repo_commit_oids: { repo: (index + 20).toString(16).padStart(40, '0') },
        },
      ),
    );
  }
  const input = {
    schema_version: 1,
    candidate_specs: specs,
    candidates,
    effects,
    targets,
    evidence: [],
    canonical_ref_oids: { repo: { 'refs/heads/main': '1'.repeat(40) } },
    requirements: {
      schema_version: 1,
      policy_digest,
      checks: [
        {
          schema_version: 1,
          id: 'behavior',
          type: 'behavior',
          config_digest: configuration,
          environment_digest,
          producers: [{ schema_version: 1, identity: 'evaluator', versions: ['1'] }],
        },
      ],
    },
  };
  const receipts = new Set();
  const options = {
    limits: {
      schema_version: 1,
      max_candidates: 2000,
      max_effect_sets: 2000,
      max_evidence: 2000,
      max_decisions: 2000,
      max_slices: 10,
      max_links: 10000,
      hub_min_degree: 100,
    },
    verifyProvenance: async (record) => receipts.has(record.id),
    policyEvaluator: {
      can_reuse: async () => true,
      required_analysis: async (_subject, sets) =>
        sets.map(({ future_revision_id, extractor_id }) => future_revision_id + '/' + extractor_id),
    },
  };
  const addEvidence = async (candidate, status, overrides = {}) => {
    const subject = await candidateEvidenceSubject(candidate);
    const record = await buildEvidence({
      schema_version: 1,
      subject_digest: subject.digest,
      type: 'behavior',
      producer_identity: 'evaluator',
      producer_version: '1',
      config_digest: configuration,
      environment_digest,
      result: { status, basis: 'OBSERVED' },
      payload_ref: 'receipt:' + candidate.id,
      created_at: '2026-10-11T00:00:00Z',
      retention_class: 'DECISION_RECORD',
      ...overrides,
    });
    input.evidence.push(record);
    receipts.add(record.id);
    return record;
  };
  return { input, options, revisions, receipts, addEvidence };
}

test('shared material effects derive one component while unrelated work remains separate', async () => {
  const f = await fixture();
  const result = await new DecisionFormulator(f.options).formulate(f.input);
  assert.equal(result.decisions.length, 2);
  assert.deepEqual(result.decisions.map(({ alternatives }) => alternatives.length).sort(), [1, 2]);
  assert.ok(
    result.decisions.every(
      ({ decision, question, alternatives }) =>
        decision.state === 'REVIEWABLE' && question && alternatives.length,
    ),
  );
  for (const component of result.decisions) await verifyDecisionBasis(component.decision.basis);
  const shared = result.decisions.find(({ alternatives }) => alternatives.length === 2);
  assert.equal(shared.reasons[0].kind, 'POSSIBLE_INTERACTION');
  assert.equal(shared.reasons[0].basis, 'INFERRED');
  assert.ok(
    shared.alternatives.every(({ code_slices }) =>
      code_slices.some(({ target }) => target === 'service/retry.ts'),
    ),
  );
});

test('ordering does not change component identity or the reviewed basis', async () => {
  const f = await fixture();
  const { digest, ...body } = f.input.effects[0];
  assert.ok(digest);
  f.input.effects.push(
    await buildEffectSet({ ...body, extractor_id: 'structure', capability: 'STRUCTURAL' }),
  );
  const formulator = new DecisionFormulator(f.options);
  const first = await formulator.formulate(f.input);
  const reordered = await formulator.formulate({
    ...f.input,
    candidates: [...f.input.candidates].reverse(),
    candidate_specs: [...f.input.candidate_specs].reverse(),
    effects: [...f.input.effects].reverse(),
  });
  assert.deepEqual(reordered, first);
});

test('required partial analysis remains reviewable with explicit uncertainty', async () => {
  const f = await fixture();
  const { digest, ...body } = f.input.effects[0];
  assert.ok(digest);
  f.input.effects[0] = await buildEffectSet({ ...body, status: 'PARTIAL' });
  const result = await new DecisionFormulator(f.options).formulate(f.input);
  const component = result.decisions.find(({ decision }) =>
    Object.values(decision.basis.required_analysis_status).includes('PARTIAL'),
  );
  assert.equal(component.decision.state, 'REVIEWABLE');
  assert.ok(component.uncertainty.some(({ status }) => status === 'PARTIAL'));
});

test('exact-state isolated passes and composed failure expose a bounded behavioral interaction', async () => {
  const f = await fixture();
  f.input.effects = await Promise.all(
    f.input.effects.map(({ digest, ...body }, index) => {
      assert.ok(digest);
      return buildEffectSet({
        ...body,
        effects: body.effects.map((effect) => ({ ...effect, target: 'module-' + index })),
      });
    }),
  );
  const spec = await buildCandidateSpec({
    ...Object.fromEntries(
      Object.entries(f.input.candidate_specs[0]).filter(([key]) => key !== 'id'),
    ),
    selected_future_revisions: f.revisions.slice(0, 2),
    selections: f.input.candidate_specs.slice(0, 2).flatMap(({ selections }) => selections),
    creation_reason: 'composed candidate',
  });
  const composed = await materializedCandidate(
    spec.id,
    { repo: 'f'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { repo: 'e'.repeat(40) } },
  );
  f.input.candidate_specs.push(spec);
  f.input.candidates.push(composed);
  await f.addEvidence(f.input.candidates[0], 'PASSING');
  await f.addEvidence(f.input.candidates[1], 'PASSING');
  await f.addEvidence(composed, 'FAILED');
  const result = await new DecisionFormulator(f.options).formulate(f.input);
  assert.equal(result.decisions.length, 2);
  const component = result.decisions.find(({ reasons }) =>
    reasons.some(({ kind }) => kind === 'COMPOSED_CHECK_FAILURE'),
  );
  assert.equal(component.alternatives.length, 3);
  assert.equal(component.reasons[0].basis, 'OBSERVED');
  assert.equal(component.reasons[0].evidence_digests.length, 3);
  assert.ok(component.question.includes('composition'));
  f.receipts.clear();
  const unverified = await new DecisionFormulator(f.options).formulate(f.input);
  assert.equal(unverified.decisions.length, 4);
  assert.ok(
    unverified.decisions.every(
      ({ reasons }) => !reasons.some(({ kind }) => kind === 'COMPOSED_CHECK_FAILURE'),
    ),
  );
});

test('dense noncritical hubs remain bounded and deferred candidates stay visible', async () => {
  const f = await fixture(1000);
  f.input.effects = await Promise.all(
    f.input.effects.map(({ digest, ...body }) => {
      assert.ok(digest);
      return buildEffectSet({
        ...body,
        effects: body.effects.map((effect) => ({ ...effect, target: 'shared-generated-file' })),
      });
    }),
  );
  f.options.limits.max_decisions = 10;
  const result = await new DecisionFormulator(f.options).formulate(f.input);
  assert.equal(result.decisions.length, 10);
  assert.equal(result.deferred_candidate_digests.length, 990);
  assert.equal(result.metrics.pairwise_expansions, 0);
  assert.equal(result.metrics.links, 0);
  assert.equal(result.suppressed.length, 1);
});

test('security-sensitive shared effects bypass hub suppression', async () => {
  const f = await fixture(4);
  f.options.limits.hub_min_degree = 2;
  f.input.effects = await Promise.all(
    f.input.effects.map(({ digest, ...body }) => {
      assert.ok(digest);
      return buildEffectSet({
        ...body,
        effects: [],
        security_effects: [
          {
            schema_version: 1,
            kind: 'auth-modified',
            target: 'auth/policy',
            operation: 'modified',
            references: [],
            attributes: { basis: 'OBSERVED' },
          },
        ],
      });
    }),
  );
  const result = await new DecisionFormulator(f.options).formulate(f.input);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].alternatives.length, 4);
  assert.equal(result.suppressed.length, 0);
});

test('invalid immutable inputs and exhausted input budgets fail instead of dropping work', async () => {
  const f = await fixture();
  await assert.rejects(
    new DecisionFormulator(f.options).formulate({
      ...f.input,
      candidates: [{ ...f.input.candidates[0], repo_tree_oids: { repo: 'f'.repeat(40) } }],
    }),
    { code: 'INTEGRITY_MISMATCH' },
  );
  f.options.limits.max_candidates = 1;
  await assert.rejects(new DecisionFormulator(f.options).formulate(f.input), {
    code: 'INCOMPLETE_ANALYSIS',
  });
});

test('a partial commit selection cannot stand in for a different whole-Future control', async () => {
  const f = await fixture();
  const whole = f.input.candidate_specs[0];
  const { id, ...body } = whole;
  assert.ok(id);
  const composedSpec = await buildCandidateSpec({
    ...body,
    selected_future_revisions: f.revisions.slice(0, 2),
    selections: f.input.candidate_specs.slice(0, 2).flatMap(({ selections }) => selections),
    creation_reason: 'composed candidate',
  });
  const composed = await materializedCandidate(
    composedSpec.id,
    { repo: 'd'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { repo: 'e'.repeat(40) } },
  );
  const partialSpec = await buildCandidateSpec({
    ...body,
    selections: [{ ...body.selections[0], kind: 'commit', commit_oid: 'f'.repeat(40) }],
  });
  f.input.candidate_specs[0] = partialSpec;
  f.input.candidates[0] = await materializedCandidate(
    partialSpec.id,
    f.input.candidates[0].repo_tree_oids,
    f.input.candidates[0].materialization_record,
  );
  f.input.candidate_specs.push(composedSpec);
  f.input.candidates.push(composed);
  await f.addEvidence(f.input.candidates[0], 'PASSING');
  await f.addEvidence(f.input.candidates[1], 'PASSING');
  await f.addEvidence(composed, 'FAILED');
  const result = await new DecisionFormulator(f.options).formulate(f.input);
  assert.ok(
    result.decisions.every(
      ({ reasons }) => !reasons.some(({ kind }) => kind === 'COMPOSED_CHECK_FAILURE'),
    ),
  );
});

test('mixed immutable baselines require reconciliation before comparing choices', async () => {
  const f = await fixture();
  const { id, ...body } = f.input.candidate_specs[0];
  assert.ok(id);
  const changed = await buildCandidateSpec({
    ...body,
    base_revision: objectId(
      'system-revision',
      await digestCanonical('object-system-revision', { moved: true }),
    ),
  });
  f.input.candidate_specs[0] = changed;
  f.input.candidates[0] = await materializedCandidate(
    changed.id,
    f.input.candidates[0].repo_tree_oids,
    f.input.candidates[0].materialization_record,
  );
  await assert.rejects(new DecisionFormulator(f.options).formulate(f.input), {
    code: 'STALE_BASIS',
  });
});
