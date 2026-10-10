import { performance } from 'node:perf_hooks';
import { durableRuntime, durableRequest } from '../tests/support/durable-runtime.mjs';

export async function benchmarkCoordination({ requests, concurrencyLevels, shards }) {
  if (
    !Number.isSafeInteger(requests) ||
    requests < 1 ||
    !Number.isSafeInteger(shards) ||
    shards < 1 ||
    !Array.isArray(concurrencyLevels) ||
    !concurrencyLevels.length ||
    concurrencyLevels.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError('Positive request, concurrency and shard counts are required.');
  }
  const runtime = await durableRuntime(false);
  const rows = [];
  try {
    for (const concurrency of concurrencyLevels) {
      const latencies = [];
      let next = 0;
      for (let shard = 0; shard < shards; shard += 1) {
        const response = await durableRequest(runtime, {
          scope: {
            schema_version: 1,
            tenant_id: 'benchmark',
            system_id: 'benchmark',
            kind: 'OBJECTIVE',
            resource_id: String(concurrency) + ':' + shard,
          },
          operation: 'increment',
        });
        if (response.status !== 200) throw new Error('Coordination warmup failed.');
      }
      const start = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < requests) {
            const index = next++;
            const scope = {
              schema_version: 1,
              tenant_id: 'benchmark',
              system_id: 'benchmark',
              kind: 'OBJECTIVE',
              resource_id: String(concurrency) + ':' + (index % shards),
            };
            const before = performance.now();
            const response = await durableRequest(runtime, { scope, operation: 'increment' });
            if (response.status !== 200) throw new Error('Coordination request failed.');
            latencies.push(performance.now() - before);
          }
        }),
      );
      const elapsed_ms = performance.now() - start;
      latencies.sort((a, b) => a - b);
      const percentile = (fraction) =>
        latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
      rows.push({
        concurrency,
        requests,
        shards,
        elapsed_ms,
        requests_per_second: (requests / elapsed_ms) * 1000,
        latency_p50_ms: percentile(0.5),
        latency_p95_ms: percentile(0.95),
        failures: 0,
      });
    }
    return { schema_version: 1, runtime: 'local-workerd', rows };
  } finally {
    await runtime.dispose();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [requests, levels, shards] = process.argv.slice(2);
  const result = await benchmarkCoordination({
    requests: Number(requests),
    concurrencyLevels: levels?.split(',').map(Number),
    shards: Number(shards),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
