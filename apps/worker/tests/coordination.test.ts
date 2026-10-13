import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { signToken } from "../src/auth.ts";
import type { Principal } from "../src/auth.ts";
import { packEvent, unpackEvent, INLINE_LIMIT } from "../src/events.ts";
import type { Bindings } from "../src/runtime.ts";
import { fixture, endpoint, scope, until } from "./helpers/convergence.ts";

test("five concurrent Git pushes are ingested, analyzed and clustered without scripted groups", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(
    f.actorRefs.map((ref, index) =>
      f.request(endpoint + "/futures", "POST", {
        system_id: "product",
        ref,
        producer: { actor_id: "producer-" + index },
      }),
    ),
  );
  for (const response of responses)
    assert.equal(response.status, 200, await response.text());
  await until(
    async () =>
      (await f.status()).futures.filter((future: any) => future.effects)
        .length === 5,
  );
  await until(
    async () =>
      (await f.status()).reduction?.candidate_spec_digests.length === 2,
  );
  const observed = await f.status();
  assert.equal(observed.reduction.status, "COMPLETE");
  assert.equal(observed.reduction.group_count, 3);
  await f.restart();
  assert.equal((await f.status()).futures.length, 5);
});

test("authentication, tenant isolation, capability expiry and durable budgets deny invalid work", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.mf.dispatchFetch(endpoint)).status, 401);
  assert.equal(
    (await f.request(endpoint.replace("/tenant/", "/foreign/"))).status,
    403,
  );
  const forged = await signToken(f.principal, randomBytes(32).toString("hex"));
  assert.equal(
    (
      await f.mf.dispatchFetch(endpoint, {
        headers: { authorization: "Bearer " + forged },
      })
    ).status,
    401,
  );
  const agent: Principal = {
    ...f.principal,
    sub: "agent",
    actor_type: "agent",
    grants: [{ scope, actions: ["read", "ingest"] }],
    capability: { id: randomUUID(), scope, budget: 1 },
  };
  const id = randomUUID();
  const first = {
    system_id: "product",
    ref: f.actorRefs[0],
    producer: { actor_id: "agent" },
  };
  assert.equal(
    (await f.request(endpoint + "/futures", "POST", first, agent, id)).status,
    200,
  );
  assert.equal(
    (await f.request(endpoint + "/futures", "POST", first, agent, id)).status,
    200,
  );
  await f.restart();
  assert.equal(
    (
      await f.request(
        endpoint + "/futures",
        "POST",
        { ...first, ref: f.actorRefs[1] },
        agent,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(endpoint, "GET", undefined, {
        ...agent,
        exp: Math.floor(Date.now() / 1000) - 1,
      })
    ).status,
    401,
  );
});

test("R2 claim checks enforce inline bounds, exact byte digests and authorization", async (t) => {
  const f = await fixture(t);
  const bindings = (await f.mf.getBindings()) as unknown as Bindings;
  const payload = { text: "x".repeat(INLINE_LIMIT) };
  const envelope = await packEvent(bindings, {
    type: "fixture",
    scope,
    subject_version: 1,
    payload,
    idempotency_key: randomUUID(),
    trace_id: randomUUID(),
    actor_id: "reviewer",
    expires_at: Date.now() + 60_000,
  });
  assert.ok(envelope.payload_ref);
  assert.equal(envelope.payload, undefined);
  assert.deepEqual(await unpackEvent(bindings, envelope), payload);
  await bindings.PAYLOADS.put(envelope.payload_ref!, "substituted");
  await assert.rejects(
    unpackEvent(bindings, envelope),
    /digest verification failed/,
  );
  await assert.rejects(
    unpackEvent(bindings, {
      ...envelope,
      scope: { ...scope, tenant_id: "foreign" },
    }),
  );
});

test("concurrent authorized promotions use real receive-pack CAS and preserve the winning ref", async (t) => {
  const f = await fixture(t);
  const a = f.promotion("decision-a", f.commits[0]);
  const b = f.promotion("decision-b", f.commits[2]);
  assert.equal((await f.refCall(a, "authorize")).status, 200);
  assert.equal((await f.refCall(b, "authorize")).status, 200);
  const results = await Promise.all([
    f.refCall(a, "promote"),
    f.refCall(b, "promote"),
  ]);
  assert.deepEqual(
    results.map((response) => response.status).sort(),
    [200, 409],
  );
  const actual = f.git([
    "--git-dir",
    join(f.directory, "remote.git"),
    "rev-parse",
    "refs/heads/main",
  ]);
  assert.ok([a.target_oid, b.target_oid].includes(actual));
  await f.restart();
  const winner = actual === a.target_oid ? a : b;
  assert.equal((await f.refCall(winner, "promote")).status, 200);
  assert.equal(
    f.git([
      "--git-dir",
      join(f.directory, "remote.git"),
      "rev-parse",
      "refs/heads/main",
    ]),
    actual,
  );
});

test("changed basis and external Git pushes reject stale authorization", async (t) => {
  const f = await fixture(t);
  const old = f.promotion("decision", f.commits[0]);
  assert.equal((await f.refCall(old, "authorize")).status, 200);
  const changed = {
    ...old,
    basis_digest: "sha256:" + "b".repeat(64),
    target_oid: f.commits[2],
  };
  assert.equal((await f.refCall(changed, "authorize")).status, 200);
  assert.equal((await f.refCall(old, "promote")).status, 409);
  f.git([
    "-C",
    join(f.directory, "driver"),
    "push",
    "--force-with-lease=refs/heads/main:" + f.base,
    "origin",
    f.commits[4] + ":refs/heads/main",
  ]);
  assert.equal((await f.refCall(changed, "promote")).status, 409);
  assert.equal(
    f.git([
      "--git-dir",
      join(f.directory, "remote.git"),
      "rev-parse",
      "refs/heads/main",
    ]),
    f.commits[4],
  );
});

test("lost Git receipt remains UNKNOWN and recovers after coordinator restart", async (t) => {
  const f = await fixture(t);
  const command = f.promotion("decision", f.commits[0]);
  assert.equal((await f.refCall(command, "authorize")).status, 200);
  f.obscureReceipt();
  assert.equal((await f.refCall(command, "promote")).status, 503);
  assert.equal(
    f.git([
      "--git-dir",
      join(f.directory, "remote.git"),
      "rev-parse",
      "refs/heads/main",
    ]),
    command.target_oid,
  );
  assert.equal(
    (await f.refCall(f.promotion("other", f.commits[2]), "authorize")).status,
    409,
  );
  await f.restart();
  assert.equal((await f.refCall(command, "reconcile")).status, 200);
  assert.equal((await f.refCall(command, "promote")).status, 200);
});

test("restoring an observed Future head advances coordination without changing revision history", async (t) => {
  const f = await fixture(t);
  const ref = f.actorRefs[0];
  const ingest = () => f.request(endpoint + "/futures", "POST", {
    system_id: "product", ref, producer: { actor_id: "producer" },
  });
  const first = await ingest();
  assert.equal(first.status, 200, await first.clone().text());
  const original = await first.json() as { revision_id: string };
  await until(async () => !!(await f.status()).futures.find((row: any) => row.revision.id === original.revision_id)?.effects);
  const updated = f.commit("retry.ts", "export function RetryLimit() { return 9; }\n");
  f.git(["-C", join(f.directory, "driver"), "push",
    "--force-with-lease=" + ref + ":" + f.commits[0], "origin", updated + ":" + ref]);
  assert.equal((await ingest()).status, 200);
  await until(async () => (await f.status()).futures.every((row: any) => !!row.effects));
  const before = await f.status();
  f.git(["-C", join(f.directory, "driver"), "push",
    "--force-with-lease=" + ref + ":" + updated, "origin", f.commits[0] + ":" + ref]);
  const restored = await ingest();
  assert.equal(restored.status, 200, await restored.clone().text());
  const observation = await restored.json() as { revision_id: string; version: number };
  assert.equal(observation.revision_id, original.revision_id);
  assert(observation.version > before.version);
  const after = await f.status();
  assert.equal(after.futures.length, before.futures.length);
  await until(async () => (await f.status()).version === observation.version && !!(await f.status()).reduction);
  await f.restart();
  assert.equal((await f.status()).version, observation.version);
});
