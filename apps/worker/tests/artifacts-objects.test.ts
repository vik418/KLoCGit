import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { ArtifactsObjectStore } from "../src/adapters/artifacts-objects.ts";
import { readObject } from "../src/routes/objects.ts";
import { signToken } from "../src/auth.ts";
import type { Bindings } from "../src/runtime.ts";

const scope = {
  tenant_id: "tenant",
  organization_id: "organization",
  repo_id: "repo",
  objective_id: "task",
};
const gitOid = (kind: string, bytes: Uint8Array) =>
  createHash("sha1")
    .update(kind + " " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");

test("Artifacts object reads are immutable, bounded and tenant scoped", async () => {
  const blob = Buffer.from("export const value = 1;\n");
  const blobOid = gitOid("blob", blob);
  const rawTree = Buffer.concat([
    Buffer.from("100644 api.ts\0"),
    Buffer.from(blobOid, "hex"),
  ]);
  const treeOid = gitOid("tree", rawTree);
  let readBlob = 0;
  let disposed = 0;
  const repo = {
    readTree: async () => [
      { name: "api.ts", mode: "100644", hash: blobOid, type: "blob" },
    ],
    readBlob: async () => {
      readBlob++;
      return new Blob([blob]);
    },
    [Symbol.dispose]: () => {
      disposed++;
    },
  };
  const namespace = {
    get: async (name: string) => {
      assert.equal(name, "isolated-repository");
      return repo;
    },
  } as unknown as Artifacts;
  const configuration = JSON.stringify([
    { ...scope, artifacts_name: "isolated-repository" },
  ]);
  const store = new ArtifactsObjectStore(namespace, configuration);
  const request = {
    schema_version: 1 as const,
    scope,
    kind: "tree" as const,
    oid: treeOid,
    max_bytes: 1024,
  };
  const result = await store.read(request);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), rawTree);
  assert.equal(readBlob, 0);
  assert.equal(disposed, 1);
  await assert.rejects(
    () => store.read({ ...request, max_bytes: 1 }),
    /budget/,
  );
  await assert.rejects(
    () => store.read({ ...request, oid: blobOid }),
    /content differs/,
  );
  await assert.rejects(
    () => store.read({ ...request, scope: { ...scope, tenant_id: "other" } }),
    /scope/,
  );
  const file = await store.read({ ...request, kind: "blob", oid: blobOid });
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), blob);
  await assert.rejects(
    () => store.read({ ...request, kind: "blob", oid: blobOid, max_bytes: 1 }),
    /budget/,
  );
});

test("object capabilities cannot authorize ref mutation or another repository", async () => {
  const secret = randomBytes(32).toString("hex");
  const grant = {
    schema_version: 1,
    aud: "git-objects",
    scope,
    action: "read",
    expires_at: Date.now() + 60000,
    max_object_bytes: 1024,
  };
  const env = { INTERNAL_SIGNING_KEY: secret } as Bindings;
  const request = async (claims: unknown, target = scope) =>
    new Request("https://klocgit.test/internal/git-objects", {
      method: "POST",
      headers: {
        "x-klocgit-object-capability": await signToken(claims, secret),
      },
      body: JSON.stringify({
        schema_version: 1,
        scope: target,
        kind: "blob",
        oid: "a".repeat(40),
        max_bytes: 100,
      }),
    });
  await assert.rejects(
    async () => readObject(await request({ ...grant, action: "promote" }), env),
    /invalid or expired/,
  );
  await assert.rejects(
    async () =>
      readObject(await request({ ...grant, expires_at: Date.now() - 1 }), env),
    /invalid or expired/,
  );
  await assert.rejects(
    async () =>
      readObject(await request(grant, { ...scope, repo_id: "other" }), env),
    /scope/,
  );
  await assert.rejects(
    async () => readObject(await request(grant), env),
    /mappings/,
  );
});
