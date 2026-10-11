import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkWorkspaces } from '../../benchmarks/workspaces.mjs';

test('native workspace experiment compares exact cold/warm content and preserves source Git during composition', async () => {
  const report = await benchmarkWorkspaces({
    counts: [8],
    blob_bytes: 4096,
    binary: process.env.KLOCGIT_ARTIFACT_FS_BINARY ?? '/tmp/klocgit-artifactfs/bin/artifact-fs',
  });
  const [row] = report.rows;
  assert.equal(row.hydration_failures, 0, JSON.stringify(row));
  assert.equal(row.native.acquisition.initial_blob_count, 0);
  assert.ok(row.native.cold_metrics.blob_bytes_transferred < row.source_blob_payload_bytes);
  assert.equal(row.native.warm_metrics.bytes_transferred, 0);
  assert.ok(row.native.warm_cache_hit_rate > 0);
  assert.ok(row.native.recovered_metrics.bytes_transferred > 0);
  assert.equal(row.materialization.source_unchanged, true);
  assert.ok(row.materialization.materialization_cold_ms > 0);
  assert.ok(row.materialization.materialization_warm_ms > 0);
  assert.ok(row.conventional.blob_payload_bytes > 0 && row.conventional.disk.apparent_bytes > 0);
});

test('unavailable native capability records a failed measurement instead of claiming success', async () => {
  const report = await benchmarkWorkspaces({
    counts: [1],
    blob_bytes: 1,
    binary: '/unavailable-artifact-fs',
  });
  assert.equal(report.rows[0].hydration_failures, 1);
  assert.equal(report.rows[0].native, undefined);
  await assert.rejects(
    benchmarkWorkspaces({ counts: [0], blob_bytes: 1, binary: '/unavailable' }),
    TypeError,
  );
});
