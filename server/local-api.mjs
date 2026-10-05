import { DomainError, record } from '../core/hash.mjs';
import { createDemo, produceWork } from '../scripts/demo.mjs';
import { handleWorkflowRequest } from './workflow-api.mjs';
import { handleNativeRequest, ownsNativePath } from './native-api.mjs';

async function resetDemo(engine, actor, { root, save }) {
  const next = await createDemo(root, save, { pending: true });
  engine.state = next.state;
  engine.state.workspace.owner_id = actor;
  engine.git = next.adapter;
  await save(engine.state);
  return engine.view();
}

async function startDemo(engine, root) {
  const task = engine.state.tasks[0];
  if (!task?.authorization) {
    throw new DomainError(
      'CONTEXT_REQUIRED',
      'Answer or explicitly assume the retrieved-policy question before starting the coordinated producers.',
      409,
    );
  }
  const validity = await engine.contextValidity({ sources: [task.source] });
  if (validity.status !== 'current') {
    throw new DomainError(
      'CONTEXT_STALE',
      'The policy changed after task review. Prepare and review the current context before starting producers.',
      409,
      { reason: validity.reason },
    );
  }
  await produceWork(engine, root);
  return engine.view();
}

async function changeDemoConstraint(engine, actor, save) {
  const old = engine.state.constraints.find((constraint) => constraint.active);
  if (!old) throw new DomainError('CONSTRAINT_NOT_FOUND', 'No active constraint is available', 404);
  old.active = false;
  const data = { ...old };
  delete data.id;
  delete data.active;
  const constraint = await record('constraint', { ...data, version: old.version + 1 });
  engine.state.constraints.push({ ...constraint, active: true });
  await engine.audit('constraint.updated', actor, { constraint_id: constraint.id });
  await save(engine.state);
  return engine.view();
}

async function handleDemoRequest(engine, { method, path, actor }, options) {
  if (method !== 'POST') return null;
  switch (path) {
    case '/api/demo/reset':
      return resetDemo(engine, actor, options);
    case '/api/demo/start':
      return startDemo(engine, options.root);
    case '/api/demo/stale':
      await engine.git.externalAdvance(engine.repo('checkout-api'));
      await engine.syncHeads();
      return engine.view();
    case '/api/demo/constraint':
      return changeDemoConstraint(engine, actor, options.save);
    default:
      return null;
  }
}

/** Called only inside the local server's serialized request boundary. */
export async function handleLocalRequest(engine, { method, url, input, actor }, options) {
  if (ownsNativePath(url.pathname))
    return handleNativeRequest(engine, { method, url, input, actor });

  const workflow = await handleWorkflowRequest(engine, { method, url, input, actor });
  if (workflow !== null) return workflow;
  const path = url.pathname;

  if (path === '/api/workspace' && method === 'GET') return engine.view();
  if (path === '/api/tasks' && method === 'GET') return { tasks: engine.state.tasks };
  if (path === '/api/tasks' && method === 'POST')
    return engine.prepareTask(input.task ?? input, actor);
  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(?:\/(answer|assume))?$/);
  if (taskMatch && method === 'GET' && !taskMatch[2]) {
    const task = engine.state.tasks.find((task) => task.task.id === taskMatch[1]);
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    return task;
  }
  if (taskMatch && method === 'POST' && taskMatch[2]) {
    return engine.resolveTask(
      taskMatch[1],
      {
        value: input.value,
        rationale: input.rationale,
      },
      actor,
      taskMatch[2] === 'assume',
    );
  }

  const demo = await handleDemoRequest(engine, { method, path, actor }, options);
  if (demo !== null) return demo;
  if (path === '/api/analysis' && method === 'POST')
    return engine.analyzeWork({ actor, refresh: input.refresh === true });
  if (path === '/api/recover' && method === 'POST') {
    await engine.recover();
    return engine.view();
  }
  const decision = path.match(/^\/api\/decisions\/([^/]+)\/(resolve|refresh)$/);
  if (decision && method === 'POST') {
    if (decision[2] === 'refresh') return engine.refreshDecision(decision[1]);
    return engine.resolve(decision[1], input, actor);
  }
  if (path === '/api/diff' && method === 'GET') {
    const revision = engine.revision(url.searchParams.get('revision'));
    return {
      diff: await engine.git.diff(
        engine.repo(revision.repo),
        revision.base_commit,
        revision.head_commit,
      ),
    };
  }
  if (path === '/api/events' && method === 'POST') {
    const native = await engine.native.observeRepositoryPush(input.event, actor);
    return native.handled ? native : engine.ingest(input.event, input.metadata);
  }
  throw new DomainError('NOT_FOUND', 'Endpoint not found', 404);
}
