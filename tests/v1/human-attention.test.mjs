import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeHumanAttention,
  assignReviewSessions,
  REVIEW_WORKFLOWS,
} from '../../benchmarks/human-attention.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';

async function fixture() {
  const cases = await Promise.all(
    ['a', 'b', 'c'].map(async (case_id) => ({
      case_id,
      workload_digest: await digestCanonical('attention-workload', { case_id }),
      seeded_defect_ids: ['interaction', 'policy'],
    })),
  );
  const design = { schema_version: 1, study_id: 'test-study', cases };
  const sessions = await Promise.all(
    assignReviewSessions(design, 0).map(async (assigned) => ({
      ...assigned,
      participant_kind: 'HUMAN',
      participant_id: 'test-participant',
      collector_id: 'test-collector',
      measurement_basis: 'OBSERVED',
      collection_method: 'instrumented',
      started_at: '2026-10-01T12:00:00.000Z',
      accepted_at: '2026-10-01T12:10:00.000Z',
      paused_ms: 60000,
      context_switches: 4,
      decisions: 2,
      questions: 1,
      integration_rework_ms: 120000,
      code_inspected: [
        {
          schema_version: 1,
          path: 'module',
          revision_digest: await digestCanonical('attention-source', { state: 'original' }),
          first_line: 1,
          last_line: 10,
        },
      ],
      found_defect_ids: ['interaction', 'unclassified'],
      accepted_state_digest: await digestCanonical('attention-accepted-state', {
        case: assigned.case_id,
      }),
    })),
  );
  return { design, sessions };
}

test('all six assignments balance workflow, workload and order without repeat exposure', async () => {
  const { design } = await fixture();
  const assignments = Array.from({ length: 6 }, (_, index) => assignReviewSessions(design, index));
  for (const assignment of assignments) {
    assert.equal(new Set(assignment.map((row) => row.case_id)).size, design.cases.length);
    assert.deepEqual(assignment.map((row) => row.workflow).sort(), [...REVIEW_WORKFLOWS].sort());
  }
  for (const workload of design.cases)
    for (const workflow of REVIEW_WORKFLOWS)
      assert.equal(
        assignments
          .flat()
          .filter((row) => row.case_id === workload.case_id && row.workflow === workflow).length,
        2,
      );
});

test('study measurements preserve observed duration, missed defects and unclassified findings', async () => {
  const { design, sessions } = await fixture();
  const report = await analyzeHumanAttention(design, sessions);
  assert.equal(report.status, 'OBSERVATIONS_COMPLETE');
  assert.equal(report.release_gate, 'REQUIRES_REVIEW');
  for (const workflow of Object.values(report.workflows)) {
    assert.equal(workflow.mean.reviewer_minutes, 9);
    assert.equal(workflow.mean.time_to_accepted_minutes, 10);
    assert.equal(workflow.mean.missed_seeded_defects, 1);
    assert.equal(workflow.mean.integration_rework_minutes, 2);
  }
  assert.deepEqual(report.rows[0].unseeded_findings, ['unclassified']);
});

test('overlapping code observations count unique lines per immutable source', async () => {
  const { design, sessions } = await fixture();
  const original = sessions[0].code_inspected[0];
  sessions[0].code_inspected.push(
    { ...original, first_line: 5, last_line: 15 },
    {
      ...original,
      revision_digest: await digestCanonical('attention-source', { state: 'changed' }),
    },
  );
  const report = await analyzeHumanAttention(design, sessions);
  assert.equal(report.rows[0].code_lines, 25);
});

test('set ordering does not change study or session identity', async () => {
  const { design, sessions } = await fixture();
  const first = await analyzeHumanAttention(design, sessions);
  for (const workload of design.cases) workload.seeded_defect_ids.reverse();
  for (const session of sessions) session.found_defect_ids.reverse();
  const reordered = await analyzeHumanAttention(design, sessions);
  assert.equal(reordered.design_digest, first.design_digest);
  assert.deepEqual(
    reordered.rows.map((row) => row.session_digest),
    first.rows.map((row) => row.session_digest),
  );
});

test('missing or declared sessions do not claim a completed observed comparison', async () => {
  const { design, sessions } = await fixture();
  assert.equal((await analyzeHumanAttention(design, [])).status, 'INCOMPLETE');
  assert.equal((await analyzeHumanAttention(design, sessions.slice(1))).status, 'INCOMPLETE');
  sessions[0].measurement_basis = 'DECLARED';
  const report = await analyzeHumanAttention(design, sessions);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.workflows[sessions[0].workflow].sessions, 0);
  assert.equal(report.workflows[sessions[0].workflow].mean, null);
});

test('substituted workloads, repeated exposure and impossible timings are rejected', async () => {
  const { design, sessions } = await fixture();
  for (const change of [
    { workload_digest: await digestCanonical('attention-workload', { changed: true }) },
    { participant_kind: 'AGENT' },
    { accepted_at: '2026-09-01T12:00:00.000Z' },
    { paused_ms: 600001 },
    { integration_rework_ms: 600001 },
    { context_switches: -1 },
    { found_defect_ids: ['interaction', 'interaction'] },
  ])
    await assert.rejects(analyzeHumanAttention(design, [{ ...sessions[0], ...change }]));
  await assert.rejects(analyzeHumanAttention(design, [...sessions, sessions[0]]));
  await assert.rejects(
    analyzeHumanAttention(design, [
      sessions[0],
      { ...sessions[1], workflow: sessions[0].workflow },
    ]),
  );
});
