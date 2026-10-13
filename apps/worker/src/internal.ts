import {
  hashProjection,
  payloadDigest,
} from "../../../packages/contracts/src/index.ts";
import { signToken } from "./auth.ts";
import { refName } from "./coordinators/ref.ts";
import type { PromotionCommand } from "./coordinators/ref.ts";
import type { Bindings, Scope } from "./runtime.ts";
import { Failure } from "./runtime.ts";

export async function callEngine(
  env: Bindings,
  action: string,
  supplied: { scope: Scope } & Record<string, unknown>,
): Promise<Response> {
  let body: { scope: Scope } & Record<string, unknown> = {
    ...supplied, execution_id: crypto.randomUUID(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  if (bytes.length > 8 * 1024 * 1024)
    throw new Failure("PAYLOAD_TOO_LARGE", 413, "Engine input exceeds limit");
  if (bytes.length >= 32 * 1024) {
    const job_payload_digest = await payloadDigest(bytes);
    const job_payload_ref =
      "jobs/" + body.scope.tenant_id + "/" + job_payload_digest.slice(7);
    await env.PAYLOADS.put(job_payload_ref, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        schema_version: "1",
        retention_class: "EPHEMERAL",
        payload_digest: job_payload_digest,
      },
    });
    body = {
      schema_version: 1,
      scope: body.scope,
      job_payload_ref,
      job_payload_digest,
    };
  }
  const token = await signToken(
    {
      schema_version: 1,
      aud: "engine",
      action,
      scope: body.scope,
      subject_digest: await hashProjection("klocgit.engine-command", body),
      actor_id: "coordinator",
      expires_at: Date.now() + 900000,
    },
    env.INTERNAL_SIGNING_KEY,
  );
  return env.ENGINE.fetch("https://engine.internal/" + action, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-klocgit-internal": token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(900000),
  });
}

export async function callRef(
  env: Bindings,
  action: "status" | "authorize" | "promote" | "reconcile",
  command: PromotionCommand,
): Promise<Response> {
  const token = await signToken(
    {
      schema_version: 1,
      aud: "ref",
      action,
      scope: command.scope,
      subject_digest: await hashProjection(
        "klocgit.promotion-command",
        command,
      ),
      actor_id: command.actor_id,
      expires_at: Date.now() + 180000,
    },
    env.INTERNAL_SIGNING_KEY,
  );
  return env.REFS.getByName(await refName(command.scope, command.ref)).fetch(
    "https://ref.internal/" + action,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-klocgit-internal": token,
      },
      body: JSON.stringify(command),
    },
  );
}
