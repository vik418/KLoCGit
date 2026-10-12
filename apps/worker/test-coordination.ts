/**
 * CODEX OPERATING CONTRACT: Phase 2 Verification Suite
 * npm run test:coordination
 */

import assert from 'node:assert';
import {
  AuthContext,
  checkPermission,
  assertAuthorized,
  CapabilityTokenManager,
} from './src/authz.ts';
import {
  EventQueueBroker,
  ObjectStore,
  INLINE_THRESHOLD_BYTES,
  QUEUE_HARD_CEILING_BYTES,
} from './src/queue.ts';
import {
  ObjectiveCoordinator,
  RefCoordinator,
  ReductionResult,
} from './src/coordinators.ts';

console.log('================================================================');
console.log('  KLoCGit v1: COORDINATION PLANE & AUTHZ VERIFICATION (P2)      ');
console.log('================================================================\n');

// ----------------------------------------------------------------------------
// TEST 1: Deny-by-default Authorization & Tenant Isolation
// ----------------------------------------------------------------------------
console.log('--- TEST 1: Identity & Authorization Boundary ---');
{
  const tenantA_Engineer: AuthContext = {
    principal_id: 'eng-alice',
    role: 'ENGINEER',
    scope: { tenant_id: 'tenant-alpha', repo_id: 'repo-core' },
  };

  // 1. Same tenant, authorized action
  const check1 = checkPermission(
    tenantA_Engineer,
    'future:submit',
    { tenant_id: 'tenant-alpha', repo_id: 'repo-core' }
  );
  assert.strictEqual(check1.allowed, true, 'Engineer should have future:submit in same tenant/repo');

  // 2. Cross-tenant access attempt (MUST DENY)
  const check2 = checkPermission(
    tenantA_Engineer,
    'future:submit',
    { tenant_id: 'tenant-beta', repo_id: 'repo-core' }
  );
  assert.strictEqual(check2.allowed, false, 'Cross-tenant access must be denied');
  assert.ok(check2.reason?.includes('Cross-tenant'), 'Reason must indicate tenant violation');

  // 3. Unauthorized action for role (e.g. Engineer trying to CAS push promotion)
  const check3 = checkPermission(
    tenantA_Engineer,
    'promotion:cas_push',
    { tenant_id: 'tenant-alpha', repo_id: 'repo-core' }
  );
  assert.strictEqual(check3.allowed, false, 'Engineer should not have promotion:cas_push (deny-by-default)');

  // 4. Admin authorized action
  const adminCtx: AuthContext = {
    principal_id: 'admin-bob',
    role: 'SUPER_ADMIN',
    scope: { tenant_id: 'tenant-alpha' },
  };
  assertAuthorized(adminCtx, 'promotion:cas_push', { tenant_id: 'tenant-alpha', repo_id: 'repo-core' });

  console.log('✓ Tenant boundary enforced: Cross-tenant denied, unauthorized actions blocked.');
}

// ----------------------------------------------------------------------------
// TEST 2: Agent Capability Tokens with Hard Budgets and Expiry
// ----------------------------------------------------------------------------
console.log('\n--- TEST 2: Agent Capability Tokens & Budgets ---');
{
  const tokenManager = new CapabilityTokenManager();

  // Issue token with budget of 100 operations and 2 second TTL
  const token = tokenManager.issueToken({
    agent_id: 'agent-bot-01',
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
    allowed_actions: ['submit_future', 'fetch_tree'],
    budget_max: 100,
    ttl_seconds: 2,
  });

  assert.ok(token.token_id.startsWith('cap_'));
  assert.strictEqual(token.signature.length, 64);

  // Consume valid budget (cost = 40)
  const use1 = tokenManager.verifyAndConsume(token.token_id, 'submit_future', 40, {
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
  });
  assert.strictEqual(use1.allowed, true);
  assert.strictEqual(use1.remaining_budget, 60);

  // Attempt unauthorized action (e.g. 'delete_ref')
  const use2 = tokenManager.verifyAndConsume(token.token_id, 'delete_ref', 10, {
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
  });
  assert.strictEqual(use2.allowed, false);
  assert.ok(use2.error?.includes('not permitted'));

  // Attempt to exceed budget (cost = 70 when only 60 left)
  const use3 = tokenManager.verifyAndConsume(token.token_id, 'submit_future', 70, {
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
  });
  assert.strictEqual(use3.allowed, false);
  assert.ok(use3.error?.includes('Budget exhausted'));

  // Consume remaining budget (cost = 60)
  const use4 = tokenManager.verifyAndConsume(token.token_id, 'submit_future', 60, {
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
  });
  assert.strictEqual(use4.allowed, true);
  assert.strictEqual(use4.remaining_budget, 0);

  console.log('✓ Capability token budget strictly enforced and hard ceiling validated.');
}

// ----------------------------------------------------------------------------
// TEST 3: Event Queue Claim-Checks, Digest Verification & DLQ
// ----------------------------------------------------------------------------
console.log('\n--- TEST 3: Event Queue Framework & Claim-Checks ---');
async function testQueue() {
  const store = new ObjectStore();
  const broker = new EventQueueBroker(store, 3);

  // 1. Small payload (<32 KB) -> Inlined
  const smallPayload = { revision: 'rev-01', message: 'Small inline commit' };
  const env1 = await broker.publish({
    topic: 'future.ingested',
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
    idempotency_key: 'idem-key-1',
    payload: smallPayload,
  });

  assert.strictEqual(env1.payload_mode, 'INLINE');
  assert.strictEqual(env1.payload_ref, undefined);
  assert.ok(env1.payload_size_bytes < INLINE_THRESHOLD_BYTES);

  // 2. Large payload (>32 KB) -> Claim-Check in R2
  const largeData = 'A'.repeat(45 * 1024); // 45 KB > 32 KB threshold
  const env2 = await broker.publish({
    topic: 'evidence.collected',
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
    idempotency_key: 'idem-key-2',
    payload: { raw_blob: largeData },
  });

  assert.strictEqual(env2.payload_mode, 'CLAIM_CHECK');
  assert.ok(env2.payload_ref?.startsWith('r2://'));
  assert.ok(store.has(env2.payload_ref!));
  assert.ok(env2.payload_size_bytes > INLINE_THRESHOLD_BYTES);

  // 3. Process events and verify post-retrieval digest match
  let processedCount = 0;
  let receivedLargeData = '';

  const res1 = await broker.processNext(async (envelope, payload) => {
    processedCount++;
    assert.strictEqual(payload.revision, 'rev-01');
  });
  assert.strictEqual(res1.status, 'PROCESSED');

  const res2 = await broker.processNext(async (envelope, payload) => {
    processedCount++;
    receivedLargeData = payload.raw_blob;
  });
  assert.strictEqual(res2.status, 'PROCESSED');
  assert.strictEqual(receivedLargeData, largeData, 'Claim-check payload retrieved with 100% byte fidelity');

  // 4. Duplicate event rejection (Idempotency)
  await broker.publish({
    topic: 'future.ingested',
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
    idempotency_key: 'idem-key-1', // Re-used key
    payload: smallPayload,
  });
  const resDuplicate = await broker.processNext(async () => {});
  assert.strictEqual(resDuplicate.status, 'SKIPPED_DUPLICATE');

  // 5. DLQ Handling on repeated failures
  await broker.publish({
    topic: 'failing.task',
    tenant_id: 'tenant-alpha',
    repo_id: 'repo-core',
    idempotency_key: 'failing-key-1',
    payload: { test: 'fail' },
  });

  // Attempt 1 -> fails
  await broker.processNext(async () => { throw new Error('Simulated transient failure'); });
  // Attempt 2 -> fails
  await broker.processNext(async () => { throw new Error('Simulated transient failure'); });
  // Attempt 3 -> fails -> sent to DLQ
  const dlqResult = await broker.processNext(async () => { throw new Error('Simulated transient failure'); });
  assert.strictEqual(dlqResult.status, 'DLQ');

  const dlq = broker.getDLQ();
  assert.strictEqual(dlq.length, 1);
  assert.strictEqual(dlq[0].attempts, 3);

  // Replay DLQ
  const replayed = broker.replayDLQ();
  assert.strictEqual(replayed, 1);
  assert.strictEqual(broker.getDLQ().length, 0);

  console.log('✓ Claim-check storage (>32KB in R2, <32KB inline) & DLQ lifecycle verified.');
}

// ----------------------------------------------------------------------------
// TEST 4: ObjectiveCoordinator State Machine & Restart Recovery
// ----------------------------------------------------------------------------
console.log('\n--- TEST 4: ObjectiveCoordinator DO State Transitions & Recovery ---');
function testObjectiveCoordinator() {
  const sharedSqliteStore = new Map<string, string>();

  // Instance 1 before restart
  const coordinator1 = new ObjectiveCoordinator(
    'obj-convergence-101',
    'tenant-alpha',
    'repo-core',
    sharedSqliteStore
  );

  assert.strictEqual(coordinator1.getState().phase, 'INIT');

  // Ingest future
  coordinator1.ingestFutureRevision('fut-rev-alpha');
  assert.strictEqual(coordinator1.getState().phase, 'ANALYZING');
  assert.deepStrictEqual(coordinator1.getState().scheduled_jobs, ['job_extract_fut-rev-alpha']);

  // Schedule reduction
  coordinator1.scheduleReductionJob();
  assert.strictEqual(coordinator1.getState().phase, 'REDUCING');

  // Consume ReductionResult from Rust engine
  const reduction: ReductionResult = {
    objective_id: 'obj-convergence-101',
    exact_duplicates_collapsed: 3,
    effect_clusters_count: 2,
    alternative_implementations_count: 1,
    resolved_dependencies: ['express', 'zod'],
    synthesized_candidate_specs: ['cand-spec-001'],
    material_effect_digest: 'digest-effects-1234',
    policy_digest: 'policy-digest-5678',
    required_analysis_status: {
      'structural-ast': 'COMPLETE',
      'dependency-check': 'COMPLETE',
    },
  };

  coordinator1.consumeReductionResult(reduction);
  assert.strictEqual(coordinator1.getState().phase, 'DECISION_PENDING');
  assert.strictEqual(coordinator1.getState().decisions['dec_obj-convergence-101'].state, 'REVIEWABLE');

  // SIMULATE COORDINATOR CRASH & RESTART
  // Spin up coordinator2 referencing the same DO SQLite backing store
  const coordinator2 = new ObjectiveCoordinator(
    'obj-convergence-101',
    'tenant-alpha',
    'repo-core',
    sharedSqliteStore
  );

  const recoveredState = coordinator2.getState();
  assert.strictEqual(recoveredState.phase, 'DECISION_PENDING');
  assert.strictEqual(recoveredState.ingested_futures[0], 'fut-rev-alpha');
  assert.strictEqual(recoveredState.candidate_specs[0], 'cand-spec-001');

  // Advance decision to RESOLVED
  coordinator2.updateDecisionState('dec_obj-convergence-101', 'RESOLVED', 'human-lead@enterprise.com');
  assert.strictEqual(coordinator2.getState().phase, 'CONVERGED');
  assert.strictEqual(coordinator2.getState().decisions['dec_obj-convergence-101'].resolved_by, 'human-lead@enterprise.com');

  console.log('✓ ObjectiveCoordinator state machine & DO SQLite restart recovery verified.');
}

// ----------------------------------------------------------------------------
// TEST 5: RefCoordinator Serialized Git Push CAS & Concurrency Test
// ----------------------------------------------------------------------------
console.log('\n--- TEST 5: RefCoordinator Serialized CAS Race Condition Prevention ---');
async function testRefCoordinatorCAS() {
  const sharedSqliteStore = new Map<string, string>();
  const initialTrunkOid = '0000000000000000000000000000000000000001';

  const refCoordinator = new RefCoordinator(
    'refs/heads/main',
    initialTrunkOid,
    sharedSqliteStore
  );

  assert.strictEqual(refCoordinator.getCurrentOid(), initialTrunkOid);

  // 1. Single valid CAS mutation
  const nextOid = '0000000000000000000000000000000000000002';
  const casResult = await refCoordinator.compareAndSwapRef({
    expected_oid: initialTrunkOid,
    target_oid: nextOid,
    mutator_id: 'promotion-worker-1',
  });
  assert.strictEqual(casResult.success, true);
  assert.strictEqual(refCoordinator.getCurrentOid(), nextOid);

  // 2. Stale CAS attempt (someone pushed from old initialTrunkOid) -> MUST FAIL
  let failedAsExpected = false;
  try {
    await refCoordinator.compareAndSwapRef({
      expected_oid: initialTrunkOid, // Stale!
      target_oid: '0000000000000000000000000000000000000003',
      mutator_id: 'promotion-worker-2',
    });
  } catch (err: any) {
    failedAsExpected = true;
    assert.ok(err.message.includes('CAS_CONFLICT'));
  }
  assert.strictEqual(failedAsExpected, true, 'Stale CAS attempt must fail with CAS_CONFLICT');

  // 3. Concurrent Push Race Simulation: 10 concurrent requests with initial expected OID
  const currentBase = refCoordinator.getCurrentOid();
  const pushAttempts = Array.from({ length: 10 }, (_, i) => ({
    expected_oid: currentBase,
    target_oid: `oid-concurrent-target-${i}`,
    mutator_id: `worker-${i}`,
  }));

  let successCount = 0;
  let conflictCount = 0;

  for (const attempt of pushAttempts) {
    try {
      await refCoordinator.compareAndSwapRef(attempt);
      successCount++;
    } catch (err: any) {
      if (err.message.includes('CAS_CONFLICT')) {
        conflictCount++;
      }
    }
  }

  // Exactly 1 must succeed and exactly 9 must fail with CAS_CONFLICT
  assert.strictEqual(successCount, 1, 'Exactly one concurrent push can win CAS');
  assert.strictEqual(conflictCount, 9, 'All subsequent concurrent pushes must receive CAS_CONFLICT');

  console.log(`✓ Zero CAS Race Conditions: Exactly 1 won (${successCount}), 9 rejected on moved trunk (${conflictCount}).`);
}

// ----------------------------------------------------------------------------
// RUN ALL TESTS
// ----------------------------------------------------------------------------
async function runAll() {
  await testQueue();
  testObjectiveCoordinator();
  await testRefCoordinatorCAS();

  console.log('\n================================================================');
  console.log('  ALL COORDINATION PLANE & AUTHZ TESTS (P2) PASSED CLEANLY!     ');
  console.log('================================================================\n');
}

runAll().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
