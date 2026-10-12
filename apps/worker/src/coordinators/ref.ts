import { DurableObject } from "cloudflare:workers";
import { hashProjection } from "../../../../packages/contracts/src/index.ts";
import { verifyInternal, sameScope } from "../auth.ts";
import { GitStore } from "../git-store.ts";
import type { PromotionPack } from "../git-store.ts";
import {
  Failure,
  failureResponse,
  readJson,
  validateScope,
} from "../runtime.ts";
import type { Bindings, Scope } from "../runtime.ts";

export interface PromotionCommand {
  schema_version: 1;
  scope: Scope;
  ref: string;
  decision_id: string;
  basis_digest: string;
  expected_oid: string;
  target_oid: string;
  actor_id: string;
  idempotency_key: string;
  promotion_pack?: PromotionPack;
}

export function refName(scope: Scope, ref: string): Promise<string> {
  return hashProjection("klocgit.ref-scope", {
    tenant_id: scope.tenant_id,
    organization_id: scope.organization_id,
    repo_id: scope.repo_id,
    ref,
  });
}

type OperationRow = {
  command_digest: string;
  command: string;
  status: string;
  result: string | null;
};

export class RefCoordinator extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS authorizations (decision_id TEXT PRIMARY KEY, command_digest TEXT NOT NULL, command TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS operations (idempotency_key TEXT PRIMARY KEY, command_digest TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, active_slot TEXT UNIQUE, result TEXT)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, action TEXT NOT NULL, object_id TEXT NOT NULL, actor_id TEXT NOT NULL, details TEXT NOT NULL)",
    );
  }

  private row(key: string): OperationRow | undefined {
    return this.ctx.storage.sql
      .exec<OperationRow>(
        "SELECT command_digest, command, status, result FROM operations WHERE idempotency_key = ?",
        key,
      )
      .toArray()[0];
  }

  private audit(
    command: PromotionCommand,
    action: string,
    details: unknown,
  ): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO audit (schema_version, action, object_id, actor_id, details) VALUES (1, ?, ?, ?, ?)",
      action,
      command.idempotency_key,
      command.actor_id,
      JSON.stringify(details),
    );
  }

  private active(): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT idempotency_key FROM operations WHERE active_slot IS NOT NULL",
        )
        .toArray().length > 0
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST")
        throw new Failure("METHOD_NOT_ALLOWED", 405, "POST is required");
      const command = await readJson<PromotionCommand>(request);
      validateScope(command.scope);
      if (
        command.schema_version !== 1 ||
        !/^refs\/heads\/[^ ~^:?*\[\\\x00-\x20]+$/.test(command.ref) ||
        command.ref.includes("..") ||
        command.ref.includes("@{") ||
        command.ref.endsWith(".lock") ||
        !/^[0-9a-f]{40}$/.test(command.expected_oid) ||
        !/^[0-9a-f]{40}$/.test(command.target_oid) ||
        !/^sha256:[0-9a-f]{64}$/.test(command.basis_digest) ||
        !command.decision_id ||
        command.decision_id.length > 256 ||
        !command.idempotency_key ||
        command.idempotency_key.length > 256 ||
        !command.actor_id
      ) {
        throw new Failure("INVALID_INPUT", 400, "Invalid promotion command");
      }
      const path = new URL(request.url).pathname;
      if (!["/authorize", "/promote", "/reconcile"].includes(path))
        throw new Failure("NOT_FOUND", 404, "Unknown operation");
      const command_digest = await hashProjection(
        "klocgit.promotion-command",
        command,
      );
      const grant = await verifyInternal(
        request,
        this.env,
        "ref",
        path.slice(1),
        command_digest,
      );
      if (
        !sameScope(grant.scope, command.scope) ||
        grant.actor_id !== command.actor_id ||
        this.ctx.id.toString() !==
          this.env.REFS.idFromName(
            await refName(command.scope, command.ref),
          ).toString()
      ) {
        throw new Failure("FORBIDDEN", 403, "Ref scope differs");
      }
      if (path === "/authorize") {
        if (this.active())
          throw new Failure(
            "REF_BUSY",
            409,
            "A canonical operation needs reconciliation",
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO authorizations (decision_id, command_digest, command) VALUES (?, ?, ?) ON CONFLICT (decision_id) DO UPDATE SET command_digest = excluded.command_digest, command = excluded.command",
          command.decision_id,
          command_digest,
          JSON.stringify(command),
        );
        this.audit(command, "promotion.authorized", { command_digest });
        return Response.json({ command_digest });
      }
      if (path === "/reconcile")
        return await this.reconcile(command, command_digest);
      return await this.promote(command, command_digest);
    } catch (error) {
      return failureResponse(error);
    }
  }

  private async promote(
    command: PromotionCommand,
    commandDigest: string,
  ): Promise<Response> {
    const prior = this.row(command.idempotency_key);
    if (prior) {
      if (prior.command_digest !== commandDigest)
        throw new Failure(
          "IDEMPOTENCY_MISMATCH",
          409,
          "Operation key is bound to different inputs",
        );
      if (prior.status === "APPLIED")
        return Response.json(JSON.parse(prior.result!));
      if (prior.status === "PREPARED" || prior.status === "UNKNOWN")
        return this.reconcile(command, commandDigest);
      throw new Failure(
        "STALE_BASIS",
        409,
        "Previous operation had no effect; review current state",
      );
    }
    const authorization = this.ctx.storage.sql
      .exec<{ command_digest: string }>(
        "SELECT command_digest FROM authorizations WHERE decision_id = ?",
        command.decision_id,
      )
      .toArray()[0];
    if (authorization?.command_digest !== commandDigest)
      throw new Failure("STALE_BASIS", 409, "Reviewed decision basis changed");
    if (this.active())
      throw new Failure(
        "REF_BUSY",
        409,
        "Another canonical operation is active",
      );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO operations (idempotency_key, command_digest, command, status, active_slot) VALUES (?, ?, ?, ?, ?)",
        command.idempotency_key,
        commandDigest,
        JSON.stringify(command),
        "PREPARED",
        "canonical",
      );
      this.audit(command, "promotion.prepared", {
        command_digest: commandDigest,
      });
    });
    try {
      const receipt = await new GitStore(
        this.env.GIT_EXECUTOR,
        this.env.INTERNAL_SIGNING_KEY,
      ).compareAndSwap(command);
      const result = {
        schema_version: 1,
        ...receipt,
        decision_id: command.decision_id,
        basis_digest: command.basis_digest,
      };
      this.complete(command, "APPLIED", result);
      return Response.json(result);
    } catch (error) {
      if (error instanceof Failure && error.code === "STALE_BASIS") {
        this.complete(command, "NO_EFFECT", { code: "STALE_BASIS" });
        throw error;
      }
      // A transport failure cannot establish that a remote push did not occur.
      this.ctx.storage.sql.exec(
        "UPDATE operations SET status = ? WHERE idempotency_key = ?",
        "UNKNOWN",
        command.idempotency_key,
      );
      this.audit(command, "promotion.unknown", {});
      throw new Failure(
        "GIT_OUTCOME_UNKNOWN",
        503,
        "Canonical outcome requires reconciliation",
      );
    }
  }

  private complete(
    command: PromotionCommand,
    status: string,
    result: unknown,
  ): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE operations SET status = ?, active_slot = NULL, result = ? WHERE idempotency_key = ?",
        status,
        JSON.stringify(result),
        command.idempotency_key,
      );
      this.audit(command, "promotion." + status.toLowerCase(), result);
    });
  }

  private async reconcile(
    command: PromotionCommand,
    commandDigest: string,
  ): Promise<Response> {
    const prior = this.row(command.idempotency_key);
    if (!prior || prior.command_digest !== commandDigest)
      throw new Failure("IDEMPOTENCY_MISMATCH", 409, "Recovery inputs differ");
    if (prior.status === "APPLIED")
      return Response.json(JSON.parse(prior.result!));
    const receipt = await new GitStore(
      this.env.GIT_EXECUTOR,
      this.env.INTERNAL_SIGNING_KEY,
    ).operation(command);
    if (
      receipt.status === "APPLIED" &&
      receipt.expected_oid === command.expected_oid &&
      receipt.target_oid === command.target_oid
    ) {
      const result = {
        schema_version: 1,
        status: "APPLIED",
        expected_oid: command.expected_oid,
        target_oid: command.target_oid,
        decision_id: command.decision_id,
        basis_digest: command.basis_digest,
      };
      this.complete(command, "APPLIED", result);
      return Response.json(result);
    }
    if (receipt.status === "NO_EFFECT") {
      this.complete(command, "NO_EFFECT", { code: "NO_GIT_EFFECT" });
      throw new Failure(
        "NO_GIT_EFFECT",
        409,
        "Git executor confirms no effect; review current state before retrying",
      );
    }
    throw new Failure(
      "GIT_OUTCOME_UNKNOWN",
      503,
      "Canonical outcome remains unknown",
    );
  }
}
