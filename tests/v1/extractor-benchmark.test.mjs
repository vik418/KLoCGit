import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkExtractors, scoreSignals } from '../../benchmarks/extractors.mjs';

test('scoring counts false positives and misses, deduplicates observations and leaves empty ratios undefined', () => {
  assert.deepEqual(scoreSignals(['a', 'b'], ['a', 'a', 'c']), {
    true_positive: 1,
    false_positive: 1,
    false_negative: 1,
    precision: 0.5,
    recall: 0.5,
  });
  assert.deepEqual(scoreSignals([], []), {
    true_positive: 0,
    false_positive: 0,
    false_negative: 0,
    precision: null,
    recall: null,
  });
});

test('actual compiler benchmark measures declared observations without masking a bad oracle', async () => {
  const fixture = {
    id: 'literal-change',
    language: 'typescript',
    before: { 'value.ts': 'export function value():number{return 1;}' },
    after: { 'value.ts': 'export function value():number{return 2;}' },
    status: 'COMPLETE',
    signals: ['source:value.ts'],
  };
  const report = await benchmarkExtractors({
    corpus: [fixture],
    languages: ['typescript'],
    repetitions: 2,
  });
  assert.equal(report.summaries[0].false_negative, 0);
  assert.equal(report.summaries[0].false_positive, 0);
  assert.equal(report.summaries[0].unexpected_statuses, 0);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].effect_digest, report.rows[1].effect_digest);
  assert.ok(report.rows.every((row) => row.elapsed_ms > 0 && row.source_bytes > 0));
  const wrong = await benchmarkExtractors({
    corpus: [{ ...fixture, signals: ['source:other.ts'] }],
    languages: ['typescript'],
    repetitions: 1,
  });
  assert.equal(wrong.summaries[0].false_negative, 1);
  assert.equal(wrong.summaries[0].false_positive, 1);
  await assert.rejects(
    benchmarkExtractors({ corpus: [fixture], languages: ['unsupported'], repetitions: 1 }),
    TypeError,
  );
});
