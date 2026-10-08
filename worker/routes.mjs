import { DomainError } from '../core/hash.mjs';
import { redactSensitive } from '../core/access.mjs';
import { handleWorkflowRequest } from '../server/workflow-api.mjs';
import { handleNativeRequest, ownsNativePath } from '../server/native-api.mjs';
import { jsonResponse } from './http.mjs';
import { scheduleAnalysis } from './events.mjs';
import { registerRepository, forkRepository } from './repositories.mjs';
import { internalPrincipal } from './identity.mjs';

export function requestPrincipal(engine, principal, actor) {
  if (principal) return principal;
  // Compatibility for trusted direct test/helper calls. The public gateway and
  // private DO always supply a verified principal; a body actor never gets here.
  if (typeof actor === 'string' && actor === engine.state.workspace.owner_id)
    return { actor_id: actor, kind: 'human', auth_method: 'owner-token' };
  throw new DomainError('UNAUTHENTICATED', 'An authenticated principal is required', 401);
}
export function servicePath(path) {
  return /^\/api\/(?:session|access|context|evaluator-profiles|evaluator-bindings|evaluation-runs|declarations|dependencies|discovery|provenance|export)(?:\/|$)/.test(path);
}
export function pushRepositories(engine, event) {
  if (!event || typeof event !== 'object') throw new DomainError('INVALID_EVENT', 'A Git push is required');
  const source = event.source_repo ?? event.repo;
  const future = (engine.state.futures ?? []).find((item) =>
    (item.repositories ?? []).some((repo) => repo.repo_id === source));
  return future ? engine.access.resourceRepositories(future) : [...new Set(
    [event.repo, event.source_repo].filter((id) => typeof id === 'string')
      .map((id) => engine.access.canonicalRepository(id)),
  )];
}
export function ignoredInternalPush(engine, event) {
  if (typeof event?.ref !== 'string' ||
      !(event.ref.startsWith('refs/klocgit/candidates/') || event.ref.startsWith('refs/klocgit/observations/')))
    return null;
  const source = event.source_repo ?? event.repo;
  const canonical = engine.state.repositories.find((repo) => repo.id === source && repo.canonical_ref === event.ref);
  const trackedFuture = (engine.state.futures ?? []).some((future) =>
    (future.repositories ?? []).some((repo) => repo.repo_id === source && repo.ref === event.ref));
  if (canonical || trackedFuture) return null;
  return { ignored: true, reason: event.ref.startsWith('refs/klocgit/candidates/')
    ? 'INTERNAL_CANDIDATE_REF' : 'INTERNAL_OBSERVATION_REF' };
}
export function filteredWorkflow(engine, result, principal, method) {
  if (method !== 'GET') return redactSensitive(result);
  if (Array.isArray(result?.mergeRequests))
    return { ...result, mergeRequests: result.mergeRequests.filter((item) => engine.access.readable(principal, item)).map(redactSensitive) };
  if (Array.isArray(result?.mergeQueue))
    return { ...result, mergeQueue: result.mergeQueue.filter((item) => engine.access.readable(principal, item)).map(redactSensitive) };
  return redactSensitive(result);
}
export function legacyReadInputs(engine, principal) {
  // Conventional evidence/context currently pins the whole canonical vector.
  // A scoped actor must be allowed to read every input the result will expose.
  engine.access.require(principal, 'repository.read', engine.access.repositoryIds());
}
async function ingestPush(engine, input, principal) {
  const repos = pushRepositories(engine, input.event);
  if (!repos.length || repos.some((id) => !engine.access.repositoryIds().includes(id)))
    return jsonResponse({ ignored: true, reason: 'UNREGISTERED_REPOSITORY' });
  const actor = engine.access.require(principal, 'ingress.write', repos);
  const ignored = ignoredInternalPush(engine, input.event);
  if (ignored) return jsonResponse(ignored);
  const native = await engine.native.observeRepositoryPush(input.event, actor);
  if (native.handled) return jsonResponse(redactSensitive(native));
  const fork = engine.state.forks.find((fork) => fork.id === input.event.repo);
  const event = fork ? { ...input.event, repo: fork.repo, source_repo: fork.id } : input.event;
  return jsonResponse(await engine.ingest(event, input.metadata ?? {}));
}

/** Called only after authentication inside WorkspaceCoordinator's serialized boundary. */
export async function handleCoordinatorRequest(engine, env, {
  method, url, input = {}, principal, actor: suppliedActor, headers = new Headers(),
}) {
  const path = url.pathname;
  if (!principal && path.startsWith('/internal/'))
    principal = internalPrincipal(path === '/internal/push' ? 'artifacts-ingress' :
      path === '/internal/merge-queue' ? 'merge-queue-coordinator' : 'coordinator');
  principal = requestPrincipal(engine, principal, suppliedActor ?? env.ACTOR_ID);
  const actor = principal.actor_id;
  if (path === '/api/session' && method === 'GET') return jsonResponse(engine.access.session(principal));
  if (path === '/api/access') {
    if (method === 'GET') return jsonResponse(engine.access.policy(principal));
    if (method === 'POST') return jsonResponse(await engine.access.update(input, principal));
    throw new DomainError('METHOD_NOT_ALLOWED', 'Access policy supports GET and POST', 405);
  }
  if (path === '/internal/merge-queue' && method === 'POST') {
    engine.access.require(principal, 'queue.process');
    const result = await engine.queue.process({ request_id: input.request_id }, actor);
    if (result.processed) await scheduleAnalysis(env, { queue_entry: result.entry?.id });
    return jsonResponse(result);
  }
  if (path === '/internal/push' || (path === '/api/events' && method === 'POST'))
    return ingestPush(engine, input, principal);
  if (path === '/api/workspace' && method === 'GET') return jsonResponse(await engine.view(principal));

  const report = method === 'POST' && /^\/api\/evaluation-runs\/[^/]+\/report$/.test(path);
  if (report) {
    if (principal.kind !== 'service' || principal.auth_method !== 'evaluator-hmac')
      throw new DomainError('UNAUTHENTICATED', 'A verified evaluator service report is required', 401);
    const result = await handleNativeRequest(engine, { method, url, input, actor, principal, requestHeaders: headers });
    if (result === null) throw new DomainError('NOT_FOUND', 'Evaluator report route is unavailable', 404);
    return jsonResponse(redactSensitive(result));
  }
  if (!path.startsWith('/internal/')) engine.access.require(principal, 'workspace.read');
  const legacyRepository = path === '/api/repositories' && method === 'POST' &&
    Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'id');
  if ((ownsNativePath(path) || servicePath(path)) && !legacyRepository) {
    const result = await handleNativeRequest(engine, { method, url, input, actor, principal, requestHeaders: headers });
    if (result === null) throw new DomainError('NOT_FOUND', 'Endpoint not found', 404);
    return jsonResponse(redactSensitive(result));
  }

  if (engine.access.authorizeWorkflow({ method, url, input, principal })) {
    if (method === 'POST' && /\/(prepare|validate)$/.test(path)) legacyReadInputs(engine, principal);
    const workflow = await handleWorkflowRequest(engine, { method, url, input, actor, principal });
    if (workflow !== null) {
      if (path === '/api/merge-queue/process' && workflow.processed)
        await scheduleAnalysis(env, { queue_entry: workflow.entry?.id });
      return jsonResponse(filteredWorkflow(engine, workflow, principal, method));
    }
  }
  if ((path === '/api/analysis' || path === '/internal/analysis') && method === 'POST') {
    engine.access.require(principal, 'analysis.run');
    const result = await engine.analyzeWork({ actor, refresh: input.refresh === true });
    const nativeAnalysis = await engine.analyzeNativeWork({
      actor, trigger: input.trigger ?? {}, request_id: input.request_id,
    });
    return jsonResponse({ ...result, native_analysis: nativeAnalysis });
  }
  if (path === '/api/recover' && method === 'POST') {
    engine.access.require(principal, 'recovery.run');
    await engine.recover();
    return jsonResponse(await engine.view(principal));
  }
  if (path === '/api/tasks' && method === 'GET')
    return jsonResponse(engine.state.tasks.filter((task) =>
      engine.access.isWorkspaceAdmin(principal) || engine.access.readable(principal, task)));
  if (path === '/api/tasks' && method === 'POST') {
    legacyReadInputs(engine, principal);
    engine.access.require(principal, 'task.prepare',
      engine.access.resourceRepositories(input.task ?? input));
    return jsonResponse(await engine.prepareTask(input.task ?? input, actor), 201);
  }
  const task = path.match(/^\/api\/tasks\/([^/]+)\/(answer|assume)$/);
  if (task && method === 'POST') {
    const current = engine.state.tasks.find((item) => item.task.id === task[1]);
    if (!current) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    engine.access.require(principal, 'task.resolve', engine.access.resourceRepositories(current));
    return jsonResponse(await engine.resolveTask(task[1], input, actor, task[2] === 'assume'));
  }
  if (path === '/api/diff' && method === 'GET') {
    const revision = engine.revision(url.searchParams.get('revision'));
    engine.access.require(principal, 'repository.read', [revision.repo]);
    return jsonResponse({ diff: await engine.git.diff(engine.repo(revision.repo), revision.base_commit, revision.head_commit) });
  }
  if (path === '/api/repositories' && method === 'POST') {
    engine.access.require(principal, 'repository.create');
    engine.access.assertQuota('repositories', engine.access.repositoryIds().length);
    return jsonResponse(await registerRepository(engine, env, input, actor), 201);
  }
  if (path === '/api/repositories/fork' && method === 'POST') {
    engine.access.require(principal, 'repository.fork', [input.repo]);
    return jsonResponse(await forkRepository(engine, env, input, actor), 201);
  }
  const decision = path.match(/^\/api\/decisions\/([^/]+)\/(refresh|resolve)$/);
  if (decision && method === 'POST') {
    const component = engine.component(decision[1]);
    legacyReadInputs(engine, principal);
    engine.access.require(principal, decision[2] === 'resolve' ? 'decision.resolve' : 'decision.prepare',
      engine.access.resourceRepositories(component));
    if (decision[2] === 'refresh') return jsonResponse(await engine.refreshDecision(decision[1]));
    const result = await engine.resolve(decision[1], input, actor);
    const analysis = await scheduleAnalysis(env, { decision: result.decision_id, head: result.canonical_head });
    return jsonResponse({ ...result, analysis });
  }
  throw new DomainError('NOT_FOUND', 'Endpoint not found', 404);
}
