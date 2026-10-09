import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, emptyState } from '../core/engine.mjs';
import { LocalGit, git } from '../server/git.mjs';
import { RemoteGit } from '../server/remote-git.mjs';
import { DomainError, record } from '../core/hash.mjs';
import { handleNativeRequest } from '../server/native-api.mjs';

const ref = 'refs/heads/main';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-pipeline-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  await mkdir(work);
  await mkdir(path.join(root, 'repositories'));
  await git(work, ['init', '--quiet', '-b', 'main']);
  await writeFile(path.join(work, 'base.txt'), 'baseline\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'baseline']);
  const base = await git(work, ['rev-parse', 'HEAD']);
  const baseTree = await git(work, ['rev-parse', 'HEAD^{tree}']);
  await writeFile(path.join(work, 'a.txt'), 'unselected parent change\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'first change']);
  const a = await git(work, ['rev-parse', 'HEAD']);
  await writeFile(path.join(work, 'b.txt'), 'selected change\n');
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'second change']);
  const b = await git(work, ['rev-parse', 'HEAD']);
  const tree = await git(work, ['rev-parse', 'HEAD^{tree}']);
  const adapter = new LocalGit(root);
  adapter.configHash = 'trusted-fixture-v0';
  await git(root, ['clone', '--bare', '--quiet', work, adapter.dir({ id: 'app' })]);
  await git(root, ['clone', '--bare', '--quiet', work, adapter.dir({ id: 'source' })]);
  await git(adapter.dir({ id: 'app' }), ['update-ref', ref, base]);
  // This finite validator is test-owned. Product code still requires an operator profile.
  let passing = true;
  adapter.validate = async () => ({
    passed: passing,
    checks: [{ name: 'fixture check', passed: passing }],
    limitations: ['Fixture only; no semantic correctness claim.'],
  });
  const revision = await record('future-revision', {
    future_id: 'future',
    repository_heads: [{ repo_id: 'app', source_repo_id: 'source', ref, commit: b }],
    baseline_refs: [{ repo_id: 'app', ref, commit: base, tree: baseTree }],
    tree_hashes: [{ repo_id: 'app', tree }],
    provenance_state: 'unknown',
  });
  const state = {
    ...emptyState(),
    repositories: [{ id: 'app', canonical_ref: ref, head: base, tree: baseTree, baseline: base }],
    futures: [{ id: 'future', status: 'active', current_revision_id: revision.id,
      repositories: [{ repo_id: 'source', canonical_repo_id: 'app', ref, status: 'ready' }] }],
    futureRevisions: [revision],
  };
  state.workspace.owner_id = 'owner';
  const saved = [];
  const engine = new Engine(state, adapter, async (value) => saved.push(structuredClone(value)));
  return {
    root,
    engine,
    adapter,
    state,
    saved,
    base,
    baseTree,
    a,
    b,
    revision,
    setPassing(value) {
      passing = value;
    },
    async selection(kind = 'future', commits = [b]) {
      return (
        await engine.pipeline.createSelection(
          {
            future_revision_id: revision.id,
            kind,
            ...(kind === 'commits' ? { repo_id: 'app', commits } : {}),
            request_id: 'selection-' + kind + '-' + commits.join('-'),
          },
          'owner',
        )
      ).selection;
    },
    async candidate(selection) {
      return (
        await engine.pipeline.createCandidate(
          {
            selection_ids: [selection.id],
            request_id: 'compose-' + selection.id,
          },
          'owner',
        )
      ).candidate;
    },
    async reviewed(candidate) {
      await engine.pipeline.validateCandidate(
        candidate.id,
        { request_id: 'check-' + candidate.id },
        'owner',
      );
      const review = await engine.pipeline.review(candidate.id);
      return {
        request_id: 'promote-' + candidate.id,
        decision_basis_hash: review.decision_basis_hash,
        expected_heads: review.expected_heads,
        rationale: 'Keep the selected change.',
      };
    },
  };
}

test('commit selection applies only the selected patch, retaining ordinary cloneable Git', async (t) => {
  const f = await fixture(t);
  const selection = await f.selection('commits');
  const candidate = await f.candidate(selection);
  const target = candidate.repositories[0];
  assert.equal(await f.adapter.file({ id: 'app' }, target.commit, 'b.txt'), 'selected change');
  assert.equal(await f.adapter.file({ id: 'app' }, target.commit, 'a.txt'), null);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
  assert.equal(await f.adapter.isAncestor({ id: 'app' }, f.a, target.commit), false);
  const clone = path.join(f.root, 'ordinary-clone');
  await git(f.root, ['clone', '--quiet', f.adapter.dir({ id: 'app' }), clone]);
  await git(clone, ['fetch', '--quiet', 'origin', target.commit]);
  assert.equal(await git(clone, ['show', target.commit + ':b.txt']), 'selected change');
  assert.equal(Object.isFrozen(f.state.selections[0].entries), true);
  assert.equal(f.state.proposals.length, 0);
  assert.equal(f.engine.mr.list().length, 0);
});

test('whole-Future composition preserves source history and immutable selection receipts', async (t) => {
  const f = await fixture(t);
  const selection = await f.selection();
  const candidate = await f.candidate(selection);
  assert.equal(
    await f.adapter.isAncestor({ id: 'app' }, f.b, candidate.repositories[0].commit),
    true,
  );
  assert.equal(
    await f.adapter.file({ id: 'app' }, candidate.repositories[0].commit, 'a.txt'),
    'unselected parent change',
  );
  const duplicate = await f.selection();
  assert.deepEqual(duplicate, selection);
  assert.equal(f.state.selections.length, 1);
  assert.equal(f.state.evidence.length, 0);
});

test('commit selections reject baseline, outside-revision and merge commits', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.selection('commits', [f.base]), { code: 'COMMIT_OUTSIDE_REVISION' });
  await assert.rejects(() => f.selection('commits', ['0'.repeat(40)]));
  const merge = await git(f.adapter.dir({ id: 'source' }), [
    'commit-tree',
    f.revision.tree_hashes[0].tree,
    '-p',
    f.b,
    '-p',
    f.base,
    '-m',
    'merge',
  ]);
  await assert.rejects(
    () =>
      f.adapter.composeSelections(f.engine.repo('app'), f.base, [
        {
          id: 'selection',
          future_revision_id: 'revision',
          kind: 'commits',
          source_repo: 'source',
          base_commit: f.base,
          head_commit: merge,
          tree_hash: f.revision.tree_hashes[0].tree,
          commits: [merge],
        },
      ]),
    { code: 'COMMIT_PARENT_REQUIRED' },
  );
});

test('an unprocessed source push invalidates selection and reviewed promotion', async (t) => {
  const f = await fixture(t);
  const selection = await f.selection();
  const candidate = await f.candidate(selection);
  const input = await f.reviewed(candidate);
  await git(f.adapter.dir({ id: 'source' }), ['update-ref', ref, f.a]);
  assert.equal((await f.engine.pipeline.review(candidate.id)).sources_current, false);
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'), {
    code: 'DECISION_STALE',
  });
  assert.equal(f.state.operations.length, 0);
  await assert.rejects(
    () =>
      f.engine.pipeline.createCandidate(
        {
          selection_ids: [selection.id],
          request_id: 'compose-stale',
        },
        'owner',
      ),
    { code: 'SELECTION_STALE' },
  );
});

test('constraint/configuration changes invalidate the reviewed basis', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  f.state.constraints.push({
    id: 'constraint-v1',
    active: true,
    kind: 'advisory',
    statement: 'review policy',
  });
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'), {
    code: 'DECISION_STALE',
  });
  f.state.constraints = [];
  f.adapter.configHash = 'trusted-fixture-v1';
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'), {
    code: 'DECISION_STALE',
  });
  assert.equal(f.state.operations.length, 0);
});

test('a failed latest run blocks promotion instead of reusing an earlier passing run', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  await f.reviewed(candidate);
  f.setPassing(false);
  await f.engine.pipeline.validateCandidate(candidate.id, { request_id: 'failed-rerun' }, 'owner');
  const review = await f.engine.pipeline.review(candidate.id);
  assert.equal(review.validation_passing, false);
  await assert.rejects(
    () =>
      f.engine.pipeline.promote(
        candidate.id,
        {
          request_id: 'failed-promotion',
          decision_basis_hash: review.decision_basis_hash,
          expected_heads: review.expected_heads,
          rationale: 'Review current checks.',
        },
        'owner',
      ),
    { code: 'VALIDATION_REQUIRED' },
  );
  assert.equal(f.state.operations.length, 0);
});

test('CAS race fails without replacing the external canonical push', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (repo, expected, target) => {
    await git(f.adapter.dir(repo), ['update-ref', ref, f.a]);
    return cas(repo, expected, target);
  };
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'), {
    code: 'DECISION_STALE',
  });
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.a);
  assert.equal(f.state.operations[0].status, 'cas-failed');
  assert.equal(
    f.saved.some((snapshot) => snapshot.operations[0]?.status === 'prepared'),
    true,
  );
});

test('lost CAS acknowledgement blocks writes and recovers by observation without replay', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection('commits'));
  const input = await f.reviewed(candidate);
  const cas = f.adapter.cas.bind(f.adapter);
  let writes = 0;
  f.adapter.cas = async (...args) => {
    writes++;
    await cas(...args);
    throw new Error('lost acknowledgement');
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(candidate.id, input, 'owner'),
    /lost acknowledgement/,
  );
  assert.equal(f.state.operations[0].status, 'recovery-required');
  await assert.rejects(
    () =>
      f.engine.pipeline.promote(candidate.id, { ...input, request_id: 'another-write' }, 'owner'),
    { code: 'RECOVERY_REQUIRED' },
  );
  // Restart from persisted metadata, not the former Engine instance.
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.equal(restarted.state.operations[0].status, 'applied');
  const result = await restarted.pipeline.promote(candidate.id, input, 'owner');
  assert.equal(result.decision.actor, 'owner');
  assert.equal(writes, 1);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), candidate.repositories[0].commit);
});

test('recovery keeps an unrelated or unchanged head uncertain and never calls CAS', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  f.adapter.cas = async () => {
    throw new Error('transport failed');
  };
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'));
  let writes = 0;
  f.adapter.cas = async () => {
    writes++;
    return true;
  };
  await f.engine.recover();
  assert.equal(writes, 0);
  assert.equal(f.state.operations[0].status, 'recovery-required');
});

test('native API binds the transport actor and does not accept producer evidence', async (t) => {
  const f = await fixture(t);
  const result = await handleNativeRequest(f.engine, {
    method: 'POST',
    url: '/api/selections',
    actor: 'owner',
    input: {
      future_revision_id: f.revision.id,
      request_id: 'api-selection',
      actor: 'attacker',
      evidence: { passed: true },
    },
  });
  assert.equal(result.selection.kind, 'future');
  assert.equal(f.state.audit.at(-1).actor, 'owner');
  assert.equal(f.state.evidence.length, 0);
  await assert.rejects(
    () =>
      handleNativeRequest(f.engine, {
        method: 'GET',
        url: '/api/candidates',
        actor: '',
      }),
    { code: 'UNAUTHENTICATED' },
  );
});

test('composed dependency checks read candidate commits while freshness tracks canonical baselines', async (t) => {
  const f = await fixture(t);
  await git(f.root, [
    'clone',
    '--bare',
    '--quiet',
    f.adapter.dir({ id: 'app' }),
    f.adapter.dir({ id: 'policy' }),
  ]);
  await git(f.root, [
    'clone',
    '--bare',
    '--quiet',
    f.adapter.dir({ id: 'source' }),
    f.adapter.dir({ id: 'policy-source' }),
  ]);
  f.state.repositories.push({
    id: 'policy',
    canonical_ref: ref,
    head: f.base,
    tree: f.baseTree,
    baseline: f.base,
  });
  const policyRevision = await record('future-revision', {
    future_id: 'policy-future',
    repository_heads: [{ repo_id: 'policy', source_repo_id: 'policy-source', ref, commit: f.b }],
    baseline_refs: [{ repo_id: 'policy', ref, commit: f.base, tree: f.baseTree }],
    tree_hashes: [{ repo_id: 'policy', tree: f.revision.tree_hashes[0].tree }],
  });
  f.state.futureRevisions.push(policyRevision);
  f.state.futures.push({
    id: 'policy-future',
    status: 'active',
    current_revision_id: policyRevision.id,
  });
  const policy = (
    await f.engine.pipeline.createSelection(
      {
        future_revision_id: policyRevision.id,
        kind: 'future',
        request_id: 'policy-selection',
      },
      'owner',
    )
  ).selection;
  const app = await f.selection();
  const candidate = (
    await f.engine.pipeline.createCandidate(
      {
        selection_ids: [app.id, policy.id],
        request_id: 'composed-system',
      },
      'owner',
    )
  ).candidate;
  const runs = [];
  f.adapter.validate = async (repo, commit, constraints, heads) => {
    runs.push({ repo: repo.id, commit, heads });
    return { passed: true, checks: [{ name: 'exact composed dependencies', passed: true }] };
  };
  const { evidence } = await f.engine.pipeline.validateCandidate(
    candidate.id,
    {
      request_id: 'composed-checks',
    },
    'owner',
  );
  for (const run of runs) {
    assert.equal(
      run.heads.app,
      candidate.repositories.find((repo) => repo.repo_id === 'app').commit,
    );
    assert.equal(
      run.heads.policy,
      candidate.repositories.find((repo) => repo.repo_id === 'policy').commit,
    );
  }
  assert.equal(evidence[0].validity_heads.policy, f.base);
  assert.equal(evidence[0].evaluation_heads.policy, runs[0].heads.policy);
  const review = await f.engine.pipeline.review(candidate.id);
  assert.equal(review.validation_passing, true);
  assert.equal(review.promotion_supported, true);
  const result = await f.engine.pipeline.promote(
    candidate.id,
    {
      request_id: 'multi-repo-promotion',
      decision_basis_hash: review.decision_basis_hash,
      expected_heads: review.expected_heads,
      rationale: 'Both selected roles.',
    },
    'owner',
  );
  assert.equal(result.operation.status, 'applied');
  assert.equal(result.operation.non_atomic, true);
  assert.deepEqual(result.operation.stages.map((stage) => stage.status), ['applied', 'applied']);
  assert.equal(
    await f.adapter.ref({ id: 'app' }, ref),
    candidate.repositories.find((repository) => repository.repo_id === 'app').commit,
  );
  assert.equal(
    await f.adapter.ref({ id: 'policy' }, ref),
    candidate.repositories.find((repository) => repository.repo_id === 'policy').commit,
  );
});

test('concurrent resolutions serialize to one canonical write and stale evidence cannot be reused', async (t) => {
  const f = await fixture(t);
  const first = await f.candidate(await f.selection());
  const second = await f.candidate(await f.selection('commits'));
  const a = await f.reviewed(first);
  const b = await f.reviewed(second);
  const outcomes = await Promise.allSettled([
    f.engine.serial(() => f.engine.pipeline.promote(first.id, a, 'owner')),
    f.engine.serial(() => f.engine.pipeline.promote(second.id, b, 'owner')),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes[1].reason.code, 'DECISION_STALE');
  const review = await f.engine.pipeline.review(second.id);
  assert.equal(review.heads_current, false);
  assert.equal(review.evidence[0].validity.status, 'stale');
  assert.equal(f.state.operations.filter((operation) => operation.status === 'applied').length, 1);
});

test('native promotion cannot bypass a pending compatibility operation', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  f.state.operations.push({ id: 'legacy-operation', status: 'prepared' });
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'), {
    code: 'RECOVERY_REQUIRED',
  });
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
});

test('a crash after preparing but before dispatch is safely settled without Git mutation', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  const save = f.engine.save;
  f.engine.save = async (state) => {
    await save(state);
    if (state.operations.at(-1)?.dispatch_state === 'not_started')
      throw new Error('crash before dispatch');
  };
  let writes = 0;
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {
    writes++;
    return cas(...args);
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(candidate.id, input, 'owner'),
    /crash before dispatch/,
  );
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.equal(restarted.state.operations[0].status, 'not-applied');
  assert.equal(writes, 0);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
});

test('local CAS does not classify an unacknowledged unchanged head as proof of no write', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.adapter.cas(f.engine.repo('app'), f.base, '9'.repeat(40)), {
    code: 'CANONICAL_WRITE_UNCERTAIN',
  });
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
});

test('canonical targets reject the zero OID rather than deleting the Git ref', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.adapter.cas(f.engine.repo('app'), f.base, '0'.repeat(40)), {
    code: 'INVALID_COMMIT',
  });
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
});

test('recovery after a lost metadata acknowledgement does not duplicate canonical events', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  const save = f.engine.save;
  let lost = false;
  f.engine.save = async (state) => {
    await save(state);
    if (!lost && state.operations.at(-1)?.status === 'applied') {
      lost = true;
      throw new Error('lost metadata acknowledgement');
    }
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(candidate.id, input, 'owner'),
    /lost metadata acknowledgement/,
  );
  assert.equal(f.state.operations[0].status, 'recovery-required');
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.equal(restarted.state.operations[0].status, 'applied');
  const updates = restarted.state.nativeEvents.filter(
    (event) => event.type === 'io.klocgit.canonical.updated',
  );
  assert.equal(updates.length, 1);
});

test('operator settlement records a declared outcome and releases the block without replay', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  let writes = 0;
  f.adapter.cas = async () => {
    writes++;
    throw new Error('unknown transport outcome');
  };
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'));
  await f.engine.recover();
  const operation = f.state.operations[0];
  const settlementInput = {
    request_id: 'operator-settlement',
    expected_head: f.base,
    outcome: 'not_applied',
    confirmed: true,
    rationale: 'Inspected repository history and the executor operation log.',
  };
  const result = await f.engine.pipeline.settleOperation(operation.id, settlementInput, 'owner');
  assert.equal(result.operation.status, 'settled');
  assert.equal(result.settlement.basis, 'declared');
  assert.equal(result.settlement.observed_ref.basis, 'observed');
  assert.equal(result.settlement.observed_ref.commit, f.base);
  assert.equal(result.settlement.actor, 'owner');
  assert.equal(writes, 1, 'Settlement never calls CAS');
  assert.deepEqual(
    await f.engine.pipeline.settleOperation(operation.id, settlementInput, 'owner'),
    result,
  );
  assert.equal(f.state.nativeSettlements.length, 1);
  assert.equal(Object.isFrozen(f.state.nativeSettlements[0]), true);
  f.adapter.cas = LocalGit.prototype.cas.bind(f.adapter);
  const applied = await f.engine.pipeline.promote(
    candidate.id,
    {
      ...input,
      request_id: 'new-reviewed-promotion',
    },
    'owner',
  );
  assert.equal(applied.operation.status, 'applied');
});

test('operator settlement preserves an applied-then-moved attestation without changing Git', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {
    await cas(...args);
    await git(f.adapter.dir({ id: 'app' }), ['update-ref', ref, f.a]);
    throw new Error('lost reply after external movement');
  };
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'));
  await f.engine.recover();
  const result = await f.engine.pipeline.settleOperation(
    f.state.operations[0].id,
    {
      request_id: 'moved-settlement',
      expected_head: f.a,
      outcome: 'applied_then_moved',
      confirmed: true,
      rationale: 'Inspected the write receipt and later external ref update.',
    },
    'owner',
  );
  assert.equal(result.settlement.outcome, 'applied_then_moved');
  assert.equal(result.settlement.basis, 'declared');
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.a);
});

test('settlement rejects stale refs, missing confirmation and unauthenticated actors', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  f.adapter.cas = async () => {
    throw new Error('unknown outcome');
  };
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'));
  const operation = f.state.operations[0];
  const settlement = {
    request_id: 'stale-settlement',
    expected_head: f.base,
    outcome: 'not_applied',
    confirmed: true,
    rationale: 'Inspected the history.',
  };
  await assert.rejects(
    () =>
      f.engine.pipeline.settleOperation(
        operation.id,
        {
          ...settlement,
          confirmed: false,
        },
        'owner',
      ),
    { code: 'INVALID_SETTLEMENT' },
  );
  await assert.rejects(() => f.engine.pipeline.settleOperation(operation.id, settlement, ''), {
    code: 'UNAUTHENTICATED',
  });
  await git(f.adapter.dir({ id: 'app' }), ['update-ref', ref, f.a]);
  await assert.rejects(() => f.engine.pipeline.settleOperation(operation.id, settlement, 'owner'), {
    code: 'SETTLEMENT_STALE',
  });
  assert.equal(operation.status, 'recovery-required');
  assert.equal(f.state.nativeSettlements.length, 0);
});

test('an exact prepared target is reconciled rather than settled through a human claim', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {
    await cas(...args);
    throw new Error('lost reply');
  };
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'));
  const operation = f.state.operations[0];
  await assert.rejects(
    () =>
      f.engine.pipeline.settleOperation(
        operation.id,
        {
          request_id: 'target-settlement',
          expected_head: operation.target_commit,
          outcome: 'not_applied',
          confirmed: true,
          rationale: 'A proposed attestation.',
        },
        'owner',
      ),
    { code: 'RECOVERY_TARGET_PRESENT' },
  );
  assert.equal(f.state.nativeSettlements.length, 0);
  await f.engine.recover();
  assert.equal(operation.status, 'applied');
});

test('remote CAS recognizes an actual Git porcelain lease rejection', async (t) => {
  const f = await fixture(t);
  await git(f.adapter.dir({ id: 'app' }), ['update-ref', ref, f.a]);
  const remote = new RemoteGit(f.root, { repositories: { app: {} } });
  // The trusted test transport uses a local bare destination, not Cloudflare.
  remote.entry = () => ({ remote: f.adapter.dir({ id: 'app' }), tokenEnv: 'FIXTURE_GIT_TOKEN' });
  remote.ensureCommit = async () => {};
  assert.equal(await remote.cas(f.engine.repo('app'), f.base, f.b), false);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.a);
});

test('a lost remote acknowledgement followed by another push remains uncertain', async (t) => {
  const f = await fixture(t);
  const candidate = await f.candidate(await f.selection());
  const target = candidate.repositories[0].commit;
  const remote = new RemoteGit(f.root, { repositories: { app: {} } });
  remote.entry = () => ({ remote: 'https://fixture.artifacts.cloudflare.net/app.git' });
  remote.ensureCommit = async () => {};
  let attempts = 0;
  remote.remote = async (_id, args) => {
    if (args[0] === 'push') {
      attempts++;
      await f.adapter.cas(f.engine.repo('app'), f.base, target);
      await git(f.adapter.dir({ id: 'app' }), ['update-ref', ref, f.a]);
      throw new DomainError('REMOTE_GIT_FAILED', 'Lost acknowledgement', 503);
    }
    throw new Error('No ref observation can prove that the write never happened');
  };
  await assert.rejects(() => remote.cas(f.engine.repo('app'), f.base, target), {
    code: 'REMOTE_GIT_FAILED',
  });
  assert.equal(attempts, 1);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.a);
});

test('an already-present remote target cannot satisfy a different reviewed head', async (t) => {
  const f = await fixture(t);
  const remote = new RemoteGit(f.root, { repositories: { app: {} } });
  remote.entry = () => ({ remote: f.adapter.dir({ id: 'app' }), tokenEnv: 'FIXTURE_GIT_TOKEN' });
  remote.ensureCommit = async () => {};
  await git(f.adapter.dir({ id: 'app' }), ['update-ref', ref, f.b]);
  assert.equal(await remote.cas(f.engine.repo('app'), f.base, f.b), false);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.b);
});

test('remote CAS accepts the exact Git write acknowledgement for the reviewed head', async (t) => {
  const f = await fixture(t);
  const remote = new RemoteGit(f.root, { repositories: { app: {} } });
  remote.entry = () => ({ remote: f.adapter.dir({ id: 'app' }), tokenEnv: 'FIXTURE_GIT_TOKEN' });
  remote.ensureCommit = async () => {};
  assert.equal(await remote.cas(f.engine.repo('app'), f.base, f.b), true);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.b);
});

test('a missing remote write receipt remains uncertain', async (t) => {
  const f = await fixture(t);
  const remote = new RemoteGit(f.root, { repositories: { app: {} } });
  remote.entry = () => ({ remote: 'https://fixture.artifacts.cloudflare.net/app.git' });
  remote.ensureCommit = async () => {};
  remote.remote = async () => '';
  await assert.rejects(() => remote.cas(f.engine.repo('app'), f.base, f.b), {
    code: 'CANONICAL_WRITE_UNCERTAIN',
  });
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
});

test('membership revocation invalidates a reviewed promotion without changing Git', async (t) => {
  const f = await fixture(t);
  f.state.workspace.owner_id = 'owner';
  const principal = { actor_id: 'owner', kind: 'human', auth_method: 'owner-token' };
  await f.engine.access.update({
    expected_version: f.engine.access.state.version,
    changes: [{ actor_id: 'reviewer', repo_id: 'app', roles: ['maintainer'] }],
  }, principal);
  const candidate = await f.candidate(await f.selection());
  const input = await f.reviewed(candidate);
  const reviewedVersion = f.engine.access.state.version;
  await f.engine.access.update({
    expected_version: reviewedVersion,
    changes: [{ actor_id: 'reviewer', repo_id: 'app', roles: [] }],
  }, principal);
  assert.equal(f.engine.access.state.version, reviewedVersion + 1);
  assert.throws(() => f.engine.access.require(
    { actor_id: 'reviewer', kind: 'human', auth_method: 'oidc' },
    'decision.resolve',
    ['app'],
  ), { code: 'FORBIDDEN' });
  await assert.rejects(() => f.engine.pipeline.promote(candidate.id, input, 'owner'), {
    code: 'DECISION_STALE',
  });
  assert.equal(f.state.operations.length, 0);
  assert.equal(await f.adapter.ref({ id: 'app' }, ref), f.base);
  assert.equal(await f.adapter.ref({ id: 'source' }, ref), f.b);
});
