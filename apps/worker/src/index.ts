import { Hono } from "hono";
import { readObject } from "./routes/objects.ts";
import { callEngine } from "./internal.ts";
import {
  hashProjection,
  payloadDigest,
  sealFutureRevision,
} from "../../../packages/contracts/src/index.ts";
import type {
  EffectSet,
  Producer,
  Candidate,
  CandidateSpec,
  Evidence,
  Predicate,
} from "../../../packages/contracts/src/index.ts";
import { authenticate, authorize, signToken } from "./auth.ts";
import { unpackEvent } from "./events.ts";
import type { EventEnvelope } from "./events.ts";
import { objectiveName } from "./coordinators/objective.ts";
import { Failure, failureResponse, identifier, readJson } from "./runtime.ts";
import type { Bindings, Scope } from "./runtime.ts";
import type { ReviewCommand, PreparedCandidate, DecisionPacket } from "./coordinators/decisions.ts";
import { EvidenceStore } from "./evidence-store.ts";

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

export { callEngine } from "./internal.ts";

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


app.get("/api/session", async (context) => {
  const principal = await authenticate(context.req.raw, context.env);
  return context.json({ schema_version: 1, actor_id: principal.sub,
    actor_type: principal.actor_type, expires_at: principal.exp, grants: principal.grants });
});

app.get(prefix + "/decisions", async (context) => {
  const target = scope(context.req.param());
  const principal = await authenticate(context.req.raw, context.env);
  authorize(principal, target, "read");
  return callObjective(context.env, target, "decisions",
    { schema_version: 1, scope: target }, principal.sub);
});

app.get(prefix + "/decisions/:decision/evidence/:evidence", async (context) => {
  const target = scope(context.req.param());
  const principal = await authenticate(context.req.raw, context.env);
  authorize(principal, target, "read");
  const response = await callObjective(context.env, target, "decisions",
    { schema_version: 1, scope: target }, principal.sub);
  if (!response.ok) return response;
  const packet = await readJson<{ decisions: DecisionPacket[] }>(response, 8 * 1024 * 1024);
  const decision = packet.decisions.find((item) => item.decision.id === context.req.param("decision"));
  const digest = context.req.param("evidence");
  if (!decision?.decision.basis.evidence_digests.includes(digest))
    throw new Failure("NOT_FOUND", 404, "Evidence is unavailable for this decision");
  const record = await new EvidenceStore(context.env.PAYLOADS).load(target.tenant_id, digest);
  return new Response(record.payload, {
    headers: { "content-type": "application/json", "x-content-type-options": "nosniff" },
  });
});

for (const action of ["review", "promote"] as const) {
  app.post(prefix + "/decisions/:decision/" + action, async (context) => {
    const target = scope(context.req.param());
    const principal = await authenticate(context.req.raw, context.env);
    authorize(principal, target, "promote");
    const input = await readJson<{
      basis_digest: string; candidate_digest: string; predicates?: Predicate[];
      author?: { name: string; email: string };
    }>(context.req.raw);
    const key = context.req.header("Idempotency-Key");
    if (!key || key.length > 256)
      throw new Failure("IDEMPOTENCY_KEY_REQUIRED", 400, "An idempotency key is required");
    const command: ReviewCommand = {
      schema_version: 1, scope: target, principal, idempotency_key: key,
      decision_id: context.req.param("decision"), basis_digest: input.basis_digest,
      candidate_digest: input.candidate_digest, predicates: input.predicates ?? [],
      ...(input.author ? { author: input.author } : {}),
    };
    if (action === "review")
      return callObjective(context.env, target, "review", command, principal.sub, principal.exp * 1000);
    const result = await callObjective(context.env, target, "promotion-input", command, principal.sub, principal.exp * 1000);
    if (!result.ok) return result;
    const preparation = await readJson<Record<string, unknown>>(result, 4 * 1024 * 1024);
    let prepared: PreparedCandidate | undefined;
    if (!preparation.prior_command) {
      if (!input.author || typeof input.author.name !== "string" || typeof input.author.email !== "string" ||
          !input.author.name || !input.author.email || input.author.name.length > 256 || input.author.email.length > 256 ||
          /[<>\r\n]/.test(input.author.name + input.author.email))
        throw new Failure("INVALID_INPUT", 400, "Commit author name and email are required");
      const output = await callEngine(context.env, "prepare", {
        ...preparation, schema_version: 1, scope: target,
        author: { ...input.author, unix_timestamp: Math.floor(Date.now() / 1000) },
      });
      if (!output.ok) return output;
      prepared = await readJson<PreparedCandidate>(output);
    }
    return callObjective(context.env, target, "promote",
      { ...command, ...(prepared ? { prepared } : {}) }, principal.sub, principal.exp * 1000);
  });
}

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
  if (payload.schema_version !== 1 || !payload.scope ||
      (await objectiveName(payload.scope)) !== (await objectiveName(envelope.scope)))
    throw new Failure("INVALID_EVENT", 400, "Event scope differs");
  if (envelope.type === "objective.reduce") {
    await reduceObjective(env, envelope);
    return;
  }
  if (envelope.type === "candidate.evaluate") {
    await evaluateCandidate(env, envelope);
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
    schema_version: 1,
    scope: payload.scope,
    original_payload,
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
    result,
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
    schema_version: 1,
    scope: envelope.scope,
    base_revisions: { [envelope.scope.repo_id]: base_oid },
    input_payload_ref,
    input_payload_digest,
    budget,
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
    result,
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
  const reductionBytes = object && object.size <= 8 * 1024 * 1024
    ? new Uint8Array(await object.arrayBuffer()) : null;
  if (
    !reductionBytes ||
    (await payloadDigest(reductionBytes)) !== output.payload_digest
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
  // An absent deployment policy is visible as configuration failure, never a relaxed gate.
  if (env.REVIEW_POLICY) {
    const reduction = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reductionBytes!)) as {
      candidate_specs: CandidateSpec[]; status: string;
    };
    if (reduction.candidate_specs.length) {
      const registered = await callObjective(env, envelope.scope, "candidates", {
        schema_version: 1, scope: envelope.scope, version: envelope.subject_version,
        candidate_specs: reduction.candidate_specs, reduction_status: reduction.status,
      }, "engine");
      if (registered.status === 409) return;
      if (!registered.ok) throw new Failure("CANDIDATE_REGISTRATION_FAILED", 503, "Candidate scheduling failed");
    }
  }
}

async function evaluateCandidate(env: Bindings, envelope: EventEnvelope): Promise<void> {
  const job = await unpackEvent(env, envelope) as { spec_id: string };
  const response = await callObjective(env, envelope.scope, "candidate-input", {
    schema_version: 1, scope: envelope.scope, version: envelope.subject_version, spec_id: job.spec_id,
  }, "engine");
  if (!response.ok) throw new Failure("CANDIDATE_INPUT_UNAVAILABLE", 503, "Candidate inputs are unavailable");
  const body = await readJson<{ input: Record<string, unknown> | null }>(response, 4 * 1024 * 1024);
  if (!body.input) return;
  const result = await callEngine(env, "evaluate", { ...body.input, schema_version: 1, scope: envelope.scope });
  if (!result.ok) throw new Failure("EVALUATION_UNAVAILABLE", 503, "Exact-state evaluation did not complete");
  const evaluated = await readJson<{ schema_version: number; candidate: Candidate; evidence: Evidence }>(result);
  if (evaluated.schema_version !== 1)
    throw new Failure("INVALID_EVALUATION", 409, "Evaluation schema differs");
  const recorded = await callObjective(env, envelope.scope, "evaluation", {
    schema_version: 1, scope: envelope.scope, version: envelope.subject_version, spec_id: job.spec_id,
    candidate: evaluated.candidate, evidence: evaluated.evidence,
  }, "engine");
  if (!recorded.ok) throw new Failure("EVALUATION_REJECTED", recorded.status, "Evaluation record was rejected");
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
