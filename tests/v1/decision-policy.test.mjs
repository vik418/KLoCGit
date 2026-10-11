import assert from 'node:assert/strict';
import test from 'node:test';
import { createCandidatePolicy } from '../../core/v1/decision-policy.mjs';
import { materializedCandidate } from '../../core/v1/materialization.mjs';
import {
  buildEvidence,
  candidateEvidenceSubject,
  verifyEvidence,
} from '../../core/v1/evidence.mjs';
import { buildDecisionBasis } from '../../core/v1/decisions.mjs';
import { digestCanonical } from '../../core/v1/encoding.mjs';
import { objectId } from '../../core/v1/conventions.mjs';

async function fixture() {
  const spec = objectId(
    'candidate-spec',
    await digestCanonical('object-candidate-spec', { selections: ['isolated'] }),
  );
  const candidate = await materializedCandidate(
    spec,
    { app: 'a'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { app: 'b'.repeat(40) } },
  );
  const other = await materializedCandidate(
    spec,
    { app: 'c'.repeat(40) },
    { schema_version: 1, repo_commit_oids: { app: 'd'.repeat(40) } },
  );
  const subject = await candidateEvidenceSubject(candidate);
  const config_digest = await digestCanonical('evaluation-config', { check: 'registered' });
  const environment_digest = await digestCanonical('evaluation-environment', { runtime: 'pinned' });
  const policy_digest = await digestCanonical('policy', { required: ['semantic', 'test'] });
  const requirements = {
    schema_version: 1,
    policy_digest,
    checks: [
      {
        schema_version: 1,
        id: 'test',
        type: 'test',
        config_digest,
        environment_digest,
        producers: [{ schema_version: 1, identity: 'evaluator', versions: ['1'] }],
      },
    ],
  };
  const evidenceBody = {
    schema_version: 1,
    subject_digest: subject.digest,
    type: 'test',
    producer_identity: 'evaluator',
    producer_version: '1',
    config_digest,
    environment_digest,
    result: { basis: 'OBSERVED', status: 'PASSING' },
    payload_ref: 'retained-result',
    created_at: '2026-10-11T00:00:00Z',
    retention_class: 'DECISION_RECORD',
  };
  const evidence = await buildEvidence(evidenceBody);
  const authenticated = new Set([evidence.id]);
  const basis = async (records) =>
    buildDecisionBasis({
      schema_version: 1,
      candidate_digests: [candidate.digest, other.digest],
      evidence_digests: await Promise.all(
        records.map(async (record) => (await verifyEvidence(record)).digest),
      ),
      material_effect_digest: await digestCanonical('material-effect', { changed: ['app'] }),
      policy_digest,
      canonical_ref_oids: { app: { 'refs/heads/main': 'e'.repeat(40) } },
      required_analysis_status: { semantic: 'COMPLETE' },
    });
  const policy = (selected, records, changes = {}) =>
    createCandidatePolicy({
      candidate: selected,
      requirements,
      required_analysis: ['semantic'],
      evidence: records,
      verifyProvenance: (record) => authenticated.has(record.id),
      canReuse: () => true,
      max_evidence: 10,
      ...changes,
    });
  return { candidate, other, evidence, evidenceBody, authenticated, basis, policy };
}

test('exact authenticated observations authorize only their selected Candidate', async () => {
  const f = await fixture(),
    basis = await f.basis([f.evidence]);
  const matching = await f.policy(f.candidate, [f.evidence]);
  assert.equal(await matching.can_resolve(basis), true);
  assert.deepEqual(matching.required_analysis(), ['semantic']);
  assert.equal(await (await f.policy(f.other, [f.evidence])).can_resolve(basis), false);
  assert.equal(
    await (
      await f.policy(f.candidate, [f.evidence], { verifyProvenance: () => false })
    ).can_resolve(basis),
    false,
  );
  assert.equal(
    await (await f.policy(f.candidate, [f.evidence], { canReuse: () => false })).can_resolve(basis),
    false,
  );
});

test('config, environment, producer and subject replay cannot satisfy required checks', async () => {
  const f = await fixture();
  const changes = [
    { config_digest: await digestCanonical('evaluation-config', { changed: true }) },
    { environment_digest: await digestCanonical('evaluation-environment', { changed: true }) },
    { producer_identity: 'producer' },
    { producer_version: '2' },
    { subject_digest: (await candidateEvidenceSubject(f.other)).digest },
  ];
  for (const change of changes) {
    const replay = await buildEvidence({ ...f.evidenceBody, ...change });
    f.authenticated.add(replay.id);
    assert.equal(
      await (await f.policy(f.candidate, [replay])).can_resolve(await f.basis([replay])),
      false,
    );
  }
});

test('failed, cancelled, pending, declared and contradictory observations remain unresolved', async () => {
  const f = await fixture();
  for (const result of [
    { basis: 'OBSERVED', status: 'FAILED' },
    { basis: 'OBSERVED', status: 'CANCELLED' },
    { basis: 'OBSERVED', status: 'PENDING' },
    { basis: 'DECLARED', status: 'PASSING' },
  ]) {
    const record = await buildEvidence({ ...f.evidenceBody, result });
    f.authenticated.add(record.id);
    const records = [f.evidence, record];
    assert.equal(
      await (await f.policy(f.candidate, records)).can_resolve(await f.basis(records)),
      false,
    );
  }
});

test('unreviewed observations, missing records and copied content identities cannot authorize', async () => {
  const f = await fixture();
  assert.equal(
    await (await f.policy(f.candidate, [f.evidence])).can_resolve(await f.basis([])),
    false,
  );
  assert.equal(
    await (await f.policy(f.candidate, [])).can_resolve(await f.basis([f.evidence])),
    false,
  );
  const copied = { ...f.evidence, result: { basis: 'OBSERVED', status: 'FAILED' } };
  await assert.rejects(
    (await f.policy(f.candidate, [copied])).can_resolve(await f.basis([f.evidence])),
    { code: 'INTEGRITY_MISMATCH' },
  );
  await assert.rejects(f.policy(f.candidate, [f.evidence, f.evidence], { max_evidence: 1 }), {
    code: 'INCOMPLETE_ANALYSIS',
  });
});
