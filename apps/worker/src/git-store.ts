import { hashProjection } from "../../../packages/contracts/src/index.ts";
import { Failure, readJson } from "./runtime.ts";
import type { Bindings, Scope } from "./runtime.ts";

export interface GitObservation {
  commit_oid: string;
  tree_oid: string;
  parent_oids: string[];
}

function oid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    throw new Failure("INVALID_GIT_OBSERVATION", 502, "Invalid Git OID");
  return value;
}

export class GitStore {
  constructor(private binding: Bindings["GIT_EXECUTOR"]) {}

  private async call<T>(path: string, command: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.binding.fetch("https://git.internal" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Failure(
        "GIT_OUTCOME_UNKNOWN",
        503,
        "Git executor outcome is unknown",
      );
    }
    if (response.status === 409)
      throw new Failure("STALE_BASIS", 409, "Canonical Git head changed");
    if (!response.ok)
      throw new Failure(
        "GIT_EXECUTOR_UNAVAILABLE",
        503,
        "Git executor is unavailable",
      );
    return readJson<T>(
      new Request("https://response.internal", {
        method: "POST",
        body: response.body,
      }),
      32 * 1024,
    );
  }

  async observe(scope: Scope, ref: string): Promise<GitObservation> {
    const value = await this.call<GitObservation>("/observe", {
      schema_version: 1,
      scope,
      ref,
    });
    oid(value.commit_oid);
    oid(value.tree_oid);
    if (!Array.isArray(value.parent_oids) || value.parent_oids.length > 128)
      throw new Failure(
        "INVALID_GIT_OBSERVATION",
        502,
        "Invalid Git parent list",
      );
    for (const parent of value.parent_oids) oid(parent);
    return value;
  }

  async compareAndSwap(command: {
    scope: Scope;
    ref: string;
    expected_oid: string;
    target_oid: string;
    idempotency_key: string;
  }): Promise<{ status: "APPLIED"; expected_oid: string; target_oid: string }> {
    const operation_digest = await hashProjection("klocgit.git-cas", command);
    const value = await this.call<{
      status: string;
      expected_oid: string;
      target_oid: string;
      operation_digest: string;
    }>("/cas", { schema_version: 1, ...command, operation_digest });
    if (
      value.operation_digest !== operation_digest ||
      value.status !== "APPLIED" ||
      value.expected_oid !== command.expected_oid ||
      value.target_oid !== command.target_oid
    )
      throw new Failure(
        "GIT_OUTCOME_UNKNOWN",
        503,
        "Git receipt does not match authorized inputs",
      );
    return { ...value, status: "APPLIED" };
  }

  async operation(command: {
    scope: Scope;
    ref: string;
    expected_oid: string;
    target_oid: string;
    idempotency_key: string;
  }): Promise<{
    status: "APPLIED" | "NO_EFFECT" | "IN_PROGRESS" | "UNKNOWN";
    expected_oid?: string;
    target_oid?: string;
  }> {
    const operation_digest = await hashProjection("klocgit.git-cas", command);
    const receipt = await this.call<{
      status: "APPLIED" | "NO_EFFECT" | "IN_PROGRESS" | "UNKNOWN";
      expected_oid?: string;
      target_oid?: string;
      operation_digest?: string;
    }>("/operation", { schema_version: 1, ...command, operation_digest });
    if (
      receipt.status !== "UNKNOWN" &&
      receipt.operation_digest !== operation_digest
    )
      throw new Failure(
        "GIT_OUTCOME_UNKNOWN",
        503,
        "Git receipt belongs to different inputs",
      );
    return receipt;
  }
}
