import assert from 'node:assert/strict';
import test from 'node:test';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';
import {
  EvidenceProvider,
  buildEvidence,
  verifyEvidence,
  evidenceSubject,
  candidateEvidenceSubject,
  evidenceRequirements,
  evidenceEligibility,
} from '../../core/v1/evidence.mjs';

async function fixture() {
  const config_digest = await digestCanonical('evaluation-config', { command: 'tests' });
  const environment_digest = await digestCanonical('evaluation-environment', {
    toolchain: 'test-runtime',
  });
  const policy_digest = await digestCanonical('policy', { required: ['tests'] });
  const subject = await evidenceSubject({
    schema_version: 1,
    repo_tree_oids: { repo: 'a'.repeat(40) },
    repo_commit_oids: { repo: 'b'.repeat(40) },
  });
  const requirements = {
    schema_version: 1,
    policy_digest,
    checks: [
      {
        schema_version: 1,
        id: 'tests',
        type: 'tests',
        config_digest,
        environment_digest,
        producers: [{ schema_version: 1, identity: 'trusted-ci', versions: ['1.0'] }],
      },
    ],
  };
  const evidence = await buildEvidence({
    schema_version: 1,
    subject_digest: subject.digest,
    type: 'tests',
    producer_identity: 'trusted-ci',
    producer_version: '1.0',
    config_digest,
    environment_digest,
    result: { status: 'PASSING', basis: 'OBSERVED' },
    payload_ref: 'evidence:receipt-1',
    created_at: '2026-10-11T00:00:00Z',
    retention_class: 'DECISION_RECORD',
  });
  const verifiedReceipts = new Set([evidence.id]);
  const options = {
    verifyProvenance: async (record) => verifiedReceipts.has(record.id),
    policyEvaluator: {
      can_reuse: async (record, check, context) =>
        context.policy_digest === policy_digest &&
        check.id === 'tests' &&
        record.result.status === 'PASSING' &&
        record.result.basis === 'OBSERVED',
    },
  };
  return { subject, evidence, requirements, verifiedReceipts, options };
}

test('Evidence identity binds exact observation data and is checked independently of its supplied ID', async () => {
  const f = await fixture();
  const verified = await verifyEvidence(f.evidence);
  assert.ok(verified.digest.startsWith('sha256:object-evidence:v1:'));
  assert.equal(verified.evidence.id, f.evidence.id);
  await assert.rejects(verifyEvidence({ ...f.evidence, result: { status: 'FAILED' } }), {
    code: 'INTEGRITY_MISMATCH',
  });
  await assert.rejects(verifyEvidence({ ...f.evidence, payload_ref: 'substituted' }), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('exact-state subjects bind every repository tree and commit while preserving set ordering', async () => {
  const f = await fixture();
  const changedCommit = await evidenceSubject({
    schema_version: 1,
    repo_tree_oids: f.subject.repo_tree_oids,
    repo_commit_oids: { repo: 'c'.repeat(40) },
  });
  assert.notEqual(changedCommit.digest, f.subject.digest);
  const composed = await evidenceSubject({
    schema_version: 1,
    repo_tree_oids: { ...f.subject.repo_tree_oids, other: 'd'.repeat(40) },
    repo_commit_oids: { ...f.subject.repo_commit_oids, other: 'e'.repeat(40) },
  });
  assert.notEqual(composed.digest, f.subject.digest);
  const reordered = await evidenceSubject({
    schema_version: 1,
    repo_tree_oids: { other: 'd'.repeat(40), repo: 'a'.repeat(40) },
    repo_commit_oids: { other: 'e'.repeat(40), repo: 'b'.repeat(40) },
  });
  assert.equal(reordered.digest, composed.digest);
  await assert.rejects(
    evidenceSubject({
      schema_version: 1,
      repo_tree_oids: f.subject.repo_tree_oids,
      repo_commit_oids: {},
    }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('subject, configuration, environment, producer and version mismatches prevent reuse', async () => {
  const f = await fixture();
  const cases = [
    [
      { subject_digest: await digestCanonical('evidence-subject', { different: true }) },
      'SUBJECT_MISMATCH',
    ],
    [
      { config_digest: await digestCanonical('evaluation-config', { changed: true }) },
      'CONFIG_MISMATCH',
    ],
    [
      { environment_digest: await digestCanonical('evaluation-environment', { changed: true }) },
      'ENVIRONMENT_MISMATCH',
    ],
    [{ producer_identity: 'producer-controlled' }, 'PRODUCER_MISMATCH'],
    [{ producer_version: '2.0' }, 'PRODUCER_MISMATCH'],
    [{ type: 'build' }, 'TYPE_MISMATCH'],
  ];
  const body = { ...f.evidence };
  delete body.id;
  for (const [overrides, reason] of cases) {
    const record = await buildEvidence({ ...body, ...overrides });
    const report = await evidenceEligibility(record, f.subject.digest, f.requirements, f.options);
    assert.deepEqual(report.eligible_for, []);
    assert.deepEqual(report.rejections, [{ check_id: 'tests', reason }]);
  }
});

test('producer declarations and passing results do not replace authenticated provenance or current policy', async () => {
  const f = await fixture();
  const eligible = await evidenceEligibility(
    f.evidence,
    f.subject.digest,
    f.requirements,
    f.options,
  );
  assert.deepEqual(eligible.eligible_for, ['tests']);
  f.verifiedReceipts.clear();
  assert.equal(
    (await evidenceEligibility(f.evidence, f.subject.digest, f.requirements, f.options))
      .rejections[0].reason,
    'UNVERIFIED_PROVENANCE',
  );
  f.verifiedReceipts.add(f.evidence.id);
  const changedPolicy = {
    ...f.requirements,
    policy_digest: await digestCanonical('policy', { required: ['security'] }),
  };
  assert.equal(
    (await evidenceEligibility(f.evidence, f.subject.digest, changedPolicy, f.options))
      .rejections[0].reason,
    'POLICY_REJECTED',
  );
  const inferred = await buildEvidence({
    ...Object.fromEntries(Object.entries(f.evidence).filter(([key]) => key !== 'id')),
    result: { status: 'PASSING', basis: 'INFERRED' },
  });
  f.verifiedReceipts.add(inferred.id);
  assert.equal(
    (await evidenceEligibility(inferred, f.subject.digest, f.requirements, f.options)).rejections[0]
      .reason,
    'POLICY_REJECTED',
  );
});

test('EvidenceProvider filters ineligible reuse, deduplicates immutable records and enforces bounds', async () => {
  const f = await fixture();
  const other = await buildEvidence({
    ...Object.fromEntries(Object.entries(f.evidence).filter(([key]) => key !== 'id')),
    subject_digest: await digestCanonical('evidence-subject', []),
  });
  const provider = {
    find_reusable: async () => [other, f.evidence, f.evidence],
    evaluate: async () => [],
  };
  const facade = new EvidenceProvider({ provider, ...f.options, max_records: 3 });
  assert.deepEqual(await facade.find_reusable(f.subject.digest, f.requirements), [f.evidence]);
  const bounded = new EvidenceProvider({ provider, ...f.options, max_records: 2 });
  await assert.rejects(bounded.find_reusable(f.subject.digest, f.requirements), {
    code: 'INVALID_ARGUMENT',
  });
  provider.find_reusable = async () => [{ ...f.evidence, result: false }];
  const forged = new EvidenceProvider({ provider, ...f.options, max_records: 3 });
  await assert.rejects(forged.find_reusable(f.subject.digest, f.requirements), {
    code: 'INTEGRITY_MISMATCH',
  });
});

test('new evaluation verifies its Candidate and rejects Evidence for a different composed state', async () => {
  const f = await fixture();
  const candidate = await materializedCandidate(
    'klocgit:candidate-spec:v1:sha256:' + 'a'.repeat(64),
    f.subject.repo_tree_oids,
    { schema_version: 1, repo_commit_oids: f.subject.repo_commit_oids },
  );
  assert.equal((await candidateEvidenceSubject(candidate)).digest, f.subject.digest);
  const facade = new EvidenceProvider({
    provider: { find_reusable: async () => [], evaluate: async () => [f.evidence] },
    ...f.options,
    max_records: 1,
  });
  assert.deepEqual(await facade.evaluate(candidate, f.requirements), [f.evidence]);
  const composition = await materializedCandidate(
    candidate.candidate_spec_id,
    { repo: 'c'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { repo: 'd'.repeat(40) } },
  );
  await assert.rejects(facade.evaluate(composition, f.requirements), { code: 'POLICY_REJECTED' });
  await assert.rejects(
    facade.evaluate({ ...candidate, repo_tree_oids: composition.repo_tree_oids }, f.requirements),
    { code: 'INTEGRITY_MISMATCH' },
  );
});

test('requirements are immutable, explicitly versioned and reject accidental permissive policies', async () => {
  const f = await fixture();
  const request = structuredClone(f.requirements);
  const normalized = evidenceRequirements(request);
  request.checks[0].producers[0].versions.push('anything');
  assert.deepEqual(normalized.checks[0].producers[0].versions, ['1.0']);
  assert.ok(Object.isFrozen(normalized.checks[0]));
  for (const invalid of [
    { ...f.requirements, checks: [f.requirements.checks[0], f.requirements.checks[0]] },
    { ...f.requirements, checks: [{ ...f.requirements.checks[0], producers: [] }] },
  ])
    assert.throws(() => evidenceRequirements(invalid), { code: 'INVALID_ARGUMENT' });
});

test('asynchronous provider calls cannot observe a caller-substituted requirement snapshot', async () => {
  const f = await fixture();
  let received;
  const facade = new EvidenceProvider({
    provider: {
      find_reusable: async (_subject, requirements) => {
        await Promise.resolve();
        received = requirements;
        return [f.evidence];
      },
      evaluate: async () => [],
    },
    ...f.options,
    max_records: 1,
  });
  const request = structuredClone(f.requirements);
  const pending = facade.find_reusable(f.subject.digest, request);
  request.checks[0].config_digest = await digestCanonical('evaluation-config', {
    substituted: true,
  });
  assert.deepEqual(await pending, [f.evidence]);
  assert.equal(received.checks[0].config_digest, f.evidence.config_digest);
});

test('provider and policy outages cannot leak diagnostics or silently establish eligibility', async () => {
  const f = await fixture();
  const unavailable = async () => {
    throw new Error('private credential-bearing diagnostic');
  };
  const facade = new EvidenceProvider({
    provider: { find_reusable: unavailable, evaluate: async () => [] },
    ...f.options,
    max_records: 1,
  });
  await assert.rejects(facade.find_reusable(f.subject.digest, f.requirements), {
    code: 'PROVIDER_UNAVAILABLE',
  });
  await assert.rejects(
    evidenceEligibility(f.evidence, f.subject.digest, f.requirements, {
      ...f.options,
      verifyProvenance: unavailable,
    }),
    { code: 'PROVIDER_UNAVAILABLE' },
  );
});
