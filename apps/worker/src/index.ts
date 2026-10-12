import { Hono } from "hono";
import { readObject } from "./routes/objects.ts";
import {
  hashProjection,
  payloadDigest,
  sealFutureRevision,
} from "../../../packages/contracts/src/index.ts";
import type {
  EffectSet,
  Producer,
} from "../../../packages/contracts/src/index.ts";
import { authenticate, authorize, signToken } from "./auth.ts";
import { unpackEvent } from "./events.ts";
import type { EventEnvelope } from "./events.ts";
import { objectiveName } from "./coordinators/objective.ts";
import { Failure, failureResponse, identifier, readJson } from "./runtime.ts";
import type { Bindings, Scope } from "./runtime.ts";

export { ObjectiveCoordinator } from "./coordinators/objective.ts";
export { RefCoordinator } from "./coordinators/ref.ts";

const API_VERSION = "2026-10-12";
const app = new Hono<{ Bindings: Bindings }>();
app.onError((error) => failureResponse(error));
app.use("*", async (context, next) => {
  const version = context.req.header("KLoCGit-Version");
  if (version && version !== API_VERSION)
    throw new Failure(
      "UNSUPPORTED_API_VERSION",
      400,
      "Requested API version is unsupported",
    );
  context.header("KLoCGit-Version", API_VERSION);
  context.header("Cache-Control", "no-store");
  await next();
});

const prefix =
  "/api/tenants/:tenant/organizations/:organization/repos/:repo/objectives/:objective";

function scope(params: Record<string, string>): Scope {
  return {
    tenant_id: identifier(params.tenant),
    organization_id: identifier(params.organization),
    repo_id: identifier(params.repo),
    objective_id: identifier(params.objective),
  };
}

export async function callObjective(
  env: Bindings,
  scope: Scope,
  action: string,
  body: unknown,
  actor: string,
  expires = Date.now() + 60_000,
): Promise<Response> {
  const subject_digest = await hashProjection(
    "klocgit.objective-command",
    body,
  );
  const token = await signToken(
    {
      schema_version: 1,
      aud: "objective",
      action,
      scope,
      subject_digest,
      actor_id: actor,
      expires_at: expires,
    },
    env.INTERNAL_SIGNING_KEY,
  );
  const object = env.OBJECTIVES.getByName(await objectiveName(scope));
  return object.fetch("https://objective.internal/" + action, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-klocgit-internal": token,
    },
    body: JSON.stringify(body),
  });
}

export async function callEngine(env: Bindings, action: string, body: { scope: Scope } & Record<string, unknown>): Promise<Response> {
  const subject_digest = await hashProjection("klocgit.engine-command", body);
  const token = await signToken({ schema_version: 1, aud: "engine", action, scope: body.scope,
    subject_digest, actor_id: "coordinator", expires_at: Date.now() + 900000 }, env.INTERNAL_SIGNING_KEY);
  return env.ENGINE.fetch("https://engine.internal/" + action, {
    method: "POST", headers: { "content-type": "application/json", "x-klocgit-internal": token },
    body: JSON.stringify(body), signal: AbortSignal.timeout(900000),
  });
}

app.get(prefix, async (context) => {
  const target = scope(context.req.param());
  const principal = await authenticate(context.req.raw, context.env);
  authorize(principal, target, "read");
  return callObjective(
    context.env,
    target,
    "status",
    { schema_version: 1, scope: target },
    principal.sub,
  );
});

app.post(prefix + "/futures", async (context) => {
  const target = scope(context.req.param());
  const principal = await authenticate(context.req.raw, context.env);
  authorize(principal, target, "ingest");
  const input = await readJson<{
    system_id: string;
    ref: string;
    producer: Producer;
  }>(context.req.raw);
  const idempotency_key = context.req.header("Idempotency-Key");
  if (!idempotency_key || idempotency_key.length > 256)
    throw new Failure(
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
      "An idempotency key is required",
    );
  const trace_id = crypto.randomUUID();
  const command = {
    schema_version: 1,
    scope: target,
    system_id: identifier(input.system_id),
    ref: input.ref,
    producer: input.producer,
    principal,
    idempotency_key,
    trace_id,
  };
  return callObjective(
    context.env,
    target,
    "ingest",
    command,
    principal.sub,
    principal.exp * 1000,
  );
});

app.post("/internal/git-objects", (context) =>
  readObject(context.req.raw, context.env),
);

app.notFound(() =>
  Response.json(
    { error: { code: "NOT_FOUND", message: "Resource not found" } },
    { status: 404 },
  ),
);

async function analyze(env: Bindings, envelope: EventEnvelope): Promise<void> {
  const payload = (await unpackEvent(env, envelope)) as {
    schema_version: number;
    scope: Scope;
    state: Parameters<typeof sealFutureRevision>[0];
    revision: Awaited<ReturnType<typeof sealFutureRevision>>;
    base_oid: string;
  };
  if (envelope.type === "objective.reduce") {
    await reduceObjective(env, envelope);
    return;
  }
  if (
    envelope.type !== "future.analyze" ||
    payload.schema_version !== 1 ||
    (await objectiveName(payload.scope)) !==
      (await objectiveName(envelope.scope))
  )
    throw new Failure("INVALID_EVENT", 400, "Analysis event scope differs");
  const expected = await sealFutureRevision(payload.state, payload.revision);
  if (
    expected.id !== payload.revision.id ||
    expected.state_digest !== payload.revision.state_digest ||
    expected.record_digest !== payload.revision.record_digest ||
    payload.state.repo_id !== envelope.scope.repo_id
  )
    throw new Failure("INVALID_EVENT", 409, "Future record differs");
  const original_payload = JSON.stringify(payload);
  const result = await callEngine(env, "analyze", {
      schema_version: 1, scope: payload.scope, original_payload,
      input_payload_digest: envelope.payload_digest,
    });
  if (!result.ok)
    throw new Failure(
      "ENGINE_UNAVAILABLE",
      503,
      "Analysis execution is unavailable",
    );
  const analysis = await readJson<{
    schema_version: number;
    input_payload_digest: string;
    effects: EffectSet;
    changed_paths: string[];
  }>(
    new Request("https://response.internal", {
      method: "POST",
      body: result.body,
    }),
    32 * 1024,
  );
  if (
    analysis.schema_version !== 1 ||
    analysis.input_payload_digest !== envelope.payload_digest
  )
    throw new Failure(
      "INVALID_ANALYSIS",
      409,
      "Analysis input binding differs",
    );
  const response = await callObjective(
    env,
    envelope.scope,
    "analysis",
    {
      schema_version: 1,
      scope: envelope.scope,
      revision_id: payload.revision.id,
      version: envelope.subject_version,
      effects: analysis.effects,
      changed_paths: analysis.changed_paths,
    },
    "engine",
  );
  if (!response.ok)
    throw new Failure(
      "ANALYSIS_REJECTED",
      response.status,
      "Analysis result was rejected",
    );
}

async function reduceObjective(
  env: Bindings,
  envelope: EventEnvelope,
): Promise<void> {
  const segments: { payload_ref: string; payload_digest: string }[] = [];
  let cursor: string | null = "";
  let base_oid = "";
  do {
    const response = await callObjective(
      env,
      envelope.scope,
      "reduction-page",
      {
        schema_version: 1,
        scope: envelope.scope,
        version: envelope.subject_version,
        cursor,
      },
      "engine",
    );
    if (response.status === 409) return;
    if (!response.ok)
      throw new Failure(
        "REDUCTION_INPUT_UNAVAILABLE",
        503,
        "Reduction input snapshot is unavailable",
      );
    const page = await readJson<{
      schema_version: number;
      version: number;
      base_oid: string;
      records: unknown[];
      next_cursor: string | null;
    }>(
      new Request("https://response.internal", {
        method: "POST",
        body: response.body,
      }),
      8 * 1024 * 1024,
    );
    if (
      page.version !== envelope.subject_version ||
      (base_oid && page.base_oid !== base_oid)
    )
      throw new Failure("INVALID_REDUCTION", 409, "Reduction base changed");
    base_oid = page.base_oid;
    const bytes = new TextEncoder().encode(JSON.stringify(page.records));
    const payload_digest = await payloadDigest(bytes);
    const payload_ref =
      "analysis/" + envelope.scope.tenant_id + "/" + payload_digest.slice(7);
    await env.PAYLOADS.put(payload_ref, bytes, {
      customMetadata: {
        retention_class: "REBUILDABLE",
        payload_digest,
        schema_version: "1",
      },
    });
    segments.push({ payload_ref, payload_digest });
    if (segments.length > 1024)
      throw new Failure(
        "REDUCTION_BUDGET_EXCEEDED",
        409,
        "Reduction input exceeds configured transport budget",
      );
    cursor = page.next_cursor;
  } while (cursor);
  const bytes = new TextEncoder().encode(
    JSON.stringify({ schema_version: 1, segments }),
  );
  const input_payload_digest = await payloadDigest(bytes);
  const input_payload_ref =
    "analysis/" +
    envelope.scope.tenant_id +
    "/" +
    input_payload_digest.slice(7);
  await env.PAYLOADS.put(input_payload_ref, bytes, {
    customMetadata: {
      retention_class: "REBUILDABLE",
      payload_digest: input_payload_digest,
      schema_version: "1",
    },
  });
  let budget: unknown;
  try {
    budget = JSON.parse(env.REDUCTION_BUDGET);
  } catch {
    throw new Failure(
      "CONFIGURATION_REQUIRED",
      503,
      "Reduction budget is not configured",
    );
  }
  const result = await callEngine(env, "reduce", {
    schema_version: 1, scope: envelope.scope, base_revisions: { [envelope.scope.repo_id]: base_oid },
    input_payload_ref, input_payload_digest, budget,
  });
  if (!result.ok)
    throw new Failure(
      "ENGINE_UNAVAILABLE",
      503,
      "Reduction execution is unavailable",
    );
  const output = await readJson<{
    schema_version: number;
    input_payload_digest: string;
    payload_ref: string;
    payload_digest: string;
    summary: unknown;
  }>(
    new Request("https://response.internal", {
      method: "POST",
      body: result.body,
    }),
  );
  if (
    output.schema_version !== 1 ||
    output.input_payload_digest !== input_payload_digest ||
    !output.payload_ref.startsWith(
      "reductions/" + envelope.scope.tenant_id + "/",
    )
  )
    throw new Failure(
      "INVALID_REDUCTION",
      409,
      "Reduction input binding differs",
    );
  const object = await env.PAYLOADS.get(output.payload_ref);
  if (
    !object ||
    object.size > 8 * 1024 * 1024 ||
    (await payloadDigest(new Uint8Array(await object.arrayBuffer()))) !==
      output.payload_digest
  )
    throw new Failure(
      "INVALID_REDUCTION",
      409,
      "Reduction payload verification failed",
    );
  const response = await callObjective(
    env,
    envelope.scope,
    "reduction",
    {
      schema_version: 1,
      scope: envelope.scope,
      version: envelope.subject_version,
      payload_ref: output.payload_ref,
      payload_digest: output.payload_digest,
      summary: output.summary,
    },
    "engine",
  );
  if (!response.ok)
    throw new Failure(
      "REDUCTION_REJECTED",
      response.status,
      "Reduction result was rejected",
    );
}

export default {
  fetch: app.fetch,
  async queue(
    batch: MessageBatch<EventEnvelope>,
    env: Bindings,
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        await analyze(env, message.body);
        message.ack();
      } catch (error) {
        const code = error instanceof Failure ? error.code : "INTERNAL_ERROR";
        console.error(
          JSON.stringify({
            schema_version: 1,
            trace_id: message.body?.trace_id,
            event_id: message.body?.event_id,
            failure_class: code,
            attempt: message.attempts,
          }),
        );
        if (message.attempts >= 5) {
          await env.DEAD_LETTER_QUEUE.send({
            schema_version: 1,
            envelope: message.body,
            failure_class: code,
          });
          message.ack();
        } else
          message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  },
};
