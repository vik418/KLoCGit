import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  digestCanonical,
  effectSetDigest,
  encodeCanonical,
  encodeDomain,
  materialEffectDigest,
  materialEffectProjection,
  normalizeEffectSet,
} from '../../core/v1/encoding.mjs';

const golden = JSON.parse(readFileSync(new URL('./encoding.golden.json', import.meta.url), 'utf8'));
const id = (kind, hex = '1') => 'klocgit:' + kind + ':v1:sha256:' + hex.repeat(64);
const digest = (domain, hex = '1') => 'sha256:' + domain + ':v1:' + hex.repeat(64);
const hex = (bytes) => Buffer.from(bytes).toString('hex');

function effects() {
  return {
    schema_version: 1,
    future_revision_id: id('future-revision'),
    extractor_id: 'git.path',
    extractor_version: '1.0.0',
    capability: 'PATH',
    status: 'COMPLETE',
    effects: [
      {
        schema_version: 1,
        kind: 'path',
        target: 'src/retry.js',
        operation: 'modify',
        attributes: { steps: ['request', 'retry'], retries: 2 },
        references: ['orders', 'billing'],
        annotations: {
          observed_at: '2026-10-10T00:00:00Z',
          trace_id: 'trace-a',
          runtime_metrics: { duration_ms: 20 },
          transient_locations: ['/scratch/a'],
        },
      },
    ],
    security_effects: [
      {
        schema_version: 1,
        kind: 'dependency',
        target: 'package-lock.json',
        operation: 'modify',
        attributes: { package: 'example', versions: ['1.0', '2.0'] },
        references: [],
      },
    ],
    digest: digest('effect-set'),
  };
}

function basis() {
  return {
    schema_version: 1,
    candidate_digests: [digest('object-candidate', '2'), digest('object-candidate')],
    evidence_digests: [digest('object-evidence', '2'), digest('object-evidence')],
    material_effect_digest: digest('material-effect'),
    policy_digest: digest('policy'),
    canonical_ref_oids: { repo: { 'refs/heads/main': 'a'.repeat(40) } },
    required_analysis_status: { 'git.path': 'COMPLETE' },
    digest: digest('decision-basis'),
  };
}

function spec() {
  return {
    schema_version: 1,
    id: id('candidate-spec'),
    base_revision: id('system-revision'),
    selected_future_revisions: [id('future-revision', '2'), id('future-revision')],
    selections: [
      { kind: 'FUTURE', revision: 'a' },
      { kind: 'FUTURE', revision: 'b' },
    ],
    required_dependencies: [id('future-revision', '4'), id('future-revision', '3')],
    effect_summary_digest: digest('material-effect'),
    creation_reason: 'Combine retry and logging.',
  };
}

for (const vector of golden.vectors) {
  test('canonical CBOR golden: ' + vector.name, async () => {
    assert.equal(hex(encodeCanonical(vector.value)), vector.cbor_hex);
    assert.equal(await digestCanonical(vector.domain, vector.value), vector.digest);
    // Insertion order must not become part of a map's identity.
    assert.equal(hex(encodeCanonical(reverseMaps(vector.value))), vector.cbor_hex);
  });
}

function reverseMaps(value) {
  if (Array.isArray(value)) return value.map(reverseMaps);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseMaps(nested)]),
  );
}

test('material EffectSet matches the independently checked literal projection', async () => {
  const vector = golden.vectors.find((entry) => entry.name === 'material-effects');
  assert.deepEqual(materialEffectProjection(effects()), vector.value);
  assert.equal(await materialEffectDigest(effects()), vector.digest);
});

test('timestamps, traces, execution metrics, locations and self digest are non-material', async () => {
  const input = effects();
  const original = await materialEffectDigest(input);
  for (const [field, value] of Object.entries({
    observed_at: '2026-10-10T12:00:00Z',
    trace_id: 'trace-b',
    runtime_metrics: { duration_ms: 9999 },
    transient_locations: ['/scratch/b', '/scratch/c'],
  })) {
    const changed = structuredClone(input);
    changed.effects[0].annotations[field] = value;
    assert.equal(await materialEffectDigest(changed), original, field);
    assert.notEqual(await effectSetDigest(changed), await effectSetDigest(input), field);
  }
  const changed = structuredClone(input);
  changed.digest = digest('effect-set', '2');
  delete changed.effects[0].annotations;
  assert.equal(await materialEffectDigest(changed), original);
  assert.equal(
    await effectSetDigest({ ...input, digest: changed.digest }),
    await effectSetDigest(input),
  );
});

test('material state, extractor identity and capability status remain hash inputs', async () => {
  const original = await materialEffectDigest(effects());
  const mutations = [
    (value) => (value.future_revision_id = id('future-revision', '2')),
    (value) => (value.extractor_id = 'parser.structure'),
    (value) => (value.extractor_version = '2.0.0'),
    (value) => (value.capability = 'STRUCTURAL'),
    (value) => (value.status = 'PARTIAL'),
    (value) => (value.effects[0].target = 'src/other.js'),
    (value) => (value.effects[0].operation = 'delete'),
    (value) => (value.effects[0].attributes.retries = 3),
    (value) => value.effects[0].references.push('security'),
    (value) => value.effects[0].attributes.steps.reverse(),
    (value) => (value.security_effects[0].attributes.package = 'other'),
    (value) => (value.security_effects = []),
  ];
  for (const mutate of mutations) {
    const changed = effects();
    mutate(changed);
    assert.notEqual(await materialEffectDigest(changed), original);
  }
});

test('metadata-looking attribute names remain material instead of being guessed away', async () => {
  const input = effects();
  input.effects[0].attributes.trace_id = 'request-a';
  const original = await materialEffectDigest(input);
  input.effects[0].attributes.trace_id = 'request-b';
  assert.notEqual(await materialEffectDigest(input), original);
});

test('effect and reference sets normalize order without mutating the producer', async () => {
  const input = effects();
  const second = structuredClone(input.effects[0]);
  second.target = 'src/log.js';
  input.effects.push(second);
  const original = structuredClone(input);
  const changed = structuredClone(input);
  changed.effects.reverse();
  changed.effects.forEach((entry) => entry.references.reverse());
  assert.equal(await materialEffectDigest(input), await materialEffectDigest(changed));
  assert.equal(hex(encodeDomain('EffectSet', input)), hex(encodeDomain('EffectSet', changed)));
  const normalized = normalizeEffectSet(input);
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(normalized.effects[0].attributes.steps), true);
  input.effects[0].attributes.steps.push('send-email');
  assert.equal(
    normalized.effects.find((entry) => entry.target === 'src/retry.js').attributes.steps.length,
    2,
  );
});

test('annotations cannot create distinct duplicate effects', () => {
  const input = effects();
  const duplicate = structuredClone(input.effects[0]);
  duplicate.annotations.trace_id = 'another';
  input.effects.push(duplicate);
  assert.throws(() => normalizeEffectSet(input), { code: 'INVALID_ARGUMENT' });
  assert.throws(
    () =>
      normalizeEffectSet({
        ...effects(),
        security_effects: [effects().security_effects[0], effects().security_effects[0]],
      }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('normalized effect schema rejects ambiguous, unknown and unsupported fields', () => {
  const invalid = [
    { surprise: true },
    { schema_version: '1' },
    { kind: 'Path' },
    { kind: 'a'.repeat(65) },
    { operation: '' },
    { target: '' },
    { attributes: [] },
    { references: ['orders', 'orders'] },
    { references: [''] },
    { annotations: { decision: 'approve' } },
    { annotations: { trace_id: false } },
    { annotations: { runtime_metrics: [] } },
    { annotations: { transient_locations: [null] } },
  ];
  for (const change of invalid) {
    const input = effects();
    Object.assign(input.effects[0], change);
    assert.throws(() => normalizeEffectSet(input), { code: 'INVALID_ARGUMENT' });
  }
  for (const field of [
    'schema_version',
    'kind',
    'target',
    'operation',
    'attributes',
    'references',
  ]) {
    const input = effects();
    delete input.effects[0][field];
    assert.throws(() => normalizeEffectSet(input), { code: 'INVALID_ARGUMENT' });
  }
  const input = effects();
  input.effects[0].schema_version = 2;
  assert.throws(() => normalizeEffectSet(input), { code: 'UNSUPPORTED_SCHEMA_VERSION' });
});

test('Git identifiers are preserved without Unicode, case, slash or whitespace rewriting', async () => {
  for (const [left, right] of [
    ['é.js', 'e\u0301.js'],
    ['Retry.js', 'retry.js'],
    ['a/b', 'a\\b'],
    ['path', ' path'],
  ]) {
    const first = effects();
    const second = effects();
    first.effects[0].target = left;
    second.effects[0].target = right;
    assert.notEqual(await materialEffectDigest(first), await materialEffectDigest(second));
  }
});

test('CandidateSpec set order is canonical while selection order is significant', () => {
  const input = spec();
  assert.equal(
    hex(encodeDomain('CandidateSpec', input)),
    golden.vectors.find((entry) => entry.name === 'candidate-spec-record').cbor_hex,
  );
  const changed = structuredClone(input);
  changed.selected_future_revisions.reverse();
  changed.required_dependencies.reverse();
  assert.equal(
    hex(encodeDomain('CandidateSpec', input)),
    hex(encodeDomain('CandidateSpec', changed)),
  );
  changed.selections.reverse();
  assert.notEqual(
    hex(encodeDomain('CandidateSpec', input)),
    hex(encodeDomain('CandidateSpec', changed)),
  );
});

test('DecisionBasis sets normalize directly and inside a Decision', () => {
  const input = basis();
  assert.equal(
    hex(encodeDomain('DecisionBasis', input)),
    golden.vectors.find((entry) => entry.name === 'decision-basis-record').cbor_hex,
  );
  const changed = structuredClone(input);
  changed.candidate_digests.reverse();
  changed.evidence_digests.reverse();
  assert.equal(
    hex(encodeDomain('DecisionBasis', input)),
    hex(encodeDomain('DecisionBasis', changed)),
  );
  const decision = {
    schema_version: 1,
    id: id('decision'),
    state: 'REVIEWABLE',
    basis: input,
    resolution: null,
  };
  assert.equal(
    hex(encodeDomain('Decision', decision)),
    hex(encodeDomain('Decision', { ...decision, basis: changed })),
  );
});

test('SystemRevision decision order is set-like and repository state remains exact', () => {
  const input = {
    schema_version: 1,
    id: id('system-revision'),
    repositories: { repo: 'a'.repeat(40) },
    configuration_digests: {},
    accepted_decisions: [id('decision', '2'), id('decision')],
    digest: digest('object-system-revision'),
  };
  const changed = structuredClone(input);
  changed.accepted_decisions.reverse();
  assert.equal(
    hex(encodeDomain('SystemRevision', input)),
    hex(encodeDomain('SystemRevision', changed)),
  );
  changed.repositories.repo = 'b'.repeat(40);
  assert.notEqual(
    hex(encodeDomain('SystemRevision', input)),
    hex(encodeDomain('SystemRevision', changed)),
  );
});

test('Git parent order is retained by persistence encoding', () => {
  const input = {
    schema_version: 1,
    id: id('future-revision'),
    system_id: 'system',
    repo_id: 'repo',
    ref: 'refs/heads/main',
    commit_oid: 'a'.repeat(40),
    tree_oid: 'b'.repeat(40),
    parent_oids: ['c'.repeat(40), 'd'.repeat(40)],
    producer: null,
    observed_at: '2026-10-10T00:00:00Z',
  };
  const changed = structuredClone(input);
  changed.parent_oids.reverse();
  assert.notEqual(
    hex(encodeDomain('FutureRevision', input)),
    hex(encodeDomain('FutureRevision', changed)),
  );
});

test('domain encoding keeps constructors and versions as its validation boundary', () => {
  assert.throws(() => encodeDomain('Unknown', {}), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeDomain('CandidateSpec', { ...spec(), schema_version: 2 }), {
    code: 'UNSUPPORTED_SCHEMA_VERSION',
  });
  assert.throws(() => encodeDomain('CandidateSpec', { ...spec(), unexpected: true }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('encoding rejects unsupported values without invoking producer code', () => {
  let called = 0;
  const accessor = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      called += 1;
      return 'secret';
    },
  });
  const custom = {
    toJSON() {
      called += 1;
      return null;
    },
  };
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    accessor,
    custom,
    cycle,
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array(),
    1n,
    undefined,
    Symbol('value'),
    NaN,
    Infinity,
    -0,
    Number.MAX_SAFE_INTEGER + 1,
    '\ud800',
    { ['\ud800']: 1 },
    [, 1],
  ]) {
    assert.throws(() => encodeCanonical(value), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(called, 0);
});

test('digest inputs are copied before asynchronous hashing', async () => {
  const value = { steps: ['a', 'b'] };
  const expected = await digestCanonical('configuration', value);
  const pending = digestCanonical('configuration', value);
  value.steps.reverse();
  assert.equal(await pending, expected);
  assert.notEqual(await digestCanonical('configuration', value), expected);
  assert.notEqual(await digestCanonical('policy', { steps: ['a', 'b'] }), expected);
});
