import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { copyApplicationFixture, copyPolicyFixture } from '../fixtures/application.mjs';
import { Engine, emptyState } from '../core/engine.mjs';
import { LocalGit, git } from '../server/git.mjs';
import { prepareTaskContext } from '../core/context.mjs';
export async function bootstrapWorkspace(root, save = async () => {}) {
  await mkdir(path.join(root, 'repositories'), { recursive: true });
  const state = emptyState();
  state.version = 2;
  state.tasks = [];
  state.contextPreparations = [];
  state.discovery = {
    components: [],
    ungrouped_revision_ids: [],
    explanation: 'No work has been analyzed.',
  };
  const adapter = await new LocalGit(root).init();
  const engine = new Engine(state, adapter, save);
  for (const id of ['checkout-api', 'payment-policy']) {
    const cwd = path.join(root, 'baseline', id);
    await mkdir(path.dirname(cwd), { recursive: true });
    await (id === 'checkout-api' ? copyApplicationFixture : copyPolicyFixture)(cwd);
    await git(cwd, ['init', '--quiet', '-b', 'main']);
    await git(cwd, ['add', '.']);
    await git(cwd, [
      'commit',
      '--quiet',
      '-m',
      'Baseline running checkout and versioned payment policy',
    ]);
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    await git(root, ['clone', '--quiet', '--bare', cwd, adapter.dir({ id })]);
    state.repositories.push({
      id,
      name: id,
      canonical_ref: 'refs/heads/main',
      head,
      baseline: head,
      provider: 'local-git',
      remote: adapter.dir({ id }),
      validation_profile: id === 'checkout-api' ? 'checkout-effects-v2' : 'context-document-v1',
      ...(id === 'checkout-api' ? { context_repo: 'payment-policy' } : {}),
      description:
        id === 'checkout-api'
          ? 'Running payment HTTP service and retrying client'
          : 'Versioned exactly-once constraint and decisions',
    });
  }
  const task = await prepareTaskContext({
    task: {
      schema: 'retry-response-v1',
      statement: 'Recover checkout when a processed payment response is lost.',
      target_repo: 'checkout-api',
      scope: ['client/retry.mjs'],
      context_source: {
        repo: 'payment-policy',
        ref: 'refs/heads/main',
        path: 'checkout-policy.json',
      },
    },
    repositories: state.repositories,
    git: adapter,
    actor: 'task-owner',
  });
  state.tasks.push(task);
  state.contextPreparations.push(task);
  state.constraints.push({
    id: task.constraint.id,
    ...task.constraint.value,
    source_ref: task.source.id,
    active: true,
  });
  state.constraints.at(-1).id = task.constraint.id;
  await engine.audit('context.question-created', 'task-owner', {
    task_id: task.task.id,
    question_id: task.question.id,
    source: task.source,
  });
  await save(state);
  return { engine, state, adapter, task };
}
