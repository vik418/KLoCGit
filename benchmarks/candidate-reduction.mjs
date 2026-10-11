import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { FutureRevision } from '../core/v1/domain.mjs';
import { CandidateReducer } from '../core/v1/candidate-reducer.mjs';
import { buildEffectSet } from '../core/v1/extractors.mjs';
import { commitOid, treeOid } from './support/git-objects.mjs';
import { objectId } from '../core/v1/conventions.mjs';
import { digestCanonical } from '../core/v1/encoding.mjs';
import { buildSystemRevision } from '../core/v1/releases.mjs';
import { createEvent, serializeEvent } from '../core/v1/events.mjs';
import { EventConsumer } from '../core/v1/consumer.mjs';
import { FutureIngestor } from '../core/v1/ingestion.mjs';
import { CoordinationStore } from '../core/v1/coordination.mjs';
import { SqliteCoordinationBackend } from '../adapters/local/coordination.mjs';

const encoder = new TextEncoder();
const observed_at = '2026-10-11T00:00:00Z';
const limits = { max_event_bytes: 4096, inline_payload_bytes: 128, max_claim_bytes: 16384 };

function seededRandom(seed) {
  let state = 2166136261;
  for (const unit of encoder.encode(seed)) state = Math.imul(state ^ unit, 16777619) >>> 0;
  return (maximum) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % maximum;
  };
}

/** Synthetic Git objects and declared effects isolate metadata/index complexity. */
export async function reductionWorkload(count, seed) {
  if (!Number.isSafeInteger(count) || count < 3 || typeof seed !== 'string' || !seed)
    throw new TypeError('A count >= 3 and a seed are required.');
  const random = seededRandom(seed),
    riskByIndex = new Map(),
    seededInteractions = [];
  const pairs = Math.max(1, Math.floor(count / 100));
  for (let index = 0; index < pairs; index++) {
    const first = random(count - 2),
      second = first + 2;
    const target = 'auth/case-' + index + '.ts';
    seededInteractions.push({
      indices: [first, second],
      target,
      repo_id: first % 2 ? 'shared' : 'application',
    });
    for (const member of [first, second]) {
      if (!riskByIndex.has(member)) riskByIndex.set(member, []);
      riskByIndex.get(member).push(target);
    }
  }
  const base_tree = await treeOid({});
  const base_commit = await commitOid(base_tree, null, 'baseline');
  const base = await buildSystemRevision({
    schema_version: 1,
    repositories: { application: base_commit, shared: base_commit },
    configuration_digests: {},
    accepted_decisions: [],
  });
  const revisions = [],
    effects = [],
    bindings = {};
  for (let index = 0; index < count; index++) {
    // Same-target duplicates share implementation, while keeping separate producers.
    const duplicate = index % 5 === 2 && !riskByIndex.has(index) && !riskByIndex.has(index - 2);
    const files = {
      'README.md': 'Shared documentation update\n',
      'implementation.ts': `export const result = ${index};\n`,
    };
    for (const target of riskByIndex.get(index) ?? [])
      files[target] = `export const validate = (input) => input === ${index};\n`;
    const tree_oid = duplicate ? revisions[index - 2].tree_oid : await treeOid(files);
    const commit_oid = await commitOid(tree_oid, base_commit, seed + ':producer:' + index);
    const facts = {
      schema_version: 1,
      system_id: 'benchmark',
      repo_id: 'future-' + index,
      ref: 'refs/heads/main',
      commit_oid,
      tree_oid,
      parent_oids: [base_commit],
    };
    const revision = FutureRevision({
      ...facts,
      id: objectId('future-revision', await digestCanonical('object-future-revision', facts)),
      producer: null,
      observed_at,
    });
    revisions.push(revision);
    bindings[revision.id] = {
      schema_version: 1,
      repo_id: index % 2 ? 'shared' : 'application',
      base_commit_oid: base_commit,
      base_tree_oid: base_tree,
    };
    const effect = (target, kind = 'path') => ({
      schema_version: 1,
      kind,
      target,
      operation: 'create',
      attributes: { basis: 'DECLARED', fixture: 'metadata-workload' },
      references: [],
    });
    effects.push(
      await buildEffectSet({
        schema_version: 1,
        future_revision_id: revision.id,
        extractor_id: 'benchmark-metadata',
        extractor_version: '1',
        capability: 'PATH',
        status: 'COMPLETE',
        effects: [
          effect('README.md'),
          effect('implementation.ts'),
          ...[...(riskByIndex.get(index) ?? [])].map((target) => effect(target)),
        ],
        security_effects: [...(riskByIndex.get(index) ?? [])].map((target) =>
          effect(target, 'security-path'),
        ),
      }),
    );
  }
  return {
    revisions,
    effects,
    seededInteractions: seededInteractions.map((entry) => ({
      ...entry,
      revision_ids: entry.indices.map((index) => revisions[index].id),
    })),
    policy: {
      schema_version: 1,
      base_revision: base.id,
      bindings,
      supersession: [],
      dependencies: [],
      rejections: [],
      completed_revision_ids: [],
      hub_min_degree: 16,
    },
  };
}

async function benchmarkEvents(workload, directory) {
  await mkdir(directory, { recursive: true });
  const backend = new SqliteCoordinationBackend({
    filename: join(directory, 'events.sqlite'),
    busy_timeout_ms: 1000,
  });
  const store = new CoordinationStore(backend),
    claims = new Map(),
    ingestors = new Map();
  const objectStore = {
    put: async ({ tenant_id, digest, bytes }) => {
      const ref = tenant_id + '/' + digest;
      claims.set(ref, bytes.slice());
      return ref;
    },
    get: async ({ tenant_id, ref }) => {
      if (!ref.startsWith(tenant_id + '/')) throw new Error('Wrong claim tenant');
      return claims.get(ref)?.slice();
    },
  };
  const principal = { actor_id: 'benchmark-controller', tenant_id: 'benchmark' };
  for (const revision of workload.revisions) {
    const scope = {
      schema_version: 1,
      tenant_id: 'benchmark',
      system_id: 'benchmark',
      kind: 'REF',
      resource_id: { repo_id: revision.repo_id, ref: revision.ref },
    };
    const snapshot = {
      schema_version: 1,
      repo_id: revision.repo_id,
      commit_oid: revision.commit_oid,
      tree_oid: revision.tree_oid,
      parent_oids: revision.parent_oids,
    };
    ingestors.set(
      revision.repo_id,
      new FutureIngestor({
        scope,
        gitStore: {
          repo_id: revision.repo_id,
          observe_ref: async () => snapshot.commit_oid,
          fetch: async () => ({ identity: snapshot }),
        },
        authorize: ({ principal: actor }) =>
          actor.actor_id === principal.actor_id && actor.tenant_id === scope.tenant_id,
        clock: () => observed_at,
        observationFilter: { blobs: 'none' },
      }),
    );
  }
  const consumer = new EventConsumer({
    store,
    limits,
    objectStore,
    max_attempts: 2,
    authorize: (query) => ingestors.get(query.event.subject_id)?.authorize(query) ?? false,
    resolveScope: ({ event }) => ingestors.get(event.subject_id).scope,
    handler: (query) => ingestors.get(query.event.subject_id).observe(query),
    reconcile: (query) => ingestors.get(query.event.subject_id).observe(query),
    executor: {
      idempotent: true,
      execute: () => {
        throw new Error('Metadata ingestion requested an irreversible effect');
      },
    },
    deadLetters: {
      send: () => {
        throw new Error('Unexpected benchmark dead letter');
      },
    },
  });
  const events = [],
    sizes = [];
  const start = performance.now();
  try {
    for (let index = 0; index < workload.revisions.length; index++) {
      const revision = workload.revisions[index];
      const metadata = {
        schema_version: 1,
        type: 'future.observed',
        tenant_id: 'benchmark',
        system_id: 'benchmark',
        objective_id: null,
        subject_id: revision.repo_id,
        subject_version: 1,
        occurred_at: observed_at,
        trace_id: 'benchmark-' + index,
      };
      const payload = {
        schema_version: 1,
        repo_id: revision.repo_id,
        ref: revision.ref,
        producer:
          index % 5 ? { producer: revision.repo_id, session: 'benchmark-session-' + index } : null,
      };
      const event = await createEvent(metadata, payload, limits, objectStore);
      events.push(event);
      sizes.push(serializeEvent(event, limits).length);
      const result = await consumer.consume(event, { principal, attempt: 1 });
      if (result.state !== 'APPLIED') throw new Error('Ingestion did not complete');
      if (index % 10 === 0) {
        const later = await createEvent(
          { ...metadata, subject_version: 2 },
          payload,
          limits,
          objectStore,
        );
        const applied = await consumer.consume(later, { principal, attempt: 1 });
        if (applied.state !== 'APPLIED') throw new Error('Later observation did not complete');
        const older = await createEvent(
          { ...metadata, trace_id: metadata.trace_id + '-delayed' },
          { ...payload, producer: { session: 'delayed-observation' } },
          limits,
          objectStore,
        );
        if ((await consumer.consume(older, { principal, attempt: 1 })).state !== 'IGNORED')
          throw new Error('Out-of-order observation was not ignored');
      }
    }
    for (const event of [...events].reverse()) {
      if ((await consumer.consume(event, { principal, attempt: 1 })).state !== 'APPLIED')
        throw new Error('Duplicate observation did not retain its receipt');
    }
    for (const revision of workload.revisions) {
      const scope = ingestors.get(revision.repo_id).scope;
      const stored = await store.transaction(scope, (tx) =>
        tx.get('future-revision:' + revision.id),
      );
      if (stored?.commit_oid !== revision.commit_oid) throw new Error('Observed revision was lost');
    }
    sizes.sort((a, b) => a - b);
    return {
      schema_version: 1,
      first_deliveries: events.length,
      replay_deliveries: events.length,
      later_observations: Math.ceil(events.length / 10),
      out_of_order_deliveries: Math.ceil(events.length / 10),
      elapsed_ms: performance.now() - start,
      envelope_p50_bytes: sizes[Math.ceil(sizes.length * 0.5) - 1],
      envelope_p95_bytes: sizes[Math.ceil(sizes.length * 0.95) - 1],
      max_envelope_bytes: sizes.at(-1),
      claim_objects: claims.size,
      irreversible_effects: 0,
    };
  } finally {
    backend.close();
  }
}

/** Measure retained inputs independently of the reducer's own success counters. */
export function reductionMeasurements(workload, result, budget) {
  const retained = new Set(
    result.implementation_frontier.flatMap((entry) => entry.future_revision_ids),
  );
  const missed = workload.seededInteractions.filter(
    (seeded) =>
      !result.effect_index.interactions.some(
        (edge) =>
          edge.repo_id === seeded.repo_id &&
          edge.target === seeded.target &&
          edge.security_sensitive &&
          seeded.revision_ids.every((id) => edge.member_revision_ids.includes(id)),
      ),
  );
  const measurements = {
    candidate_specs: result.candidate_specs.length,
    materialized_candidates: 0,
    distinct_implementations: result.metrics.exact_implementations,
    deferred_implementations: result.metrics.deferred_implementations,
    interaction_hyperedges: result.effect_index.interactions.length,
    suppressed_noncritical_hubs: result.effect_index.suppressed.length,
    memberships: result.effect_index.metrics.memberships,
    pairwise_expansions: result.effect_index.metrics.pairwise_expansions,
    comparisons_avoided: result.effect_index.metrics.pairwise_comparisons_avoided,
    seeded_high_severity_interactions: workload.seededInteractions.length,
    missed_seeded_high_severity_interactions: missed.length,
    lost_revision_origins: workload.revisions.filter(({ id }) => !retained.has(id)).length,
    complete: result.complete,
  };
  return {
    ...measurements,
    falsified:
      measurements.candidate_specs > budget.max_candidate_specs ||
      measurements.pairwise_expansions !== 0 ||
      measurements.missed_seeded_high_severity_interactions !== 0 ||
      measurements.lost_revision_origins !== 0,
  };
}

export async function benchmarkReduction({
  counts,
  seed,
  budget,
  events = true,
  onProgress = () => {},
}) {
  if (!Array.isArray(counts) || !counts.length || new Set(counts).size !== counts.length)
    throw new TypeError('Distinct workload counts are required.');
  const directory = await mkdtemp(join(tmpdir(), 'klocgit-reduction-benchmark-')),
    rows = [];
  const reducer = new CandidateReducer({ verifyRejection: () => false });
  try {
    for (const count of counts) {
      const generated = performance.now(),
        workload = await reductionWorkload(count, seed);
      const generation_ms = performance.now() - generated,
        started = performance.now();
      const result = await reducer.reduce(
        workload.revisions,
        workload.effects,
        workload.policy,
        budget,
      );
      const reduction_ms = performance.now() - started;
      const row = {
        schema_version: 1,
        futures: count,
        generation_ms,
        reduction_ms,
        reduction_ms_per_future: reduction_ms / count,
        ...reductionMeasurements(workload, result, budget),
        events: events ? await benchmarkEvents(workload, join(directory, String(count))) : null,
      };
      rows.push(row);
      await onProgress(row);
    }
    return {
      schema_version: 1,
      hypothesis: 'H1',
      workload: 'synthetic-git-metadata-and-declared-effects',
      scope:
        'Index retention and scheduling bounds, not semantic-conflict detection or runtime evaluation',
      seed,
      counts,
      budget,
      event_limits: limits,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      rows,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [counts, seed, maxCandidateSpecs] = process.argv.slice(2);
  const report = await benchmarkReduction({
    counts: counts?.split(',').map(Number),
    seed,
    budget: {
      schema_version: 1,
      max_candidate_specs: Number(maxCandidateSpecs),
      max_selections_per_spec: 8,
      max_dependency_visits: 256,
    },
    onProgress: (row) =>
      process.stderr.write(
        JSON.stringify({
          event: 'benchmark.completed',
          futures: row.futures,
          reduction_ms: row.reduction_ms,
          falsified: row.falsified,
        }) + '\n',
      ),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.rows.some((row) => row.falsified)) process.exitCode = 1;
}
