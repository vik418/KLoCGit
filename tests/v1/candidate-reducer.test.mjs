import assert from 'node:assert/strict';
import test from 'node:test';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { buildEffectSet } from '../../core/v1/extractors.mjs';
import { CandidateReducer } from '../../core/v1/candidate-reducer.mjs';
import { verifyCandidateSpec } from '../../core/v1/reduction.mjs';

async function fixture(count, { duplicate = false, security = [] } = {}) {
  const revisions = Array.from({ length: count }, (_, index) =>
    FutureRevision({
      schema_version: 1,
      id: 'klocgit:future-revision:v1:sha256:' + (index + 1).toString(16).padStart(64, '0'),
      system_id: 'product',
      repo_id: 'producer-' + index,
      ref: 'refs/heads/main',
      commit_oid: (index + 1).toString(16).padStart(40, '0'),
      tree_oid: duplicate ? 'f'.repeat(40) : (index + 1).toString(16).padStart(40, '0'),
      parent_oids: [],
      producer: null,
      observed_at: '2026-10-11T00:00:00Z',
    }),
  );
  const effect = {
    schema_version: 1,
    kind: 'path',
    target: 'shared.txt',
    operation: 'update',
    attributes: { basis: 'OBSERVED' },
    references: [],
  };
  const effects = await Promise.all(
    revisions.map((revision, index) =>
      buildEffectSet({
        schema_version: 1,
        future_revision_id: revision.id,
        extractor_id: 'git-path',
        extractor_version: '1',
        capability: 'PATH',
        status: 'COMPLETE',
        effects: [effect],
        security_effects: security.includes(index) ? [{ ...effect, kind: 'security-path' }] : [],
      }),
    ),
  );
  return {
    revisions,
    effects,
    policy: {
      schema_version: 1,
      base_revision: 'klocgit:system-revision:v1:sha256:' + 'a'.repeat(64),
      bindings: Object.fromEntries(
        revisions.map(({ id }) => [
          id,
          {
            schema_version: 1,
            repo_id: 'canonical',
            base_commit_oid: 'a'.repeat(40),
            base_tree_oid: 'b'.repeat(40),
          },
        ]),
      ),
      dependencies: [],
      supersession: [],
      rejections: [],
      completed_revision_ids: [],
      hub_min_degree: 8,
    },
    budget: {
      schema_version: 1,
      max_candidate_specs: 8,
      max_selections_per_spec: 16,
      max_dependency_visits: 64,
    },
    reducer: new CandidateReducer({ verifyRejection: () => true }),
  };
}

test('dense distinct work has bounded plans and an explicit, lossless deferred frontier', async () => {
  const f = await fixture(1000);
  const result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.candidate_specs.length, 8);
  assert.equal(result.implementation_frontier.length, 1000);
  assert.equal(result.metrics.deferred_implementations, 992);
  assert.equal(result.effect_index.metrics.pairwise_expansions, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(
    new Set(
      result.implementation_frontier.flatMap(({ future_revision_ids }) => future_revision_ids),
    ),
    new Set(f.revisions.map(({ id }) => id)),
  );
  for (const spec of result.candidate_specs)
    assert.deepEqual(await verifyCandidateSpec(spec), spec);
  assert.deepEqual(
    await f.reducer.reduce(
      [...f.revisions].reverse(),
      [...f.effects].reverse(),
      f.policy,
      f.budget,
    ),
    result,
  );
});

test('exact duplicates reuse one plan without losing distinct provenance histories', async () => {
  const f = await fixture(30, { duplicate: true });
  const result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.candidate_specs.length, 1);
  assert.equal(result.candidate_specs[0].selections.length, 1);
  assert.equal(result.candidate_specs[0].selected_future_revisions.length, 30);
  assert.equal(result.complete, true);
});

test('security effects bypass hub suppression and scheduling rotates repository targets', async () => {
  const f = await fixture(20, { security: [19] });
  f.policy.bindings[f.revisions[18].id].repo_id = 'other';
  f.budget.max_candidate_specs = 3;
  const result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.candidate_specs[0].selected_future_revisions[0], f.revisions[19].id);
  assert.equal(result.effect_index.interactions[0].security_sensitive, true);
  assert.ok(
    result.candidate_specs.some((spec) =>
      spec.selections.some(({ target_repo_id }) => target_repo_id === 'other'),
    ),
  );
});

test('dependency closure is ordered, bounded and never silently substitutes stale inputs', async () => {
  const f = await fixture(4);
  const edge = (from, to) => ({
    schema_version: 1,
    from_revision: f.revisions[from].id,
    to_revision: f.revisions[to].id,
  });
  f.policy.dependencies = [edge(0, 1), edge(1, 2)];
  let result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.deepEqual(
    result.candidate_specs[0].selections.map(({ future_revision_id }) => future_revision_id),
    [f.revisions[2].id, f.revisions[1].id, f.revisions[0].id],
  );
  assert.deepEqual(result.candidate_specs[0].required_dependencies, [
    f.revisions[1].id,
    f.revisions[2].id,
  ]);
  f.budget.max_selections_per_spec = 1;
  result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.implementation_frontier[0].reason, 'SELECTION_BUDGET');
  assert.ok(result.candidate_specs.every(({ selections }) => selections.length <= 1));
  f.policy.dependencies = [edge(0, 1), edge(1, 0)];
  f.budget.max_selections_per_spec = 16;
  result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.implementation_frontier[0].reason, 'DEPENDENCY_CYCLE');
  f.policy.dependencies = [
    { ...edge(0, 1), to_revision: 'klocgit:future-revision:v1:sha256:' + 'f'.repeat(64) },
  ];
  result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.implementation_frontier[0].reason, 'MISSING_DEPENDENCY');
});

test('only verified deterministic checkable failures reject work', async () => {
  const f = await fixture(4);
  const rejection = {
    schema_version: 1,
    future_revision_id: f.revisions[0].id,
    kind: 'checkable',
    basis: 'DETERMINISTIC',
    check_ref: 'required-build',
    evidence_digest: 'sha256:object-evidence:v1:' + 'a'.repeat(64),
  };
  for (const claim of [
    { ...rejection, basis: 'INFERRED' },
    { ...rejection, kind: 'advisory' },
  ]) {
    const result = await f.reducer.reduce(
      f.revisions,
      f.effects,
      { ...f.policy, rejections: [claim] },
      f.budget,
    );
    assert.equal(result.rejected.length, 0);
    assert.equal(result.unverified_rejections.length, 1);
  }
  const untrusted = new CandidateReducer({ verifyRejection: () => false });
  assert.equal(
    (
      await untrusted.reduce(
        f.revisions,
        f.effects,
        { ...f.policy, rejections: [rejection] },
        f.budget,
      )
    ).rejected.length,
    0,
  );
  f.policy.rejections = [rejection];
  f.policy.dependencies = [
    { schema_version: 1, from_revision: f.revisions[1].id, to_revision: f.revisions[0].id },
  ];
  const result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.implementation_frontier[0].reason, 'REJECTED_DEPENDENCY');
  f.policy.rejections.push({ ...rejection, check_ref: 'required-security-scan' });
  assert.equal(
    (await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget)).rejected.length,
    2,
  );
});

test('dependencies on replaced revisions remain stale instead of following the replacement', async () => {
  const f = await fixture(3);
  f.revisions[2] = FutureRevision({ ...f.revisions[2], repo_id: f.revisions[1].repo_id });
  f.policy.supersession = [
    { schema_version: 1, from_revision: f.revisions[1].id, to_revision: f.revisions[2].id },
  ];
  f.policy.dependencies = [
    { schema_version: 1, from_revision: f.revisions[0].id, to_revision: f.revisions[1].id },
  ];
  const result = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(result.implementation_frontier[0].reason, 'STALE_DEPENDENCY');
  assert.equal(result.superseded.length, 1);
  assert.ok(
    result.candidate_specs.every(
      (spec) => !spec.selected_future_revisions.includes(f.revisions[0].id),
    ),
  );
});

test('global traversal limits retain work and later batches can progress', async () => {
  const f = await fixture(12);
  f.budget.max_dependency_visits = 2;
  const first = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(first.metrics.dependency_visits, 2);
  assert.equal(first.candidate_specs.length, 2);
  assert.equal(first.implementation_frontier[2].reason, 'DEPENDENCY_BUDGET');
  f.policy.completed_revision_ids = first.candidate_specs.flatMap(
    ({ selected_future_revisions }) => selected_future_revisions,
  );
  const next = await f.reducer.reduce(f.revisions, f.effects, f.policy, f.budget);
  assert.equal(next.candidate_specs.length, 2);
  assert.ok(
    next.candidate_specs.every((spec) =>
      spec.selected_future_revisions.every((id) => !f.policy.completed_revision_ids.includes(id)),
    ),
  );
  const missing = await f.reducer.reduce(f.revisions, [], f.policy, f.budget);
  assert.deepEqual(
    missing.incomplete_revision_ids,
    f.revisions.map(({ id }) => id),
  );
});
