import assert from 'node:assert/strict';
import test from 'node:test';
import { ForwardPortPipeline, ReviewedDeltaReader } from '../../core/v1/forward-port.mjs';
import { ConservativeIntersection } from '../../core/v1/intersection.mjs';
import { buildEffectSet } from '../../core/v1/extractors.mjs';
import { createConditionalReview, buildDecisionBasis } from '../../core/v1/decisions.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { objectId } from '../../core/v1/conventions.mjs';
import { SystemRevision } from '../../core/v1/domain.mjs';
import { candidateEvidenceSubject, buildEvidence } from '../../core/v1/evidence.mjs';
import { EvidenceScheduler } from '../../core/v1/evidence-scheduling.mjs';
import { compositionFixture } from './support/composition.mjs';

async function fixture(t) {
  const initial = {
    'left.ts': 'export const left = 1;\n',
    'right.ts': 'export const right = 1;\n',
  };
  const f = await compositionFixture(t, initial);
  const future = await f.future('producer', { ...initial, 'left.ts': 'export const left = 2;\n' });
  const spec = await f.spec();
  const candidate = await f.materializer.materialize(spec, f.context);
  const reader = new ReviewedDeltaReader({
    resolveSource: (repo) => f.sources.get(repo),
    materializer: f.materializer,
    max_files: 100,
  });
  const reviewedDelta = await reader.read(f.context.base_revision, candidate);
  const policy_digest = await digestCanonical('policy', { check: 'behavior' });
  const config_digest = await digestCanonical('evaluation-config', { recipe: 'registered' });
  const environment_digest = await digestCanonical('evaluation-environment', { runtime: 'pinned' });
  const requirements = {
    schema_version: 1,
    policy_digest,
    checks: [
      {
        schema_version: 1,
        id: 'behavior',
        type: 'test',
        config_digest,
        environment_digest,
        producers: [{ schema_version: 1, identity: 'trusted', versions: ['1'] }],
      },
    ],
  };
  const basis = await buildDecisionBasis({
    schema_version: 1,
    candidate_digests: [candidate.digest],
    evidence_digests: [],
    material_effect_digest: await digestCanonical('material-effect', { reviewed: true }),
    policy_digest,
    canonical_ref_oids: { canonical: { 'refs/heads/main': f.baseline.commit_oid } },
    required_analysis_status: {},
  });
  const decision = {
    schema_version: 1,
    id: objectId('decision', await digestCanonical('object-decision', { spec: spec.id })),
    state: 'REVIEWABLE',
    basis,
    resolution: null,
  };
  const review = await createConditionalReview(decision, {
    reviewedDeltaDigest: reviewedDelta.digest,
    predicates: [],
    allowLateNonMaterialEvidence: false,
  });
  const nextSnapshot = await f.commit(
    'canonical',
    { ...initial, 'right.ts': 'export const right = 2;\n' },
    f.baseline.commit_oid,
  );
  const { id: ignored, digest: oldDigest, ...baseBody } = f.context.base_revision;
  assert.ok(ignored && oldDigest);
  const nextBody = { ...baseBody, repositories: { canonical: nextSnapshot.commit_oid } };
  const digest = await digestCanonical('object-system-revision', nextBody);
  const nextBase = SystemRevision({ ...nextBody, digest, id: objectId('system-revision', digest) });
  const set = (revision, capability, target, attributes = {}) =>
    buildEffectSet({
      schema_version: 1,
      future_revision_id: revision,
      extractor_id: capability.toLowerCase(),
      extractor_version: '1',
      capability,
      status: 'COMPLETE',
      effects: [
        {
          schema_version: 1,
          kind: 'git-path',
          target,
          operation: 'modified',
          references: [],
          attributes: { basis: 'OBSERVED', ...attributes },
        },
      ],
      security_effects: [],
    });
  const movedId = objectId(
    'future-revision',
    await digestCanonical('object-future-revision', nextSnapshot),
  );
  const input = {
    schema_version: 1,
    decision,
    review,
    candidate,
    candidate_spec: spec,
    previous_context: f.context,
    next_context: { ...f.context, base_revision: nextBase },
    proposed_effects: [
      await set(future.id, 'PATH', 'left.ts'),
      await set(future.id, 'SEMANTIC', 'left.ts'),
    ],
    intervening_effects: [
      await set(movedId, 'PATH', 'right.ts'),
      await set(movedId, 'SEMANTIC', 'right.ts'),
    ],
    targets: { [future.id]: 'canonical', [movedId]: 'canonical' },
    requirements,
  };
  const receipts = new Set(),
    calls = [];
  const evidenceFor = async (target) => {
    const subject = await candidateEvidenceSubject(target);
    const observation = await buildEvidence({
      schema_version: 1,
      subject_digest: subject.digest,
      type: 'test',
      config_digest,
      environment_digest,
      producer_identity: 'trusted',
      producer_version: '1',
      result: { status: 'PASSING', basis: 'OBSERVED' },
      payload_ref: 'check:' + target.id,
      created_at: '2026-10-11T00:00:00Z',
      retention_class: 'DECISION_RECORD',
    });
    receipts.add(observation.id);
    return observation;
  };
  const oldEvidence = await evidenceFor(candidate);
  const policy = {
    required_analysis: (_subject, effects) =>
      effects.map((item) => item.future_revision_id + '/' + item.extractor_id),
    can_reuse: () => true,
  };
  let mutateMaterial = false;
  const options = {
    intersection: new ConservativeIntersection({
      policyEvaluator: policy,
      max_effect_sets: 10,
      max_targets: 100,
    }),
    materializer: f.materializer,
    deltaReader: reader,
    // This registered test extractor compares actual verified Git deltas. The
    // compiler-specific intersection corpus is tested separately.
    analyzeEffects: async (base, target) => {
      const delta = await reader.read(base, target);
      const revision = objectId(
        'future-revision',
        await digestCanonical('object-future-revision', { candidate: target.digest }),
      );
      const effects = [];
      for (const capability of ['PATH', 'SEMANTIC']) {
        effects.push({
          schema_version: 1,
          repo_id: 'canonical',
          effect_set: await buildEffectSet({
            schema_version: 1,
            future_revision_id: revision,
            extractor_id: capability.toLowerCase(),
            extractor_version: '1',
            capability,
            status: 'COMPLETE',
            effects: delta.changes.map((change) => ({
              schema_version: 1,
              kind: 'registered-delta',
              target: change.path,
              operation: 'modified',
              references: [],
              attributes: {
                basis: 'OBSERVED',
                before: change.before,
                after: change.after,
                context: mutateMaterial && target.digest !== candidate.digest ? 'changed' : 'same',
              },
            })),
            security_effects: [],
          }),
        });
      }
      return {
        schema_version: 1,
        base_revision_digest: base.digest,
        candidate_digest: target.digest,
        effects,
      };
    },
    scheduler: new EvidenceScheduler({
      provider: {
        find_reusable: async () => [oldEvidence],
        evaluate: async (target) => {
          calls.push(target.digest);
          return [await evidenceFor(target)];
        },
      },
      verifyProvenance: (record) => receipts.has(record.id),
      policyEvaluator: policy,
      limits: { schema_version: 1, max_checks: 10, max_records: 10, max_evaluations: 10 },
    }),
    policyEvaluator: policy,
  };
  return {
    ...f,
    input,
    options,
    reader,
    calls,
    oldEvidence,
    mutateMaterial: () => {
      mutateMaterial = true;
    },
  };
}

test('disjoint base movement rematerializes Git and preserves only the exact reviewed delta', async (t) => {
  const f = await fixture(t);
  const sources = await f.sourceState();
  const result = await new ForwardPortPipeline(f.options).forward(f.input);
  assert.equal(result.state, 'REVIEW_PRESERVED');
  assert.notEqual(result.candidate.digest, f.input.candidate.digest);
  assert.notEqual(result.candidate_spec.id, f.input.candidate_spec.id);
  assert.equal(result.candidate_spec.base_revision, f.input.next_context.base_revision.id);
  assert.equal(result.reviewed_delta.digest, f.input.review.reviewed_delta_digest);
  const workspace = await f.materializer.open(result.candidate, 'canonical');
  assert.equal(
    new TextDecoder().decode((await workspace.readFile('left.ts')).bytes),
    'export const left = 2;\n',
  );
  assert.equal(
    new TextDecoder().decode((await workspace.readFile('right.ts')).bytes),
    'export const right = 2;\n',
  );
  assert.deepEqual(await f.sourceState(), sources);
  assert.deepEqual(f.calls, [result.candidate.digest]);
  assert.ok(!result.evaluation.evidence.some(({ id }) => id === f.oldEvidence.id));
  assert.equal(result.decision.state, 'REVIEWABLE');
  assert.notEqual(result.decision.basis.digest, f.input.decision.basis.digest);
});

test('possible interactions and required incomplete analysis stale before materialization', async (t) => {
  const f = await fixture(t);
  const { digest, ...effect } = f.input.intervening_effects[1];
  assert.ok(digest);
  f.input.intervening_effects[1] = await buildEffectSet({ ...effect, status: 'PARTIAL' });
  const result = await new ForwardPortPipeline(f.options).forward(f.input);
  assert.equal(result.state, 'STALE');
  assert.equal(result.reason, 'POSSIBLE_INTERACTION');
  assert.equal(result.decision.state, 'STALE');
  assert.deepEqual(f.calls, []);
});

test('changed material observations invalidate review even when Git delta survives', async (t) => {
  const f = await fixture(t);
  f.mutateMaterial();
  const result = await new ForwardPortPipeline(f.options).forward(f.input);
  assert.equal(result.state, 'STALE');
  assert.equal(result.reason, 'MATERIAL_EFFECTS_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('changed reviewed delta forces another review even after a disjoint hint', async (t) => {
  const f = await fixture(t);
  const originalRead = f.reader.read.bind(f.reader);
  f.options.deltaReader = {
    read: async (...args) => {
      const delta = await originalRead(...args);
      if (args[0].id === f.input.next_context.base_revision.id)
        return { ...delta, digest: await digestCanonical('reviewed-delta', { changed: true }) };
      return delta;
    },
  };
  const result = await new ForwardPortPipeline(f.options).forward(f.input);
  assert.equal(result.state, 'STALE');
  assert.equal(result.reason, 'REVIEWED_DELTA_CHANGED');
  assert.deepEqual(f.calls, []);
});

test('grouped choices, changed policy and unresolved review predicates require renewed review', async (t) => {
  const f = await fixture(t);
  const { digest, ...basisBody } = f.input.decision.basis;
  assert.ok(digest);
  const groupedBasis = await buildDecisionBasis({
    ...basisBody,
    candidate_digests: [
      ...basisBody.candidate_digests,
      await digestCanonical('object-candidate', { alternative: true }),
    ],
  });
  const originalDecision = f.input.decision,
    originalReview = f.input.review;
  f.input.decision = { ...originalDecision, basis: groupedBasis };
  f.input.review = { ...originalReview, basis: groupedBasis };
  assert.equal(
    (await new ForwardPortPipeline(f.options).forward(f.input)).reason,
    'GROUP_REQUIRES_REDISCOVERY',
  );
  f.input.decision = originalDecision;
  f.input.review = originalReview;
  f.input.requirements = {
    ...f.input.requirements,
    policy_digest: await digestCanonical('policy', { changed: true }),
  };
  assert.equal(
    (await new ForwardPortPipeline(f.options).forward(f.input)).reason,
    'POLICY_CHANGED',
  );
  f.input.requirements = {
    ...f.input.requirements,
    policy_digest: f.input.decision.basis.policy_digest,
  };
  f.input.review = { ...f.input.review, predicates: ['contract-remains-valid'] };
  assert.equal(
    (await new ForwardPortPipeline(f.options).forward(f.input)).reason,
    'PREDICATE_CHANGED',
  );
});

test('reviewed candidate/base substitution is rejected before preserving review', async (t) => {
  const f = await fixture(t);
  const { digest, ...body } = f.input.decision.basis;
  assert.ok(digest);
  const basis = await buildDecisionBasis({
    ...body,
    canonical_ref_oids: {
      canonical: { 'refs/heads/main': f.input.next_context.base_revision.repositories.canonical },
    },
  });
  f.input.decision = { ...f.input.decision, basis };
  f.input.review = { ...f.input.review, basis };
  await assert.rejects(new ForwardPortPipeline(f.options).forward(f.input), {
    code: 'STALE_BASIS',
  });
});
