import assert from 'node:assert';
import {
  CanonicalFutureRevisionState,
  CanonicalFutureRevisionRecord,
  CanonicalEffectSet,
  CanonicalCandidateSpec,
  CanonicalCandidate,
  CanonicalEvidence,
  CanonicalDecisionBasis,
  CanonicalSystemRevisionState,
  CanonicalSystemRevisionRecord,
  CanonicalReleaseConstraints,
  CanonicalDeploymentAttestation,
  FutureRevision,
  EffectSet,
  Evidence,
  computeFutureRevisionStateDigest,
  computeFutureRevisionRecordDigest,
  computeEffectDigest,
  computeCandidateSpecDigest,
  computeCandidateDigest,
  computeEvidenceDigest,
  computeDecisionBasisDigest,
  computeSystemRevisionStateDigest,
  computeSystemRevisionRecordDigest,
  computeReleaseConstraintsDigest,
  computeDeploymentAttestationDigest,
  computePayloadDigest,
  encodeCBOR,
  sortStrings,
} from './src/index.ts';

console.log('--- RUNNING CONTRACTS & CANONICAL DIGEST SUITE ---');

// Test 1: Three-Tier Digest Architecture & Invariant Separation
{
  const state: CanonicalFutureRevisionState = {
    repo_id: 'repo-core',
    commit_oid: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    tree_oid: '0123456789abcdef0123456789abcdef01234567',
    parent_oids: ['parent1', 'parent2'],
  };
  const state_digest = computeFutureRevisionStateDigest(state);
  assert.strictEqual(state_digest.length, 64, 'state_digest must be 64-character SHA-256 hex');

  const futureRev: FutureRevision = {
    id: 'fut-001',
    system_id: 'sys-01',
    ref: 'refs/heads/feature-x',
    state_digest,
    producer: {
      actor_id: 'agent-kloc',
      agent_version: '2.1.0',
      task_id: 'task-42',
      prompt_digest: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
    },
    record_digest: '',
    observed_at: '2026-10-12T00:00:00Z', // Volatile - must be excluded from hash
  };

  const record_digest = computeFutureRevisionRecordDigest(futureRev);
  assert.strictEqual(record_digest.length, 64, 'record_digest must be 64-character SHA-256 hex');

  // Mutating volatile metadata must NOT change record_digest
  const futureRevPerturbed: FutureRevision = {
    ...futureRev,
    observed_at: '2029-01-01T12:34:56Z',
  };
  assert.strictEqual(
    computeFutureRevisionRecordDigest(futureRevPerturbed),
    record_digest,
    'Volatile metadata observed_at must be stripped from hash'
  );

  const raw_payload = 'raw payload string';
  const payload_digest = computePayloadDigest(raw_payload);
  assert.strictEqual(payload_digest.length, 64, 'payload_digest must be 64-character SHA-256 hex');

  // Identity Separation Invariant
  assert.notStrictEqual(state_digest, record_digest, 'state_digest and record_digest must be decoupled');
  assert.notStrictEqual(record_digest, payload_digest, 'record_digest and payload_digest must be decoupled');
  assert.notStrictEqual(state_digest, payload_digest, 'state_digest and payload_digest must be decoupled');

  console.log('✓ Test 1 Passed: Three-Tier Digest Model & Invariant Separation');
}

// Test 2: Field-Level Canonicalization Rules
{
  // Set-like arrays must sort lexicographically
  const effectsUnsorted: EffectSet = {
    future_revision_id: 'fut-101',
    extractor_id: 'structural-ts',
    extractor_version: '1.0.0',
    capability: 'STRUCTURAL',
    status: 'COMPLETE',
    modified_exports: ['zebra', 'alpha', 'beta'],
    added_dependencies: {
      zod: '^3.22.0',
      express: '^4.19.0',
      dotenv: '^16.0.0',
    },
    db_migrations_detected: false,
    security_effects: ['NET:egress', 'CRYPTO:usage'],
    effect_digest: '',
  };

  const digest1 = computeEffectDigest(effectsUnsorted);

  const effectsPermuted: EffectSet = {
    ...effectsUnsorted,
    modified_exports: ['beta', 'zebra', 'alpha'],
    security_effects: ['CRYPTO:usage', 'NET:egress'],
  };

  const digest2 = computeEffectDigest(effectsPermuted);
  assert.strictEqual(digest1, digest2, 'Set-like arrays must sort identically');

  // Preserving Git parent_oids exact sequence
  const stateA: CanonicalFutureRevisionState = {
    repo_id: 'repo-core',
    commit_oid: 'c1',
    tree_oid: 't1',
    parent_oids: ['parentA', 'parentB'],
  };
  const stateB: CanonicalFutureRevisionState = {
    repo_id: 'repo-core',
    commit_oid: 'c1',
    tree_oid: 't1',
    parent_oids: ['parentB', 'parentA'],
  };
  assert.notStrictEqual(
    computeFutureRevisionStateDigest(stateA),
    computeFutureRevisionStateDigest(stateB),
    'Semantic sequences (parent_oids) must preserve exact order'
  );

  console.log('✓ Test 2 Passed: Field-Level Canonicalization & Sequence Invariants');
}

// Test 3: Evidence & Retention Invariants
{
  const ev1: Evidence = {
    id: 'ev-1',
    subject_digest: 'subject-111',
    evaluator_id: 'sandbox-eval',
    evaluator_version: '1.0.0',
    config_digest: 'cfg-111',
    environment_digest: 'env-node24',
    result: 'PASSED',
    payload_digest: 'payload-hex-abc',
    payload_ref: 'r2://bucket/receipts/ev-1.json',
    retention_class: 'DECISION_RECORD',
    created_at: '2026-10-12T01:00:00Z',
    evidence_digest: '',
  };

  const digest1 = computeEvidenceDigest(ev1);

  // Altering retention_class or payload_ref or created_at must NOT mutate evidence_digest
  const ev2: Evidence = {
    ...ev1,
    payload_ref: 'r2://other-bucket/moved/ev-1.json',
    retention_class: 'EPHEMERAL',
    created_at: '2027-01-01T00:00:00Z',
  };

  const digest2 = computeEvidenceDigest(ev2);
  assert.strictEqual(digest1, digest2, 'Evidence storage location and retention policy must never mutate evidence identity');

  console.log('✓ Test 3 Passed: Storage location & retention class decoupling');
}

// Test 4: SystemRevision & ReleaseConstraints Canonical Projections
{
  const sysState: CanonicalSystemRevisionState = {
    repositories: {
      'repo-frontend': 'commit_front_1',
      'repo-backend': 'commit_back_1',
    },
    configuration_digests: {
      'env.production': 'cfg_prod_hash',
      'docker-compose': 'compose_hash',
    },
  };
  const sys_state_digest = computeSystemRevisionStateDigest(sysState);
  assert.strictEqual(sys_state_digest.length, 64);

  const constraints: CanonicalReleaseConstraints = {
    system_revision_state_digest: sys_state_digest,
    ordering_constraints: [
      {
        before: { repo_id: 'repo-db', resource_type: 'migration', resource_id: '001_init' },
        after: { repo_id: 'repo-api', resource_type: 'service', resource_id: 'api-server' },
      },
    ],
    compatibility_requirements: [
      {
        subject: { repo_id: 'repo-frontend', resource_type: 'service', resource_id: 'web' },
        target: { repo_id: 'repo-backend', resource_type: 'service', resource_id: 'api' },
        relation: 'COMPATIBLE',
      },
    ],
    preconditions: [
      {
        target: { repo_id: 'repo-db', resource_type: 'database', resource_id: 'primary' },
        assertion: 'HEALTHY',
      },
    ],
    postconditions: [
      {
        target: { repo_id: 'repo-api', resource_type: 'service', resource_id: 'api-server' },
        assertion: 'HEALTHY',
      },
    ],
    forward_only_operations: [
      {
        resource: { repo_id: 'repo-db', resource_type: 'migration', resource_id: '001_init' },
        operation: 'APPLY_SCHEMA_MIGRATION',
        failure_policy: 'ABORT',
      },
    ],
  };

  const constraints_digest = computeReleaseConstraintsDigest(constraints);
  assert.strictEqual(constraints_digest.length, 64);

  // Deployment attestation
  const attestation: CanonicalDeploymentAttestation = {
    system_revision_state_digest: sys_state_digest,
    environment: 'production',
    deployer_identity: 'argocd-runner',
    observed_state: 'SUCCEEDED',
    observed_repositories: {
      'repo-frontend': 'commit_front_1',
      'repo-backend': 'commit_back_1',
    },
    observed_configuration_digests: {
      'env.production': 'cfg_prod_hash',
      'docker-compose': 'compose_hash',
    },
    payload_digest: 'payload_hash_deploy_1',
  };

  const attestation_digest = computeDeploymentAttestationDigest(attestation);
  assert.strictEqual(attestation_digest.length, 64);

  console.log('✓ Test 4 Passed: SystemRevision, Constraints & Attestation Projections');
}

console.log('--- ALL CONTRACT TESTS PASSED CLEANLY ---');
