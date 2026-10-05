import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, LocalGit } from '../server/git.mjs';
import { record } from '../core/hash.mjs';
import {
  prepareTaskContext,
  answerTaskContext,
  assumeTaskContext,
  contextProvenance,
} from '../core/context.mjs';
import { createDemo, produceWork } from '../scripts/demo.mjs';

const CREATED = '2026-10-02T12:00:00.000Z';
const ANSWERED = '2026-10-02T12:01:00.000Z';
const policy = {
  id: 'checkout-policy-v0',
  version: 1,
  statement: 'A lost processed response must cause exactly one charge and confirmation.',
  parameter: 'retry_failed_response',
  kind: 'checkable',
  check_ref: 'platform:lost-response-exactly-once-v0',
  allowed_values: [false, true],
  validity_scope: ['client/retry.mjs'],
};
const task = {
  schema: 'retry-response-v0',
  statement: 'Make checkout resilient to transient failed responses.',
  target_repo: 'checkout-api',
  scope: ['client/retry.mjs'],
  context_source: { repo: 'payment-policy', ref: 'refs/heads/main', path: 'checkout-policy.json' },
};

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'repositories'));
  const repositories = [];
  const works = {};
  for (const id of ['checkout-api', 'payment-policy']) {
    const work = path.join(root, `${id}-work`);
    await git(root, ['init', '--quiet', '--initial-branch=main', work]);
    works[id] = work;
    if (id === 'payment-policy')
      await writeFile(
        path.join(work, 'checkout-policy.json'),
        JSON.stringify({ ...policy, ...overrides }, null, 2) + '\n',
      );
    else {
      await mkdir(path.join(work, 'client'));
      await writeFile(
        path.join(work, 'client/retry.mjs'),
        'export const retryFailedResponse = false;\n',
      );
    }
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'Baseline']);
    const head = await git(work, ['rev-parse', 'HEAD']);
    const bare = path.join(root, 'repositories', `${id}.git`);
    await git(root, ['clone', '--quiet', '--bare', work, bare]);
    await git(work, ['remote', 'add', 'origin', bare]);
    repositories.push({ id, head, baseline: head, canonical_ref: 'refs/heads/main' });
  }
  const adapter = new LocalGit(root);
  const prepare = (input = task) =>
    prepareTaskContext({
      task: input,
      repositories,
      git: adapter,
      actor: 'test-task-owner',
      created_at: CREATED,
    });
  return { root, repositories, works, adapter, prepare };
}

async function workspaceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-context-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ...(await createDemo(root, async () => {}, { pending: true })) };
}

async function publishContext(
  { root, engine, adapter },
  resolved,
  { key = 'context-work', repo = 'checkout-api', message, artifact, files = {} } = {},
) {
  const provenance = await contextProvenance(resolved);
  const cwd = path.join(root, key);
  await git(root, ['clone', '--quiet', adapter.dir(engine.repo(repo)), cwd]);
  await git(cwd, ['checkout', '--quiet', '-b', key]);
  await mkdir(path.join(cwd, '.klocgit'), { recursive: true });
  await writeFile(
    path.join(cwd, '.klocgit/context.json'),
    JSON.stringify(artifact ?? provenance.artifact) + '\n',
  );
  for (const [filename, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, filename)), { recursive: true });
    await writeFile(path.join(cwd, filename), content);
  }
  await git(cwd, ['add', '.']);
  await git(cwd, [
    'commit',
    '--quiet',
    '-m',
    message ?? 'Reviewed context\n\n' + provenance.git_trailers.join('\n'),
  ]);
  await git(cwd, ['push', '--quiet', 'origin', key]);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  return engine.ingest({ repo, ref: `refs/heads/${key}`, after: head });
}

async function changeSource({ root, engine, adapter }, { policyChange = false } = {}) {
  const cwd = path.join(root, 'source-update-' + (policyChange ? 'policy' : 'readme'));
  await git(root, ['clone', '--quiet', adapter.dir(engine.repo('payment-policy')), cwd]);
  if (policyChange) {
    const original = JSON.parse(
      await adapter.file(
        engine.repo('payment-policy'),
        await adapter.ref(engine.repo('payment-policy'), 'refs/heads/main'),
        'checkout-policy.json',
      ),
    );
    await writeFile(
      path.join(cwd, 'checkout-policy.json'),
      JSON.stringify(
        { ...original, version: original.version + 1, allowed_values: [false] },
        null,
        2,
      ) + '\n',
    );
  } else
    await writeFile(
      path.join(cwd, 'source-readme.md'),
      'Metadata outside the retrieved constraint changed.\n',
    );
  await git(cwd, ['add', '.']);
  await git(cwd, [
    'commit',
    '--quiet',
    '-m',
    policyChange ? 'Narrow the reviewed retry constraint' : 'Document the policy repository',
  ]);
  await git(cwd, ['push', '--quiet', 'origin', 'main']);
  return git(cwd, ['rev-parse', 'HEAD']);
}

test('before code: exactly one material question after immutable retrieval from another registered Git repository', async (t) => {
  const { prepare, adapter, repositories } = await fixture(t);
  const preparation = await prepare();
  assert.equal(preparation.status, 'needs_clarification');
  assert.equal(preparation.snapshot, null);
  assert.equal(preparation.authorization, null);
  assert.equal(preparation.question.parameter, 'retry_failed_response');
  assert.equal(preparation.question.options.length, 2);
  assert.match(preparation.question.material_effect, /side effects/);
  assert.equal(preparation.source.repo, 'payment-policy');
  assert.equal(preparation.source.commit, await adapter.ref(repositories[1], 'refs/heads/main'));
  assert.equal(preparation.source.path, 'checkout-policy.json');
  assert.match(preparation.source.content_hash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => contextProvenance(preparation),
    (error) => error.code === 'PRODUCER_NOT_AUTHORIZED',
  );
  assert.throws(() => {
    preparation.question.options.push({ value: true });
  }, TypeError);
});

test('declared answer carries actor, time, scope and exact source through snapshot, authorization, artifact and Git trailers', async (t) => {
  const { prepare } = await fixture(t);
  const pending = await prepare();
  const resolved = await answerTaskContext(pending, {
    value: true,
    actor: 'test-reviewer',
    created_at: ANSWERED,
  });
  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.question.id, pending.question.id);
  assert.deepEqual(resolved.snapshot.questions, [pending.question.id]);
  const answer = resolved.snapshot.items.find((item) => item.id === resolved.snapshot.answer_ref);
  assert.equal(answer.basis, 'declared');
  assert.equal(answer.value.value, true);
  assert.equal(answer.source.actor, 'test-reviewer');
  assert.equal(answer.source.created_at, ANSWERED);
  assert.equal(answer.source.question_id, pending.question.id);
  assert.deepEqual(answer.validity_scope, ['client/retry.mjs']);
  assert.equal(resolved.snapshot.items[0].basis, 'retrieved');
  assert.equal(resolved.snapshot.sources[0].commit, pending.source.commit);
  assert.equal(resolved.authorization.context_version, resolved.snapshot.id);
  assert.equal(resolved.authorization.task_id, resolved.task.id);
  assert.equal(resolved.authorization.requires_human_review, false);
  assert.deepEqual(resolved.snapshot.assumption_refs, []);
  const provenance = await contextProvenance(resolved);
  assert.equal(provenance.metadata.context_version, resolved.snapshot.id);
  assert.equal(provenance.artifact.task_id, resolved.task.id);
  assert.equal(provenance.artifact.context_snapshot_id, resolved.snapshot.id);
  assert.equal(provenance.artifact.answer_ref, answer.id);
  assert.ok(provenance.git_trailers.includes(`Decision-Task: ${resolved.task.id}`));
  assert.ok(provenance.git_trailers.includes(`Decision-Context: ${resolved.snapshot.id}`));
  assert.ok(provenance.git_trailers.includes(`Decision-Answer: ${answer.id}`));
  assert.equal(JSON.stringify(provenance).includes(task.statement), false);
  assert.equal(JSON.stringify(provenance).includes(policy.statement), false);
  const { id, ...snapshotData } = resolved.snapshot;
  assert.equal((await record('ctx', snapshotData)).id, id);
  assert.throws(() => {
    answer.value.value = false;
  }, TypeError);
});

test('source advances create a new snapshot while an already prepared question stays tied to its original commit', async (t) => {
  const { prepare, works } = await fixture(t);
  const pending = await prepare();
  const work = works['payment-policy'];
  await writeFile(
    path.join(work, 'checkout-policy.json'),
    JSON.stringify({
      ...policy,
      version: 2,
      statement: policy.statement + ' Preserve acknowledgement identity.',
    }),
  );
  await git(work, ['add', '.']);
  await git(work, ['commit', '--quiet', '-m', 'Version the constraint']);
  await git(work, ['push', '--quiet', 'origin', 'main']);
  const next = await prepare();
  assert.notEqual(next.source.commit, pending.source.commit);
  assert.notEqual(next.source.content_hash, pending.source.content_hash);
  const beforeAnswer = await answerTaskContext(pending, {
    value: false,
    actor: 'test-reviewer',
    created_at: ANSWERED,
  });
  const afterAnswer = await answerTaskContext(next, {
    value: false,
    actor: 'test-reviewer',
    created_at: ANSWERED,
  });
  assert.notEqual(beforeAnswer.snapshot.id, afterAnswer.snapshot.id);
  assert.equal(beforeAnswer.snapshot.sources[0].commit, pending.source.commit);
  assert.equal(afterAnswer.snapshot.sources[0].commit, next.source.commit);
});

test('unanswered questions stay pending until an explicit unresolved assumption authorizes reviewed work', async (t) => {
  const { prepare } = await fixture(t);
  const pending = await prepare();
  assert.equal(pending.authorization, null);
  const resolved = await assumeTaskContext(pending, {
    value: false,
    rationale: 'Proceed conservatively while the retry policy is unanswered.',
    actor: 'test-producer-owner',
    created_at: ANSWERED,
  });
  assert.equal(resolved.status, 'ready_with_assumption');
  assert.equal(resolved.question.id, pending.question.id);
  assert.equal(resolved.snapshot.answer_ref, null);
  assert.equal(resolved.snapshot.assumption_refs.length, 1);
  const assumption = resolved.snapshot.items.find((item) => item.type === 'assumption');
  assert.equal(assumption.truth_state, 'unresolved');
  assert.equal(assumption.basis, 'declared');
  assert.equal(assumption.source.actor, 'test-producer-owner');
  assert.equal(resolved.authorization.requires_human_review, true);
  assert.equal(resolved.authorization.unresolved_assumption_refs[0], assumption.id);
  assert.deepEqual(resolved.authorization.parameter_values, { retry_failed_response: false });
  const provenance = await contextProvenance(resolved);
  assert.ok(provenance.git_trailers.includes(`Decision-Assumption: ${assumption.id}`));
  assert.equal(provenance.artifact.requires_human_review, true);
  await assert.rejects(
    () => assumeTaskContext(pending, { value: false, rationale: '', actor: 'test-producer-owner' }),
    (error) => error.code === 'ASSUMPTION_RATIONALE_REQUIRED',
  );
});

test('a reliable retrieved existing decision supplies the answer without asking any question', async (t) => {
  const { prepare } = await fixture(t, {
    decision_id: 'decision-retry-policy-v3',
    decision_answer: false,
  });
  const resolved = await prepare();
  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.question, null);
  assert.deepEqual(resolved.snapshot.questions, []);
  const answer = resolved.snapshot.items.find((item) => item.type === 'parameter');
  assert.equal(answer.basis, 'retrieved');
  assert.equal(answer.value.value, false);
  assert.equal(answer.source.decision_id, 'decision-retry-policy-v3');
  assert.equal(answer.source.commit, resolved.source.commit);
});

test('a single allowed value and an explicit task answer also need no clarification', async (t) => {
  const { prepare } = await fixture(t);
  const declared = await prepare({ ...task, parameters: { retry_failed_response: true } });
  assert.equal(declared.question, null);
  assert.equal(declared.snapshot.items[1].basis, 'declared');
  const other = await fixture(t, { allowed_values: [false] });
  const constrained = await other.prepare();
  assert.equal(constrained.question, null);
  assert.equal(constrained.snapshot.items[1].basis, 'retrieved');
  assert.equal(constrained.snapshot.parameter_values.retry_failed_response, false);
});

test('unsupported tasks do not invent questions; unregistered, same-repo and out-of-scope context are rejected', async (t) => {
  const { prepare } = await fixture(t);
  await assert.rejects(
    () => prepare({ ...task, schema: 'arbitrary-task' }),
    (error) => error.code === 'CONTEXT_SCHEMA_UNSUPPORTED',
  );
  await assert.rejects(
    () => prepare({ ...task, context_source: { ...task.context_source, repo: 'missing' } }),
    (error) => error.code === 'REPO_NOT_FOUND',
  );
  await assert.rejects(
    () => prepare({ ...task, context_source: { ...task.context_source, repo: 'checkout-api' } }),
    (error) => error.code === 'CROSS_REPO_CONTEXT_REQUIRED',
  );
  await assert.rejects(
    () => prepare({ ...task, scope: ['server/payment.mjs'] }),
    (error) => error.code === 'CONTEXT_SCOPE_MISMATCH',
  );
  await assert.rejects(
    () => prepare({ ...task, context_source: { ...task.context_source, path: '../secret' } }),
    (error) => error.code === 'INVALID_CONTEXT_PATH',
  );
});

test('repository booleans without a decision ID are not silently treated as authoritative answers', async (t) => {
  const { prepare } = await fixture(t, { decision_answer: true });
  await assert.rejects(
    () => prepare(),
    (error) => error.code === 'INVALID_CONTEXT_SOURCE',
  );
});

test('conflicting declared answers require review; invalid and unauthenticated answer input cannot authorize producers', async (t) => {
  const reliable = await fixture(t, {
    decision_id: 'known-retry-decision',
    decision_answer: false,
  });
  await assert.rejects(
    () => reliable.prepare({ ...task, parameters: { retry_failed_response: true } }),
    (error) => error.code === 'CONTEXT_DECISION_CONFLICT',
  );
  const { prepare } = await fixture(t);
  const pending = await prepare();
  await assert.rejects(
    () => answerTaskContext(pending, { value: 'yes', actor: 'test-reviewer' }),
    (error) => error.code === 'INVALID_CONTEXT_ANSWER',
  );
  await assert.rejects(
    () => answerTaskContext(pending, { value: true }),
    (error) => error.code === 'UNAUTHENTICATED',
  );
  const answered = await answerTaskContext(pending, {
    value: false,
    actor: 'test-reviewer',
    created_at: ANSWERED,
  });
  await assert.rejects(
    () => answerTaskContext(answered, { value: true, actor: 'test-reviewer' }),
    (error) => error.code === 'CONTEXT_ALREADY_RESOLVED',
  );
});

test('advisory constraints neither force an answer nor automatically reject another allowed schema choice', async (t) => {
  const { prepare } = await fixture(t, { kind: 'advisory', allowed_values: [false] });
  const pending = await prepare();
  assert.equal(pending.status, 'needs_clarification');
  assert.equal(pending.question.options.length, 2);
  const answered = await answerTaskContext(pending, {
    value: true,
    actor: 'test-reviewer',
    created_at: ANSWERED,
  });
  assert.equal(answered.snapshot.parameter_values.retry_failed_response, true);
  const declared = await prepare({ ...task, parameters: { retry_failed_response: true } });
  assert.equal(declared.status, 'ready');
});

test('real workspace starts with one unanswered cross-repo question and starts zero coordinated producers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-context-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { engine, state, adapter, specs } = await createDemo(root, async () => {}, {
    pending: true,
  });
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].source.repo, 'payment-policy');
  assert.equal(state.tasks[0].source.path, 'checkout-policy.json');
  assert.equal(state.tasks[0].status, 'needs_clarification');
  assert.equal(state.tasks[0].authorization, null);
  assert.deepEqual(specs, []);
  assert.equal(state.proposals.length, 0);
  assert.equal(state.workspace.producers.length, 0);
  await assert.rejects(
    () => produceWork(engine, root),
    (error) => error.code === 'CONTEXT_REQUIRED',
  );
  assert.equal(
    await git(adapter.dir(engine.repo('checkout-api')), [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
    ]),
    'refs/heads/main',
  );
});

test('ordinary untagged Git work remains ingestible while the coordinated task waits for an answer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-context-arbitrary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { engine, state, adapter } = await createDemo(root, async () => {}, { pending: true });
  const cwd = path.join(root, 'ordinary-client');
  await git(root, ['clone', '--quiet', adapter.dir(engine.repo('checkout-api')), cwd]);
  await git(cwd, ['checkout', '--quiet', '-b', 'ordinary-docs']);
  await writeFile(
    path.join(cwd, 'ordinary-docs.md'),
    'Standard Git clients can still collaborate.\n',
  );
  await git(cwd, ['add', '.']);
  await git(cwd, ['commit', '--quiet', '-m', 'Ordinary documentation change']);
  await git(cwd, ['push', '--quiet', 'origin', 'ordinary-docs']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const result = await engine.ingest({
    repo: 'checkout-api',
    ref: 'refs/heads/ordinary-docs',
    after: head,
  });
  const revision = engine.revision(result.revision_id);
  assert.equal(revision.provenance_state, 'unknown');
  assert.equal(revision.context_binding_state, 'unknown');
  assert.equal(state.tasks[0].authorization, null);
  assert.equal(state.proposals.length, 1);
});

test('producer Git artifact and trailers bind the stored immutable answer to the ingested revision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-context-ingestion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { engine, state, adapter } = await createDemo(root, async () => {}, { pending: true });
  const resolved = await engine.resolveTask(
    state.tasks[0].task.id,
    { value: true },
    'test-reviewer',
  );
  const provenance = await contextProvenance(resolved);
  const cwd = path.join(root, 'tagged-client');
  await git(root, ['clone', '--quiet', adapter.dir(engine.repo('checkout-api')), cwd]);
  await git(cwd, ['checkout', '--quiet', '-b', 'tagged-task']);
  await mkdir(path.join(cwd, '.klocgit'));
  await writeFile(
    path.join(cwd, '.klocgit/context.json'),
    JSON.stringify(provenance.artifact) + '\n',
  );
  await git(cwd, ['add', '.']);
  await git(cwd, [
    'commit',
    '--quiet',
    '-m',
    'Declare the exact reviewed task context\n\n' + provenance.git_trailers.join('\n'),
  ]);
  await git(cwd, ['push', '--quiet', 'origin', 'tagged-task']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const result = await engine.ingest({
    repo: 'checkout-api',
    ref: 'refs/heads/tagged-task',
    after: head,
  });
  const revision = engine.revision(result.revision_id);
  assert.equal(revision.context_binding_state, 'bound');
  assert.equal(revision.context_version, resolved.snapshot.id);
  assert.equal(revision.context_task_id, resolved.task.id);
  assert.equal(revision.context_answer_ref, resolved.snapshot.answer_ref);
  assert.equal(
    state.contexts
      .find((snapshot) => snapshot.id === revision.context_version)
      .items.find((item) => item.id === revision.context_answer_ref).source.actor,
    'test-reviewer',
  );
});

test('producer metadata binds declarations to immutable answer references without modifying the snapshot', async (t) => {
  const workspace = await workspaceFixture(t);
  const resolved = await workspace.engine.resolveTask(
    workspace.state.tasks[0].task.id,
    { value: true },
    'context-reviewer',
  );
  const snapshotBefore = JSON.stringify(resolved.snapshot);
  const result = await publishContext(workspace, resolved, {
    key: 'declared-producer',
    files: {
      '.klocgit/proposal.json': JSON.stringify({
        title: 'Producer declaration',
        decision_key: 'retry timing',
        choice: 'fixed',
      }),
    },
  });
  const revision = workspace.engine.revision(result.revision_id);
  assert.equal(revision.context_binding_state, 'bound');
  assert.equal(revision.context_version, resolved.snapshot.id);
  assert.equal(revision.context_answer_ref, resolved.snapshot.answer_ref);
  assert.equal(revision.provenance_state, 'declared');
  assert.equal(revision.decision_key, 'retry timing');
  assert.equal(revision.declared_choice, 'fixed');
  assert.equal(
    workspace.state.proposals.find((proposal) => proposal.id === revision.proposal_id).title,
    'Producer declaration',
  );
  assert.equal(JSON.stringify(resolved.snapshot), snapshotBefore);
});

test('malformed, empty and oversized producer metadata cannot declare a valid context or choice', async (t) => {
  const workspace = await workspaceFixture(t);
  const resolved = await workspace.engine.resolveTask(
    workspace.state.tasks[0].task.id,
    { value: true },
    'current-context-reviewer',
  );
  const current = await publishContext(workspace, resolved, {
    key: 'current-producer',
    files: {
      '.klocgit/proposal.json': JSON.stringify({
        title: 'Current declaration',
        decision_key: 'current choice',
        choice: 'current',
      }),
    },
  });
  const currentRevision = workspace.engine.revision(current.revision_id);
  assert.equal(currentRevision.context_binding_state, 'bound');
  assert.equal(currentRevision.context_version, resolved.snapshot.id);
  assert.equal(currentRevision.decision_key, 'current choice');
  assert.equal(currentRevision.declared_choice, 'current');
  for (const [key, raw] of [
    ['malformed', '{'],
    ['empty', ''],
    ['oversized', 'x'.repeat(32769)],
  ]) {
    const result = await publishContext(workspace, resolved, {
      key: `${key}-producer`,
      files: {
        '.klocgit/context.json': raw,
        '.klocgit/proposal.json': raw,
      },
    });
    const revision = workspace.engine.revision(result.revision_id);
    assert.notEqual(revision.context_binding_state, 'bound');
    assert.equal(revision.provenance_state, 'unknown');
    assert.equal(revision.decision_key, null);
    assert.equal(revision.declared_choice, null);
  }
});

test('substring suffixes and body-only references cannot impersonate exact Git authorization trailers', async (t) => {
  const workspace = await workspaceFixture(t);
  const resolved = await workspace.engine.resolveTask(
    workspace.state.tasks[0].task.id,
    { value: true },
    'test-reviewer',
  );
  const provenance = await contextProvenance(resolved);
  const suffixMessage =
    'Malformed references\n\n' +
    provenance.git_trailers.map((trailer) => trailer + '-suffix').join('\n');
  const suffix = await publishContext(workspace, resolved, {
    key: 'suffix-trailers',
    message: suffixMessage,
  });
  assert.equal(workspace.engine.revision(suffix.revision_id).context_binding_state, 'invalid');
  const bodyMessage =
    'Discussion of prior references\n\n' +
    provenance.git_trailers.join('\n') +
    '\n\nThis final prose paragraph does not authorize the commit.';
  const body = await publishContext(workspace, resolved, {
    key: 'body-trailers',
    message: bodyMessage,
  });
  assert.equal(workspace.engine.revision(body.revision_id).context_binding_state, 'invalid');
});

test('an authentic task authorization cannot be rebound to a different canonical repository', async (t) => {
  const workspace = await workspaceFixture(t);
  const resolved = await workspace.engine.resolveTask(
    workspace.state.tasks[0].task.id,
    { value: true },
    'test-reviewer',
  );
  const response = await publishContext(workspace, resolved, {
    key: 'wrong-target',
    repo: 'payment-policy',
  });
  const revision = workspace.engine.revision(response.revision_id);
  assert.equal(revision.context_binding_state, 'invalid');
  assert.match(revision.context_binding_reason, /another canonical repository/);
  assert.equal(
    workspace.state.proposals.length,
    1,
    'The ordinary Git push remains ingested for review.',
  );
});

test('engine records trusted answer actor and time, and identical answer retries retain the original receipt', async (t) => {
  const workspace = await workspaceFixture(t);
  const id = workspace.state.tasks[0].task.id;
  const resolved = await workspace.engine.resolveTask(
    id,
    { value: true, actor: 'forged-actor', created_at: '1700-01-01T00:00:00.000Z' },
    'test-reviewer',
  );
  const answer = resolved.snapshot.items.find((item) => item.id === resolved.snapshot.answer_ref);
  assert.equal(answer.source.actor, 'test-reviewer');
  assert.notEqual(answer.source.created_at, '1700-01-01T00:00:00.000Z');
  assert.ok(Math.abs(Date.now() - Date.parse(answer.source.created_at)) < 30_000);
  const counts = {
    contexts: workspace.state.contexts.length,
    preparations: workspace.state.contextPreparations.length,
    audit: workspace.state.audit.length,
  };
  const repeated = await workspace.engine.resolveTask(
    id,
    { value: true, created_at: '2999-01-01T00:00:00.000Z' },
    'test-reviewer',
  );
  assert.equal(repeated.id, resolved.id);
  assert.equal(repeated.authorization.id, resolved.authorization.id);
  assert.equal(repeated.snapshot.answer_ref, resolved.snapshot.answer_ref);
  assert.deepEqual(
    {
      contexts: workspace.state.contexts.length,
      preparations: workspace.state.contextPreparations.length,
      audit: workspace.state.audit.length,
    },
    counts,
  );
  await assert.rejects(
    () => workspace.engine.resolveTask(id, { value: false }, 'test-reviewer'),
    (error) => error.code === 'CONTEXT_ALREADY_RESOLVED',
  );
  await assert.rejects(
    () => workspace.engine.resolveTask(id, { value: true }, 'another-reviewer'),
    (error) => error.code === 'CONTEXT_ALREADY_RESOLVED',
  );
});

test('changed source constraint invalidates an unanswered question, and refreshed preparation retires its prior version', async (t) => {
  const workspace = await workspaceFixture(t);
  const pending = workspace.state.tasks[0];
  const newHead = await changeSource(workspace, { policyChange: true });
  await assert.rejects(
    () => workspace.engine.resolveTask(pending.task.id, { value: true }, 'test-reviewer'),
    (error) => error.code === 'CONTEXT_STALE' && error.status === 409,
  );
  assert.equal(pending.authorization, null);
  const refreshed = await workspace.engine.prepareTask(task, 'test-reviewer');
  assert.equal(refreshed.source.commit, newHead);
  assert.notEqual(refreshed.source.content_hash, pending.source.content_hash);
  assert.equal(refreshed.question, null, 'The new checkable policy permits exactly one answer.');
  assert.equal(refreshed.snapshot.parameter_values.retry_failed_response, false);
  assert.equal(
    workspace.state.constraints.find((constraint) => constraint.id === pending.constraint.id)
      .active,
    false,
  );
  assert.equal(workspace.state.constraints.filter((constraint) => constraint.active).length, 1);
});

test('historical bound code survives a source-policy change but cannot obtain current composition validation', async (t) => {
  const workspace = await workspaceFixture(t);
  const resolved = await workspace.engine.resolveTask(
    workspace.state.tasks[0].task.id,
    { value: true },
    'test-reviewer',
  );
  const response = await publishContext(workspace, resolved);
  const revision = workspace.engine.revision(response.revision_id);
  assert.equal(revision.context_binding_state, 'bound');
  await changeSource(workspace, { policyChange: true });
  assert.equal((await workspace.engine.contextValidity(resolved.snapshot)).status, 'stale');
  workspace.engine.git.validate = async () => ({
    passed: true,
    checks: [],
    observations: { lostResponse: { attempts: 2 } },
  });
  const composition = await workspace.engine.compose('checkout-api', [revision.id]);
  assert.equal(composition.validation, 'failed');
  const evidence = workspace.state.evidence.find((item) => item.id === composition.evidence_ids[0]);
  assert.equal(
    evidence.result.checks.find(
      (check) => check.name === 'Bound retry answer matches observed behavior',
    ).passed,
    false,
  );
  assert.equal(
    revision.context_version,
    resolved.snapshot.id,
    'Historical provenance is preserved.',
  );
});

test('source repository moves without changed policy content retain the original reviewed source citation', async (t) => {
  const workspace = await workspaceFixture(t);
  const pending = workspace.state.tasks[0];
  const newHead = await changeSource(workspace);
  assert.notEqual(newHead, pending.source.commit);
  assert.equal(
    (await workspace.engine.contextValidity({ sources: [pending.source] })).status,
    'current',
  );
  const resolved = await workspace.engine.resolveTask(
    pending.task.id,
    { value: true },
    'test-reviewer',
  );
  assert.equal(resolved.snapshot.sources[0].commit, pending.source.commit);
  assert.equal(resolved.question.id, pending.question.id);
});

test('declining retries changes eight proposals into one derived decision and preserves the false answer through canonical code', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'klocgit-context-no-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { engine, state, adapter } = await createDemo(root, async () => {}, {
    retry: false,
    actor: 'decline-retry-owner',
  });
  const answered = state.tasks[0];
  const answer = answered.snapshot.items.find((item) => item.id === answered.snapshot.answer_ref);
  assert.equal(answer.value.value, false);
  assert.equal(answer.basis, 'declared');
  assert.equal(answer.source.actor, 'decline-retry-owner');
  assert.equal(state.proposals.length, 8);
  assert.equal(state.workspace.producers.length, 5);
  assert.equal(state.decisionComponents.length, 1);
  const component = state.decisionComponents[0];
  assert.equal(component.derived, true);
  assert.ok(component.edges.length > 0);
  assert.ok(component.edges.every((edge) => edge.type === 'alternative'));
  assert.equal(
    engine
      .applicableRelationships()
      .filter(
        (relationship) =>
          relationship.type === 'conflicts_with' && relationship.basis === 'observed',
      ).length,
    0,
  );
  assert.equal(
    state.evidence.filter(
      (evidence) =>
        evidence.type === 'composed-interaction' &&
        evidence.result.passed === false &&
        engine.evidenceValidity(evidence).status === 'current',
    ).length,
    0,
  );
  assert.equal((await engine.view()).summary.decisionsRequired, 1);

  const bound = state.revisions.find((revision) => revision.context_binding_state === 'bound');
  assert.ok(bound);
  assert.equal(bound.context_version, answered.snapshot.id);
  assert.equal(bound.context_answer_ref, answer.id);
  const option = component.alternatives.find(
    (alternative) =>
      alternative.validation === 'passed' && alternative.composed_revision_ids.includes(bound.id),
  );
  assert.ok(
    option,
    'The reviewed alternative includes the separately bound no-retry implementation.',
  );
  const evidence = state.evidence.find((item) => item.id === option.evidence_ids[0]);
  assert.equal(engine.evidenceValidity(evidence).status, 'current');
  assert.equal(evidence.result.observations.lostResponse.attempts, 1);
  assert.equal(evidence.result.observations.lostResponse.charges, 1);
  assert.equal(evidence.result.observations.lostResponse.confirmations, 1);
  assert.equal(
    evidence.result.checks.find(
      (check) => check.name === 'Bound retry answer matches observed behavior',
    ).passed,
    true,
  );

  await engine.serial(() =>
    engine.resolve(
      component.id,
      {
        alternative_id: option.id,
        basis_hash: component.basis_hash,
        expected_canonical_head: component.canonical_head_seen,
        rationale:
          'Respect the explicit no-retry answer and review the remaining timing alternative with the independent work.',
      },
      'no-retry-decision-owner',
    ),
  );
  const decision = state.decisions.at(-1);
  assert.ok(decision.proposal_revision_ids.includes(bound.id));
  assert.ok(decision.context_refs.includes(answered.snapshot.id));
  assert.ok(decision.context_answer_refs.includes(answer.id));
  const repo = engine.repo('checkout-api');
  const artifact = JSON.parse(await adapter.file(repo, repo.head, '.klocgit/context.json'));
  assert.equal(artifact.context_snapshot_id ?? artifact.context_version, answered.snapshot.id);
  assert.equal(artifact.answer_ref, answer.id);
  const code = await adapter.file(repo, repo.head, 'client/retry.mjs');
  assert.match(code, /export const MAX_ATTEMPTS = 1;/);
  assert.match(code, /uncertainOutcome:true/);
  assert.equal(
    answered.snapshot.items.find((item) => item.id === artifact.answer_ref).value.value,
    false,
  );
  assert.equal((await engine.view()).summary.decisionsRequired, 0);
});
