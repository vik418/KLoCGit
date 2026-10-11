import assert from 'node:assert/strict';
import test from 'node:test';
import { FutureRevision } from '../../core/v1/domain.mjs';
import { buildCandidateSpec, wholeFutureSelection } from '../../core/v1/reduction.mjs';
import { pruneDeterministicDominance } from '../../core/v1/dominance.mjs';

async function fixture(count, distinct = false) {
  const revisions = Array.from({ length: count }, (_, number) =>
    FutureRevision({
      schema_version: 1,
      id: 'klocgit:future-revision:v1:sha256:' + (number + 1).toString(16).padStart(64, '0'),
      system_id: 'system',
      repo_id: 'source-' + number,
      ref: 'refs/heads/main',
      commit_oid: (number + 1).toString(16).padStart(40, '0'),
      tree_oid: distinct ? (number + 1).toString(16).padStart(40, '0') : 'a'.repeat(40),
      parent_oids: [],
      producer: null,
      observed_at: '2026-10-11T00:00:00Z',
    }),
  );
  const bindings = Object.fromEntries(
    revisions.map(({ id }) => [
      id,
      {
        schema_version: 1,
        repo_id: 'target',
        base_commit_oid: 'b'.repeat(40),
        base_tree_oid: 'c'.repeat(40),
      },
    ]),
  );
  const specs = await Promise.all(
    revisions.map((revision) =>
      buildCandidateSpec({
        schema_version: 1,
        base_revision: 'klocgit:system-revision:v1:sha256:' + 'a'.repeat(64),
        selected_future_revisions: [revision.id],
        selections: [wholeFutureSelection(revision, bindings[revision.id])],
        required_dependencies: [],
        effect_summary_digest: 'sha256:material-effect:v1:' + 'a'.repeat(64),
        creation_reason: 'Observed implementation',
      }),
    ),
  );
  specs.sort((left, right) => (left.id < right.id ? -1 : 1));
  const measurements = specs.map((spec, number) => ({
    schema_version: 1,
    candidate_spec_id: spec.id,
    evidence_digest: 'sha256:object-evidence:v1:' + (number + 1).toString(16).padStart(64, '0'),
    dimensions: { bytes: { basis: 'OBSERVED', value: number + 1 } },
  }));
  return {
    specs,
    context: { revisions, bindings },
    options: {
      dimensions: [{ schema_version: 1, name: 'bytes', direction: 'MINIMIZE' }],
      measurements,
      verifyMeasurement: () => true,
      max_comparisons: 100,
    },
  };
}

test('trusted measured dominance applies only inside exact implementation states', async () => {
  const f = await fixture(3);
  const result = await pruneDeterministicDominance(f.specs, f.context, f.options);
  assert.equal(result.candidate_specs.length, 1);
  assert.equal(result.candidate_specs[0].id, f.specs[0].id);
  assert.equal(result.dominated.length, 2);
  assert.ok(
    result.dominated.every(
      ({ preferred_spec_id, evidence_digests }) =>
        preferred_spec_id === f.specs[0].id && evidence_digests.length === 2,
    ),
  );
  const different = await fixture(3, true);
  assert.equal(
    (await pruneDeterministicDominance(different.specs, different.context, different.options))
      .candidate_specs.length,
    3,
  );
});

test('inferred scores, untrusted evidence and missing dimensions cannot delete plans', async () => {
  const f = await fixture(3);
  for (const settings of [
    { ...f.options, verifyMeasurement: () => false },
    {
      ...f.options,
      measurements: f.options.measurements.map((row) => ({
        ...row,
        dimensions: { bytes: { ...row.dimensions.bytes, basis: 'INFERRED' } },
      })),
    },
    {
      ...f.options,
      measurements: f.options.measurements.map((row) => ({ ...row, dimensions: {} })),
    },
  ]) {
    assert.equal(
      (await pruneDeterministicDominance(f.specs, f.context, settings)).candidate_specs.length,
      3,
    );
  }
});

test('tradeoffs and measurement ties retain alternatives', async () => {
  const f = await fixture(3);
  const settings = {
    ...f.options,
    dimensions: [
      ...f.options.dimensions,
      { schema_version: 1, name: 'speed', direction: 'MAXIMIZE' },
    ],
    measurements: f.options.measurements.map((row) => ({
      ...row,
      dimensions: {
        ...row.dimensions,
        speed: { basis: 'OBSERVED', value: row.dimensions.bytes.value },
      },
    })),
  };
  assert.equal(
    (await pruneDeterministicDominance(f.specs, f.context, settings)).candidate_specs.length,
    3,
  );
  settings.measurements = settings.measurements.map((row) => ({
    ...row,
    dimensions: { bytes: { basis: 'OBSERVED', value: 1 }, speed: { basis: 'OBSERVED', value: 1 } },
  }));
  assert.equal(
    (await pruneDeterministicDominance(f.specs, f.context, settings)).candidate_specs.length,
    3,
  );
});

test('comparison budgets preserve unexamined plans in dense equal-state workloads', async () => {
  const f = await fixture(100);
  const settings = {
    ...f.options,
    max_comparisons: 7,
    measurements: f.options.measurements.map((row) => ({
      ...row,
      dimensions: { bytes: { basis: 'OBSERVED', value: 1 } },
    })),
  };
  const result = await pruneDeterministicDominance(f.specs, f.context, settings);
  assert.equal(result.comparisons, 7);
  assert.equal(result.budget_exhausted, true);
  assert.equal(result.candidate_specs.length, 100);
  assert.equal(result.dominated.length, 0);
});

test('selected Git states must match their immutable input observations', async () => {
  const f = await fixture(2);
  const body = { ...f.specs[0] };
  delete body.id;
  const invalid = await buildCandidateSpec({
    ...body,
    selections: [{ ...body.selections[0], tree_oid: 'd'.repeat(40) }],
  });
  await assert.rejects(pruneDeterministicDominance([invalid], f.context, f.options), {
    code: 'INVALID_ARGUMENT',
  });
  const settings = { ...f.options, measurements: [] };
  await assert.rejects(pruneDeterministicDominance([invalid], f.context, settings), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('verified measurements and reduction records are immutable snapshots', async () => {
  const f = await fixture(3);
  const result = await pruneDeterministicDominance(f.specs, f.context, {
    ...f.options,
    verifyMeasurement(measurement) {
      assert.throws(() => {
        measurement.dimensions.bytes.value = 0;
      }, TypeError);
      return true;
    },
  });
  assert.throws(() => result.dominated[0].evidence_digests.push('substitution'), TypeError);
  assert.equal(result.candidate_specs.length, 1);
  const distinct = await fixture(3, true);
  const unexamined = await pruneDeterministicDominance(distinct.specs, distinct.context, {
    ...distinct.options,
    max_comparisons: 0,
  });
  assert.equal(unexamined.budget_exhausted, false);
});
