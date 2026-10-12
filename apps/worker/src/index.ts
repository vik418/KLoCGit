import { Hono } from 'hono';
import { hashProjection, sealFutureRevision } from '../../../packages/contracts/src/index.ts';
import type { EffectSet, Producer } from '../../../packages/contracts/src/index.ts';
import { authenticate, authorize, signToken } from './auth.ts';
import { unpackEvent } from './events.ts';
import type { EventEnvelope } from './events.ts';
import { objectiveName } from './coordinators/objective.ts';
import { Failure, failureResponse, identifier, readJson } from './runtime.ts';
import type { Bindings, Scope } from './runtime.ts';

export { ObjectiveCoordinator } from './coordinators/objective.ts';
export { RefCoordinator } from './coordinators/ref.ts';

const API_VERSION = '2026-10-12';
const app = new Hono<{ Bindings: Bindings }>();
app.onError((error) => failureResponse(error));
app.use('*', async (context, next) => {
  const version = context.req.header('KLoCGit-Version');
  if (version && version !== API_VERSION) throw new Failure('UNSUPPORTED_API_VERSION', 400, 'Requested API version is unsupported');
  context.header('KLoCGit-Version', API_VERSION);
  context.header('Cache-Control', 'no-store');
  await next();
});

const prefix = '/api/tenants/:tenant/organizations/:organization/repos/:repo/objectives/:objective';

function scope(params: Record<string, string>): Scope {
  return {
    tenant_id: identifier(params.tenant), organization_id: identifier(params.organization),
    repo_id: identifier(params.repo), objective_id: identifier(params.objective),
  };
}

export async function callObjective(env: Bindings, scope: Scope, action: string, body: unknown, actor: string, expires = Date.now() + 60_000): Promise<Response> {
  const subject_digest = await hashProjection('klocgit.objective-command', body);
  const token = await signToken({
    schema_version: 1, aud: 'objective', action, scope, subject_digest, actor_id: actor, expires_at: expires,
  }, env.INTERNAL_SIGNING_KEY);
  const object = env.OBJECTIVES.getByName(await objectiveName(scope));
  return object.fetch('https://objective.internal/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-klocgit-internal': token },
    body: JSON.stringify(body),
  });
}

app.get(prefix, async (context) => {
  const target = scope(context.req.param());
  const principal = await authenticate(context.req.raw, context.env);
  authorize(principal, target, 'read');
  return callObjective(context.env, target, 'status', { schema_version: 1, scope: target }, principal.sub);
});

app.post(prefix + '/futures', async (context) => {
  const target = scope(context.req.param());
  const principal = await authenticate(context.req.raw, context.env);
  authorize(principal, target, 'ingest');
  const input = await readJson<{ system_id: string; ref: string; producer: Producer }>(context.req.raw);
  const idempotency_key = context.req.header('Idempotency-Key');
  if (!idempotency_key || idempotency_key.length > 256) throw new Failure('IDEMPOTENCY_KEY_REQUIRED', 400, 'An idempotency key is required');
  const trace_id = crypto.randomUUID();
  const command = { schema_version: 1, scope: target, system_id: identifier(input.system_id), ref: input.ref, producer: input.producer, principal, idempotency_key, trace_id };
  return callObjective(context.env, target, 'ingest', command, principal.sub, principal.exp * 1000);
});

app.notFound(() => Response.json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } }, { status: 404 }));

async function analyze(env: Bindings, envelope: EventEnvelope): Promise<void> {
  const payload = await unpackEvent(env, envelope) as {
    schema_version: number; scope: Scope;
    state: Parameters<typeof sealFutureRevision>[0];
    revision: Awaited<ReturnType<typeof sealFutureRevision>>;
  };
  if (envelope.type !== 'future.analyze' || payload.schema_version !== 1
    || await objectiveName(payload.scope) !== await objectiveName(envelope.scope)) throw new Failure('INVALID_EVENT', 400, 'Analysis event scope differs');
  const expected = await sealFutureRevision(payload.state, payload.revision);
  if (expected.id !== payload.revision.id || expected.state_digest !== payload.revision.state_digest
    || expected.record_digest !== payload.revision.record_digest || payload.state.repo_id !== envelope.scope.repo_id) throw new Failure('INVALID_EVENT', 409, 'Future record differs');
  const result = await env.ENGINE.fetch('https://engine.internal/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, input_payload_digest: envelope.payload_digest, state: payload.state, revision: payload.revision, scope: payload.scope }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!result.ok) throw new Failure('ENGINE_UNAVAILABLE', 503, 'Analysis execution is unavailable');
  const analysis = await readJson<{ schema_version: number; input_payload_digest: string; effects: EffectSet }>(
    new Request('https://response.internal', { method: 'POST', body: result.body }), 32 * 1024,
  );
  if (analysis.schema_version !== 1 || analysis.input_payload_digest !== envelope.payload_digest) throw new Failure('INVALID_ANALYSIS', 409, 'Analysis input binding differs');
  const response = await callObjective(env, envelope.scope, 'analysis', {
    schema_version: 1, scope: envelope.scope, revision_id: payload.revision.id,
    version: envelope.subject_version, effects: analysis.effects,
  }, 'engine');
  if (!response.ok) throw new Failure('ANALYSIS_REJECTED', response.status, 'Analysis result was rejected');
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<EventEnvelope>, env: Bindings): Promise<void> {
    for (const message of batch.messages) {
      try {
        await analyze(env, message.body);
        message.ack();
      } catch (error) {
        const code = error instanceof Failure ? error.code : 'INTERNAL_ERROR';
        console.error(JSON.stringify({ schema_version: 1, trace_id: message.body?.trace_id, event_id: message.body?.event_id, failure_class: code, attempt: message.attempts }));
        if (message.attempts >= 5) {
          await env.DEAD_LETTER_QUEUE.send({ schema_version: 1, envelope: message.body, failure_class: code });
          message.ack();
        } else message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  },
};
