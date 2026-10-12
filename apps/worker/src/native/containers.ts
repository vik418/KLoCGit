import { Container } from "@cloudflare/containers";
import { hashProjection } from "../../../../packages/contracts/src/index.ts";
import { verifyInternal, sameScope } from "../auth.ts";
import {
  Failure,
  failureResponse,
  readJson,
  validateScope,
} from "../runtime.ts";
import type { Scope } from "../runtime.ts";

export interface NativeBindings {
  ANALYSIS: DurableObjectNamespace;
  EVALUATIONS: DurableObjectNamespace;
  CONTROL_PLANE: Fetcher;
  PAYLOADS: R2Bucket;
  INTERNAL_SIGNING_KEY: string;
  EVALUATION_CONFIG: string;
  TRUSTED_SUITE_MANIFEST: string;
}

export interface Command {
  schema_version: 1;
  scope: Scope;
  action: string;
  payload: unknown;
}

export class NativeContainer extends Container<NativeBindings> {
  defaultPort = 43191;
  sleepAfter = "5m";
  enableInternet = false;
  protected role = "analysis";

  protected async prepare(_input: Command): Promise<Response | undefined> {
    return undefined;
  }

  protected async complete(
    _input: Command,
    response: Response,
  ): Promise<Response> {
    return response;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const input = await readJson<Command>(request, 32 * 1024 * 1024);
      validateScope(input.scope);
      if (
        input.schema_version !== 1 ||
        ![
          "analyze",
          "reduce",
          "materialize",
          "workspace/blob",
          "prepare-commit",
          "stage",
          "evaluate",
          "destroy",
          "git/cas",
          "git/operation",
        ].includes(input.action)
      )
        throw new Failure("INVALID_INPUT", 400, "Invalid native command");
      const digest = await hashProjection("klocgit.native-command", input);
      const grant = await verifyInternal(
        request,
        this.env,
        "native-container",
        input.action,
        digest,
      );
      if (!sameScope(grant.scope, input.scope))
        throw new Failure("FORBIDDEN", 403, "Native command scope differs");
      const permitted =
        this.role === "analysis"
          ? ["analyze", "reduce", "materialize", "workspace/blob", "prepare-commit", "destroy"]
          : this.role === "git"
            ? ["git/cas", "git/operation", "destroy"]
            : ["stage", "evaluate", "destroy"];
      if (!permitted.includes(input.action))
        throw new Failure(
          "FORBIDDEN",
          403,
          "Native role does not allow this action",
        );
      let session = "";
      await this.ctx.blockConcurrencyWhile(async () => {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS runtime_scope (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema_version INTEGER NOT NULL, scope TEXT NOT NULL, session_key TEXT NOT NULL)",
        );
        const existing = this.ctx.storage.sql
          .exec<{ scope: string; session_key: string }>(
            "SELECT scope, session_key FROM runtime_scope WHERE singleton = 1",
          )
          .toArray()[0];
        if (existing && !sameScope(JSON.parse(existing.scope), input.scope))
          return;
        if (existing) {
          session = existing.session_key;
          return;
        }
        session = Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        this.ctx.storage.sql.exec(
          "INSERT INTO runtime_scope (singleton, schema_version, scope, session_key) VALUES (1, 1, ?, ?)",
          JSON.stringify(input.scope),
          session,
        );
      });
      if (!session)
        throw new Failure(
          "FORBIDDEN",
          403,
          "Native instance belongs to another scope",
        );
      if (input.action === "destroy") {
        await this.destroy();
        return Response.json({ schema_version: 1, status: "DESTROYED" });
      }
      const early = await this.prepare(input);
      if (early) return early;
      await this.startAndWaitForPorts({
        ports: this.defaultPort,
        startOptions: {
          enableInternet: false,
          envVars: {
            KLOCGIT_HOST_ROLE: this.role,
            KLOCGIT_HOST_PORT: String(this.defaultPort),
            KLOCGIT_SESSION: session,
          },
        },
        cancellationOptions: {
          instanceGetTimeoutMS: 30000,
          portReadyTimeoutMS: 30000,
          abort: request.signal,
        },
      });
      const response = await this.containerFetch(
        "http://native.internal/" + input.action,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-klocgit-session": session,
          },
          body: JSON.stringify(input.payload),
          signal: request.signal,
        },
      );
      return await this.complete(input, response);
    } catch (error) {
      return failureResponse(error);
    }
  }
}

export class AnalysisContainer extends NativeContainer {
  interceptHttps = true;
  allowedHosts = ["broker.internal"];
  static outbound = async (
    request: Request,
    env: NativeBindings,
  ): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.hostname !== "broker.internal" ||
      url.pathname !== "/internal/git-objects" ||
      request.method !== "POST"
    )
      return new Response("Forbidden", { status: 403 });
    return env.CONTROL_PLANE.fetch(
      new Request("https://control.internal/internal/git-objects", request),
    );
  };
}

export class EvaluationContainer extends NativeContainer {
  protected role = "evaluation";
  // This VM executes repository code. It has neither outbound handlers nor
  // repository tokens; all source and trusted checks arrive through staging.
  allowedHosts: string[] = [];
}
