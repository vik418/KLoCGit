import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createRanker } from '../../benchmarks/support/model-ranker.mjs';

test('local ranking receives bounded data without host credentials or shell execution', async () => {
  let request;
  const ranker = await createRanker({
    python: '/runtime/python',
    directory: '/models/review',
    run: (binary, argv, options, done) => {
      assert.equal(binary, '/runtime/python');
      assert.equal(argv.length, 2);
      assert.equal(argv[1], '/models/review');
      assert.equal(options.shell, undefined);
      assert.deepEqual(Object.keys(options.env).sort(), [
        'OMP_NUM_THREADS',
        'OPENBLAS_NUM_THREADS',
        'PATH',
        'TOKENIZERS_PARALLELISM',
      ]);
      const stdin = new PassThrough();
      const chunks = [];
      stdin.on('data', (bytes) => chunks.push(bytes));
      stdin.on('finish', () => {
        request = JSON.parse(Buffer.concat(chunks).toString());
        done(null, JSON.stringify({ schema_version: 1, priorities: ['candidate'] }));
      });
      return { stdin };
    },
  });
  assert.equal(ranker.metadata.basis, 'INFERRED');
  const result = await ranker.rank([{ id: 'candidate' }], { schema_version: 1 });
  assert.deepEqual(result, { schema_version: 1, priorities: ['candidate'] });
  assert.deepEqual(request, {
    schema_version: 1,
    candidate_specs: [{ id: 'candidate' }],
    evidence_summary: { schema_version: 1 },
  });
});

test('model startup errors and private diagnostics remain provider failures', async () => {
  for (const [error, output] of [
    [new Error('private source'), ''],
    [null, 'invalid private data'],
  ]) {
    const ranker = await createRanker({
      python: '/runtime/python',
      directory: '/models/review',
      run: (_binary, _argv, _options, done) => {
        queueMicrotask(() => done(error, output));
        return { stdin: new PassThrough() };
      },
    });
    await assert.rejects(ranker.rank([], { schema_version: 1 }), { code: 'PROVIDER_UNAVAILABLE' });
  }
});

test('invalid execution configuration and oversized source do not launch a model', async () => {
  for (const options of [
    { python: 'python', directory: '/models' },
    { python: '/python', directory: 'models' },
  ])
    await assert.rejects(createRanker(options), { code: 'INVALID_ARGUMENT' });
  let launched = false;
  const ranker = await createRanker({
    python: '/runtime/python',
    directory: '/models',
    run: () => {
      launched = true;
    },
  });
  await assert.rejects(ranker.rank([], { schema_version: 1, text: 'x'.repeat(1048576) }), {
    code: 'INCOMPLETE_ANALYSIS',
  });
  assert.equal(launched, false);
});
