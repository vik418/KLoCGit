import test from 'node:test';
import assert from 'node:assert/strict';
import * as domain from '../../core/v1/domain.mjs';

const id = (kind, hex = '1') => 'klocgit:' + kind + ':v1:sha256:' + hex.repeat(64);
const digest = (name, hex = '1') => 'sha256:' + name + ':v1:' + hex.repeat(64);
const oid = (hex = 'a', length = 40) => hex.repeat(length);
const now = '2026-10-09T00:00:00.000Z';

// These are syntax fixtures, not assertions that a digest authenticates content.
function fixtures() {
  const basis = {
    schema_version: 1,
    candidate_digests: [digest('object-candidate'), digest('object-candidate', '2')],
    evidence_digests: [digest('object-evidence')],
    material_effect_digest: digest('material-effect'),
    policy_digest: digest('policy'),
    canonical_ref_oids: {
      'repo-a': { 'refs/heads/main': oid('a') },
      'repo-b': { 'refs/heads/main': oid('b', 64) },
    },
    required_analysis_status: { 'typescript.semantic': 'COMPLETE', 'git.path': 'COMPLETE' },
    digest: digest('decision-basis'),
  };
  return {
    FutureRevision: {
      schema_version: 1,
      id: id('future-revision'),
      system_id: 'system-a',
      repo_id: 'repo-a',
      ref: 'refs/heads/retry',
      commit_oid: oid('a'),
      tree_oid: oid('b'),
      parent_oids: [oid('c'), oid('d')],
      producer: { identity: 'producer-a', basis: 'DECLARED', annotations: [null, false] },
      observed_at: now,
    },
    EffectSet: {
      schema_version: 1,
      future_revision_id: id('future-revision'),
      extractor_id: 'git.path',
      extractor_version: '1.0.0',
      capability: 'PATH',
      status: 'PARTIAL',
      effects: [{ path: 'src/retry.js', change: 'MODIFIED', detail: { lines: [2, 1] } }],
      security_effects: [{ category: 'CI', path: '.github/workflows/check.yml' }],
      digest: digest('effect-set'),
    },
    CandidateSpec: {
      schema_version: 1,
      id: id('candidate-spec'),
      base_revision: id('system-revision'),
      selected_future_revisions: [id('future-revision', '2'), id('future-revision')],
      selections: [
        { future_revision_id: id('future-revision', '2'), kind: 'COMMIT', commit_oid: oid('d') },
        { future_revision_id: id('future-revision'), kind: 'FUTURE' },
      ],
      required_dependencies: [id('future-revision', '3')],
      effect_summary_digest: digest('material-effect'),
      creation_reason: 'Compose the selected changes.',
    },
    Candidate: {
      schema_version: 1,
      id: id('candidate'),
      candidate_spec_id: id('candidate-spec'),
      repo_tree_oids: { 'repo-b': oid('b', 64), 'repo-a': oid('a') },
      digest: digest('object-candidate'),
      materialization_record: {
        steps: [
          { future_revision_id: id('future-revision', '2'), commit_oid: oid('d') },
          { future_revision_id: id('future-revision'), commit_oid: oid('a') },
        ],
        workspace: '/scratch/candidate',
        hydrated_bytes: 128,
      },
    },
    Evidence: {
      schema_version: 1,
      id: id('evidence'),
      subject_digest: digest('object-candidate'),
      type: 'tests',
      producer_identity: 'evaluator-a',
      producer_version: '1.0.0',
      config_digest: digest('configuration'),
      environment_digest: digest('environment'),
      result: { status: 'PASSING', observations: [true, null, 0.5, '', { count: 1 }] },
      payload_ref: 'object://evidence/1',
      created_at: '2026-10-09T00:00:00Z',
      retention_class: 'DECISION_RECORD',
    },
    DecisionBasis: basis,
    Decision: {
      schema_version: 1,
      id: id('decision'),
      state: 'REVIEWABLE',
      basis,
      resolution: null,
    },
    SystemRevision: {
      schema_version: 1,
      id: id('system-revision'),
      repositories: { 'repo-a': oid('a'), 'repo-b': oid('b', 64) },
      configuration_digests: { application: digest('configuration') },
      accepted_decisions: [id('decision')],
      digest: digest('object-system-revision'),
    },
    ReleaseConstraints: {
      schema_version: 1,
      system_revision_digest: digest('object-system-revision'),
      ordering_constraints: [{ before: 'repo-a', after: 'repo-b' }],
      compatibility_requirements: [{ contract: 'orders', version: 2 }],
      preconditions: [{ check: 'database-compatible' }],
      postconditions: [{ check: 'observed-revision-matches' }],
      forward_only_operations: [{ migration: '002' }],
      digest: digest('release-constraints'),
    },
    DeploymentObservation: {
      schema_version: 1,
      id: id('deployment-observation'),
      digest: digest('object-deployment-observation'),
      system_revision_digest: digest('object-system-revision'),
      external_run_id: 'cd/run-a',
      status: 'UNKNOWN',
      observed_at: now,
      method: 'provider-api',
    },
    DeploymentAttestation: {
      schema_version: 1,
      id: id('deployment-attestation'),
      digest: digest('object-deployment-attestation'),
      system_revision_digest: digest('object-system-revision'),
      observation_digest: digest('object-deployment-observation'),
      producer_identity: 'deployment-observer-a',
      created_at: now,
      proof_ref: 'object://attestations/1',
    },
  };
}

function assertFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const entry of Object.values(value)) assertFrozen(entry);
}

for (const [type, input] of Object.entries(fixtures())) {
  test(type + ' validates and round-trips as immutable JSON data', () => {
    const record = domain[type](input);
    assert.deepEqual(record, input);
    assert.notEqual(record, input);
    assertFrozen(record);
    const encoded = domain.serializeDomain(type, record);
    assert.deepEqual(JSON.parse(encoded), input);
    const restored = domain.deserializeDomain(type, encoded);
    assert.deepEqual(restored, record);
    assertFrozen(restored);
  });

  test(type + ' rejects missing fields, unknown fields and unsupported versions', () => {
    for (const field of Object.keys(input)) {
      const missing = { ...input };
      delete missing[field];
      assert.throws(() => domain[type](missing), { code: 'INVALID_ARGUMENT' }, field);
    }
    assert.throws(() => domain[type]({ ...input, unexpected: true }), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => domain[type]({ ...input, schema_version: '1' }), {
      code: 'INVALID_ARGUMENT',
    });
    assert.throws(() => domain[type]({ ...input, schema_version: 2 }), {
      code: 'UNSUPPORTED_SCHEMA_VERSION',
    });
  });
}

test('caller mutations cannot change accepted nested snapshots', () => {
  const input = fixtures().Decision;
  const accepted = domain.Decision(input);
  input.basis.candidate_digests.push(digest('object-candidate', '3'));
  input.basis.canonical_ref_oids['repo-a']['refs/heads/main'] = oid('f');
  input.basis.required_analysis_status['git.path'] = 'FAILED';
  assert.equal(accepted.basis.candidate_digests.length, 2);
  assert.equal(accepted.basis.canonical_ref_oids['repo-a']['refs/heads/main'], oid('a'));
  assert.equal(accepted.basis.required_analysis_status['git.path'], 'COMPLETE');
  assert.throws(() => {
    accepted.basis.candidate_digests.push(digest('object-candidate', '4'));
  }, TypeError);
  assert.throws(() => {
    accepted.basis.required_analysis_status['git.path'] = 'FAILED';
  }, TypeError);
});

test('parent order and ordered composition and release steps survive persistence', () => {
  const records = fixtures();
  assert.deepEqual(domain.FutureRevision(records.FutureRevision).parent_oids, [oid('c'), oid('d')]);
  assert.deepEqual(domain.CandidateSpec(records.CandidateSpec).selections, records.CandidateSpec.selections);
  assert.deepEqual(
    domain.Candidate(records.Candidate).materialization_record.steps,
    records.Candidate.materialization_record.steps,
  );
  const release = {
    ...records.ReleaseConstraints,
    ordering_constraints: [{ before: 'b', after: 'c' }, { before: 'a', after: 'b' }],
  };
  assert.deepEqual(domain.ReleaseConstraints(release).ordering_constraints, release.ordering_constraints);
});

test('unknown provenance is valid and claimed provenance is not promoted to trust', () => {
  const input = fixtures().FutureRevision;
  assert.equal(domain.FutureRevision({ ...input, producer: null }).producer, null);
  const inferred = { ...input, producer: { identity: 'claimed-producer', basis: 'INFERRED' } };
  assert.deepEqual(domain.FutureRevision(inferred).producer, inferred.producer);
  assert.throws(() => domain.FutureRevision({ ...input, producer: 'producer-a' }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('FutureRevision binds exact same-format commit, tree and ordered parents', () => {
  const input = fixtures().FutureRevision;
  const sha256 = {
    ...input,
    commit_oid: oid('a', 64),
    tree_oid: oid('b', 64),
    parent_oids: [oid('c', 64), oid('d', 64)],
  };
  assert.deepEqual(domain.FutureRevision(sha256).parent_oids, sha256.parent_oids);
  assert.throws(() => domain.FutureRevision({ ...input, tree_oid: oid('b', 64) }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.throws(() => domain.FutureRevision({ ...input, parent_oids: [oid('c', 64)] }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.deepEqual(domain.FutureRevision({ ...input, parent_oids: [] }).parent_oids, []);
});

test('Git OIDs reject null sentinels, aliases, abbreviations, uppercase and trailing terminators', () => {
  const input = fixtures().FutureRevision;
  for (const invalid of [
    '',
    'HEAD',
    'main',
    'abc123',
    oid('0'),
    oid('0', 64),
    oid('A'),
    'a'.repeat(39) + '\n',
    'a'.repeat(63) + '\n',
    'g'.repeat(40),
    null,
  ]) {
    assert.throws(() => domain.FutureRevision({ ...input, commit_oid: invalid }), {
      code: 'INVALID_ARGUMENT',
    });
  }
});

test('exact Git refs accept ordinary namespaces and reject malformed or abbreviated names', () => {
  const input = fixtures().FutureRevision;
  for (const valid of ['refs/heads/main', 'refs/tags/v1.0', 'refs/notes/review', 'refs/custom']) {
    assert.equal(domain.FutureRevision({ ...input, ref: valid }).ref, valid);
  }
  for (const invalid of [
    'main',
    'HEAD',
    'refs/',
    'refs/heads/',
    'refs//main',
    'refs/heads/.hidden',
    'refs/heads/thing.lock',
    'refs/heads/thing.',
    'refs/heads/a..b',
    'refs/heads/a@{b',
    'refs/heads/white space',
    'refs/heads/a\\b',
    'refs/heads/a?b',
    'refs/heads/main\n',
  ]) {
    assert.throws(() => domain.FutureRevision({ ...input, ref: invalid }), {
      code: 'INVALID_ARGUMENT',
    });
  }
});

test('timestamps preserve UTC second or millisecond precision and reject impossible dates', () => {
  const input = fixtures().FutureRevision;
  for (const valid of [now, '2024-02-29T01:02:03Z', '2024-02-29T01:02:03.123Z']) {
    assert.equal(domain.FutureRevision({ ...input, observed_at: valid }).observed_at, valid);
  }
  for (const invalid of [
    '2025-02-29T01:02:03Z',
    '2026-02-30T01:02:03Z',
    '2026-10-09',
    '2026-10-09T24:00:00Z',
    '2026-10-09T00:00:00+00:00',
    '2026-10-09T00:00:00.123456Z',
    now + '\n',
  ]) {
    assert.throws(() => domain.FutureRevision({ ...input, observed_at: invalid }), {
      code: 'INVALID_ARGUMENT',
    });
  }
});

test('Extractor capability and status remain explicit, including failures with no effects', () => {
  const input = fixtures().EffectSet;
  for (const capability of domain.ANALYSIS_CAPABILITIES) {
    for (const status of domain.ANALYSIS_STATUSES) {
      const accepted = domain.EffectSet({ ...input, capability, status, effects: [], security_effects: [] });
      assert.equal(accepted.capability, capability);
      assert.equal(accepted.status, status);
    }
  }
  assert.throws(() => domain.EffectSet({ ...input, status: 'UNKNOWN' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => domain.EffectSet({ ...input, capability: 'AST' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => domain.EffectSet({ ...input, effects: ['a path'] }), { code: 'INVALID_ARGUMENT' });
});

test('CandidateSpec preserves whole-Future selections and rejects duplicate set references', () => {
  const input = fixtures().CandidateSpec;
  assert.deepEqual(domain.CandidateSpec({ ...input, selections: [] }).selections, []);
  const baseOnly = { ...input, selected_future_revisions: [], selections: [], required_dependencies: [] };
  assert.deepEqual(domain.CandidateSpec(baseOnly).selected_future_revisions, []);
  for (const field of ['selected_future_revisions', 'required_dependencies']) {
    assert.throws(() => domain.CandidateSpec({ ...input, [field]: [id('future-revision'), id('future-revision')] }), {
      code: 'INVALID_ARGUMENT',
    });
  }
  assert.throws(() => domain.CandidateSpec({ ...input, base_revision: id('future-revision') }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('Candidate and SystemRevision require nonempty exact state, with independent repo object formats', () => {
  const records = fixtures();
  for (const [type, field] of [['Candidate', 'repo_tree_oids'], ['SystemRevision', 'repositories']]) {
    assert.doesNotThrow(() => domain[type](records[type]));
    for (const mapping of [{}, { 'repo-a': 'main' }, { 'repo-a': oid('0') }]) {
      assert.throws(() => domain[type]({ ...records[type], [field]: mapping }), {
        code: 'INVALID_ARGUMENT',
      });
    }
  }
});

test('explicit object IDs and digests must agree without claiming content verification', () => {
  const records = fixtures();
  for (const type of ['Candidate', 'SystemRevision', 'DeploymentObservation', 'DeploymentAttestation']) {
    const input = records[type];
    assert.throws(() => domain[type]({ ...input, digest: input.digest.replace(/1{64}$/, '2'.repeat(64)) }), {
      code: 'INTEGRITY_MISMATCH',
    });
  }
  assert.throws(() => domain.FutureRevision({ ...records.FutureRevision, id: id('candidate') }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.throws(() => domain.EffectSet({ ...records.EffectSet, digest: digest('decision-basis') }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('Evidence preserves observations and requires an evaluator and retention class', () => {
  const input = fixtures().Evidence;
  for (const result of [null, false, 'FAILED', 2, { status: 'PENDING' }, [1, 2]]) {
    assert.deepEqual(domain.Evidence({ ...input, result }).result, result);
  }
  for (const retention_class of domain.RETENTION_CLASSES) {
    assert.equal(domain.Evidence({ ...input, retention_class }).retention_class, retention_class);
  }
  for (const change of [
    { producer_identity: null },
    { producer_identity: ' ' },
    { retention_class: 'FOREVER' },
    { subject_digest: 'main' },
    { config_digest: 'config-v1' },
    { environment_digest: null },
  ]) {
    assert.throws(() => domain.Evidence({ ...input, ...change }), { code: 'INVALID_ARGUMENT' });
  }
});

test('DecisionBasis rejects wrong digest namespaces and nonexact canonical refs', () => {
  const input = fixtures().DecisionBasis;
  assert.throws(() => domain.DecisionBasis({ ...input, candidate_digests: [digest('object-evidence')] }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.throws(() => domain.DecisionBasis({ ...input, evidence_digests: [digest('object-candidate')] }), {
    code: 'INTEGRITY_MISMATCH',
  });
  assert.throws(() => domain.DecisionBasis({ ...input, candidate_digests: [input.candidate_digests[0], input.candidate_digests[0]] }), {
    code: 'INVALID_ARGUMENT',
  });
  for (const canonical_ref_oids of [
    { 'repo-a': {} },
    { 'repo-a': { main: oid('a') } },
    { 'repo-a': { 'refs/heads/main': 'HEAD' } },
    { 'repo-a': { 'refs/heads/main': oid('0') } },
    { 'repo-a': { 'refs/heads/main': oid('a'), 'refs/tags/v1': oid('b', 64) } },
  ]) {
    assert.throws(() => domain.DecisionBasis({ ...input, canonical_ref_oids }), {
      code: 'INVALID_ARGUMENT',
    });
  }
  assert.throws(() => domain.DecisionBasis({ ...input, required_analysis_status: { semantic: 'UNKNOWN' } }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('PARTIAL remains reviewable but explicitly required incomplete statuses cannot be resolvable', () => {
  const input = fixtures().Decision;
  for (const status of ['PARTIAL', 'FAILED', 'UNSUPPORTED']) {
    const basis = { ...input.basis, required_analysis_status: { semantic: status } };
    assert.equal(domain.Decision({ ...input, basis }).state, 'REVIEWABLE');
    for (const state of ['RESOLVABLE', 'RESOLVED']) {
      const resolution = state === 'RESOLVED' ? { candidate_digest: input.basis.candidate_digests[0] } : null;
      assert.throws(() => domain.Decision({ ...input, state, basis, resolution }), {
        code: 'INVALID_ARGUMENT',
      });
    }
  }
});

test('empty declared analysis requirements are preserved, without inventing policy completeness', () => {
  const input = fixtures().Decision;
  const basis = { ...input.basis, required_analysis_status: {} };
  assert.deepEqual(domain.Decision({ ...input, basis }).basis.required_analysis_status, {});
  assert.deepEqual(domain.Decision({ ...input, state: 'RESOLVABLE', basis }).basis.required_analysis_status, {});
  const missing = { ...basis };
  delete missing.required_analysis_status;
  assert.throws(() => domain.Decision({ ...input, basis: missing }), { code: 'INVALID_ARGUMENT' });
});

test('Decision snapshots bind resolution to a reviewed alternative and forbid impossible combinations', () => {
  const input = fixtures().Decision;
  const resolution = { candidate_digest: input.basis.candidate_digests[0], actor: 'human-a', rationale: 'Choose this approach.' };
  assert.equal(domain.Decision({ ...input, state: 'RESOLVED', resolution }).resolution.candidate_digest, resolution.candidate_digest);
  assert.equal(domain.Decision({ ...input, state: 'DISCOVERED', basis: null }).basis, null);
  for (const state of ['REVIEWABLE', 'RESOLVABLE', 'RESOLVED', 'STALE']) {
    assert.throws(() => domain.Decision({ ...input, state, basis: null, resolution: state === 'RESOLVED' ? resolution : null }), {
      code: 'INVALID_ARGUMENT',
    });
  }
  for (const state of ['DISCOVERED', 'REVIEWABLE', 'RESOLVABLE', 'STALE']) {
    assert.throws(() => domain.Decision({ ...input, state, resolution }), { code: 'INVALID_ARGUMENT' });
  }
  for (const invalid of [null, {}, { candidate_digest: digest('object-candidate', 'f') }]) {
    assert.throws(() => domain.Decision({ ...input, state: 'RESOLVED', resolution: invalid }), {
      code: 'INVALID_ARGUMENT',
    });
  }
  assert.throws(() => domain.Decision({ ...input, state: 'RESOLVABLE', basis: { ...input.basis, candidate_digests: [] } }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('SystemRevision retains configuration digests and unique accepted Decision IDs', () => {
  const input = fixtures().SystemRevision;
  assert.deepEqual(domain.SystemRevision({ ...input, configuration_digests: {}, accepted_decisions: [] }).accepted_decisions, []);
  assert.throws(() => domain.SystemRevision({ ...input, accepted_decisions: [id('decision'), id('decision')] }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.throws(() => domain.SystemRevision({ ...input, accepted_decisions: [id('candidate')] }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('ReleaseConstraints allow empty provider-neutral lists and preserve ordered predicates', () => {
  const input = fixtures().ReleaseConstraints;
  const empty = { ...input };
  for (const field of ['ordering_constraints', 'compatibility_requirements', 'preconditions', 'postconditions', 'forward_only_operations']) {
    empty[field] = [];
  }
  assert.deepEqual(domain.ReleaseConstraints(empty), empty);
  assert.throws(() => domain.ReleaseConstraints({ ...input, system_revision_digest: digest('object-candidate') }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('deployment observation states remain distinct and attestations retain exact bindings', () => {
  const records = fixtures();
  for (const status of domain.DEPLOYMENT_STATUSES) {
    assert.equal(domain.DeploymentObservation({ ...records.DeploymentObservation, status }).status, status);
  }
  assert.throws(() => domain.DeploymentObservation({ ...records.DeploymentObservation, status: 'TIMED_OUT' }), {
    code: 'INVALID_ARGUMENT',
  });
  assert.equal(domain.DeploymentObservation(records.DeploymentObservation).status, 'UNKNOWN');
  assert.throws(() => domain.DeploymentAttestation({ ...records.DeploymentAttestation, observation_digest: digest('object-candidate') }), {
    code: 'INTEGRITY_MISMATCH',
  });
  // A constructor preserves a claimed proof reference; T096 verifies its authority.
  const claimed = { ...records.DeploymentAttestation, proof_ref: 'object://unverified-claim' };
  assert.equal(domain.DeploymentAttestation(claimed).proof_ref, claimed.proof_ref);
});

test('lossy or executable JSON values are rejected rather than dropped or coerced', () => {
  const input = fixtures().Evidence;
  for (const result of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    Number.MAX_SAFE_INTEGER + 1,
    1n,
    Symbol('data'),
    () => true,
    new Date(now),
    new Uint8Array([1]),
    { omitted: undefined },
    { toJSON() { throw new Error('must not run'); } },
    '\ud800',
    { '\udfff': true },
  ]) {
    assert.throws(() => domain.Evidence({ ...input, result }), { code: 'INVALID_ARGUMENT' });
  }
});

test('getters are rejected without invocation, including inherited and array accessors', () => {
  const input = fixtures().Evidence;
  let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { calls += 1; return true; } });
  const arrayAccessor = [true];
  Object.defineProperty(arrayAccessor, '0', { enumerable: true, get() { calls += 1; return true; } });
  const inherited = Object.create({ value: true });
  const nonenumerable = {};
  Object.defineProperty(nonenumerable, 'value', { value: true });
  for (const result of [accessor, arrayAccessor, inherited, nonenumerable]) {
    assert.throws(() => domain.Evidence({ ...input, result }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(calls, 0);
});

test('sparse, decorated and symbolic arrays or objects are rejected without dropping data', () => {
  const input = fixtures().Evidence;
  const sparse = Array(2);
  sparse[1] = true;
  const decorated = [true];
  decorated.annotation = 'retained data';
  const symbolic = {};
  symbolic[Symbol('annotation')] = true;
  const symbolicArray = [true];
  symbolicArray[Symbol('annotation')] = true;
  for (const result of [sparse, decorated, symbolic, symbolicArray]) {
    assert.throws(() => domain.Evidence({ ...input, result }), { code: 'INVALID_ARGUMENT' });
  }
});

test('cycles fail while shared JSON subobjects are copied independently', () => {
  const input = fixtures().Evidence;
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => domain.Evidence({ ...input, result: cyclic }), { code: 'INVALID_ARGUMENT' });
  const shared = { count: 1 };
  const record = domain.Evidence({ ...input, result: { first: shared, second: shared } });
  assert.deepEqual(record.result.first, record.result.second);
  assert.notEqual(record.result.first, record.result.second);
  shared.count = 2;
  assert.equal(record.result.first.count, 1);
});

test('opaque map keys cannot pollute prototypes and identity strings are preserved', () => {
  const input = fixtures().SystemRevision;
  const repositories = JSON.parse('{"__proto__":"' + oid('a') + '","constructor":"' + oid('b') + '"}');
  const record = domain.SystemRevision({ ...input, repositories });
  assert.equal(Object.getPrototypeOf(record.repositories), Object.prototype);
  assert.equal(Object.hasOwn(record.repositories, '__proto__'), true);
  assert.equal(record.repositories.__proto__, oid('a'));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(domain.deserializeDomain('SystemRevision', domain.serializeDomain('SystemRevision', record)), record);
  const future = fixtures().FutureRevision;
  assert.equal(domain.FutureRevision({ ...future, repo_id: 'répo-A' }).repo_id, 'répo-A');
});

test('JSON persistence rejects malformed text and unknown types without dispatching prototypes', () => {
  for (const type of ['__proto__', 'constructor', 'NotAType', null]) {
    assert.throws(() => domain.serializeDomain(type, fixtures().FutureRevision), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => domain.deserializeDomain(type, '{}'), { code: 'INVALID_ARGUMENT' });
  }
  for (const encoded of ['', '{', 'null', '[]', 1]) {
    assert.throws(() => domain.deserializeDomain('FutureRevision', encoded), { code: 'INVALID_ARGUMENT' });
  }
});
