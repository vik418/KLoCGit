import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, emptyState } from '../core/engine.mjs';
import { LocalGit, git } from '../server/git.mjs';
import { record } from '../core/hash.mjs';

const ref = 'refs/heads/main';
const actor = 'owner';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-rollout-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'repositories'));
  const adapter = new LocalGit(root);
  adapter.configHash = 'rollout-checks-v0';
  const state = emptyState();
  const facts = {};
  for (const id of ['alpha', 'beta']) {
    const work = path.join(root, id);
    await mkdir(work);
    await git(work, ['init', '--quiet', '-b', 'main']);
    await writeFile(path.join(work, 'base.txt'), id + ' baseline\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'baseline']);
    const base = await git(work, ['rev-parse', 'HEAD']);
    const baseTree = await git(work, ['rev-parse', 'HEAD^{tree}']);
    await git(work, ['checkout', '--quiet', '-b', 'external']);
    await writeFile(path.join(work, 'external.txt'), 'ordinary external push\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'external work']);
    const external = await git(work, ['rev-parse', 'HEAD']);
    await git(work, ['checkout', '--quiet', 'main']);
    await writeFile(path.join(work, 'feature.txt'), id + ' feature\n');
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'future work']);
    const head = await git(work, ['rev-parse', 'HEAD']);
    const tree = await git(work, ['rev-parse', 'HEAD^{tree}']);
    await git(root, ['clone', '--bare', '--quiet', work, adapter.dir({ id })]);
    await git(root, ['clone', '--bare', '--quiet', work, adapter.dir({ id: id + '-source' })]);
    await git(adapter.dir({ id }), ['update-ref', ref, base]);
    const revision = await record('future-revision', {
      future_id: id + '-future',
      repository_heads: [{ repo_id: id, source_repo_id: id + '-source', ref, commit: head }],
      baseline_refs: [{ repo_id: id, ref, commit: base, tree: baseTree }],
      tree_hashes: [{ repo_id: id, tree }],
      provenance_state: 'unknown',
    });
    state.repositories.push({ id, canonical_ref: ref, head: base, tree: baseTree, baseline: base });
    state.futures ??= [];
    state.futureRevisions ??= [];
    state.futures.push({
      id: revision.future_id,
      status: 'active',
      current_revision_id: revision.id,
    });
    state.futureRevisions.push(revision);
    facts[id] = { base, baseTree, external, head, tree, revision };
  }
  const validations = [];
  // A fixture-owned evaluator establishes exact input plumbing, not general correctness.
  adapter.validate = async (repo, commit, constraints, heads) => {
    validations.push({ repo: repo.id, commit, heads: structuredClone(heads) });
    return { passed: true, checks: [{ name: 'fixture-owned finite check', passed: true }] };
  };
  const saved = [];
  const engine = new Engine(state, adapter, async (value) => saved.push(structuredClone(value)));
  let serial = 0;
  async function selection(id) {
    return (
      await engine.pipeline.createSelection(
        {
          future_revision_id: facts[id].revision.id,
          kind: 'future',
          request_id: 'selection-' + id,
        },
        actor,
      )
    ).selection;
  }
  async function candidate(selections) {
    return (
      await engine.pipeline.createCandidate(
        {
          selection_ids: selections.map((item) => item.id),
          request_id: 'candidate-' + ++serial,
        },
        actor,
      )
    ).candidate;
  }
  async function review(candidateValue, continuation) {
    await engine.pipeline.validateCandidate(
      candidateValue.id,
      {
        request_id: 'validate-' + ++serial,
      },
      actor,
    );
    const current = continuation
      ? await engine.pipeline.reviewContinuation(continuation.id, candidateValue.id)
      : await engine.pipeline.review(candidateValue.id);
    return {
      candidate_id: candidateValue.id,
      request_id: 'promotion-' + ++serial,
      expected_heads: current.expected_heads,
      decision_basis_hash: current.decision_basis_hash,
      rationale: 'Accept the exact tested system state.',
    };
  }
  async function prepared() {
    const selections = await Promise.all(['alpha', 'beta'].map(selection));
    const value = await candidate(selections);
    const input = await review(value);
    return { selections, candidate: value, input };
  }
  return {
    root,
    state,
    facts,
    engine,
    adapter,
    saved,
    validations,
    selection,
    candidate,
    composeCandidate: candidate,
    review,
    prepared,
    async head(id) {
      return adapter.ref({ id }, ref);
    },
    async externalPush(id) {
      await git(adapter.dir({ id }), ['update-ref', ref, facts[id].external]);
    },
  };
}

async function partial(t) {
  const f = await fixture(t);
  const work = await f.prepared();
  const cas = f.adapter.cas.bind(f.adapter);
  const attempts = [];
  f.adapter.cas = async (repo, expected, target) => {
    attempts.push(repo.id);
    if (repo.id === 'beta') await f.externalPush('beta');
    return cas(repo, expected, target);
  };
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, work.input, actor), {
    code: 'DECISION_STALE',
  });
  f.adapter.cas = async (repo, expected, target) => {
    attempts.push(repo.id);
    return cas(repo, expected, target);
  };
  return { ...f, ...work, operation: f.state.operations.at(-1), attempts };
}

test('multi-repository rollout uses exact composed dependencies and independent Git CAS', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  for (const run of f.validations)
    for (const repo of work.candidate.repositories)
      assert.equal(run.heads[repo.repo_id], repo.commit);
  const writes = [];
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {
    writes.push(args[0].id);
    return cas(...args);
  };
  const result = await f.engine.pipeline.promote(work.candidate.id, work.input, actor);
  assert.equal(result.operation.status, 'applied');
  assert.equal(result.operation.non_atomic, true);
  assert.deepEqual(writes, ['alpha', 'beta']);
  assert.deepEqual(
    result.operation.stages.map((stage) => stage.status),
    ['applied', 'applied'],
  );
  for (const repo of work.candidate.repositories) {
    assert.equal(await f.head(repo.repo_id), repo.commit);
    assert.equal(
      await f.adapter.file({ id: repo.repo_id }, repo.commit, 'feature.txt'),
      repo.repo_id + ' feature',
    );
  }
  const repeated = await f.engine.pipeline.promote(work.candidate.id, work.input, actor);
  assert.equal(repeated.operation.id, result.operation.id);
  assert.equal(writes.length, 2);
  assert.equal(
    f.state.nativeEvents.filter((event) => event.type === 'io.klocgit.canonical.updated').length,
    2,
  );
  assert.equal(f.state.nativeDispositions.filter((entry) => entry.status === 'applied').length, 2);
});

test('a second-repository race exposes partial application and blocks every new canonical write', async (t) => {
  const f = await partial(t);
  assert.equal(f.operation.status, 'recovery-required');
  assert.deepEqual(
    f.operation.stages.map((stage) => stage.status),
    ['applied', 'rejected'],
  );
  assert.equal(await f.head('alpha'), f.candidate.repositories[0].commit);
  assert.equal(await f.head('beta'), f.facts.beta.external);
  assert.equal(
    f.state.nativeDispositions.some((entry) => entry.status === 'partially_applied'),
    true,
  );
  await assert.rejects(
    () =>
      f.engine.pipeline.promote(
        f.candidate.id,
        {
          ...f.input,
          request_id: 'unrelated-attempt',
        },
        actor,
      ),
    { code: 'RECOVERY_REQUIRED' },
  );
  await f.engine.recover();
  assert.deepEqual(f.attempts, ['alpha', 'beta']);
  assert.equal(f.operation.status, 'recovery-required');
});

test('a crash before any dispatch recovers as not applied without touching Git', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const save = f.engine.save;
  f.engine.save = async (state) => {
    await save(state);
    if (state.operations.at(-1)?.stages?.every((stage) => stage.dispatch_state === 'not_started'))
      throw new Error('crash before dispatch');
  };
  let writes = 0;
  f.adapter.cas = async () => {
    writes++;
    return true;
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(work.candidate.id, work.input, actor),
    /crash before dispatch/,
  );
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.equal(restarted.state.operations[0].status, 'not-applied');
  assert.deepEqual(
    restarted.state.operations[0].stages.map((stage) => stage.status),
    ['not-issued', 'not-issued'],
  );
  assert.equal(writes, 0);
  assert.equal(await f.head('alpha'), f.facts.alpha.base);
  assert.equal(await f.head('beta'), f.facts.beta.base);
});

test('a crash after dispatch was persisted stays uncertain even when Git still shows the base', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const save = f.engine.save;
  let crashed = false;
  f.engine.save = async (state) => {
    await save(state);
    if (!crashed && state.operations.at(-1)?.stages?.[0].dispatch_state === 'issued') {
      crashed = true;
      throw new Error('crash after dispatch record');
    }
  };
  let writes = 0;
  f.adapter.cas = async () => {
    writes++;
    return true;
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(work.candidate.id, work.input, actor),
    /crash after dispatch record/,
  );
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.equal(restarted.state.operations[0].status, 'recovery-required');
  assert.equal(restarted.state.operations[0].stages[0].status, 'uncertain');
  assert.equal(writes, 0);
});

test('crash between repositories retains the applied stage and never dispatches the remaining one', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const save = f.engine.save;
  let crashed = false;
  f.engine.save = async (state) => {
    await save(state);
    if (!crashed && state.operations.at(-1)?.stages?.[0].status === 'applied') {
      crashed = true;
      throw new Error('metadata acknowledgement lost');
    }
  };
  const writes = [];
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (...args) => {
    writes.push(args[0].id);
    return cas(...args);
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(work.candidate.id, work.input, actor),
    /metadata acknowledgement lost/,
  );
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.deepEqual(writes, ['alpha']);
  assert.equal(restarted.state.operations[0].status, 'recovery-required');
  assert.deepEqual(
    restarted.state.operations[0].stages.map((stage) => stage.status),
    ['applied', 'not-issued'],
  );
  assert.equal(await f.head('beta'), f.facts.beta.base);
});

test('a lost final acknowledgement recovers exact targets without repeating either write', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const cas = f.adapter.cas.bind(f.adapter);
  const writes = [];
  f.adapter.cas = async (repo, ...args) => {
    writes.push(repo.id);
    await cas(repo, ...args);
    if (repo.id === 'beta') throw new Error('reply lost');
    return true;
  };
  await assert.rejects(
    () => f.engine.pipeline.promote(work.candidate.id, work.input, actor),
    /reply lost/,
  );
  const restarted = new Engine(structuredClone(f.saved.at(-1)), f.adapter);
  await restarted.recover();
  assert.equal(restarted.state.operations[0].status, 'applied');
  assert.deepEqual(writes, ['alpha', 'beta']);
  assert.equal(
    restarted.state.nativeEvents.filter((event) => event.type === 'io.klocgit.canonical.updated')
      .length,
    2,
  );
});

test('later external movement is not proof of non-application and settlement stays declared', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const cas = f.adapter.cas.bind(f.adapter);
  const writes = [];
  f.adapter.cas = async (repo, ...args) => {
    writes.push(repo.id);
    await cas(repo, ...args);
    if (repo.id === 'beta') {
      await f.externalPush('beta');
      throw new Error('lost reply before external move');
    }
    return true;
  };
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, work.input, actor));
  await f.engine.recover();
  const operation = f.state.operations[0];
  assert.equal(operation.stages[1].status, 'uncertain');
  await assert.rejects(
    () =>
      f.engine.pipeline.settleOperation(
        operation.id,
        {
          request_id: 'unsafe-abandon',
          confirmed: true,
          abandon: true,
          expected_heads: Object.fromEntries(
            f.state.repositories.map((repo) => [repo.id, repo.head]),
          ),
          rationale: 'Do not silently erase an uncertain stage.',
        },
        actor,
      ),
    { code: 'RECOVERY_REQUIRED' },
  );
  const settled = await f.engine.pipeline.settleOperation(
    operation.id,
    {
      request_id: 'settle-beta',
      repo_id: 'beta',
      expected_head: f.facts.beta.external,
      outcome: 'applied_then_moved',
      confirmed: true,
      rationale: 'Inspected the executor and Git history.',
    },
    actor,
  );
  assert.equal(settled.settlement.basis, 'declared');
  assert.equal(settled.settlement.observed_refs[0].basis, 'observed');
  assert.equal(operation.status, 'recovery-required');
  const abandon = await f.engine.pipeline.settleOperation(
    operation.id,
    {
      request_id: 'abandon-rest',
      confirmed: true,
      abandon: true,
      expected_heads: Object.fromEntries(f.state.repositories.map((repo) => [repo.id, repo.head])),
      rationale: 'Keep the observed partial state; any reversal needs a new candidate.',
    },
    actor,
  );
  assert.equal(abandon.operation.status, 'settled');
  assert.equal(abandon.settlement.outcome, 'abandon_remaining');
  assert.deepEqual(writes, ['alpha', 'beta']);
  assert.equal(await f.head('alpha'), work.candidate.repositories[0].commit);
  assert.equal(await f.head('beta'), f.facts.beta.external);
});

test('explicit continuation requires fresh full-vector validation and never repeats applied stages', async (t) => {
  const f = await partial(t);
  const candidate = await f.composeCandidate(f.selections);
  const input = await f.review(candidate, f.operation);
  const continued = await f.engine.pipeline.continuePromotion(f.operation.id, input, actor);
  assert.equal(continued.operation.status, 'applied');
  assert.equal(continued.operation.continuation_of, f.operation.id);
  assert.equal(f.operation.status, 'continued');
  assert.equal(f.operation.continued_by, continued.operation.id);
  assert.deepEqual(f.attempts, ['alpha', 'beta', 'beta']);
  assert.equal(await f.head('alpha'), f.candidate.repositories[0].commit);
  assert.equal(
    await f.adapter.file({ id: 'beta' }, await f.head('beta'), 'external.txt'),
    'ordinary external push',
  );
  assert.equal(
    await f.adapter.file({ id: 'beta' }, await f.head('beta'), 'feature.txt'),
    'beta feature',
  );
  const repeated = await f.engine.pipeline.continuePromotion(f.operation.id, input, actor);
  assert.equal(repeated.operation.id, continued.operation.id);
  assert.equal(f.attempts.length, 3);
});

test('continuation cannot use a normal review hash or hide changed configuration, constraints or sources', async (t) => {
  const f = await partial(t);
  const candidate = await f.composeCandidate(f.selections);
  const normal = await f.review(candidate);
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, normal, actor), {
    code: 'DECISION_STALE',
  });
  let input = await f.review(candidate, f.operation);
  f.adapter.configHash = 'changed-configuration';
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, input, actor), {
    code: 'DECISION_STALE',
  });
  f.adapter.configHash = 'rollout-checks-v0';
  input = await f.review(candidate, f.operation);
  f.state.constraints.push({ id: 'new-constraint', active: true, kind: 'advisory' });
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, input, actor), {
    code: 'DECISION_STALE',
  });
  f.state.constraints = [];
  input = await f.review(candidate, f.operation);
  await git(f.adapter.dir({ id: 'beta-source' }), ['update-ref', ref, f.facts.beta.external]);
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, input, actor), {
    code: 'DECISION_STALE',
  });
  assert.deepEqual(f.attempts, ['alpha', 'beta']);
});

test('continuation hashes partial-stage state and stale canonical vectors explicitly', async (t) => {
  const f = await partial(t);
  const candidate = await f.composeCandidate(f.selections);
  let input = await f.review(candidate, f.operation);
  f.operation.stop_reason = 'operator-inspected';
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, input, actor), {
    code: 'DECISION_STALE',
  });
  input = await f.review(candidate, f.operation);
  await git(f.adapter.dir({ id: 'beta' }), ['update-ref', ref, f.facts.beta.base]);
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, input, actor), {
    code: 'DECISION_STALE',
  });
  assert.deepEqual(f.attempts, ['alpha', 'beta']);
});

test('changed constraints before the second dispatch leave an explicit non-issued partial stage', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const cas = f.adapter.cas.bind(f.adapter);
  const writes = [];
  f.adapter.cas = async (repo, ...args) => {
    writes.push(repo.id);
    const result = await cas(repo, ...args);
    f.state.constraints.push({ id: 'constraint-after-first-cas', active: true, kind: 'advisory' });
    return result;
  };
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, work.input, actor), {
    code: 'DECISION_STALE',
  });
  assert.deepEqual(writes, ['alpha']);
  assert.deepEqual(
    f.state.operations[0].stages.map((stage) => stage.status),
    ['applied', 'not-issued'],
  );
  assert.equal(f.state.operations[0].status, 'recovery-required');
});

test('single-repository operation shape and retry receipts remain compatible', async (t) => {
  const f = await fixture(t);
  const candidate = await f.composeCandidate([await f.selection('alpha')]);
  const input = await f.review(candidate);
  const result = await f.engine.pipeline.promote(candidate.id, input, actor);
  assert.equal(result.operation.stages, undefined);
  assert.equal(result.operation.repo, 'alpha');
  assert.equal(result.operation.expected_head, f.facts.alpha.base);
  assert.equal(result.operation.dispatch_state, 'issued');
  assert.equal(result.operation.status, 'applied');
  assert.equal(
    (await f.engine.pipeline.promote(candidate.id, input, actor)).operation.id,
    result.operation.id,
  );
  assert.equal(await f.head('beta'), f.facts.beta.base);
});

test('a failed continuation retains the partial-rollout block and can be freshly reviewed again', async (t) => {
  const f = await partial(t);
  const candidate = await f.composeCandidate(f.selections);
  const input = await f.review(candidate, f.operation);
  const cas = f.adapter.cas.bind(f.adapter);
  f.adapter.cas = async (repo, expected, target) => {
    await git(f.adapter.dir(repo), ['update-ref', ref, f.facts.beta.base]);
    return cas(repo, expected, target);
  };
  await assert.rejects(() => f.engine.pipeline.continuePromotion(f.operation.id, input, actor), {
    code: 'DECISION_STALE',
  });
  const attempted = f.state.operations.at(-1);
  assert.equal(f.operation.status, 'continued');
  assert.equal(attempted.continuation_of, f.operation.id);
  assert.equal(attempted.status, 'recovery-required');
  assert.equal(attempted.stages[0].status, 'rejected');
  await f.engine.recover();
  assert.equal(attempted.status, 'recovery-required');
  const next = await f.composeCandidate(f.selections);
  const nextInput = await f.review(next, attempted);
  f.adapter.cas = async (repo, expected, target) => {
    return cas(repo, expected, target);
  };
  const completed = await f.engine.pipeline.continuePromotion(attempted.id, nextInput, actor);
  assert.equal(completed.operation.status, 'applied');
  assert.deepEqual(f.attempts, ['alpha', 'beta', 'beta', 'beta']);
  assert.equal(await f.head('alpha'), f.candidate.repositories[0].commit);
});

test('discovery can pin the exact baseline used by a composition attempt', async (t) => {
  const f = await fixture(t);
  const selections = await Promise.all(['alpha', 'beta'].map(f.selection));
  const expected = Object.fromEntries(f.state.repositories.map((repo) => [repo.id, repo.head]));
  await f.externalPush('beta');
  let compositions = 0;
  const compose = f.adapter.composeSelections.bind(f.adapter);
  f.adapter.composeSelections = async (...args) => {
    compositions++;
    return compose(...args);
  };
  await assert.rejects(
    () =>
      f.engine.pipeline.createCandidate(
        {
          selection_ids: selections.map((entry) => entry.id),
          expected_heads: expected,
          request_id: 'pinned-composition',
        },
        actor,
      ),
    { code: 'CANONICAL_CHANGED' },
  );
  assert.equal(compositions, 0);
  assert.equal(f.state.candidateStates.length, 0);
});

test('an earlier ref moving during the final CAS is exposed as a moved partial rollout', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  const cas = f.adapter.cas.bind(f.adapter);
  const writes = [];
  f.adapter.cas = async (repo, ...args) => {
    writes.push(repo.id);
    const result = await cas(repo, ...args);
    if (repo.id === 'beta') await f.externalPush('alpha');
    return result;
  };
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, work.input, actor), {
    code: 'DECISION_STALE',
  });
  const operation = f.state.operations[0];
  assert.equal(operation.status, 'recovery-required');
  assert.deepEqual(
    operation.stages.map((stage) => stage.status),
    ['applied', 'applied'],
  );
  assert.equal(operation.stages[0].current, false);
  assert.equal(operation.stages[0].observed_head, f.facts.alpha.external);
  await f.engine.recover();
  assert.equal(operation.status, 'recovery-required');
  assert.deepEqual(writes, ['alpha', 'beta']);
});

test('required external evaluation gates promotion and uses acknowledged rollout vectors', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  f.adapter.validate = async () => ({
    passed: false,
    checks: [{ name: 'legacy profile is not the configured evaluator', passed: false }],
  });
  let passing = false;
  const vectors = [];
  f.engine.evaluators = {
    async eligibility(id, options = {}) {
      assert.equal(id, work.candidate.id);
      const expected = options.canonical_heads ?? work.candidate.base_heads;
      vectors.push(structuredClone(expected));
      const current = Object.entries(expected).every(
        ([repoId, head]) => f.engine.repo(repoId).head === head,
      );
      return {
        configured: true,
        passing: passing && current,
        basis: { required_evaluations: [{ run: 'trusted-run', version: 'v0' }] },
        runs: [{ id: 'trusted-run' }],
        reasons: [],
      };
    },
  };
  let input = await f.review(work.candidate);
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, input, actor), {
    code: 'VALIDATION_REQUIRED',
  });
  assert.equal(f.state.operations.length, 0);
  passing = true;
  input = await f.review(work.candidate);
  const result = await f.engine.pipeline.promote(work.candidate.id, input, actor);
  assert.equal(result.operation.status, 'applied');
  assert.deepEqual(result.decision.evaluator_run_ids, ['trusted-run']);
  assert.equal(
    vectors.some(
      (heads) =>
        heads.alpha === work.candidate.repositories[0].commit && heads.beta === f.facts.beta.base,
    ),
    true,
  );
});

test('a changed evaluation run after the first write blocks the next repository dispatch', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  let version = 'passing';
  f.engine.evaluators = {
    async eligibility() {
      return {
        configured: true,
        passing: version === 'passing',
        basis: { run: version },
        runs: [{ id: version }],
      };
    },
  };
  const input = await f.review(work.candidate);
  const cas = f.adapter.cas.bind(f.adapter);
  const writes = [];
  f.adapter.cas = async (repo, ...args) => {
    writes.push(repo.id);
    const result = await cas(repo, ...args);
    version = 'pending-new-run';
    return result;
  };
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, input, actor), {
    code: 'DECISION_STALE',
  });
  assert.deepEqual(writes, ['alpha']);
  assert.equal(f.state.operations[0].status, 'recovery-required');
  assert.equal(f.state.operations[0].stages[1].status, 'not-issued');
});

test('material context invalidation blocks a reviewed promotion before any Git write', async (t) => {
  const f = await fixture(t);
  const work = await f.prepared();
  let current = true;
  f.engine.objectiveContext = {
    async revisionsValidity(ids) {
      assert.equal(ids.length, 2);
      return {
        status: current ? 'current' : 'stale',
        snapshots: [
          {
            id: 'context-v0',
            basis_hash: 'context-basis',
            assumption_refs: [],
            validity: { status: current ? 'current' : 'stale', reasons: [] },
          },
        ],
        unknown_revision_count: 0,
        requires_human_judgment: false,
      };
    },
  };
  const input = await f.review(work.candidate);
  current = false;
  await assert.rejects(() => f.engine.pipeline.promote(work.candidate.id, input, actor), {
    code: 'DECISION_STALE',
  });
  assert.equal(f.state.operations.length, 0);
  assert.equal(await f.head('alpha'), f.facts.alpha.base);
});

test('an annotated source tag moving to a new object invalidates selection even at the same commit', async (t) => {
  const f = await fixture(t);
  const object = '7'.repeat(40);
  const priorRevision = structuredClone(f.facts.alpha.revision);
  delete priorRevision.id;
  const revision = await record('future-revision', {
    ...priorRevision,
    repository_heads: [
      {
        repo_id: 'alpha',
        source_repo_id: 'alpha-source',
        ref: 'refs/tags/work',
        commit: f.facts.alpha.head,
        object_id: object,
        object_type: 'tag',
      },
    ],
  });
  // Construct a new immutable tag-pinned revision; existing commit history stays intact.
  f.state.futureRevisions.push(revision);
  f.state.futures.find((future) => future.id === 'alpha-future').current_revision_id = revision.id;
  let observedObject = object;
  f.adapter.readRef = async () => ({
    ref: 'refs/tags/work',
    object_id: observedObject,
    object_type: 'tag',
    commit: f.facts.alpha.head,
    available_for_future: true,
  });
  const selection = (
    await f.engine.pipeline.createSelection(
      {
        future_revision_id: revision.id,
        kind: 'future',
        request_id: 'tag-selection',
      },
      actor,
    )
  ).selection;
  assert.equal(selection.entries[0].object_id, object);
  assert.equal(await f.engine.pipeline.sourceValidity([selection.id]), true);
  observedObject = '8'.repeat(40);
  assert.equal(await f.engine.pipeline.sourceValidity([selection.id]), false);
});
