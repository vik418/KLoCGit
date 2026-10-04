import test from 'node:test';
import assert from 'node:assert/strict';
import { MergeQueue } from '../core/merge-queue.mjs';
import { hash, record, DomainError } from '../core/hash.mjs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDemo } from '../scripts/demo.mjs';
import { git } from '../server/git.mjs';

async function workspace({ mergeRequests = false, sameRepo = false } = {}) {
  const state = {
    workspace: { id: 'test' },
    repositories: [],
    proposals: [],
    revisions: [],
    compositions: [],
    evidence: [],
    decisionComponents: [],
    decisions: [],
    operations: [],
    mergeQueue: [],
    queueEvents: [],
    mergeRequests: [],
    basisVersions: {},
  };
  const sourceHeads = new Map(),
    resolveCalls = [],
    saveSnapshots = [];
  const repoIds = sameRepo ? ['repo', 'repo'] : ['repo-a', 'repo-b'];
  for (const id of [...new Set(repoIds)])
    state.repositories.push({ id, head: `${id}-baseline`, canonical_ref: 'refs/heads/main' });
  for (const [index, name] of ['a', 'b'].entries()) {
    const repo = repoIds[index],
      id = `revision-${name}`,
      ref = `refs/heads/${name}`;
    state.proposals.push({ id: `proposal-${name}`, ref });
    state.revisions.push({
      id,
      proposal_id: `proposal-${name}`,
      repo,
      head_commit: `source-${name}`,
      tree_hash: `tree-${name}`,
    });
    sourceHeads.set(`${repo}:${ref}`, `source-${name}`);
    state.decisionComponents.push({
      id: `component-${name}`,
      status: 'open',
      scope: [repo],
      revision_ids: [id],
      supplemental_revision_ids: [],
      alternatives: [
        { id: `alternative-${name}`, repo, revision_ids: [id], composed_revision_ids: [id] },
      ],
    });
    if (mergeRequests)
      state.mergeRequests.push({
        id: `mr-${name}`,
        revision_id: id,
        repo,
        status: 'open',
        draft: false,
        event_id: `mr-event-${name}-1`,
        version: 1,
        dependency_ids: [],
        approved: true,
        checks_passed: true,
      });
  }
  const engine = {
    state,
    resolveCalls,
    saveSnapshots,
    sourceHeads,
    failure: null,
    activeResolutions: 0,
    maxResolutions: 0,
    repo(id) {
      const value = state.repositories.find((item) => item.id === id);
      if (!value) throw new DomainError('REPO_NOT_FOUND', 'Missing repository', 404);
      return value;
    },
    revision(id) {
      const value = state.revisions.find((item) => item.id === id);
      if (!value) throw new DomainError('REVISION_NOT_FOUND', 'Missing revision', 404);
      return value;
    },
    component(id) {
      const value = state.decisionComponents.find((item) => item.id === id);
      if (!value) throw new DomainError('DECISION_NOT_FOUND', 'Missing component', 404);
      return value;
    },
    git: {
      ref: async (repo, ref) =>
        ref === 'refs/heads/main'
          ? engine.repo(repo.id).head
          : sourceHeads.get(`${repo.id}:${ref}`),
      facts: async (_repo, head) => {
        const revision = state.revisions.find((item) => item.head_commit === head);
        return { head, tree: revision?.tree_hash };
      },
    },
    syncHeads: async () => false,
    evidenceValidity(evidence) {
      return {
        status:
          evidence.validity_heads[evidence.repo] === engine.repo(evidence.repo).head
            ? 'current'
            : 'stale',
      };
    },
    save: async (current) => {
      saveSnapshots.push(structuredClone(current));
    },
    async basis(component) {
      return hash({
        id: component.id,
        head: engine.repo(component.alternatives[0].repo).head,
        version: state.basisVersions[component.id] ?? 0,
        options: component.alternatives.map((option) => ({
          id: option.id,
          composition_id: option.composition_id,
          evidence_ids: option.evidence_ids,
          merge_request_basis_hash: option.merge_request_basis_hash,
        })),
      });
    },
    async resolve(id, input, actor, execution = {}) {
      resolveCalls.push({
        id,
        input: structuredClone(input),
        actor,
        execution: structuredClone(execution),
      });
      engine.activeResolutions++;
      engine.maxResolutions = Math.max(engine.maxResolutions, engine.activeResolutions);
      try {
        await Promise.resolve();
        const component = engine.component(id),
          option = component.alternatives.find((item) => item.id === input.alternative_id),
          repo = engine.repo(option.repo);
        if (
          input.basis_hash !== (await engine.basis(component)) ||
          input.expected_canonical_head !== repo.head
        )
          throw new DomainError('DECISION_STALE', 'Head or basis changed', 409);
        if (engine.failure === 'before-operation')
          throw new Error('Coordinator failed before write-ahead intent');
        const composition = state.compositions.find((item) => item.id === option.composition_id);
        const decision = await record('decision', {
          component_id: id,
          resolution: option.id,
          decision_basis_hash: input.basis_hash,
          canonical_head_seen: repo.head,
          proposal_revision_ids: composition.proposal_revision_ids,
          actor,
          queue_ticket_id: execution.queue_ticket_id ?? null,
          queue_attempt_id: execution.queue_attempt_id ?? null,
        });
        state.decisions.push(decision);
        const operation = {
          id: `operation-${decision.id}`,
          decision_id: decision.id,
          repo: repo.id,
          expected_head: repo.head,
          target_commit: composition.commit,
          status: 'prepared',
          queue_ticket_id: execution.queue_ticket_id ?? null,
          queue_attempt_id: execution.queue_attempt_id ?? null,
        };
        state.operations.push(operation);
        if (engine.failure === 'uncertain') {
          operation.status = 'recovery-required';
          throw new DomainError('RECOVERY_REQUIRED', 'Git outcome uncertain', 503);
        }
        if (engine.failure === 'cas-failed') {
          operation.status = 'cas-failed';
          throw new DomainError('DECISION_STALE', 'Git CAS failed', 409);
        }
        operation.status = 'applied';
        repo.head = composition.commit;
        component.status = 'resolved';
        for (const mr of state.mergeRequests.filter((item) =>
          composition.proposal_revision_ids.includes(item.revision_id),
        )) {
          mr.status = 'merged';
          mr.version++;
          mr.event_id = `merged-${decision.id}`;
        }
        return { decision_id: decision.id, canonical_head: repo.head, resolution: option.id };
      } finally {
        engine.activeResolutions--;
      }
    },
    async recover() {
      for (const operation of state.operations.filter((item) =>
        ['prepared', 'recovery-required'].includes(item.status),
      )) {
        operation.status = 'applied';
        engine.repo(operation.repo).head = operation.target_commit;
        const decision = state.decisions.find((item) => item.id === operation.decision_id);
        engine.component(decision.component_id).status = 'resolved';
      }
    },
  };
  if (mergeRequests) {
    engine.mr = {
      get(id) {
        const value = state.mergeRequests.find((item) => item.id === id);
        if (!value) throw new DomainError('MR_NOT_FOUND', 'Missing MR', 404);
        return structuredClone(value);
      },
      list: () => structuredClone(state.mergeRequests),
      async basisFor(ids) {
        const selected = state.mergeRequests.filter((item) => ids.includes(item.revision_id)),
          all = new Map();
        const add = (mr) => {
          if (all.has(mr.id)) return;
          all.set(mr.id, mr);
          for (const id of mr.dependency_ids)
            add(state.mergeRequests.find((item) => item.id === id));
        };
        selected.forEach(add);
        return hash([...all.values()].sort((a, b) => a.id.localeCompare(b.id)));
      },
      async guardRevisionIds(ids, _actor, options = {}) {
        engine.guardCompositionIds ??= [];
        engine.guardCompositionIds.push(options.composition_id);
        const reasons = [];
        for (const id of ids) {
          const revision = engine.revision(id),
            proposal = state.proposals.find((item) => item.id === revision.proposal_id);
          if (sourceHeads.get(`${revision.repo}:${proposal.ref}`) !== revision.head_commit)
            throw new DomainError('MR_STALE', 'Source ref changed', 409);
          const mr = state.mergeRequests.find((item) => item.revision_id === id);
          if (!mr) continue;
          if (mr.draft)
            reasons.push({ mr_id: mr.id, code: 'MR_DRAFT', message: 'Draft needs publication' });
          if (!mr.approved)
            reasons.push({ mr_id: mr.id, code: 'REVIEW_REQUIRED', message: 'Approval required' });
          if (!mr.checks_passed)
            reasons.push({
              mr_id: mr.id,
              code: 'CHECK_REQUIRED',
              message: 'Required check is blocked',
            });
          for (const dependencyId of mr.dependency_ids) {
            const dependency = state.mergeRequests.find((item) => item.id === dependencyId);
            if (
              dependency.status !== 'merged' &&
              !(ids.includes(dependency.revision_id) && dependency.repo === mr.repo)
            )
              reasons.push({ mr_id: mr.id, code: 'DEPENDENCY_PENDING', message: dependencyId });
          }
        }
        if (reasons.length)
          throw new DomainError('MR_BLOCKED', 'MR prerequisites blocked', 409, { reasons });
        return {
          allowed: true,
          merge_request_ids: state.mergeRequests
            .filter((item) => ids.includes(item.revision_id))
            .map((item) => item.id),
          basis_hash: await engine.mr.basisFor(ids),
        };
      },
    };
  }
  async function review(component) {
    for (const option of component.alternatives) {
      const repo = engine.repo(option.repo),
        version = state.basisVersions[component.id] ?? 0;
      const composition = {
        id: `composition-${component.id}-${repo.head}-${version}`,
        repo: repo.id,
        base_commit: repo.head,
        resulting_tree: `tree-${component.id}-${repo.head}-${version}`,
        commit: `commit-${component.id}-${repo.head}-${version}`,
        proposal_revision_ids: sorted(option.composed_revision_ids ?? option.revision_ids),
      };
      state.compositions.push(composition);
      const evidence = {
        id: `evidence-${composition.id}`,
        repo: repo.id,
        source: 'platform-owned checks',
        type: 'trusted-validation',
        subject_ref: composition.id,
        tree_hash: composition.resulting_tree,
        result: { passed: true },
        validity_heads: { [repo.id]: repo.head },
      };
      state.evidence.push(evidence);
      Object.assign(option, {
        composition_id: composition.id,
        evidence_ids: [evidence.id],
        validation: 'passed',
        merge_request_basis_hash: engine.mr
          ? await engine.mr.basisFor(composition.proposal_revision_ids)
          : undefined,
      });
    }
    component.basis_hash = await engine.basis(component);
    component.canonical_head_seen = engine.repo(component.alternatives[0].repo).head;
  }
  for (const component of state.decisionComponents) await review(component);
  const queue = new MergeQueue(engine);
  const input = (name, request = `enqueue-${name}`) => {
    const component = engine.component(`component-${name}`),
      option = component.alternatives[0];
    return {
      request_id: request,
      component_id: component.id,
      alternative_id: option.id,
      basis_hash: component.basis_hash,
      expected_canonical_head: component.canonical_head_seen,
      rationale: 'Reviewed this exact implementation and its prerequisites.',
    };
  };
  return { engine, state, queue, review, input };
}
const sorted = (values) => [...new Set(values)].sort();

test('enqueue pins reviewed immutable implementation, evidence and actor; exact request replay is a no-op', async () => {
  const { queue, state, input } = await workspace();
  const ticket = await queue.enqueue(input('a'), 'reviewer');
  const eventCount = state.queueEvents.length;
  assert.equal(ticket.status, 'queued');
  assert.deepEqual(ticket.selected_revision_ids, ['revision-a']);
  assert.ok(Object.isFrozen(state.mergeQueue[0].ticket));
  assert.ok(Object.isFrozen(state.queueEvents[0]));
  assert.deepEqual(await queue.enqueue(input('a'), 'reviewer'), ticket);
  assert.equal(state.queueEvents.length, eventCount);
  await assert.rejects(
    () => queue.enqueue({ ...input('a'), rationale: 'Changed request' }, 'reviewer'),
    (error) => error.code === 'QUEUE_REQUEST_REUSED',
  );
  await assert.rejects(
    () => queue.enqueue(input('a'), 'another-reviewer'),
    (error) => error.code === 'QUEUE_REQUEST_REUSED',
  );
  const snapshot = queue.list();
  snapshot[0].ticket.basis_hash = 'changed-local-snapshot';
  assert.notEqual(state.mergeQueue[0].ticket.basis_hash, snapshot[0].ticket.basis_hash);
});

test('request replay repairs a failed response persistence without duplicating queue authorization', async () => {
  const { queue, engine, state, input } = await workspace();
  let saves = 0,
    persisted;
  engine.save = async (current) => {
    if (++saves === 1) throw new Error('Transient persistence failure');
    persisted = structuredClone(current);
  };
  await assert.rejects(
    () => queue.enqueue(input('a'), 'reviewer'),
    /Transient persistence failure/,
  );
  assert.equal(state.mergeQueue.length, 1);
  const count = state.queueEvents.length;
  const replayed = await queue.enqueue(input('a'), 'reviewer');
  assert.equal(replayed.id, state.mergeQueue[0].id);
  assert.equal(persisted.mergeQueue.length, 1);
  assert.equal(state.queueEvents.length, count);
  assert.equal(engine.resolveCalls.length, 0);
});

test('producer test reports, wrong trees and stale evidence cannot enter an executable queue', async () => {
  for (const mutation of [
    (evidence) => {
      evidence.source = 'producer tests';
    },
    (evidence) => {
      evidence.tree_hash = 'different-tree';
    },
    (evidence) => {
      evidence.result.passed = false;
    },
    (evidence) => {
      evidence.validity_heads[evidence.repo] = 'old-head';
    },
  ]) {
    const { queue, state, input } = await workspace();
    mutation(state.evidence[0]);
    await assert.rejects(
      () => queue.enqueue(input('a'), 'reviewer'),
      (error) => error.code === 'VALIDATION_REQUIRED',
    );
    assert.equal(state.mergeQueue.length, 0);
  }
});

test('stale enqueue head/basis and producer-selected revision substitution fail closed', async () => {
  const { queue, input } = await workspace();
  await assert.rejects(
    () => queue.enqueue({ ...input('a'), basis_hash: 'obsolete' }, 'reviewer'),
    (error) => error.code === 'DECISION_STALE',
  );
  await assert.rejects(
    () => queue.enqueue({ ...input('a'), expected_canonical_head: 'obsolete' }, 'reviewer'),
    (error) => error.code === 'DECISION_STALE',
  );
  await assert.rejects(
    () => queue.enqueue({ ...input('a'), selected_revision_ids: ['revision-b'] }, 'reviewer'),
    (error) => error.code === 'INVALID_RESOLUTION',
  );
  await assert.rejects(
    () => queue.enqueue(input('a'), ''),
    (error) => error.code === 'UNAUTHENTICATED',
  );
});

test('processing executes one FIFO canonical operation and exact process replay never merges the next ticket', async () => {
  const { queue, state, engine, input } = await workspace();
  const first = await queue.enqueue(input('a'), 'approver-a'),
    second = await queue.enqueue(input('b'), 'approver-b');
  const merged = await queue.process({ request_id: 'process-first' }, 'queue-service');
  assert.equal(merged.processed, true);
  assert.equal(merged.entry.id, first.id);
  assert.equal(queue.get(second.id).status, 'queued');
  assert.equal(engine.resolveCalls.length, 1);
  assert.equal(engine.resolveCalls[0].actor, 'approver-a');
  assert.equal(engine.resolveCalls[0].execution.queue_ticket_id, first.ticket.id);
  assert.equal(engine.resolveCalls[0].execution.queue_attempt_id, merged.entry.attempt.id);
  assert.deepEqual(await queue.process({ request_id: 'process-first' }, 'queue-service'), merged);
  assert.equal(engine.resolveCalls.length, 1);
  assert.equal(
    (await queue.process({ request_id: 'process-second' }, 'queue-service')).entry.id,
    second.id,
  );
  assert.equal(engine.resolveCalls.length, 2);
  assert.ok(
    state.queueEvents.some(
      (event) =>
        event.type === 'queue.merge-result' &&
        event.actor === 'queue-service' &&
        event.data.approved_by === 'approver-a',
    ),
  );
});

test('processing requires an immutable request identity before any queue or Git mutation', async () => {
  const { queue, state, engine, input } = await workspace();
  await queue.enqueue(input('a'), 'reviewer');
  const count = state.queueEvents.length;
  for (const value of [{}, { request_id: '' }, { request_id: 42 }]) {
    await assert.rejects(
      () => queue.process(value, 'queue-service'),
      (error) => error.code === 'QUEUE_REQUEST_ID_REQUIRED',
    );
  }
  assert.equal(state.queueEvents.length, count);
  assert.equal(engine.resolveCalls.length, 0);
  assert.equal(queue.list()[0].status, 'queued');
});

test('another canonical update makes a queued ticket needs-review without changing its reviewed pin', async () => {
  const { queue, engine, state, input } = await workspace({ sameRepo: true });
  await queue.enqueue(input('a'), 'reviewer');
  const second = await queue.enqueue(input('b'), 'reviewer');
  const pin = structuredClone(second.ticket);
  await queue.process({ request_id: 'first' }, 'queue-service');
  const next = await queue.process({ request_id: 'second' }, 'queue-service');
  assert.equal(next.processed, false);
  assert.equal(queue.get(second.id).status, 'needs_review');
  assert.deepEqual(queue.get(second.id).ticket, pin);
  assert.equal(engine.resolveCalls.length, 1);
  assert.equal(state.operations.length, 1);
});

test('MR draft/review/check blockers are visible and clearing their changed basis requires explicit re-review', async () => {
  for (const [field, value] of [
    ['draft', true],
    ['approved', false],
    ['checks_passed', false],
  ]) {
    const { queue, state, engine, review, input } = await workspace({ mergeRequests: true });
    const mr = state.mergeRequests[0];
    mr[field] = value;
    await review(engine.component('component-a'));
    const entry = await queue.enqueue(input('a'), 'reviewer');
    assert.equal(entry.status, 'blocked');
    assert.ok(entry.blockers.length > 0);
    assert.equal(
      (await queue.process({ request_id: 'blocked' }, 'queue-service')).processed,
      false,
    );
    assert.equal(engine.resolveCalls.length, 0);
    mr[field] = !value;
    mr.version++;
    mr.event_id = `updated-${field}`;
    await queue.process({ request_id: 'changed-basis' }, 'queue-service');
    assert.equal(queue.get(entry.id).status, 'needs_review');
    assert.equal(engine.resolveCalls.length, 0);
    await queue.cancel(entry.id, { request_id: 'cancel-obsolete' }, 'reviewer');
    await review(engine.component('component-a'));
    const renewed = await queue.enqueue(input('a', 'new-approval'), 'reviewer');
    assert.notEqual(renewed.id, entry.id);
    assert.equal((await queue.process({ request_id: 'renewed' }, 'queue-service')).processed, true);
  }
});

test('dependency guards choose the eligible prerequisite before an older blocked dependent; its changed base is never silently adopted', async () => {
  const { queue, engine, state, review, input } = await workspace({
    mergeRequests: true,
    sameRepo: true,
  });
  state.mergeRequests[1].dependency_ids = ['mr-a'];
  await review(engine.component('component-b'));
  const child = await queue.enqueue(input('b'), 'reviewer'),
    parent = await queue.enqueue(input('a'), 'reviewer');
  assert.equal(child.status, 'blocked');
  assert.ok(child.reviewed_dependencies.some((item) => item.id === 'mr-a'));
  const result = await queue.process({ request_id: 'topological-first' }, 'queue-service');
  assert.equal(result.entry.id, parent.id);
  assert.equal(result.processed, true);
  await queue.process({ request_id: 'topological-second' }, 'queue-service');
  assert.equal(queue.get(child.id).status, 'needs_review');
  assert.equal(engine.resolveCalls.length, 1);
});

test('same-repository dependency revisions selected together execute only their exact checked batch', async () => {
  const { queue, engine, state, review, input } = await workspace({
    mergeRequests: true,
    sameRepo: true,
  });
  state.mergeRequests[1].dependency_ids = ['mr-a'];
  const component = engine.component('component-b');
  component.revision_ids = ['revision-a', 'revision-b'];
  component.alternatives[0].revision_ids = ['revision-a', 'revision-b'];
  component.alternatives[0].composed_revision_ids = ['revision-a', 'revision-b'];
  state.basisVersions[component.id] = 1;
  await review(component);
  const entry = await queue.enqueue(input('b'), 'reviewer');
  assert.equal(entry.status, 'queued');
  assert.deepEqual(entry.merge_request_ids, ['mr-a', 'mr-b']);
  assert.equal((await queue.process({ request_id: 'batch' }, 'queue-service')).processed, true);
  assert.equal(engine.resolveCalls.length, 1);
  assert.deepEqual(state.decisions[0].proposal_revision_ids, ['revision-a', 'revision-b']);
  assert.ok(engine.guardCompositionIds.every((id) => id === entry.composition_id));
});

test('ordinary Git work remains usable but a changed producer head invalidates its queued authorization', async () => {
  const { queue, engine, input } = await workspace();
  const entry = await queue.enqueue(input('a'), 'reviewer');
  engine.sourceHeads.set('repo-a:refs/heads/a', 'rebased-source');
  await queue.process({ request_id: 'source-drift' }, 'queue-service');
  assert.equal(queue.get(entry.id).status, 'needs_review');
  assert.equal(engine.resolveCalls.length, 0);
});

test('deleted producer branches become explicit needs-review rather than recurring processing errors', async () => {
  const { queue, engine, input } = await workspace();
  const entry = await queue.enqueue(input('a'), 'reviewer');
  engine.git.ref = async () => {
    throw new DomainError('REF_NOT_FOUND', 'Branch unavailable', 404);
  };
  const result = await queue.process({ request_id: 'deleted-source' }, 'queue-service');
  assert.equal(result.reason, 'needs_review');
  assert.equal(queue.get(entry.id).status, 'needs_review');
  assert.equal(engine.resolveCalls.length, 0);
});

test('retained revert candidates use exact immutable Git facts instead of producer branch assumptions', async () => {
  const { queue, engine, state, input } = await workspace();
  state.revisions[0].source_kind = 'retained-candidate';
  state.revisions[0].base_commit = 'repo-a-baseline';
  state.proposals[0].ref = 'refs/converge/candidates/source-a';
  const entry = await queue.enqueue(input('a'), 'reviewer');
  assert.equal(entry.status, 'queued');
  engine.git.facts = async () => ({ head: 'source-a', tree: 'a-different-object' });
  await queue.process({ request_id: 'changed-object' }, 'queue-service');
  assert.equal(queue.get(entry.id).status, 'needs_review');
  assert.equal(engine.resolveCalls.length, 0);
});

test('uncertain CAS stops the queue; recovery reconciliation observes exact applied operation without repeating Git', async () => {
  const { queue, engine, state, input } = await workspace();
  const entry = await queue.enqueue(input('a'), 'reviewer');
  await queue.enqueue(input('b'), 'reviewer');
  engine.failure = 'uncertain';
  const outcome = await queue.process({ request_id: 'uncertain' }, 'queue-service');
  assert.equal(outcome.reason, 'recovery_required');
  assert.equal(queue.get(entry.id).status, 'recovery_required');
  assert.equal(engine.resolveCalls.length, 1);
  await queue.process({ request_id: 'stop' }, 'queue-service');
  assert.equal(engine.resolveCalls.length, 1);
  await queue.reconcile('recovery-service');
  assert.equal(queue.get(entry.id).status, 'recovery_required');
  await engine.recover();
  const reconciled = await queue.reconcile('recovery-service');
  assert.deepEqual(reconciled.reconciled_entry_ids, [entry.id]);
  assert.equal(queue.get(entry.id).status, 'merged');
  assert.equal(engine.resolveCalls.length, 1);
  assert.equal(queue.get(entry.id).outcome.decision_id, state.operations[0].decision_id);
  await queue.reconcile('recovery-service');
  assert.equal(engine.resolveCalls.length, 1);
});

test('known CAS rejection requires review; an interruption without prepared intent is never automatically retried', async () => {
  for (const failure of ['cas-failed', 'before-operation']) {
    const { queue, engine, input } = await workspace();
    const entry = await queue.enqueue(input('a'), 'reviewer');
    engine.failure = failure;
    await queue.process({ request_id: failure }, 'queue-service');
    assert.equal(
      queue.get(entry.id).status,
      failure === 'cas-failed' ? 'needs_review' : 'recovery_required',
    );
    if (failure === 'before-operation') await queue.reconcile('recovery-service');
    assert.equal(queue.get(entry.id).status, 'needs_review');
    await queue.process({ request_id: `no-retry-${failure}` }, 'queue-service');
    assert.equal(engine.resolveCalls.length, 1);
  }
});

test('a later direct resolution cannot be attributed to an interrupted queue attempt', async () => {
  const { queue, engine, state, input } = await workspace();
  const entry = await queue.enqueue(input('a'), 'reviewer');
  engine.failure = 'before-operation';
  await queue.process({ request_id: 'interrupted' }, 'queue-service');
  assert.equal(queue.get(entry.id).status, 'recovery_required');
  engine.failure = null;
  const approved = input('a');
  await engine.resolve(approved.component_id, approved, 'reviewer');
  assert.equal(state.operations[0].status, 'applied');
  assert.equal(state.operations[0].queue_attempt_id, null);
  await queue.reconcile('recovery-service');
  assert.equal(queue.get(entry.id).status, 'needs_review');
  assert.ok(
    !state.queueEvents.some(
      (event) => event.type === 'queue.merge-reconciled' && event.data.entry_id === entry.id,
    ),
  );
  assert.equal(engine.resolveCalls.length, 2);
});

test('concurrent process calls cannot overlap canonical operations even without a nested engine serial call', async () => {
  const { queue, engine, input } = await workspace();
  await queue.enqueue(input('a'), 'reviewer');
  await queue.enqueue(input('b'), 'reviewer');
  const results = await Promise.all([
    queue.process({ request_id: 'one' }, 'queue-service'),
    queue.process({ request_id: 'two' }, 'queue-service'),
  ]);
  assert.equal(results.filter((result) => result.processed).length, 1);
  assert.ok(results.some((result) => result.reason === 'queue_busy'));
  assert.equal(engine.maxResolutions, 1);
  assert.equal(engine.resolveCalls.length, 1);
});

test('only cancellable pending states accept cancellation; replay preserves append-only result records', async () => {
  const { queue, state, engine, input } = await workspace();
  const entry = await queue.enqueue(input('a'), 'reviewer');
  const cancelled = await queue.cancel(entry.id, { request_id: 'cancel' }, 'reviewer');
  const count = state.queueEvents.length;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await queue.cancel(entry.id, { request_id: 'cancel' }, 'reviewer'), cancelled);
  assert.equal(state.queueEvents.length, count);
  await assert.rejects(
    () => queue.cancel(entry.id, { request_id: 'again' }, 'reviewer'),
    (error) => error.code === 'QUEUE_NOT_CANCELLABLE',
  );
  const other = await queue.enqueue(input('b'), 'reviewer');
  await queue.process({ request_id: 'merge' }, 'queue-service');
  await assert.rejects(
    () => queue.cancel(other.id, {}, 'reviewer'),
    (error) => error.code === 'QUEUE_NOT_CANCELLABLE',
  );
  assert.equal(engine.resolveCalls.length, 1);
  for (let index = 0; index < state.queueEvents.length; index++) {
    const { id, ...data } = state.queueEvents[index];
    assert.equal((await record('queue_event', data)).id, id);
    if (index) assert.equal(data.previous, state.queueEvents[index - 1].id);
  }
});

test('ordinary Git work passes the actual engine queue and uncertain remote acknowledgment recovers without a second CAS', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'converge-queue-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { engine, state, adapter } = await createDemo(root, async () => {}, { pending: true });
  const repo = engine.repo('checkout-api');
  async function propose(name) {
    const directory = path.join(root, name);
    await mkdir(directory);
    await git(root, ['clone', '--quiet', adapter.dir(repo), directory]);
    await git(directory, ['checkout', '--quiet', '-b', name]);
    const filename = path.join(directory, 'README.md');
    await writeFile(
      filename,
      (await readFile(filename, 'utf8')) + `\nReviewed queue behavior: ${name}.\n`,
    );
    await git(directory, ['add', 'README.md']);
    await git(directory, ['commit', '--quiet', '-m', name]);
    await git(directory, ['push', '--quiet', 'origin', name]);
    const head = await git(directory, ['rev-parse', 'HEAD']),
      ingestion = await engine.ingest({ repo: repo.id, ref: `refs/heads/${name}`, after: head });
    const component = await engine.prepareReview(
      { revision_ids: [ingestion.revision_id] },
      'explicit-git-reviewer',
    );
    assert.equal(component.alternatives[0].validation, 'passed');
    return engine.queue.enqueue(
      {
        request_id: `enqueue-${name}`,
        component_id: component.id,
        alternative_id: component.alternatives[0].id,
        basis_hash: component.basis_hash,
        expected_canonical_head: component.canonical_head_seen,
        rationale: 'Reviewed the exact ordinary Git documentation change.',
      },
      'explicit-git-reviewer',
    );
  }
  const first = await propose('ordinary-change');
  const result = await engine.queue.process({ request_id: 'process-ordinary' }, 'queue-service');
  assert.equal(result.processed, true);
  assert.equal(result.entry.id, first.id);
  assert.equal(state.decisions[0].queue_ticket_id, first.id);
  assert.equal(state.operations[0].queue_attempt_id, engine.queue.get(first.id).attempt.id);
  const second = await propose('lost-acknowledgment');
  const conditionalUpdate = adapter.cas.bind(adapter);
  let attempts = 0;
  adapter.cas = async (...args) => {
    attempts++;
    const applied = await conditionalUpdate(...args);
    if (applied) throw new Error('Acknowledgment lost after the conditional Git update');
    return applied;
  };
  const uncertain = await engine.queue.process(
    { request_id: 'process-uncertain' },
    'queue-service',
  );
  assert.equal(uncertain.reason, 'recovery_required');
  assert.equal(engine.queue.get(second.id).status, 'recovery_required');
  await engine.recover();
  assert.equal(engine.queue.get(second.id).status, 'merged');
  assert.equal(attempts, 1);
  await engine.queue.process({ request_id: 'process-uncertain' }, 'queue-service');
  await engine.queue.process({ request_id: 'observe-empty' }, 'queue-service');
  assert.equal(attempts, 1);
  const clone = path.join(root, 'clone-verify');
  await git(root, ['clone', '--quiet', adapter.dir(repo), clone]);
  assert.equal(await git(clone, ['rev-parse', 'HEAD']), repo.head);
  await git(clone, ['fsck', '--full']);
  assert.match(await readFile(path.join(clone, 'README.md'), 'utf8'), /ordinary-change/);
  assert.match(await readFile(path.join(clone, 'README.md'), 'utf8'), /lost-acknowledgment/);
  assert.equal(
    state.tasks[0].authorization,
    null,
    'Standard Git producers did not need to adopt the task-agent workflow',
  );
});
