import { DomainError } from '../core/hash.mjs';
import { handleWorkflowRequest } from '../server/workflow-api.mjs';
import { handleNativeRequest, ownsNativePath } from '../server/native-api.mjs';
import { jsonResponse } from './http.mjs';
import { scheduleAnalysis } from './events.mjs';
import { registerRepository, forkRepository } from './repositories.mjs';

async function processMergeQueue(engine, env, input) {
  const result = await engine.queue.process(
    { request_id: input.request_id },
    'merge-queue-coordinator',
  );
  if (result.processed) await scheduleAnalysis(env, { queue_entry: result.entry?.id });
  return jsonResponse(result);
}

async function ingestPush(engine, input, actor) {
  const native = await engine.native.observeRepositoryPush(input.event, actor);
  if (native.handled) return jsonResponse(native);
  const fork = engine.state.forks.find((fork) => fork.id === input.event.repo);
  const event = fork ? { ...input.event, repo: fork.repo, source_repo: fork.id } : input.event;
  if (!engine.state.repositories.some((repo) => repo.id === event.repo)) {
    return jsonResponse({ ignored: true, reason: 'UNREGISTERED_REPOSITORY' });
  }
  return jsonResponse(await engine.ingest(event, input.metadata ?? {}));
}

async function resolveDecision(engine, env, id, input) {
  const result = await engine.resolve(id, input, env.ACTOR_ID);
  const analysis = await scheduleAnalysis(env, {
    decision: result.decision_id,
    head: result.canonical_head,
  });
  // Git and the applied audit receipt are already durable. Failed reanalysis
  // enqueue must not misrepresent a completed canonical update.
  return jsonResponse({ ...result, analysis });
}

/** Called only inside WorkspaceCoordinator's serialized request boundary. */
export async function handleCoordinatorRequest(engine, env, { method, url, input }) {
  const path = url.pathname;
  const actor = env.ACTOR_ID;
  if (path === '/internal/merge-queue' && method === 'POST') {
    return processMergeQueue(engine, env, input);
  }

  // Preserve the existing repository adapter payload while native clients use id/mode.
  const legacyRepository =
    path === '/api/repositories' &&
    method === 'POST' &&
    Object.hasOwn(input, 'name') &&
    !Object.hasOwn(input, 'id');
  if (ownsNativePath(path) && !legacyRepository)
    return jsonResponse(await handleNativeRequest(engine, { method, url, input, actor }));

  const workflow = await handleWorkflowRequest(engine, { method, url, input, actor });
  if (workflow !== null) {
    if (path === '/api/merge-queue/process' && workflow.processed) {
      await scheduleAnalysis(env, { queue_entry: workflow.entry?.id });
    }
    return jsonResponse(workflow);
  }

  if (path === '/api/workspace' && method === 'GET') return jsonResponse(await engine.view());
  if ((path === '/api/analysis' || path === '/internal/analysis') && method === 'POST') {
    return jsonResponse(
      await engine.analyzeWork({
        actor: path.startsWith('/internal/') ? 'coordinator' : actor,
        refresh: input.refresh === true,
      }),
    );
  }
  if (path === '/api/recover' && method === 'POST') {
    await engine.recover();
    return jsonResponse(await engine.view());
  }
  if (path === '/api/tasks' && method === 'GET') return jsonResponse(engine.state.tasks);
  if (path === '/api/tasks' && method === 'POST')
    return jsonResponse(await engine.prepareTask(input, actor), 201);
  const task = path.match(/^\/api\/tasks\/([^/]+)\/(answer|assume)$/);
  if (task && method === 'POST')
    return jsonResponse(await engine.resolveTask(task[1], input, actor, task[2] === 'assume'));

  if (path === '/api/diff' && method === 'GET') {
    const revision = engine.revision(url.searchParams.get('revision'));
    return jsonResponse({
      diff: await engine.git.diff(
        engine.repo(revision.repo),
        revision.base_commit,
        revision.head_commit,
      ),
    });
  }
  if (path === '/internal/push') return ingestPush(engine, input, 'artifacts-ingress');
  if (path === '/api/events' && method === 'POST') return ingestPush(engine, input, 'git-ingress');
  if (path === '/api/repositories' && method === 'POST')
    return jsonResponse(await registerRepository(engine, env, input, actor), 201);
  if (path === '/api/repositories/fork' && method === 'POST')
    return jsonResponse(await forkRepository(engine, env, input, actor), 201);

  const decision = path.match(/^\/api\/decisions\/([^/]+)\/(refresh|resolve)$/);
  if (decision && method === 'POST') {
    if (decision[2] === 'refresh') return jsonResponse(await engine.refreshDecision(decision[1]));
    return resolveDecision(engine, env, decision[1], input);
  }
  throw new DomainError('NOT_FOUND', 'Endpoint not found', 404);
}
