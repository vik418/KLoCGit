/** Analyze recorded human sessions. This report never authorizes a release or Git write. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { copyJsonData } from '../core/v1/domain.mjs';
import { digestCanonical } from '../core/v1/encoding.mjs';
import { parseDigest } from '../core/v1/conventions.mjs';

export const REVIEW_WORKFLOWS = Object.freeze(['PR', 'PR_AI_REVIEW', 'KLOCGIT']);

function valid(condition, message) {
  if (!condition) throw new TypeError(message);
}

function text(value) {
  return (
    typeof value === 'string' &&
    value.trim() &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function unique(values) {
  return Array.isArray(values) && values.every(text) && new Set(values).size === values.length;
}

function instant(value) {
  valid(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'Session timestamps must be UTC ISO instants.',
  );
  return Date.parse(value);
}

function plan(input) {
  const value = copyJsonData(input);
  valid(
    value.schema_version === 1 &&
      text(value.study_id) &&
      Array.isArray(value.cases) &&
      value.cases.length === REVIEW_WORKFLOWS.length,
    'Register three distinct workloads before collecting sessions.',
  );
  valid(unique(value.cases.map((entry) => entry.case_id)), 'Case IDs must be unique.');
  for (const entry of value.cases) {
    parseDigest(entry.workload_digest, 'attention-workload');
    valid(unique(entry.seeded_defect_ids), 'Register independent defect labels.');
    entry.seeded_defect_ids.sort();
  }
  return value;
}

function permutations(values) {
  if (!values.length) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, position) => position !== index)).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

/** All six workflow orders balance condition and workload over a complete cohort. */
export function assignReviewSessions(input, participant_index) {
  const study = plan(input);
  valid(
    Number.isSafeInteger(participant_index) && participant_index >= 0,
    'Participant index must be a nonnegative integer.',
  );
  const orders = permutations(REVIEW_WORKFLOWS);
  const order = orders[participant_index % orders.length];
  return study.cases.map((entry, index) => ({
    schema_version: 1,
    study_id: study.study_id,
    case_id: entry.case_id,
    workload_digest: entry.workload_digest,
    workflow: order[index],
  }));
}

function inspectedLines(slices) {
  valid(Array.isArray(slices) && slices.length <= 10000, 'Code observations exceed study budget.');
  const files = new Map();
  for (const slice of slices) {
    valid(
      slice.schema_version === 1 &&
        text(slice.path) &&
        Number.isSafeInteger(slice.first_line) &&
        slice.first_line >= 1 &&
        Number.isSafeInteger(slice.last_line) &&
        slice.last_line >= slice.first_line,
      'Invalid code observation.',
    );
    parseDigest(slice.revision_digest, 'attention-source');
    const key = JSON.stringify([slice.revision_digest, slice.path]);
    if (!files.has(key)) files.set(key, []);
    files.get(key).push([slice.first_line, slice.last_line]);
  }
  let count = 0;
  for (const ranges of files.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [first, last] of ranges) {
      count += Math.max(0, last - Math.max(first, end + 1) + 1);
      end = Math.max(end, last);
    }
  }
  valid(Number.isSafeInteger(count), 'Code measurement overflow.');
  return count;
}

/** Inputs come from a facilitator or instrumented UI, never an automated reviewer. */
export async function analyzeHumanAttention(designInput, sessionsInput) {
  const design = plan(designInput);
  const sessions = copyJsonData(sessionsInput);
  valid(Array.isArray(sessions) && sessions.length <= 10000, 'Sessions exceed study budget.');
  const cases = new Map(design.cases.map((entry) => [entry.case_id, entry]));
  const participants = new Map(),
    used = new Set(),
    rows = [];
  for (const session of sessions) {
    valid(
      session.schema_version === 1 &&
        session.study_id === design.study_id &&
        session.participant_kind === 'HUMAN' &&
        text(session.participant_id) &&
        text(session.collector_id) &&
        ['OBSERVED', 'DECLARED'].includes(session.measurement_basis) &&
        ['instrumented', 'facilitator-recorded'].includes(session.collection_method) &&
        REVIEW_WORKFLOWS.includes(session.workflow),
      'Invalid human-session identity or source.',
    );
    const workload = cases.get(session.case_id);
    valid(
      workload && workload.workload_digest === session.workload_digest,
      'A session must use its registered immutable workload.',
    );
    parseDigest(session.accepted_state_digest, 'attention-accepted-state');
    const elapsed_ms = instant(session.accepted_at) - instant(session.started_at);
    valid(elapsed_ms >= 0, 'Acceptance cannot precede review.');
    for (const field of [
      'paused_ms',
      'context_switches',
      'decisions',
      'questions',
      'integration_rework_ms',
    ])
      valid(
        Number.isSafeInteger(session[field]) && session[field] >= 0,
        'Invalid session measurement.',
      );
    valid(
      session.paused_ms <= elapsed_ms && session.integration_rework_ms <= elapsed_ms,
      'Session duration cannot be exceeded by measured intervals.',
    );
    valid(unique(session.found_defect_ids), 'Finding IDs must be unique.');
    session.found_defect_ids.sort();
    const key = JSON.stringify([session.participant_id, session.case_id]);
    valid(!used.has(key), 'A participant cannot repeat the same workload.');
    used.add(key);
    if (!participants.has(session.participant_id))
      participants.set(session.participant_id, new Set());
    const workflows = participants.get(session.participant_id);
    valid(!workflows.has(session.workflow), 'A participant cannot repeat a workflow.');
    workflows.add(session.workflow);
    const found = new Set(session.found_defect_ids);
    rows.push({
      schema_version: 1,
      session_digest: await digestCanonical('attention-session', session),
      participant_id: session.participant_id,
      case_id: session.case_id,
      workflow: session.workflow,
      measurement_basis: session.measurement_basis,
      collection_method: session.collection_method,
      reviewer_minutes: (elapsed_ms - session.paused_ms) / 60000,
      code_lines: inspectedLines(session.code_inspected),
      context_switches: session.context_switches,
      decisions: session.decisions,
      questions: session.questions,
      integration_rework_minutes: session.integration_rework_ms / 60000,
      missed_seeded_defects: workload.seeded_defect_ids.filter((id) => !found.has(id)).length,
      unseeded_findings: session.found_defect_ids.filter(
        (id) => !workload.seeded_defect_ids.includes(id),
      ),
      time_to_accepted_minutes: elapsed_ms / 60000,
    });
  }
  const complete =
    participants.size > 0 &&
    [...participants.values()].every((workflows) => workflows.size === REVIEW_WORKFLOWS.length) &&
    rows.every((row) => row.measurement_basis === 'OBSERVED');
  const metrics = [
    'reviewer_minutes',
    'code_lines',
    'context_switches',
    'decisions',
    'questions',
    'integration_rework_minutes',
    'missed_seeded_defects',
    'time_to_accepted_minutes',
  ];
  return {
    schema_version: 1,
    design_digest: await digestCanonical('attention-design', design),
    status: complete ? 'OBSERVATIONS_COMPLETE' : 'INCOMPLETE',
    participant_count: participants.size,
    workflows: Object.fromEntries(
      REVIEW_WORKFLOWS.map((workflow) => {
        const observed = rows.filter(
          (row) => row.workflow === workflow && row.measurement_basis === 'OBSERVED',
        );
        return [
          workflow,
          {
            schema_version: 1,
            sessions: observed.length,
            mean: observed.length
              ? Object.fromEntries(
                  metrics.map((metric) => [
                    metric,
                    observed.reduce((sum, row) => sum + row[metric], 0) / observed.length,
                  ]),
                )
              : null,
          },
        ];
      }),
    ),
    rows,
    scope:
      'Recorded session measurements and seeded defects only. Unseeded findings are unclassified. Human presence and causal benefit require independent study review.',
    release_gate: 'REQUIRES_REVIEW',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [designPath, sessionsPath] = process.argv.slice(2);
  if (!designPath || !sessionsPath)
    throw new TypeError('Provide study design and session JSON files.');
  const report = await analyzeHumanAttention(
    JSON.parse(await readFile(designPath, 'utf8')),
    JSON.parse(await readFile(sessionsPath, 'utf8')),
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'OBSERVATIONS_COMPLETE') process.exitCode = 2;
}
