import { DomainError, hash } from '../core/hash.mjs';
import { configuredWorkspace } from './config.mjs';
import { forwardPrincipal, internalPrincipal } from './identity.mjs';

export async function scheduleAnalysis(env, trigger) {
  const workspace = configuredWorkspace(env);
  try {
    if (!env.ANALYSIS_QUEUE) return 'not-enqueued';
    await env.ANALYSIS_QUEUE.send({
      kind: 'analyze',
      workspace,
      trigger,
    });
    return 'enqueued';
  } catch {
    return 'enqueue-failed';
  }
}

async function postInternal(stub, env, path, input, failureMessage, actor = 'coordinator') {
  const response = await stub.fetch(
    await forwardPrincipal(
      new Request('https://coordinator' + path, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      internalPrincipal(actor),
      env,
    ),
  );
  if (!response.ok) throw new Error(failureMessage);
  return response;
}

async function ingestPush(event, stub, env, workspace) {
  const response = await postInternal(
    stub,
    env,
    '/internal/push',
    {
      event: {
        repo: event.source.repoName,
        ref: event.payload.ref,
        before: event.payload.before,
        after: event.payload.after,
      },
    },
    'Ingestion not acknowledged',
    'artifacts-ingress',
  );
  const ingestion = await response.json();
  if (ingestion.ignored || ingestion.reason === 'OUT_OF_ORDER_EVENT') return;

  // Delivery is acknowledged only after both durable ingestion and analysis
  // enqueue succeed. An enqueue failure retries the idempotent ingress receipt.
  if (!env.ANALYSIS_QUEUE) throw new Error('Analysis queue is unconfigured');
  await env.ANALYSIS_QUEUE.send({
    kind: 'analyze',
    workspace,
    trigger: {
      repo: event.source.repoName,
      ref: event.payload.ref,
      head: event.payload.after,
    },
  });
}

async function handleEvent(event, env, workspace) {
  const internal = event?.kind === 'process_merge_queue' || event?.kind === 'analyze';
  if (internal && event.workspace !== workspace) {
    throw new DomainError('WORKSPACE_MISMATCH', 'The queued job names a different workspace', 409);
  }
  if (event?.kind === 'process_merge_queue') {
    // Malformed jobs cannot name a replayable operation. Retrying cannot repair
    // the payload, so discard it before entering coordination.
    if (
      typeof event.request_id !== 'string' ||
      !event.request_id.trim() ||
      event.request_id.length > 200
    )
      return;
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(workspace));
    await postInternal(
      stub,
      env,
      '/internal/merge-queue',
      {
        request_id: event.request_id,
      },
      'Merge queue processing not acknowledged',
      'merge-queue-coordinator',
    );
    return;
  }
  if (event?.kind === 'analyze') {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(workspace));
    const trigger =
      event.trigger && typeof event.trigger === 'object' && !Array.isArray(event.trigger)
        ? event.trigger
        : {};
    // Redelivery names the same analysis request. Canonical/source-head changes
    // produce a different trigger and are evaluated against their own basis.
    const requestId = 'queue:' + (await hash({ workspace, trigger }));
    await postInternal(
      stub,
      env,
      '/internal/analysis',
      {
        refresh: false,
        trigger,
        request_id: requestId,
      },
      'Analysis not acknowledged',
    );
    return;
  }
  if (
    event?.type !== 'cf.artifacts.repo.pushed' ||
    event.source?.namespace !== env.ARTIFACTS_NAMESPACE
  )
    return;
  const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(workspace));
  await ingestPush(event, stub, env, workspace);
}

export async function consumeEvents(batch, env) {
  // Configuration failures reject the batch before any message is processed or acknowledged.
  const workspace = configuredWorkspace(env);
  for (const message of batch.messages) {
    try {
      await handleEvent(message.body, env, workspace);
      message.ack();
    } catch {
      message.retry();
    }
  }
}
