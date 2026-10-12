import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { EvidenceStore } from "../src/evidence-store.ts";
import { hashProjection, payloadDigest, sealEvidence } from "../../../packages/contracts/src/index.ts";

test("concurrent evidence reuse cannot downgrade canonical retention or change identity", async (t) => {
  const mf = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: 'export default { fetch() { return new Response("ok"); } };', r2Buckets: ["EVIDENCE"] });
  t.after(() => mf.dispose());
  const bucket = await mf.getR2Bucket("EVIDENCE");
  const store = new EvidenceStore(bucket as unknown as R2Bucket);
  const payload = new TextEncoder().encode(JSON.stringify({ exit_code: 0, stdout: "passing trusted check" }));
  const state = await hashProjection("klocgit.test-state", { tree: "verified" });
  const evidence = await sealEvidence({
    subject_digest: state, evaluator_id: "trusted-fixture", evaluator_version: "1",
    config_digest: await hashProjection("klocgit.test-config", { check: "contract" }),
    environment_digest: await hashProjection("klocgit.test-environment", { isolation: "fixture" }),
    result: "PASSED", payload_digest: await payloadDigest(payload),
    payload_ref: "", retention_class: "EPHEMERAL", created_at: "",
  });
  const original = await store.persist("tenant", evidence, payload);
  const results = await Promise.all([
    store.persist("tenant", { ...evidence, retention_class: "CANONICAL" }, payload),
    store.persist("tenant", { ...evidence, retention_class: "REBUILDABLE" }, payload),
    store.persist("tenant", { ...evidence, retention_class: "DECISION_RECORD" }, payload),
  ]);
  for (const record of results) assert.equal(record.evidence_digest, original.evidence_digest);
  const current = await store.load("tenant", original.evidence_digest);
  assert.equal(current.evidence.retention_class, "CANONICAL");
  assert.equal(await store.payloadRetention("tenant", current.evidence.payload_digest), "CANONICAL");
  await store.persist("tenant", evidence, payload);
  assert.equal((await store.load("tenant", original.evidence_digest)).evidence.retention_class, "CANONICAL");
  await assert.rejects(() => store.load("another-tenant", original.evidence_digest), /unavailable/);
  await bucket.put(current.evidence.payload_ref, new Uint8Array([0, 1]));
  await assert.rejects(() => store.load("tenant", original.evidence_digest), /substituted/);
  await assert.rejects(() => store.persist("tenant", evidence, payload), /bytes differ/);
});
