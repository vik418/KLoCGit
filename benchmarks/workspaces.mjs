/** Native hydration and local composition measurements over controlled Git fixtures. */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { git } from '../server/git.mjs';
import { ArtifactFSWorkspaceSource } from '../adapters/cloudflare/artifact-fs-workspace.mjs';
import { LocalWorkspaceSource } from '../adapters/local/workspace-source.mjs';
import { BoundedWorkspaceCache } from '../core/v1/workspace-cache.mjs';
import { compositionFixture } from '../tests/v1/support/composition.mjs';

function fixtureBytes(size, seed) {
  let state = seed + 1;
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 255;
  }
  return bytes;
}

/** Do not traverse symlinks or mounted hydration trees while measuring disk use. */
async function diskBytes(root) {
  const device = (await lstat(root)).dev;
  let apparent_bytes = 0,
    allocated_bytes = 0,
    skipped_mounts = 0;
  const visit = async (path) => {
    const info = await lstat(path);
    if (info.dev !== device) {
      skipped_mounts++;
      return;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (info.isFile()) {
      apparent_bytes += info.size;
      allocated_bytes += info.blocks * 512;
    }
  };
  await visit(root);
  return { schema_version: 1, apparent_bytes, allocated_bytes, skipped_mounts };
}

async function fullFetch(f, destination) {
  const repository = f.repositories.get('canonical');
  const started = performance.now();
  await git(f.root, [
    'clone',
    '--bare',
    '--quiet',
    '--no-local',
    '--depth=1',
    '--branch',
    'main',
    pathToFileURL(f.adapter.dir(repository)).href,
    destination,
  ]);
  const oid = await git(destination, ['rev-parse', 'HEAD']);
  if (oid !== f.baseline.commit_oid) throw new Error('Full fetch substituted the exact baseline');
  const usable_ms = performance.now() - started;
  const objects = await git(destination, ['rev-list', '--objects', 'HEAD']);
  const inventory = await git(
    destination,
    ['cat-file', '--batch-check=%(objecttype) %(objectsize)'],
    objects
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')[0])
      .join('\n') + '\n',
  );
  let blob_payload_bytes = 0,
    metadata_payload_bytes = 0;
  for (const line of inventory.split('\n').filter(Boolean)) {
    const [kind, text] = line.split(' '),
      size = Number(text);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error('Invalid fetched object inventory');
    if (kind === 'blob') blob_payload_bytes += size;
    else metadata_payload_bytes += size;
  }
  const readStarted = performance.now();
  const contents = await git(destination, ['show', oid + ':main.txt'], undefined, { raw: true });
  return {
    schema_version: 1,
    usable_ms,
    selected_read_ms: performance.now() - readStarted,
    contents,
    blob_payload_bytes,
    metadata_payload_bytes,
    disk: await diskBytes(destination),
  };
}

async function measureWorkload({ file_count, blob_bytes, binary }) {
  const cleanup = [],
    sources = [];
  const initial = { 'main.txt': 'baseline\n', 'feature.txt': 'baseline feature\n' };
  for (let index = 0; index < file_count; index++)
    initial['data-' + index + '.bin'] = { contents: fixtureBytes(blob_bytes, index) };
  let f;
  try {
    f = await compositionFixture({ after: (work) => cleanup.push(work) }, initial);
    const directory = f.adapter.dir(f.repositories.get('canonical'));
    await git(directory, ['config', 'uploadpack.allowFilter', 'true']);
    const cache = new BoundedWorkspaceCache({
      policy: { schema_version: 1, max_entries: 4096, max_bytes: 32 * 1024 * 1024, ttl_ms: 120000 },
    });
    const hydration = join(f.root, 'hydration');
    const source = new ArtifactFSWorkspaceSource({
      binary,
      root: hydration,
      repository: {
        id: 'canonical',
        remote: pathToFileURL(directory).href,
        ref: 'refs/heads/main',
      },
      prepare_timeout_ms: 30000,
      mount_timeout_ms: 5000,
      max_object_bytes: Math.max(blob_bytes, 4096),
      max_acquisitions: 1,
      cache,
    });
    sources.push(source);
    const coldStart = performance.now();
    const cold = await source.fetch(f.baseline, { blobs: 'none' });
    const cold_usable_ms = performance.now() - coldStart,
      coldRead = performance.now();
    const coldFile = await cold.readFile('main.txt');
    const cold_selected_read_ms = performance.now() - coldRead;
    if (coldFile.contents !== initial['main.txt'])
      throw new Error('Cold hydration substituted content');
    const warmStart = performance.now();
    const warm = await source.fetch(f.baseline, { blobs: 'selected', paths: ['main.txt'] });
    const warm_usable_ms = performance.now() - warmStart,
      warmRead = performance.now();
    if ((await warm.readFile('main.txt')).contents !== coldFile.contents)
      throw new Error('Warm hydration substituted content');
    const warm_selected_read_ms = performance.now() - warmRead;
    const coldMetrics = cold.metrics(),
      warmMetrics = warm.metrics();
    const cacheBeforeLoss = cache.stats();
    cache.clear();
    const recoveredStart = performance.now();
    const recovered = await source.fetch(f.baseline, { blobs: 'selected', paths: ['main.txt'] });
    if ((await recovered.readFile('main.txt')).contents !== coldFile.contents)
      throw new Error('Cache loss changed content');
    const cache_loss_recovery_ms = performance.now() - recoveredStart;
    const nativeDisk = await diskBytes(hydration);
    const full = await fullFetch(f, join(f.root, 'full-cold.git'));
    const readStart = performance.now();
    await git(join(f.root, 'full-cold.git'), ['show', f.baseline.commit_oid + ':main.txt']);
    const full_warm_selected_read_ms = performance.now() - readStart;
    if (full.contents !== coldFile.contents)
      throw new Error('Comparison fetched different content');

    // Composition uses the generic read-only Git transport; ArtifactFS above
    // measures native head hydration independently of historical object access.
    await f.future('a', { ...initial, 'main.txt': 'chosen main\n' });
    await f.future('b', { ...initial, 'feature.txt': 'chosen feature\n' });
    const stateBefore = await f.sourceState();
    const compositionCache = new BoundedWorkspaceCache({ policy: cache.policy });
    for (const [id, repository] of f.repositories)
      f.sources.set(
        id,
        new LocalWorkspaceSource({ adapter: f.adapter, repository, cache: compositionCache }),
      );
    const spec = await f.spec();
    const composeStart = performance.now();
    const candidate = await f.materializer.materialize(spec, f.context);
    const materialization_cold_ms = performance.now() - composeStart;
    const workspace = await f.materializer.open(candidate, 'canonical');
    if (
      (await workspace.readFile('main.txt')).contents !== 'chosen main\n' ||
      (await workspace.readFile('feature.txt')).contents !== 'chosen feature\n'
    )
      throw new Error('Composition did not preserve both selected changes');
    const compositionCold = f.materializer.metrics(candidate.digest);
    await f.materializer.release(candidate.digest);
    const warmCompose = performance.now();
    const repeated = await f.materializer.materialize(spec, f.context);
    const materialization_warm_ms = performance.now() - warmCompose;
    if (repeated.digest !== candidate.digest)
      throw new Error('Rematerialization changed exact Candidate');
    const compositionWarm = f.materializer.metrics(repeated.digest);
    const source_unchanged = JSON.stringify(await f.sourceState()) === JSON.stringify(stateBefore);
    if (!source_unchanged) throw new Error('Speculative composition changed durable Git state');
    return {
      schema_version: 1,
      file_count,
      blob_bytes,
      source_blob_payload_bytes: full.blob_payload_bytes,
      transport: 'local-file-git',
      cache_scope: 'fresh adapter/application caches; operating-system cache is uncontrolled',
      native: {
        acquisition: cold.acquisitionMetrics(),
        cold_usable_ms,
        cold_selected_read_ms,
        cold_metrics: coldMetrics,
        warm_usable_ms,
        warm_selected_read_ms,
        warm_metrics: warmMetrics,
        warm_cache_hit_rate:
          warmMetrics.cache_hits / (warmMetrics.cache_hits + warmMetrics.cache_misses),
        cache: cacheBeforeLoss,
        cache_loss_recovery_ms,
        recovered_metrics: recovered.metrics(),
        disk: nativeDisk,
      },
      conventional: { ...full, contents: undefined, full_warm_selected_read_ms },
      materialization: {
        transport: 'local-read-only-git-objects',
        materialization_cold_ms,
        materialization_warm_ms,
        cold_metrics: compositionCold,
        warm_metrics: compositionWarm,
        source_unchanged,
      },
      hydration_failures: 0,
    };
  } finally {
    for (const source of sources) await source.close();
    for (const work of cleanup.reverse()) await work();
  }
}

export async function benchmarkWorkspaces({ counts, blob_bytes, binary, onProgress = () => {} }) {
  if (
    !Array.isArray(counts) ||
    !counts.length ||
    new Set(counts).size !== counts.length ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 1) ||
    !Number.isSafeInteger(blob_bytes) ||
    blob_bytes < 1 ||
    typeof binary !== 'string'
  )
    throw new TypeError(
      'Distinct file counts, payload size and ArtifactFS executable are required.',
    );
  const rows = [];
  for (const file_count of counts) {
    let row;
    try {
      row = await measureWorkload({ file_count, blob_bytes, binary });
    } catch (error) {
      row = {
        schema_version: 1,
        file_count,
        blob_bytes,
        hydration_failures: 1,
        failure_class: error.code ?? 'BENCHMARK_FAILURE',
      };
    }
    rows.push(row);
    await onProgress(row);
  }
  return {
    schema_version: 1,
    measured_at: new Date().toISOString(),
    hypothesis: 'H3',
    counts,
    blob_bytes,
    runtime: {
      node: process.version,
      git: await git(process.cwd(), ['--version']),
      platform: process.platform,
      arch: process.arch,
    },
    scope:
      'Local fixture transport, native FUSE hydration, generic local Git composition. No Cloudflare network/billing measurement.',
    byte_scope:
      'Exact object payload counters and private disk sizes; provider network framing and background prefetch are not measured.',
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [counts, blob_bytes] = process.argv.slice(2);
  const report = await benchmarkWorkspaces({
    counts: counts?.split(',').map(Number),
    blob_bytes: Number(blob_bytes),
    binary: process.env.KLOCGIT_ARTIFACT_FS_BINARY,
    onProgress: (row) =>
      process.stderr.write(
        JSON.stringify({
          event: 'workspace.measured',
          file_count: row.file_count,
          failures: row.hydration_failures,
        }) + '\n',
      ),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.rows.some((row) => row.hydration_failures)) process.exitCode = 1;
}
