import { DomainError, record } from '../core/hash.mjs';
import { redactSensitive } from '../core/access.mjs';
import {
  requestPrincipal,
  pushRepositories,
  ignoredInternalPush,
  filteredWorkflow,
  legacyReadInputs,
  servicePath,
} from '../worker/routes.mjs';
import { createDemo, produceWork } from '../scripts/demo.mjs';
import { handleWorkflowRequest } from './workflow-api.mjs';
import { handleNativeRequest, ownsNativePath } from './native-api.mjs';

async function resetDemo(engine, actor, { root, save }) {
  const prior = engine.state;
  const next = await createDemo(root, save, { pending: true });
  engine.state = next.state;
  engine.state.workspace.owner_id = prior.workspace.owner_id;
  engine.state.access = prior.access;
  engine.state.accessVersions = prior.accessVersions;
  engine.state.audit = prior.audit;
  await engine.audit('workspace.demo-reset', actor, { mode: 'disposable-demo' });
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

/** Called only inside the local server's authenticated serialized request boundary. */
export async function handleLocalRequest(
  engine,
  { method, url, input = {}, actor: suppliedActor, principal, headers = {}, bytes },
  options,
) {
  principal = requestPrincipal(engine, principal, suppliedActor);
  const actor = principal.actor_id;
  if (bytes !== undefined) engine.access.assertQuota('request_bytes', 0, bytes);
  const path = url.pathname;
  if (path === '/api/session' && method === 'GET') return engine.access.session(principal);
  if (path === '/api/access') {
    if (method === 'GET') return engine.access.policy(principal);
    if (method === 'POST') return engine.access.update(input, principal);
    throw new DomainError('METHOD_NOT_ALLOWED', 'Access policy supports GET and POST', 405);
  }
  if (method === 'POST' && /^\/api\/evaluation-runs\/[^/]+\/report$/.test(path)) {
    if (principal.kind !== 'service' || principal.auth_method !== 'evaluator-hmac')
      throw new DomainError('UNAUTHENTICATED', 'A verified evaluator report is required', 401);
    const result = await handleNativeRequest(engine, {
      method,
      url,
      input,
      actor,
      principal,
      requestHeaders: headers,
    });
    if (result === null)
      throw new DomainError('NOT_FOUND', 'Evaluator report route is unavailable', 404);
    return redactSensitive(result);
  }
  if (path === '/api/events' && method === 'POST') {
    const repos = pushRepositories(engine, input.event);
    if (!repos.length || repos.some((id) => !engine.access.repositoryIds().includes(id)))
      return { ignored: true, reason: 'UNREGISTERED_REPOSITORY' };
    engine.access.require(principal, 'ingress.write', repos);
    const ignored = ignoredInternalPush(engine, input.event);
    if (ignored) return ignored;
    const native = await engine.native.observeRepositoryPush(input.event, actor);
    if (!native.handled) return redactSensitive(await engine.ingest(input.event, input.metadata));
    if (native.ignored || native.reason === 'OUT_OF_ORDER_EVENT') return redactSensitive(native);
    let analysis;
    try {
      analysis = await engine.analyzeNativeWork({
        actor: 'coordinator',
        trigger: input.event,
      });
    } catch {
      // Git observation has already persisted. Analysis can be retried without
      // asking a producer to recreate or undo their ordinary Git push.
      analysis = { state: 'unavailable', reason: 'ANALYSIS_UNAVAILABLE' };
    }
    return redactSensitive({ ...native, analysis });
  }
  engine.access.require(principal, 'workspace.read');
  if (path === '/api/workspace' && method === 'GET') return engine.view(principal);
  if (ownsNativePath(path) || servicePath(path)) {
    const result = await handleNativeRequest(engine, {
      method,
      url,
      input,
      actor,
      principal,
      requestHeaders: headers,
    });
    if (result === null) throw new DomainError('NOT_FOUND', 'Endpoint not found', 404);
    return redactSensitive(result);
  }
  if (engine.access.authorizeWorkflow({ method, url, input, principal })) {
    if (method === 'POST' && /\/(prepare|validate)$/.test(path))
      legacyReadInputs(engine, principal);
    const workflow = await handleWorkflowRequest(engine, { method, url, input, actor, principal });
    if (workflow !== null) return filteredWorkflow(engine, workflow, principal, method);
  }
  if (path === '/api/tasks' && method === 'GET')
    return {
      tasks: engine.state.tasks.filter(
        (task) =>
          engine.access.isWorkspaceAdmin(principal) || engine.access.readable(principal, task),
      ),
    };
  if (path === '/api/tasks' && method === 'POST') {
    legacyReadInputs(engine, principal);
    engine.access.require(
      principal,
      'task.prepare',
      engine.access.resourceRepositories(input.task ?? input),
    );
    return engine.prepareTask(input.task ?? input, actor);
  }
  const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(?:\/(answer|assume))?$/);
  if (taskMatch) {
    const task = engine.state.tasks.find((task) => task.task.id === taskMatch[1]);
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    const repos = engine.access.resourceRepositories(task);
    if (method === 'GET' && !taskMatch[2]) {
      engine.access.require(principal, 'repository.read', repos);
      return redactSensitive(task);
    }
    if (method === 'POST' && taskMatch[2]) {
      engine.access.require(principal, 'task.resolve', repos);
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
  }
  if (path.startsWith('/api/demo/')) {
    if (principal.actor_id !== engine.state.workspace.owner_id)
      throw new DomainError(
        'FORBIDDEN',
        'Only the bootstrap owner can reset or mutate the disposable demo',
        403,
      );
    engine.access.require(principal, 'access.manage');
    const demo = await handleDemoRequest(engine, { method, path, actor }, options);
    if (demo !== null) return redactSensitive(demo);
  }
  if (path === '/api/analysis' && method === 'POST') {
    engine.access.require(principal, 'analysis.run');
    const result = await engine.analyzeWork({ actor, refresh: input.refresh === true });
    const nativeAnalysis = await engine.analyzeNativeWork({
      actor,
      trigger: input.trigger ?? {},
      request_id: input.request_id,
    });
    return { ...result, native_analysis: nativeAnalysis };
  }
  if (path === '/api/recover' && method === 'POST') {
    engine.access.require(principal, 'recovery.run');
    await engine.recover();
    return engine.view(principal);
  }
  const decision = path.match(/^\/api\/decisions\/([^/]+)\/(resolve|refresh)$/);
  if (decision && method === 'POST') {
    legacyReadInputs(engine, principal);
    engine.access.require(
      principal,
      decision[2] === 'resolve' ? 'decision.resolve' : 'decision.prepare',
      engine.access.resourceRepositories(engine.component(decision[1])),
    );
    if (decision[2] === 'refresh') return engine.refreshDecision(decision[1]);
    return engine.resolve(decision[1], input, actor);
  }
  if (path === '/api/diff' && method === 'GET') {
    const revision = engine.revision(url.searchParams.get('revision'));
    engine.access.require(principal, 'repository.read', [revision.repo]);
    return {
      diff: await engine.git.diff(
        engine.repo(revision.repo),
        revision.base_commit,
        revision.head_commit,
      ),
    };
  }
  throw new DomainError('NOT_FOUND', 'Endpoint not found', 404);
}
