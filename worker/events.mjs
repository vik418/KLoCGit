import { DomainError } from '../core/hash.mjs';
import { configuredWorkspace } from './config.mjs';

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

async function postInternal(stub, path, input, failureMessage) {
  const response = await stub.fetch(
    new Request('https://coordinator' + path, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
  if (!response.ok) throw new Error(failureMessage);
  return response;
}

async function ingestPush(event, stub, env, workspace) {
  const response = await postInternal(
    stub,
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
      '/internal/merge-queue',
      {
        request_id: event.request_id,
      },
      'Merge queue processing not acknowledged',
    );
    return;
  }
  if (event?.kind === 'analyze') {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(workspace));
    await postInternal(
      stub,
      '/internal/analysis',
      {
        refresh: false,
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
