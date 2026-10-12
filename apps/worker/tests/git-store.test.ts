import assert from "node:assert/strict";
import test from "node:test";
import { GitStore } from "../src/git-store.ts";
import { Failure } from "../src/runtime.ts";
import type { Bindings } from "../src/runtime.ts";

const scope = {
  tenant_id: "tenant",
  organization_id: "organization",
  repo_id: "repo",
  objective_id: "objective",
};
const command = {
  scope,
  ref: "refs/heads/main",
  expected_oid: "1".repeat(40),
  target_oid: "2".repeat(40),
  idempotency_key: "operation",
};

test("only an authoritative stale response permits a no-effect conclusion", async () => {
  for (const code of [
    "EXECUTION_ERROR",
    "INPUT_MISMATCH",
    "GIT_OUTCOME_UNKNOWN",
  ]) {
    const transport = {
      fetch: async () => Response.json({ error: { code } }, { status: 409 }),
    } as unknown as Bindings["GIT_EXECUTOR"];
    const store = new GitStore(transport, "test-signing-key".repeat(3));
    await assert.rejects(
      store.compareAndSwap(command),
      (error) =>
        error instanceof Failure && error.code === "GIT_OUTCOME_UNKNOWN",
    );
  }
  const transport = {
    fetch: async () =>
      Response.json({ error: { code: "STALE_BASIS" } }, { status: 409 }),
  } as unknown as Bindings["GIT_EXECUTOR"];
  await assert.rejects(
    new GitStore(transport, "test-signing-key".repeat(3)).compareAndSwap(
      command,
    ),
    (error) => error instanceof Failure && error.code === "STALE_BASIS",
  );
});

test("coordination metadata cannot change the receive-pack operation identity", async () => {
  const { hashProjection } = await import("../../../packages/contracts/src/index.ts");
  const expected = await hashProjection("klocgit.git-cas", command);
  const transport = { fetch: async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.operation_digest, expected);
    assert.equal(body.decision_id, undefined);
    return Response.json({ status: "APPLIED", expected_oid: command.expected_oid, target_oid: command.target_oid, operation_digest: expected });
  } } as unknown as Bindings["GIT_EXECUTOR"];
  const full = { ...command, schema_version: 1, decision_id: "decision", actor_id: "owner", basis_digest: "sha256:" + "3".repeat(64) };
  assert.equal((await new GitStore(transport, "test-signing-key".repeat(3)).compareAndSwap(full)).status, "APPLIED");
});
