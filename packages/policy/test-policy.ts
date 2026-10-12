/**
 * CODEX OPERATING CONTRACT: Phase 5 Verification Suite
 * npm run test:policy
 */

import assert from 'node:assert';
import { PolicyDecisionEngine, PromotionGate } from './src/policy.ts';
import { ExternalCDAttestationClient } from '../../services/attestation/src/client.ts';
import { Decision } from '../contracts/src/types.ts';

console.log('================================================================');
console.log('  KLoCGit v1: POLICY ENGINE & ATTESTATION VERIFICATION (P5)     ');
console.log('================================================================\n');

async function runPolicyTests() {
  const policyEngine = new PolicyDecisionEngine();
  const cdClient = new ExternalCDAttestationClient();

  // Test 1: Incomplete Analysis strictly blocks resolution (Invariant 5)
  console.log('--- TEST 1: Invariant 5 Enforcement (Blocked on Incomplete Analysis) ---');
  const incompleteDecision: Decision = {
    id: 'dec_incomplete_001',
    objective_id: 'obj_001',
    basis: {
      candidate_digests: ['cand_001'],
      evidence_digests: ['ev_001'],
      material_effect_digest: 'eff_001',
      policy_digest: 'pol_001',
      canonical_ref_oids: { 'repo-core': 'oid_1' },
      required_analysis_status: {
        'ast-structural': 'COMPLETE',
        'security-sast': 'PARTIAL', // INCOMPLETE!
      },
      basis_digest: '',
    },
    state: 'DISCOVERED',
    conditional_predicates: [
      { kind: 'ANALYSIS_COMPLETE', subject: 'obj_001' },
      { kind: 'EVIDENCE_PASSED', subject: 'cand_001' },
    ],
  };

  const evalIncomplete = policyEngine.evaluate(incompleteDecision, 'TECH_LEAD', 'lead-user');
  assert.strictEqual(evalIncomplete.allowed, false);
  assert.ok(evalIncomplete.blocked_reason?.includes('INVARIANT_5_VIOLATION'));
  console.log('✓ Invariant 5 verified: Decision with PARTIAL analysis strictly blocked.');

  // Test 2: Unauthorized Role Sign-Off Blocked
  console.log('\n--- TEST 2: Role-Based Authorization & Human Sign-Off ---');
  const validDecision: Decision = {
    id: 'dec_valid_002',
    objective_id: 'obj_002',
    basis: {
      candidate_digests: ['cand_002'],
      evidence_digests: ['ev_002'],
      material_effect_digest: 'eff_002',
      policy_digest: 'pol_002',
      canonical_ref_oids: { 'repo-core': 'oid_1' },
      required_analysis_status: {
        'ast-structural': 'COMPLETE',
        'security-sast': 'COMPLETE',
      },
      basis_digest: '',
    },
    state: 'REVIEWABLE',
    conditional_predicates: [
      { kind: 'ANALYSIS_COMPLETE', subject: 'obj_002' },
      { kind: 'EVIDENCE_PASSED', subject: 'cand_002' },
    ],
  };

  // Bot role attempted sign-off (MUST FAIL)
  const evalBot = policyEngine.evaluate(validDecision, 'AGENT', 'autonomous-bot');
  assert.strictEqual(evalBot.allowed, false);
  assert.ok(evalBot.blocked_reason?.includes('not authorized'));
  console.log('✓ Invariant 4 verified: AI/Agent role cannot autonomously sign off.');

  // Authorized Tech Lead sign-off (MUST SUCCEED)
  const resolved = policyEngine.resolveDecision(validDecision, 'TECH_LEAD', 'alice@enterprise.com');
  assert.strictEqual(resolved.state, 'RESOLVED');
  assert.ok(resolved.resolved_by?.includes('alice@enterprise.com'));
  console.log('✓ Authorized human sign-off transitioned decision to RESOLVED.');

  // Test 3: Promotion Gate releases CAS Lock only on RESOLVED state
  console.log('\n--- TEST 3: Promotion Gating ---');
  assert.doesNotThrow(() => PromotionGate.assertPromotionAllowed(resolved));

  let gateFailed = false;
  try {
    PromotionGate.assertPromotionAllowed(incompleteDecision);
  } catch (err: any) {
    gateFailed = true;
    assert.ok(err.message.includes('PROMOTION_BLOCKED'));
  }
  assert.strictEqual(gateFailed, true, 'Unresolved decision must be blocked from Git push promotion');
  console.log('✓ PromotionGate verified: CAS push unlocked only for RESOLVED decisions.');

  // Test 4: External CD Attestation Ingestion (Invariant 7)
  console.log('\n--- TEST 4: External CD Deployment Attestation ---');
  const sysStateDigest = '2285b8b1d7024d09db873c69560bb93bddde9f3723a3b8ed1fae90897b63b731';
  const intent = await cdClient.submitDeploymentIntent(sysStateDigest, 'production', {
    'repo-core': 'oid_1',
    'repo-billing': 'oid_2',
  });
  assert.ok(intent.intent_id.startsWith('intent_'));

  const attestation = await cdClient.generateAttestation(intent);
  assert.strictEqual(attestation.observed_state, 'SUCCEEDED');
  assert.strictEqual(attestation.attestation_digest.length, 64);
  assert.ok(attestation.attestation_payload_ref.startsWith('r2://'));
  console.log('✓ Invariant 7 verified: External CD deployment intent submitted and immutable attestation ingested.');

  console.log('\n================================================================');
  console.log('  ALL POLICY & ATTESTATION TESTS (P5) PASSED CLEANLY!           ');
  console.log('================================================================\n');
}

runPolicyTests().catch((err) => {
  console.error('Policy Test Suite Failed:', err);
  process.exit(1);
});
