import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Response as WorkerResponse } from "miniflare";
import { hashProjection, payloadDigest } from "../../../packages/contracts/src/index.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import { fixture, endpoint, scope, until } from "./helpers/convergence.ts";
import type { Principal } from "../src/auth.ts";
import type { CandidateSpec } from "../../../packages/contracts/src/index.ts";
import type { DecisionPacket } from "../src/coordinators/decisions.ts";

const root = resolve(import.meta.dirname, "../../..");
const image = process.env.KLOCGIT_SANDBOX_IMAGE;
assert.match(image ?? "", /^sha256:[0-9a-f]{64}$/);

async function execute(command: string, args: string[], input?: string | Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: root, timeout: 180000, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    if (input !== undefined) child.stdin!.end(input);
  });
}

async function engine(input: unknown): Promise<any> {
  return JSON.parse(await execute(join(root, "target/debug/klocgit-engine"), [], JSON.stringify(input)));
}

export async function decisionFixture(
  t: { after: (fn: () => unknown) => void },
  options: { partial?: boolean; beforePrepare?: (f: Awaited<ReturnType<typeof fixture>>) => void } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "klocgit-trusted-checks-"));
  const checks = join(directory, "checks");
  cpSync(join(root, "tests/fixtures/sandbox/typescript-checks"), checks, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await execute("git", ["init", checks]);
  await execute("git", ["-C", checks, "add", "."]);
  const tree = await execute("git", ["-C", checks, "write-tree"]);
  rmSync(join(checks, ".git"), { recursive: true, force: true });
  const version = (await execute("docker", [
    "--host=unix:///var/run/docker.sock", "run", "--rm", "--network=none",
    "--env=HTTP_PROXY=", "--env=HTTPS_PROXY=", image!, "node", "--version",
  ])).replace(/^v/, "");
  const toolchain = { language: "typescript", version, image_oid: image };
  const evaluationPolicy = {
    schema_version: 1, evaluator_id: "trusted-sandbox", evaluator_version: "1",
    image_oid: image, language: "typescript",
    supported_toolchains: { schema_version: 1, entries: [toolchain] },
    trusted_suite_state_digest: await hashProjection("klocgit.trusted-suite", { tree_oid: tree }),
    checks: [
      { id: "vitest", command: [
        "node", "/opt/node-tools/node_modules/vitest/vitest.mjs", "run", "--globals",
        "--root", "/checks", "--config", "/checks/vitest.config.cjs",
      ] },
      { id: "tsc", command: [
        "node", "/opt/node-tools/node_modules/typescript/bin/tsc", "--noEmit", "--project", "/workspace/tsconfig.json",
      ] },
    ],
    timeout_ms: 60000, memory_bytes: 536870912, pids_limit: 256, max_log_bytes: 65536,
  };
  const config_digest = await hashProjection("klocgit.evaluator.config", evaluationPolicy);
  const environment_digest = await hashProjection("klocgit.evaluator.environment", {
    image_oid: image, network: "NONE", uid: 10001,
    source_read_only: true, suite_read_only: true, memory_bytes: evaluationPolicy.memory_bytes,
    pids_limit: evaluationPolicy.pids_limit, toolchain,
    scratch_mount: { writable: true, executable: true, bytes: 268435456 },
  });
  const reviewPolicy = {
    schema_version: 1, required_capability: options.partial ? "SEMANTIC" : "STRUCTURAL",
    minimum_reviewers: 1, reviewer_actor_ids: ["reviewer"],
    evidence_requirements: [{
      evaluator_id: evaluationPolicy.evaluator_id, evaluator_version: evaluationPolicy.evaluator_version,
      config_digest, environment_digests: [environment_digest],
    }],
  };
  let f: Awaited<ReturnType<typeof fixture>>;
  let evaluations = 0;
  let prepared = 0;
  f = await fixture(t, {
    sourceDirectory: join(root, "tests/fixtures/sandbox/typescript"),
    bindings: { REVIEW_POLICY: JSON.stringify(reviewPolicy) },
    engine: async (action, input, context) => {
      if (!["evaluate", "prepare"].includes(action)) return undefined;
      const sources = input.sources.map((source: object) => ({ ...source, repository_path: context.driver }));
      const args = {
        base_repository: context.driver, repo_id: scope.repo_id,
        candidate_spec: input.candidate_spec, sources,
      };
      const bucket = await context.bucket();
      if (action === "evaluate") {
        evaluations++;
        const result = await engine({
          operation: "evaluate_candidate", ...args,
          trusted_suite: checks, policy: evaluationPolicy,
        });
        assert.equal(result.evidence.config_digest, config_digest);
        assert.equal(result.evidence.environment_digest, environment_digest);
        const evidence = await new EvidenceStore(bucket).persist(
          scope.tenant_id, result.evidence, Uint8Array.from(result.payload),
        );
        return WorkerResponse.json({ schema_version: 1, candidate: result.candidate, evidence });
      }
      prepared++;
      options.beforePrepare?.(f);
      const result = await engine({
        operation: "prepare_candidate", ...args, expected_oid: input.expected_oid,
        decision_id: input.decision_id, basis_digest: input.basis_digest, author: input.author,
        max_pack_bytes: 8 * 1024 * 1024,
      });
      const bytes = new Uint8Array(Buffer.from(result.pack_hex, "hex"));
      assert.equal(await payloadDigest(bytes), result.payload_digest);
      const ref = "promotion-packs/" + await hashProjection("klocgit.promotion-pack.scope", scope) + "/" + result.payload_digest.slice(7);
      await bucket.put(ref, bytes);
      const { pack_hex, ...receipt } = result;
      return WorkerResponse.json(receipt);
    },
  });
  for (const ref of f.actorRefs) {
    const response = await f.request(endpoint + "/futures", "POST", {
      system_id: "product", ref, producer: { actor_id: ref.split("/")[2] },
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  async function decisions(): Promise<DecisionPacket[]> {
    const response = await f.request(endpoint + "/decisions");
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { decisions: DecisionPacket[] };
    return result.decisions;
  }
  await until(async () => (await decisions()).length > 0, 180000);
  async function act(
    action: "review" | "promote", packet: DecisionPacket,
    selected = packet.candidates[0], claims = f.principal, key = randomUUID(),
  ) {
    return f.request(endpoint + "/decisions/" + packet.decision.id + "/" + action, "POST", {
      basis_digest: packet.decision.basis.basis_digest,
      candidate_digest: selected.candidate.candidate_digest,
      author: { name: "Fixture", email: "fixture@example.org" },
    }, claims, key);
  }
  return {
    ...f, decisions, act, reviewPolicy, evaluationPolicy,
    get evaluations() { return evaluations; },
    get prepared() { return prepared; },
    get mf() { return f.mf; },
    restart: () => f.restart(),
  };
}

test("real concurrent Git work becomes one persisted review choice and one CAS promotion", async (t) => {
  const f = await decisionFixture(t);
  const [packet] = await f.decisions();
  assert.equal(packet.decision.state, "REVIEWABLE");
  assert(packet.candidates.length > 1);
  for (const candidate of packet.candidates) {
    assert(packet.evidence.some((evidence) =>
      evidence.subject_digest === candidate.candidate.candidate_digest && evidence.result === "PASSED"));
  }
  await f.restart();
  const [recovered] = await f.decisions();
  assert.equal(recovered.decision.basis.basis_digest, packet.decision.basis.basis_digest);
  const reviewKey = randomUUID();
  const first = await f.act("review", recovered, recovered.candidates[0], f.principal, reviewKey);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json() as DecisionPacket).decision.state, "RESOLVABLE");
  const duplicate = await f.act("review", recovered, recovered.candidates[0], f.principal, reviewKey);
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  await f.restart();
  const operation = randomUUID();
  const selected = recovered.candidates[0];
  const promotion = await f.act("promote", recovered, selected, f.principal, operation);
  assert.equal(promotion.status, 200, await promotion.clone().text());
  const receipt = await promotion.json() as { target_oid: string };
  const remote = join(f.directory, "remote.git");
  assert.equal(f.git(["--git-dir", remote, "rev-parse", "refs/heads/main"]), receipt.target_oid);
  assert.equal(f.git(["--git-dir", remote, "rev-parse", receipt.target_oid + "^{tree}"]), selected.candidate.repo_tree_oids[scope.repo_id]);
  assert.equal(f.git(["--git-dir", remote, "rev-list", "--parents", "-n", "1", receipt.target_oid]), receipt.target_oid + " " + f.base);
  const before = f.prepared;
  const retry = await f.act("promote", recovered, selected, f.principal, operation);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(f.prepared, before);
  assert.equal((await f.decisions()).length, 0);
});

test("agents and a required missing semantic capability cannot authorize a candidate", async (t) => {
  const f = await decisionFixture(t, { partial: true });
  const [packet] = await f.decisions();
  const agent: Principal = {
    ...f.principal, actor_type: "agent", sub: "agent",
    capability: { id: randomUUID(), scope, budget: 10 },
  };
  assert.equal((await f.act("review", packet, packet.candidates[0], agent)).status, 403);
  const review = await f.act("review", packet);
  assert.equal(review.status, 200, await review.clone().text());
  const reviewed = await review.json() as DecisionPacket;
  assert.equal(reviewed.decision.state, "REVIEWABLE");
  assert(Object.values(reviewed.blockers).every((blockers) => blockers.some((item) => item.code === "CAPABILITY_REQUIRED")));
  assert.equal((await f.act("promote", reviewed)).status, 422);
  assert.equal(f.prepared, 0);
});

test("an external push during native preparation rejects stale authorization", async (t) => {
  let moved = false;
  const f = await decisionFixture(t, {
    beforePrepare: (state) => {
      if (moved) return;
      moved = true;
      state.git(["-C", join(state.directory, "driver"), "push",
        "--force-with-lease=refs/heads/main:" + state.base, "origin", state.commits.at(-1)! + ":refs/heads/main"]);
    },
  });
  const [packet] = await f.decisions();
  assert.equal((await f.act("review", packet)).status, 200);
  assert.equal((await f.act("promote", packet)).status, 409);
  assert.equal(f.git(["--git-dir", join(f.directory, "remote.git"), "rev-parse", "refs/heads/main"]), f.commits.at(-1));
  const [stale] = await f.decisions();
  assert.equal(stale.decision.state, "STALE");
});

test("a lost Git response recovers the exact prepared operation after restart", async (t) => {
  const f = await decisionFixture(t);
  const [packet] = await f.decisions();
  assert.equal((await f.act("review", packet)).status, 200);
  const operation = randomUUID();
  f.obscureReceipt();
  const lost = await f.act("promote", packet, packet.candidates[0], f.principal, operation);
  assert.equal(lost.status, 503, await lost.clone().text());
  const accepted = f.git(["--git-dir", join(f.directory, "remote.git"), "rev-parse", "refs/heads/main"]);
  await f.restart();
  const before = f.prepared;
  const recovered = await f.act("promote", packet, packet.candidates[0], f.principal, operation);
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal(f.prepared, before);
  assert.equal(f.git(["--git-dir", join(f.directory, "remote.git"), "rev-parse", "refs/heads/main"]), accepted);
  assert.equal((await f.decisions()).length, 0);
});

test("one reviewer changing choice does not leave an eligible approval on the previous candidate", async (t) => {
  const f = await decisionFixture(t);
  const [packet] = await f.decisions();
  const [first, second] = packet.candidates;
  assert.equal((await f.act("review", packet, first)).status, 200);
  assert.equal((await f.act("review", packet, second)).status, 200);
  assert.equal((await f.act("promote", packet, first)).status, 422);
  assert.equal((await f.act("promote", packet, second)).status, 200);
});
