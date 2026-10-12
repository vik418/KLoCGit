import { DurableObject } from "cloudflare:workers";
import {
  hashProjection,
  sealFutureRevision,
  sealEffectSet,
} from "../../../../packages/contracts/src/index.ts";
import type {
  Producer,
  EffectSet,
} from "../../../../packages/contracts/src/index.ts";
import { sameScope, authorize, verifyInternal } from "../auth.ts";
import type { Principal } from "../auth.ts";
import { packEvent } from "../events.ts";
import { GitStore } from "../git-store.ts";
import {
  Failure,
  failureResponse,
  readJson,
  validateScope,
  identifier,
} from "../runtime.ts";
import type { Bindings, Scope } from "../runtime.ts";

export function objectiveName(scope: Scope): Promise<string> {
  return hashProjection("klocgit.objective-scope", scope);
}

export interface IngestCommand {
  schema_version: 1;
  scope: Scope;
  system_id: string;
  ref: string;
  producer: Producer;
  principal: Principal;
  idempotency_key: string;
  trace_id: string;
}

type Job = {
  job_id: string;
  version: number;
  payload: string;
  actor_id: string;
  expires_at: number;
  status: string;
};
type FutureRow = {
  revision_id: string;
  ref: string;
  version: number;
  record: string;
  effects: string | null;
};

export class ObjectiveCoordinator extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS receipts (idempotency_key TEXT PRIMARY KEY, command_digest TEXT NOT NULL, response TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS futures (revision_id TEXT PRIMARY KEY, ref TEXT NOT NULL, version INTEGER NOT NULL, schema_version INTEGER NOT NULL, record TEXT NOT NULL, effects TEXT)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS current_refs (ref TEXT PRIMARY KEY, revision_id TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS outbox (job_id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, actor_id TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS capabilities (id TEXT PRIMARY KEY, claims_digest TEXT NOT NULL, remaining INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reductions (version INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, payload_ref TEXT NOT NULL, payload_digest TEXT NOT NULL, summary TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, action TEXT NOT NULL, actor_id TEXT NOT NULL, trace_id TEXT NOT NULL, object_id TEXT NOT NULL)",
    );
  }

  private version(): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM metadata WHERE key = ?",
          "version",
        )
        .toArray()[0]?.value ?? 0,
    );
  }

  private audit(
    action: string,
    actor: string,
    trace: string,
    object: string,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO audit (schema_version, action, actor_id, trace_id, object_id) VALUES (1, ?, ?, ?, ?)",
      action,
      actor,
      trace,
      object,
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST")
        throw new Failure("METHOD_NOT_ALLOWED", 405, "POST is required");
      const body = await readJson<
        IngestCommand & {
          effects?: EffectSet;
          revision_id?: string;
          version?: number;
          payload_ref?: string;
          payload_digest?: string;
          summary?: unknown;
          cursor?: string;
        }
      >(request);
      validateScope(body.scope);
      const action = new URL(request.url).pathname.slice(1);
      if (
        ![
          "ingest",
          "status",
          "analysis",
          "reduction",
          "reduction-page",
        ].includes(action)
      )
        throw new Failure("NOT_FOUND", 404, "Unknown operation");
      const subject = await hashProjection("klocgit.objective-command", body);
      const grant = await verifyInternal(
        request,
        this.env,
        "objective",
        action,
        subject,
      );
      if (
        !sameScope(grant.scope, body.scope) ||
        this.ctx.id.toString() !==
          this.env.OBJECTIVES.idFromName(
            await objectiveName(body.scope),
          ).toString()
      )
        throw new Failure("FORBIDDEN", 403, "Objective scope differs");
      if (action === "status") return this.status();
      if (action === "reduction-page") return this.reductionPage(body);
      if (action === "analysis") return await this.analysis(body);
      if (action === "reduction") return this.reduction(body);
      if (
        grant.actor_id !== body.principal.sub ||
        body.principal.exp * 1000 <= Date.now()
      )
        throw new Failure("FORBIDDEN", 403, "Ingestion authorization expired");
      authorize(body.principal, body.scope, "ingest");
      return await this.ctx.blockConcurrencyWhile(async () => {
        // A denied request is a normal response, not a fatal object reset.
        try {
          return await this.ingest(body);
        } catch (error) {
          return failureResponse(error);
        }
      });
    } catch (error) {
      return failureResponse(error);
    }
  }

  private status(): Response {
    return Response.json({
      schema_version: 1,
      version: this.version(),
      futures: this.ctx.storage.sql
        .exec<FutureRow>(
          "SELECT revision_id, ref, version, record, effects FROM futures ORDER BY version DESC LIMIT 100",
        )
        .toArray()
        .map((row) => ({
          ...JSON.parse(row.record),
          effects: row.effects ? JSON.parse(row.effects) : null,
        })),
      reduction:
        this.ctx.storage.sql
          .exec<{ summary: string }>(
            "SELECT summary FROM reductions WHERE version = ? LIMIT 1",
            this.version(),
          )
          .toArray()
          .map((row) => JSON.parse(row.summary))[0] ?? null,
    });
  }

  private async ingest(command: IngestCommand): Promise<Response> {
    if (
      !/^refs\/futures\/[^ ~^:?*\[\\\x00-\x20]+\/[^ ~^:?*\[\\\x00-\x20]+$/.test(
        command.ref,
      ) ||
      command.ref.includes("..") ||
      command.ref.includes("@{") ||
      command.ref.endsWith(".lock") ||
      !command.idempotency_key ||
      command.idempotency_key.length > 256 ||
      !command.trace_id ||
      command.trace_id.length > 128
    ) {
      throw new Failure("INVALID_INPUT", 400, "Invalid Future ingress");
    }
    identifier(command.system_id);
    const command_digest = await hashProjection("klocgit.ingest-command", {
      scope: command.scope,
      system_id: command.system_id,
      ref: command.ref,
      producer: command.producer,
      actor_id: command.principal.sub,
    });
    const prior = this.ctx.storage.sql
      .exec<{ command_digest: string; response: string }>(
        "SELECT command_digest, response FROM receipts WHERE idempotency_key = ?",
        command.idempotency_key,
      )
      .toArray()[0];
    if (prior) {
      if (prior.command_digest !== command_digest)
        throw new Failure(
          "IDEMPOTENCY_MISMATCH",
          409,
          "Event key belongs to different inputs",
        );
      await this.flush();
      return Response.json(JSON.parse(prior.response));
    }
    const store = new GitStore(this.env.GIT_EXECUTOR);
    const capturedBase = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM metadata WHERE key = ?",
        "base_oid",
      )
      .toArray()[0];
    if (!this.env.CANONICAL_REF?.startsWith("refs/heads/"))
      throw new Failure(
        "CONFIGURATION_REQUIRED",
        503,
        "Canonical ref is not configured",
      );
    const baseline =
      capturedBase?.value ??
      (await store.observe(command.scope, this.env.CANONICAL_REF)).commit_oid;
    const observed = await store.observe(command.scope, command.ref);
    const state = { repo_id: command.scope.repo_id, ...observed };
    const revision = await sealFutureRevision(state, {
      system_id: command.system_id,
      ref: command.ref,
      producer: command.producer,
      observed_at: new Date().toISOString(),
    });
    const capability_digest = command.principal.capability
      ? await hashProjection("klocgit.capability", {
          sub: command.principal.sub,
          exp: command.principal.exp,
          grants: command.principal.grants,
          capability: command.principal.capability,
        })
      : null;
    let response: {
      revision_id: string;
      state_digest: string;
      version: number;
    };
    this.ctx.storage.transactionSync(() => {
      const system = this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM metadata WHERE key = ?",
          "system_id",
        )
        .toArray()[0];
      if (system && system.value !== command.system_id)
        throw new Failure(
          "SYSTEM_SCOPE_MISMATCH",
          409,
          "Objective belongs to a different system",
        );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)",
        "system_id",
        command.system_id,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)",
        "base_oid",
        baseline,
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)",
        "scope",
        JSON.stringify(command.scope),
      );
      // The network observation can interleave with another request. Recheck
      // receipt identity within the same transaction that spends the budget.
      const existing = this.ctx.storage.sql
        .exec<{ command_digest: string; response: string }>(
          "SELECT command_digest, response FROM receipts WHERE idempotency_key = ?",
          command.idempotency_key,
        )
        .toArray()[0];
      if (existing) {
        if (existing.command_digest !== command_digest)
          throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Event key differs");
        response = JSON.parse(existing.response);
        return;
      }
      const known = this.ctx.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM futures WHERE revision_id = ?",
          revision.id,
        )
        .toArray()[0];
      if (!known && command.principal.capability) {
        const capability = command.principal.capability;
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO capabilities (id, claims_digest, remaining) VALUES (?, ?, ?)",
          capability.id,
          capability_digest!,
          capability.budget,
        );
        const budget = this.ctx.storage.sql
          .exec<{ claims_digest: string; remaining: number; revoked: number }>(
            "SELECT claims_digest, remaining, revoked FROM capabilities WHERE id = ?",
            capability.id,
          )
          .toArray()[0];
        if (
          budget.claims_digest !== capability_digest ||
          budget.revoked ||
          budget.remaining < 1
        )
          throw new Failure(
            "CAPABILITY_EXHAUSTED",
            403,
            "Agent capability is revoked or exhausted",
          );
        this.ctx.storage.sql.exec(
          "UPDATE capabilities SET remaining = remaining - 1 WHERE id = ?",
          capability.id,
        );
      }
      const version = known?.version ?? this.version() + 1;
      if (!known) {
        const record = JSON.stringify({ schema_version: 1, state, revision });
        this.ctx.storage.sql.exec(
          "INSERT INTO futures (revision_id, ref, version, schema_version, record) VALUES (?, ?, ?, 1, ?)",
          revision.id,
          command.ref,
          version,
          record,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          "version",
          String(version),
        );
        const payload = {
          schema_version: 1,
          scope: command.scope,
          state,
          revision,
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO outbox (job_id, version, payload, actor_id, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)",
          revision.id,
          version,
          JSON.stringify(payload),
          command.principal.sub,
          command.principal.exp * 1000,
          "PENDING",
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO current_refs (ref, revision_id) VALUES (?, ?) ON CONFLICT (ref) DO UPDATE SET revision_id = excluded.revision_id",
        command.ref,
        revision.id,
      );
      response = {
        revision_id: revision.id,
        state_digest: revision.state_digest,
        version,
      };
      this.ctx.storage.sql.exec(
        "INSERT INTO receipts (idempotency_key, command_digest, response) VALUES (?, ?, ?)",
        command.idempotency_key,
        command_digest,
        JSON.stringify(response),
      );
      this.audit(
        "future.observed",
        command.principal.sub,
        command.trace_id,
        revision.id,
      );
    });
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    await this.flush();
    return Response.json(response!);
  }

  private async flush(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<Job>(
        "SELECT job_id, version, payload, actor_id, expires_at, status FROM outbox WHERE status = ? ORDER BY version LIMIT 100",
        "PENDING",
      )
      .toArray();
    for (const job of pending) {
      const payload = JSON.parse(job.payload);
      const envelope = await packEvent(this.env, {
        type:
          payload.operation === "reduce"
            ? "objective.reduce"
            : "future.analyze",
        scope: payload.scope,
        subject_version: job.version,
        payload,
        idempotency_key: job.job_id,
        trace_id: job.job_id,
        actor_id: job.actor_id,
        expires_at: job.expires_at,
      });
      await this.env.ANALYSIS_QUEUE.send(envelope);
      this.ctx.storage.sql.exec(
        "UPDATE outbox SET status = ? WHERE job_id = ?",
        "SENT",
        job.job_id,
      );
    }
    if (pending.length === 100)
      await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm(): Promise<void> {
    try {
      await this.flush();
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }

  private async analysis(command: {
    revision_id?: string;
    version?: number;
    effects?: EffectSet;
  }): Promise<Response> {
    const row = this.ctx.storage.sql
      .exec<FutureRow>(
        "SELECT revision_id, ref, version, record, effects FROM futures WHERE revision_id = ?",
        command.revision_id ?? "",
      )
      .toArray()[0];
    if (
      !row ||
      row.version !== command.version ||
      !command.effects ||
      command.effects.future_revision_id !== row.revision_id
    )
      throw new Failure("INVALID_ANALYSIS", 409, "Analysis inputs differ");
    const sealed = await sealEffectSet(command.effects);
    if (sealed.effect_digest !== command.effects.effect_digest)
      throw new Failure("INVALID_ANALYSIS", 409, "Effect digest differs");
    if (
      row.effects &&
      JSON.parse(row.effects).effect_digest !== sealed.effect_digest
    )
      throw new Failure(
        "IMMUTABLE_RECORD_CHANGED",
        409,
        "Analysis record already exists",
      );
    if (!row.effects) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE futures SET effects = ? WHERE revision_id = ?",
          JSON.stringify(sealed),
          row.revision_id,
        );
        const version = this.version() + 1;
        this.ctx.storage.sql.exec(
          "UPDATE metadata SET value = ? WHERE key = ?",
          String(version),
          "version",
        );
        const incomplete = this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM current_refs c JOIN futures f ON c.revision_id = f.revision_id WHERE f.effects IS NULL LIMIT 1",
          )
          .toArray().length;
        if (!incomplete) {
          const scope = JSON.parse(
            this.ctx.storage.sql
              .exec<{ value: string }>(
                "SELECT value FROM metadata WHERE key = ?",
                "scope",
              )
              .one().value,
          );
          const payload = {
            schema_version: 1,
            operation: "reduce",
            scope,
            version,
          };
          this.ctx.storage.sql.exec(
            "INSERT INTO outbox (job_id, version, payload, actor_id, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)",
            "reduce-" + version,
            version,
            JSON.stringify(payload),
            "engine",
            Date.now() + 86400000,
            "PENDING",
          );
        }
      });
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      await this.flush();
    }
    return Response.json({
      schema_version: 1,
      effect_digest: sealed.effect_digest,
    });
  }

  private reductionPage(command: {
    version?: number;
    cursor?: string;
  }): Response {
    if (command.version !== this.version())
      throw new Failure("OUTDATED_VERSION", 409, "Objective inputs changed");
    const rows = this.ctx.storage.sql
      .exec<FutureRow>(
        "SELECT f.revision_id, f.ref, f.version, f.record, f.effects FROM current_refs c JOIN futures f ON c.revision_id = f.revision_id WHERE f.revision_id > ? ORDER BY f.revision_id LIMIT 64",
        command.cursor ?? "",
      )
      .toArray();
    if (rows.some((row) => !row.effects))
      throw new Failure(
        "ANALYSIS_PENDING",
        409,
        "Required structural analysis is pending",
      );
    const base_oid = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM metadata WHERE key = ?",
        "base_oid",
      )
      .one().value;
    return Response.json({
      schema_version: 1,
      version: command.version,
      base_oid,
      records: rows.map((row) => ({
        ...JSON.parse(row.record),
        effects: JSON.parse(row.effects!),
      })),
      next_cursor:
        rows.length === 64 ? rows[rows.length - 1].revision_id : null,
    });
  }

  private reduction(command: {
    version?: number;
    payload_ref?: string;
    payload_digest?: string;
    summary?: unknown;
  }): Response {
    if (command.version !== this.version())
      return Response.json({ ignored: true, reason: "OUTDATED_VERSION" });
    if (
      !command.payload_ref ||
      !/^sha256:[0-9a-f]{64}$/.test(command.payload_digest ?? "") ||
      new TextEncoder().encode(JSON.stringify(command.summary)).length >
        16 * 1024
    )
      throw new Failure(
        "INVALID_REDUCTION",
        400,
        "Reduction summary exceeds bounds",
      );
    const prior = this.ctx.storage.sql
      .exec<{ payload_digest: string }>(
        "SELECT payload_digest FROM reductions WHERE version = ?",
        command.version,
      )
      .toArray()[0];
    if (prior && prior.payload_digest !== command.payload_digest)
      throw new Failure(
        "IMMUTABLE_RECORD_CHANGED",
        409,
        "Reduction version already exists",
      );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO reductions (version, schema_version, payload_ref, payload_digest, summary) VALUES (?, 1, ?, ?, ?)",
      command.version,
      command.payload_ref,
      command.payload_digest!,
      JSON.stringify(command.summary),
    );
    return Response.json({ schema_version: 1, accepted: true });
  }
}
