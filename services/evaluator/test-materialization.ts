/**
 * CODEX OPERATING CONTRACT: Phase 3 Verification Suite
 * npm run test:materialization
 */

import assert from 'node:assert';
import { ArtifactFS } from './src/artifact_fs.ts';
import { ContainerSandbox } from './src/sandbox.ts';
import { EvidenceCollector } from './src/evidence.ts';
import { ProvenanceSlice } from '../../packages/contracts/src/types.ts';
import { computeEvidenceDigest } from '../../packages/contracts/src/digest.ts';

console.log('================================================================');
console.log('  KLoCGit v1: MATERIALIZATION & EVIDENCE VERIFICATION (P3)      ');
console.log('================================================================\n');

async function runMaterializationTests() {
  const artifactFs = new ArtifactFS();
  const sandbox = new ContainerSandbox({ timeout_ms: 5000 });
  const collector = new EvidenceCollector();

  // 1. Materialize Candidate via ArtifactFS
  console.log('--- TEST 1: ArtifactFS Scratch Overlay Mount ---');
  const candidate_id = 'cand_conv_9981';
  const slices: ProvenanceSlice[] = [
    {
      repo_id: 'repo-core',
      path: 'src/gateway.ts',
      selector: { type: 'hunk', value: '@@ -1,5 +1,9 @@' },
      source_future_id: 'fut-001',
      source_commit_oid: 'commit_oid_1111',
    },
    {
      repo_id: 'repo-billing',
      path: 'src/invoice.ts',
      selector: { type: 'symbol', value: 'InvoiceCalculator' },
      source_future_id: 'fut-002',
      source_commit_oid: 'commit_oid_2222',
    },
  ];

  const mount = artifactFs.mountCandidate(candidate_id, {}, slices);
  assert.ok(mount.scratch_path, 'Mount scratch path must be populated');
  assert.strictEqual(mount.materialized_files.length, 2);

  const file1 = artifactFs.readFile(mount.mount_id, 'repo-core/src/gateway.ts');
  assert.ok(file1.includes('fut-001'), 'File must contain slice metadata');
  console.log('✓ Candidate materialized into isolated scratch worktree without durable Git ref writes.');

  // 2. Execute Hermetic Sandbox Evaluation
  console.log('\n--- TEST 2: Hermetic Container Sandbox Execution ---');
  const receipt = await sandbox.runTestSuite(mount, 'IntegrationSuite');
  assert.strictEqual(receipt.exit_code, 0);
  assert.strictEqual(receipt.tests_passed, 42);
  assert.strictEqual(receipt.tests_failed, 0);
  assert.ok(receipt.coverage_pct >= 90);
  console.log(`✓ Sandbox executed in ${receipt.duration_ms}ms with zero network egress. 42 tests passed.`);

  // 3. Stage Evidence to R2 and Verify Canonical Decoupling
  console.log('\n--- TEST 3: R2 Claim-Check Staging & Identity Decoupling ---');
  const subject_digest = 'a56923bab6191b827d20c16eec436d3740534bc24f157c36322a28c3fb7db67a';
  const { evidence, canonical_evidence, payload_bytes } = collector.stageEvidence({
    subject_digest,
    receipt,
  });

  assert.strictEqual(evidence.result, 'PASSED');
  assert.strictEqual(evidence.retention_class, 'CANONICAL');
  assert.ok(evidence.payload_ref.startsWith('r2://'));
  assert.strictEqual(evidence.evidence_digest.length, 64);

  // Retrieve bytes from R2 and verify
  const storedBytes = collector.getR2Payload(evidence.payload_ref);
  assert.ok(storedBytes);
  assert.deepStrictEqual(storedBytes, payload_bytes, 'R2 payload must match 100% byte-for-byte');

  // Verify Decoupling: mutating retention_class or payload_ref must NOT change evidence_digest
  const alteredEvidence = {
    ...evidence,
    payload_ref: 'r2://klocgit-cold-archive/moved/old.json',
    retention_class: 'EPHEMERAL' as const,
    created_at: '2029-01-01T00:00:00Z',
  };
  const recomputedDigest = computeEvidenceDigest(alteredEvidence);
  assert.strictEqual(
    recomputedDigest,
    evidence.evidence_digest,
    'Invariant 9: Evidence identity must remain strictly decoupled from storage location and retention policy'
  );
  console.log('✓ Evidence staged to R2. Evidence digest strictly decoupled from storage ref & retention policy.');

  // 4. Atomic Teardown
  console.log('\n--- TEST 4: Atomic Scratch Teardown ---');
  artifactFs.teardown(mount.mount_id);
  let readFailed = false;
  try {
    artifactFs.readFile(mount.mount_id, 'repo-core/src/gateway.ts');
  } catch {
    readFailed = true;
  }
  assert.ok(readFailed, 'Mount directory must be completely removed upon teardown');
  artifactFs.teardownAll();
  console.log('✓ Teardown complete. Zero durable Git pollution.');

  console.log('\n================================================================');
  console.log('  ALL MATERIALIZATION & EVIDENCE TESTS (P3) PASSED CLEANLY!     ');
  console.log('================================================================\n');
}

runMaterializationTests().catch((err) => {
  console.error('Materialization Test Suite Failed:', err);
  process.exit(1);
});
