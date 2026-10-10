import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildDecisionBasis,
  ConditionalReview,
  verifyDecisionBasis,
} from '../../core/v1/decisions.mjs';

const { vectors } = JSON.parse(
  readFileSync(new URL('./encoding.golden.json', import.meta.url), 'utf8'),
);
const golden = vectors.find((vector) => vector.name === 'decision-basis-identity');

test('DecisionBasis identity matches the independent Python golden digest', async () => {
  const input = structuredClone(golden.value);
  input.candidate_digests.reverse();
  input.evidence_digests.reverse();
  const basis = await buildDecisionBasis(input);
  assert.equal(basis.digest, golden.digest);
  assert.deepEqual(await verifyDecisionBasis(basis), basis);
});

test('copied basis digests cannot hide changes to canonical state or policy', async () => {
  for (const field of ['canonical_ref_oids', 'policy_digest', 'required_analysis_status']) {
    const input = { ...structuredClone(golden.value), digest: golden.digest };
    if (field === 'canonical_ref_oids')
      input.canonical_ref_oids.repo['refs/heads/main'] = 'b'.repeat(40);
    if (field === 'policy_digest') input.policy_digest = 'sha256:policy:v1:' + '2'.repeat(64);
    if (field === 'required_analysis_status')
      input.required_analysis_status['git.path'] = 'PARTIAL';
    await assert.rejects(verifyDecisionBasis(input), { code: 'INTEGRITY_MISMATCH' }, field);
  }
});

test('a configuration digest cannot be substituted for the reviewed code delta', () => {
  const review = {
    schema_version: 1,
    decision_id: 'klocgit:decision:v1:sha256:' + '1'.repeat(64),
    basis: { ...golden.value, digest: golden.digest },
    reviewed_delta_digest: 'sha256:configuration:v1:' + '1'.repeat(64),
    allow_late_non_material_evidence: false,
    predicates: [],
  };
  assert.throws(() => ConditionalReview(review), { code: 'INTEGRITY_MISMATCH' });
});
