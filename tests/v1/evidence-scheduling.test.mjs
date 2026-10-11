import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceScheduler } from '../../core/v1/evidence-scheduling.mjs';
import { buildEvidence, candidateEvidenceSubject } from '../../core/v1/evidence.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';

async function fixture() {
  const candidate = await materializedCandidate(
    'klocgit:candidate-spec:v1:sha256:' + 'a'.repeat(64),
    { repo: 'b'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { repo: 'c'.repeat(40) } },
  );
  const subject = await candidateEvidenceSubject(candidate);
  const environment_digest = await digestCanonical('evaluation-environment', { runtime: '1' });
  const checks = await Promise.all(
    ['build', 'integration', 'tests'].map(async (id) => ({
      schema_version: 1,
      id,
      type: id,
      config_digest: await digestCanonical('evaluation-config', { check: id }),
      environment_digest,
      producers: [{ schema_version: 1, identity: 'evaluator', versions: ['1'] }],
    })),
  );
  const requirements = {
    schema_version: 1,
    policy_digest: await digestCanonical('policy', { checks: checks.map(({ id }) => id) }),
    checks,
  };
  const trusted = new Set();
  const evidence = async (check, overrides = {}) => {
    const record = await buildEvidence({
      schema_version: 1,
      subject_digest: subject.digest,
      type: check.type,
      producer_identity: 'evaluator',
      producer_version: '1',
      config_digest: check.config_digest,
      environment_digest,
      result: { status: 'PASSING', basis: 'OBSERVED' },
      payload_ref: 'receipt:' + check.id,
      created_at: '2026-10-11T00:00:00Z',
      retention_class: 'DECISION_RECORD',
      ...overrides,
    });
    trusted.add(record.id);
    return record;
  };
  const calls = [],
    reusable = [];
  const options = {
    limits: { schema_version: 1, max_checks: 10, max_records: 20, max_evaluations: 10 },
    verifyProvenance: async (record) => trusted.has(record.id),
    policyEvaluator: { can_reuse: async () => true },
    provider: {
      find_reusable: async (digest) => {
        calls.push(['find', digest]);
        return reusable;
      },
      evaluate: async (input, required) => {
        assert.equal(input.digest, candidate.digest);
        calls.push(['evaluate', ...required.checks.map(({ id }) => id)]);
        return Promise.all(required.checks.map((check) => evidence(check)));
      },
    },
  };
  return { candidate, subject, requirements, evidence, options, calls, reusable, trusted };
}

test('matching isolated evidence is reused before only missing checks run', async () => {
  const f = await fixture();
  f.reusable.push(await f.evidence(f.requirements.checks[0]));
  const result = await new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements);
  assert.deepEqual(
    f.calls.map(([operation, id]) => [operation, id]),
    [
      ['find', f.subject.digest],
      ['evaluate', 'integration'],
      ['evaluate', 'tests'],
    ],
  );
  assert.deepEqual(
    result.plan.checks.map(({ state }) => state),
    ['REUSED', 'EVALUATED', 'EVALUATED'],
  );
  assert.equal(result.evidence.length, 3);
});

test('stale state, config, environment or provenance causes exact-state reevaluation', async () => {
  const f = await fixture();
  for (const check of f.requirements.checks)
    f.reusable.push(
      await f.evidence(check, {
        subject_digest: await digestCanonical('evidence-subject', { old: true }),
      }),
    );
  const result = await new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements);
  assert.ok(result.evidence.every((record) => record.subject_digest === f.subject.digest));
  assert.ok(result.plan.checks.every(({ state }) => state === 'EVALUATED'));
  for (const overrides of [
    { config_digest: await digestCanonical('evaluation-config', { changed: true }) },
    { environment_digest: await digestCanonical('evaluation-environment', { changed: true }) },
    { producer_version: 'untrusted' },
  ]) {
    f.reusable.splice(0, f.reusable.length, await f.evidence(f.requirements.checks[0], overrides));
    await new EvidenceScheduler(f.options).evaluate(f.candidate, {
      ...f.requirements,
      checks: [f.requirements.checks[0]],
    });
    assert.deepEqual(f.calls.at(-1), ['evaluate', 'build']);
  }
});

test('composed state cannot inherit isolated evidence and full-suite work requires policy', async () => {
  const f = await fixture();
  const composed = await materializedCandidate(
    f.candidate.candidate_spec_id,
    { repo: 'd'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { repo: 'e'.repeat(40) } },
  );
  f.reusable.push(await f.evidence(f.requirements.checks[0]));
  f.options.provider.evaluate = async (candidate, requirements) => {
    f.calls.push(['evaluate', ...requirements.checks.map(({ id }) => id)]);
    const subject = await candidateEvidenceSubject(candidate);
    return Promise.all(
      requirements.checks.map((check) => f.evidence(check, { subject_digest: subject.digest })),
    );
  };
  const result = await new EvidenceScheduler(f.options).evaluate(composed, {
    ...f.requirements,
    checks: [f.requirements.checks[0]],
  });
  assert.deepEqual(f.calls.at(-1), ['evaluate', 'build']);
  assert.equal(result.evidence.length, 1);
  const calls = f.calls.length;
  const empty = await new EvidenceScheduler(f.options).evaluate(composed, {
    ...f.requirements,
    checks: [],
  });
  assert.equal(empty.plan.checks.length, 0);
  assert.equal(f.calls.length, calls);
});

test('budget exhaustion defers unresolved checks and never drops their requirements', async () => {
  const f = await fixture();
  f.options.limits.max_evaluations = 1;
  const result = await new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements);
  assert.deepEqual(
    result.plan.checks.map(({ state }) => state),
    ['EVALUATED', 'DEFERRED', 'DEFERRED'],
  );
  assert.equal(f.calls.filter(([operation]) => operation === 'evaluate').length, 1);
  assert.equal(result.plan.checks.length, f.requirements.checks.length);
});

test('contradictory authenticated observations remain visible instead of choosing the passing one', async () => {
  const f = await fixture();
  const check = f.requirements.checks[0];
  f.reusable.push(await f.evidence(check));
  f.reusable.push(
    await f.evidence(check, {
      result: { status: 'FAILED', basis: 'OBSERVED' },
      payload_ref: 'failed-observation',
    }),
  );
  const result = await new EvidenceScheduler(f.options).evaluate(f.candidate, {
    ...f.requirements,
    checks: [check],
  });
  assert.equal(result.evidence.length, 2);
  assert.equal(result.plan.checks[0].evidence_ids.length, 2);
  assert.equal(f.calls.length, 1);
});

test('substitution, provider outages and untrusted new observations fail explicitly', async () => {
  const f = await fixture();
  await assert.rejects(
    new EvidenceScheduler(f.options).evaluate(
      { ...f.candidate, repo_tree_oids: { repo: 'f'.repeat(40) } },
      f.requirements,
    ),
    { code: 'INTEGRITY_MISMATCH' },
  );
  assert.equal(f.calls.length, 0);
  f.options.provider.find_reusable = async () => {
    throw new Error('private-provider-data');
  };
  await assert.rejects(new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements), {
    code: 'PROVIDER_UNAVAILABLE',
    message: 'The provider is unavailable.',
  });
  f.options.provider.find_reusable = async () => [];
  f.options.verifyProvenance = async () => false;
  await assert.rejects(new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements), {
    code: 'POLICY_REJECTED',
  });
});

test('missing evaluator output stays missing and bounded responses cannot bypass limits', async () => {
  const f = await fixture();
  f.options.provider.evaluate = async () => [];
  const result = await new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements);
  assert.ok(result.plan.checks.every(({ state }) => state === 'MISSING'));
  f.options.limits.max_checks = 1;
  await assert.rejects(new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements), {
    code: 'INCOMPLETE_ANALYSIS',
  });
  f.options.limits.max_checks = 10;
  f.options.limits.max_records = 1;
  f.reusable.push(
    await f.evidence(f.requirements.checks[0]),
    await f.evidence(f.requirements.checks[1]),
  );
  await assert.rejects(new EvidenceScheduler(f.options).evaluate(f.candidate, f.requirements), {
    code: 'INCOMPLETE_ANALYSIS',
  });
});
