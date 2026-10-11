import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCandidateSpec } from '../../core/v1/reduction.mjs';
import { acceptRanking, scheduleOptionalRanking } from '../../core/v1/ranking.mjs';

async function fixture() {
  return Promise.all(
    [1, 2, 3].map((number) =>
      buildCandidateSpec({
        schema_version: 1,
        base_revision: 'klocgit:system-revision:v1:sha256:' + 'a'.repeat(64),
        selected_future_revisions: [
          'klocgit:future-revision:v1:sha256:' + String(number).repeat(64),
        ],
        selections: [
          {
            schema_version: 1,
            kind: 'future',
            future_revision_id: 'klocgit:future-revision:v1:sha256:' + String(number).repeat(64),
          },
        ],
        required_dependencies: [],
        effect_summary_digest: 'sha256:effect-summary:v1:' + 'a'.repeat(64),
        creation_reason: 'Observed approach',
      }),
    ),
  );
}

test('a waiting model cannot hold up the deterministic queue or delete candidates', async () => {
  const specs = await fixture();
  let respond;
  const job = await scheduleOptionalRanking(
    specs,
    { schema_version: 1, observations: [] },
    {
      timeout_ms: 1000,
      ranker: {
        rank: () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      },
    },
  );
  assert.equal(job.initial.status, 'PENDING');
  assert.deepEqual(
    job.initial.priorities,
    specs.map(({ id }) => id),
  );
  respond({ schema_version: 1, priorities: [...job.initial.priorities].reverse() });
  const ranked = await job.completion;
  assert.equal(ranked.basis, 'INFERRED');
  assert.deepEqual(
    acceptRanking(job.initial, ranked).priorities,
    [...job.initial.priorities].reverse(),
  );
  assert.deepEqual(new Set(ranked.priorities), new Set(job.initial.priorities));
});

test('disabled, failed, malformed and timed-out models preserve deterministic progress', async () => {
  const specs = await fixture(),
    summary = { schema_version: 1, observations: [] };
  const providers = [
    [null, 'DISABLED'],
    [
      {
        rank() {
          throw new Error('private provider details');
        },
      },
      'FAILED',
    ],
    [{ rank: () => ({ schema_version: 1, priorities: [specs[0].id] }) }, 'FAILED'],
    [
      { rank: () => ({ schema_version: 1, priorities: [specs[0].id, specs[0].id, specs[0].id] }) },
      'FAILED',
    ],
    [
      { rank: () => ({ schema_version: 1, priorities: [specs[0].id, specs[1].id, 'unknown'] }) },
      'FAILED',
    ],
    [{ rank: () => new Promise(() => {}) }, 'TIMED_OUT'],
  ];
  for (const [ranker, status] of providers) {
    const job = await scheduleOptionalRanking(specs, summary, { ranker, timeout_ms: 10 });
    const result = await job.completion;
    assert.equal(result.status, status);
    assert.equal(result.basis, 'DETERMINISTIC');
    assert.deepEqual(
      result.priorities,
      specs.map(({ id }) => id),
    );
  }
});

test('late ranking cannot change the queue for another Evidence snapshot', async () => {
  const specs = await fixture();
  const first = await scheduleOptionalRanking(
    specs,
    { schema_version: 1, checks: ['pending'] },
    { ranker: null, timeout_ms: 10 },
  );
  const second = await scheduleOptionalRanking(
    specs,
    { schema_version: 1, checks: ['passing'] },
    {
      ranker: {
        rank: () => ({ schema_version: 1, priorities: [...first.initial.priorities].reverse() }),
      },
      timeout_ms: 1000,
    },
  );
  assert.deepEqual(acceptRanking(first.initial, await second.completion), first.initial);
});

test('ranking receives immutable snapshots and substituted plans never reach the provider', async () => {
  const specs = await fixture();
  const summary = { schema_version: 1, checks: [] };
  const started = scheduleOptionalRanking(specs, summary, {
    timeout_ms: 1000,
    ranker: {
      rank(inputs, snapshot) {
        assert.throws(() => snapshot.checks.push('producer claim'), TypeError);
        assert.throws(() => {
          inputs[0].creation_reason = 'substituted';
        }, TypeError);
        return { schema_version: 1, priorities: inputs.map(({ id }) => id) };
      },
    },
  });
  summary.checks.push('late mutation');
  const job = await started;
  assert.equal((await job.completion).status, 'COMPLETE');
  await assert.rejects(
    scheduleOptionalRanking([{ ...specs[0], creation_reason: 'substituted' }], summary, {
      ranker: {
        rank() {
          assert.fail('Invalid plans must not reach the provider');
        },
      },
      timeout_ms: 10,
    }),
    { code: 'INTEGRITY_MISMATCH' },
  );
});
