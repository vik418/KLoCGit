import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpRanker } from '../../adapters/ranking/http.mjs';
import { buildCandidateSpec } from '../../core/v1/reduction.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { scheduleOptionalRanking } from '../../core/v1/ranking.mjs';
import { createRanker } from '../../scripts/configured-ranker.mjs';

async function spec() {
  return buildCandidateSpec({
    schema_version: 1,
    base_revision: 'klocgit:system-revision:v1:sha256:' + 'a'.repeat(64),
    selected_future_revisions: [],
    selections: [],
    required_dependencies: [],
    effect_summary_digest: await digestCanonical('effect-summary', []),
    creation_reason: 'Ranking transport fixture',
  });
}

const config = {
  base_url: 'https://ranking.example.test',
  path: '/rank',
  timeout_ms: 1000,
  max_bytes: 16384,
  credential: async () => 'private-ranking-credential',
};

test('ranking transport sends verified inputs with credentials outside its payload', async () => {
  const candidate = await spec();
  const ranker = new HttpRanker({
    ...config,
    fetch: async (url, options) => {
      assert.equal(url, 'https://ranking.example.test/rank');
      assert.equal(options.headers.authorization, 'Bearer private-ranking-credential');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.schema_version, 1);
      assert.deepEqual(body.candidate_specs, [candidate]);
      assert.deepEqual(body.evidence_summary, { schema_version: 1, observations: [] });
      assert.ok(!options.body.includes('private-ranking-credential'));
      return Response.json({ schema_version: 1, priorities: [candidate.id] });
    },
  });
  const job = await scheduleOptionalRanking(
    [candidate],
    { schema_version: 1, observations: [] },
    { ranker, timeout_ms: 1000 },
  );
  assert.equal(job.initial.status, 'PENDING');
  assert.equal((await job.completion).status, 'COMPLETE');
});

test('caller cancellation and bounded replies cannot delay deterministic progress', async () => {
  const candidate = await spec();
  let aborted = false;
  const ranker = new HttpRanker({
    ...config,
    fetch: async (_url, { signal }) => {
      await new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      throw new Error('private provider exception');
    },
  });
  const job = await scheduleOptionalRanking(
    [candidate],
    { schema_version: 1 },
    { ranker, timeout_ms: 10 },
  );
  assert.deepEqual(job.initial.priorities, [candidate.id]);
  assert.equal((await job.completion).status, 'TIMED_OUT');
  assert.equal(aborted, true);

  const oversized = new HttpRanker({
    ...config,
    fetch: async () => new Response('x'.repeat(config.max_bytes + 1)),
  });
  await assert.rejects(oversized.rank([candidate], { schema_version: 1 }), {
    code: 'PROVIDER_UNAVAILABLE',
  });
});

test('invalid specs and unsafe endpoints never dispatch a ranking request', async () => {
  let dispatched = false;
  const ranker = new HttpRanker({
    ...config,
    fetch: () => {
      dispatched = true;
    },
  });
  const candidate = await spec();
  await assert.rejects(
    ranker.rank([{ ...candidate, creation_reason: 'substitution' }], { schema_version: 1 }),
  );
  assert.equal(dispatched, false);
  for (const base_url of [
    'http://ranking.example.test',
    'https://user:secret@ranking.example.test',
    'https://ranking.example.test/?credential=secret',
  ])
    assert.throws(() => new HttpRanker({ ...config, base_url }), { code: 'INVALID_ARGUMENT' });
  for (const path of ['//foreign.example.test/rank', 'rank'])
    assert.throws(() => new HttpRanker({ ...config, path }), { code: 'INVALID_ARGUMENT' });
});

test('operator configuration captures the endpoint and credential without exposing invalid values', () => {
  const env = {
    KLOCGIT_RANKER_URL: 'https://ranking.example.test/rank',
    KLOCGIT_RANKER_TOKEN: 'private-ranking-credential',
    KLOCGIT_RANKER_TIMEOUT_MS: '1000',
    KLOCGIT_RANKER_MAX_BYTES: '16384',
  };
  const ranker = createRanker(env);
  assert.equal(ranker.path, '/rank');
  env.KLOCGIT_RANKER_TOKEN = 'changed-after-startup';
  assert.equal(ranker.http.credential(), 'private-ranking-credential');
  for (const [setting, value] of [
    ['KLOCGIT_RANKER_URL', 'private-invalid-url'],
    ['KLOCGIT_RANKER_URL', 'https://user:private-password@ranking.example.test'],
    ['KLOCGIT_RANKER_URL', 'https://ranking.example.test?token=private-query'],
    ['KLOCGIT_RANKER_URL', 'http://ranking.example.test'],
    ['KLOCGIT_RANKER_TOKEN', 'private-token\n'],
    ['KLOCGIT_RANKER_TOKEN', ''],
    ['KLOCGIT_RANKER_TIMEOUT_MS', 'private-invalid-timeout'],
    ['KLOCGIT_RANKER_MAX_BYTES', '0'],
  ]) {
    assert.throws(
      () => createRanker({ ...env, [setting]: value }),
      (error) =>
        error instanceof TypeError &&
        error.message.startsWith(setting) &&
        !error.message.includes('private-'),
    );
  }
});
