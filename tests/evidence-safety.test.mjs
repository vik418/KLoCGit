import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, emptyState } from '../core/engine.mjs';
import { record } from '../core/hash.mjs';
import { validationPassed } from '../core/evidence.mjs';

function fixture() {
  const state = emptyState();
  state.repositories.push({
    id: 'repo',
    head: 'base',
    baseline: 'base',
    canonical_ref: 'refs/heads/main',
  });
  state.proposals.push({
    id: 'proposal',
    repo: 'repo',
    ref: 'refs/heads/work',
    title: 'Ordinary work',
  });
  state.contexts.push({ id: 'context', items: [] });
  state.revisions.push({
    id: 'revision',
    proposal_id: 'proposal',
    repo: 'repo',
    head_commit: 'source',
    base_commit: 'base',
    tree_hash: 'source-tree',
    context_version: 'context',
    affected_scope: ['work.md'],
    provenance_state: 'unknown',
  });
  state.refVersions['repo:refs/heads/work'] = 'source';
  let canonicalWrites = 0;
  const adapter = {
    configHash: 'trusted-config',
    ref: async (_repo, ref) => (ref === 'refs/heads/main' ? state.repositories[0].head : 'source'),
    compose: async () => ({ tree: 'candidate-tree', commit: 'candidate', baseTree: 'base-tree' }),
    validate: async () => ({ passed: true, checks: [{ name: 'Finite case', passed: true }] }),
    cas: async () => {
      canonicalWrites++;
      return true;
    },
  };
  return { engine: new Engine(state, adapter), state, writes: () => canonicalWrites };
}

async function nextRunWithState(previousEvidence, state) {
  const previousFields = Object.fromEntries(
    Object.entries(previousEvidence).filter(([key]) => key !== 'id'),
  );
  return record('ev', { ...previousFields, state, created_at: 'next-platform-run' });
}

test('unfinished or failed trusted state never authorizes code even with a residual passing boolean', () => {
  for (const status of ['pending', 'running', 'failed', 'cancelled', 'unknown'])
    for (const location of ['record', 'result', 'check']) {
      const evidence = { result: { passed: true, checks: [{ passed: true }] } };
      if (location === 'record') evidence.state = status;
      if (location === 'result') evidence.result.state = status;
      if (location === 'check') evidence.result.checks[0].state = status;
      assert.equal(validationPassed(evidence), false, `${location}:${status}`);
    }
  assert.equal(
    validationPassed({ state: 'passing', result: { passed: true, checks: [{ passed: true }] } }),
    true,
  );
});

test('new trusted composition results stale standalone decisions and cannot revive a pinned historical pass', async () => {
  for (const status of ['failed', 'pending', 'cancelled']) {
    const f = fixture(),
      component = await f.engine.prepareReview({ revision_ids: ['revision'] }, 'owner');
    const alternative = component.alternatives[0],
      original = f.state.evidence.find((e) => e.id === alternative.evidence_ids[0]);
    const input = {
      alternative_id: alternative.id,
      basis_hash: component.basis_hash,
      expected_canonical_head: 'base',
    };
    f.state.evidence.push(await nextRunWithState(original, status));
    await assert.rejects(
      () => f.engine.resolve(component.id, input, 'owner'),
      (error) => error.code === 'DECISION_STALE',
    );
    component.basis_hash = await f.engine.basis(component);
    await assert.rejects(
      () => f.engine.resolve(component.id, { ...input, basis_hash: component.basis_hash }, 'owner'),
      (error) => error.code === 'VALIDATION_REQUIRED',
    );
    assert.equal(f.writes(), 0);
    const fresh = await f.engine.prepareReview({ revision_ids: ['revision'] }, 'owner');
    await f.engine.resolve(
      fresh.id,
      {
        alternative_id: fresh.alternatives[0].id,
        basis_hash: fresh.basis_hash,
        expected_canonical_head: 'base',
      },
      'owner',
    );
    assert.equal(f.writes(), 1, 'Only the explicitly reviewed new passing proof can advance Git');
  }
});
