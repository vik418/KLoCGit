import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { hashProjection } from "../../../../packages/contracts/src/index.ts";
import { signToken } from "../../src/auth.ts";
import type { Principal } from "../../src/auth.ts";
import { packEvent, unpackEvent, INLINE_LIMIT } from "../../src/events.ts";
import type { Scope, Bindings } from "../../src/runtime.ts";

export const scope: Scope = {
  tenant_id: "tenant",
  organization_id: "organization",
  repo_id: "repo",
  objective_id: "objective",
};
export const endpoint =
  "https://klocgit.test/api/tenants/tenant/organizations/organization/repos/repo/objectives/objective";
const root = resolve(import.meta.dirname, "../../../..");

export interface FixtureOptions {
  sourceDirectory?: string;
  bindings?: Record<string, string>;
  engine?: (action: string, input: any, context: {
    driver: string; remote: string; base: string;
    git: (args: string[]) => string;
    bucket: () => Promise<any>;
  }) => Promise<WorkerResponse | undefined>;
}

export async function fixture(t: { after: (fn: () => unknown) => void }, optionsOverride: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "klocgit-coordination-"));
  const driver = join(directory, "driver");
  const remote = join(directory, "remote.git");
  const receipts = join(directory, "receipts");
  mkdirSync(receipts);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init", "--bare", remote]);
  git(["init", driver]);
  if (optionsOverride.sourceDirectory) cpSync(optionsOverride.sourceDirectory, driver, { recursive: true });
  git(["-C", driver, "config", "user.name", "Fixture"]);
  git(["-C", driver, "config", "user.email", "fixture@example.org"]);
  writeFileSync(
    join(driver, "retry.ts"),
    "export function RetryLimit() { return 0; }\n",
  );
  git(["-C", driver, "add", "."]);
  git(["-C", driver, "commit", "-m", "baseline"]);
  git(["-C", driver, "branch", "-M", "main"]);
  git(["-C", driver, "remote", "add", "origin", remote]);
  git(["-C", driver, "push", "origin", "main"]);
  git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const base = git(["-C", driver, "rev-parse", "HEAD"]);

  function commit(path: string, content: string, ref?: string): string {
    git(["-C", driver, "checkout", "--detach", base]);
    writeFileSync(join(driver, path), content);
    git(["-C", driver, "add", "."]);
    git([
      "-C",
      driver,
      "commit",
      "-m",
      "change-" + randomUUID(),
      "--allow-empty",
    ]);
    const oid = git(["-C", driver, "rev-parse", "HEAD"]);
    if (ref) git(["-C", driver, "push", "origin", oid + ":" + ref]);
    return oid;
  }
  const actorRefs = [
    "a",
    "duplicate",
    "alternative",
    "telemetry",
    "security",
  ].map((actor) => "refs/futures/" + actor + "/task");
  const commits = [
    commit(
      "retry.ts",
      "export function RetryLimit() { return 1; }\n",
      actorRefs[0],
    ),
    commit(
      "retry.ts",
      "export function RetryLimit() { return 1; }\n",
      actorRefs[1],
    ),
    commit(
      "retry.ts",
      "export function RetryLimit() { return 2; }\n",
      actorRefs[2],
    ),
    commit("telemetry.ts", "export const Telemetry = true;\n", actorRefs[3]),
    commit("auth.ts", "export const Secure = true;\n", actorRefs[4]),
  ];
  const authKey = randomBytes(32).toString("hex");
  const internalKey = randomBytes(32).toString("hex");
  const bundle = await build({
    entryPoints: [join(root, "apps/worker/src/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  let obscureNextReceipt = false;
  let engineCalls = 0;
  function receiptPath(id: string) {
    return join(receipts, Buffer.from(id).toString("hex") + ".json");
  }
  const serviceBindings = {
    GIT_EXECUTOR: async (request: Request) => {
      const input = (await request.json()) as {
        promotion_pack?: { payload_digest: string; tree_oid: string; candidate_digest: string };
        scope: Scope;
        ref: string;
        expected_oid?: string;
        target_oid?: string;
        idempotency_key?: string;
        operation_digest?: string;
      };
      if (
        input.scope.tenant_id !== scope.tenant_id ||
        input.scope.repo_id !== scope.repo_id ||
        input.scope.organization_id !== scope.organization_id
      )
        return new WorkerResponse("forbidden", { status: 403 });
      const path = new URL(request.url).pathname;
      if (path === "/observe") {
        const oid = git([
          "--git-dir",
          remote,
          "rev-parse",
          "--verify",
          input.ref,
        ]);
        const tree = git(["--git-dir", remote, "rev-parse", oid + "^{tree}"]);
        const parents = git([
          "--git-dir",
          remote,
          "rev-list",
          "--parents",
          "-n",
          "1",
          oid,
        ])
          .split(" ")
          .slice(1);
        return WorkerResponse.json({
          commit_oid: oid,
          tree_oid: tree,
          parent_oids: parents,
        });
      }
      if (path === "/operation") {
        const path = receiptPath(input.idempotency_key!);
        return WorkerResponse.json(
          existsSync(path)
            ? JSON.parse(readFileSync(path, "utf8"))
            : { status: "UNKNOWN" },
        );
      }
      if (path === "/cas") {
        try {
          if (input.promotion_pack) {
            const bucket = await mf.getR2Bucket("PAYLOADS");
            const key = "promotion-packs/" + await hashProjection("klocgit.promotion-pack.scope", input.scope) +
              "/" + input.promotion_pack.payload_digest.slice(7);
            const pack = await bucket.get(key);
            assert.ok(pack);
            const bytes = new Uint8Array(await pack.arrayBuffer());
            const { payloadDigest } = await import("../../../../packages/contracts/src/index.ts");
            assert.equal(await payloadDigest(bytes), input.promotion_pack.payload_digest);
            execFileSync("git", ["-C", driver, "index-pack", "--stdin", "--strict"], {
              input: bytes, stdio: ["pipe", "ignore", "pipe"],
            });
            assert.equal(git(["-C", driver, "rev-parse", input.target_oid + "^{tree}"]), input.promotion_pack.tree_oid);
            assert.equal(git(["-C", driver, "rev-list", "--parents", "-n", "1", input.target_oid!]),
              input.target_oid + " " + input.expected_oid);
          }
          git([
            "-C",
            driver,
            "push",
            "--porcelain",
            "--force-with-lease=" + input.ref + ":" + input.expected_oid,
            "origin",
            input.target_oid + ":" + input.ref,
          ]);
          const record = {
            status: "APPLIED",
            expected_oid: input.expected_oid,
            target_oid: input.target_oid,
            operation_digest: input.operation_digest,
          };
          const path = receiptPath(input.idempotency_key!);
          writeFileSync(path + ".tmp", JSON.stringify(record));
          renameSync(path + ".tmp", path);
          if (obscureNextReceipt) {
            obscureNextReceipt = false;
            return new WorkerResponse("connection lost", { status: 503 });
          }
          return WorkerResponse.json(record);
        } catch {
          writeFileSync(
            receiptPath(input.idempotency_key!),
            JSON.stringify({
              status: "NO_EFFECT",
              operation_digest: input.operation_digest,
            }),
          );
          return WorkerResponse.json(
            { error: { code: "STALE_BASIS" } },
            { status: 409 },
          );
        }
      }
      return new WorkerResponse("not found", { status: 404 });
    },
    ENGINE: async (request: Request) => {
      let input = (await request.json()) as any;
      if (input.job_payload_ref) {
        const bucket = await mf.getR2Bucket("PAYLOADS");
        const object = await bucket.get(input.job_payload_ref);
        assert.ok(object);
        const bytes = new Uint8Array(await object.arrayBuffer());
        const { payloadDigest } = await import("../../../../packages/contracts/src/index.ts");
        assert.equal(await payloadDigest(bytes), input.job_payload_digest);
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      }
      const action = new URL(request.url).pathname.slice(1);
      if (optionsOverride.engine) {
        const output = await optionsOverride.engine(action, input, {
          driver, remote, base, git, bucket: () => mf.getR2Bucket("PAYLOADS"),
        });
        if (output) return output;
      }
      if (action === "reduce") {
        const bucket = await mf.getR2Bucket("PAYLOADS");
        const manifestObject = await bucket.get(input.input_payload_ref);
        assert.ok(manifestObject);
        const manifestBytes = new Uint8Array(
          await manifestObject.arrayBuffer(),
        );
        const { payloadDigest } =
          await import("../../../../packages/contracts/src/index.ts");
        assert.equal(
          await payloadDigest(manifestBytes),
          input.input_payload_digest,
        );
        const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
        const records: any[] = [];
        for (const segment of manifest.segments) {
          const object = await bucket.get(segment.payload_ref);
          assert.ok(object);
          const bytes = new Uint8Array(await object.arrayBuffer());
          assert.equal(await payloadDigest(bytes), segment.payload_digest);
          records.push(...JSON.parse(new TextDecoder().decode(bytes)));
        }
        const futures = records.map((record) => ({
          state: record.state,
          revision: record.revision,
          effects: record.effects,
          changed_paths: git([
            "--git-dir",
            remote,
            "diff",
            "--name-only",
            input.base_revisions.repo,
            record.state.commit_oid,
          ])
            .split("\n")
            .filter(Boolean),
          required_future_ids: [],
        }));
        const output = JSON.parse(
          execFileSync(
            "cargo",
            [
              "run",
              "--quiet",
              "-p",
              "klocgit-engine",
              "--bin",
              "klocgit-engine",
            ],
            {
              cwd: root,
              input: JSON.stringify({
                operation: "reduce",
                base_revisions: input.base_revisions,
                futures,
                budget: input.budget,
              }),
              encoding: "utf8",
            },
          ),
        );
        const bytes = new TextEncoder().encode(JSON.stringify(output));
        const payload_digest = await payloadDigest(bytes);
        const payload_ref =
          "reductions/" + scope.tenant_id + "/" + payload_digest.slice(7);
        await bucket.put(payload_ref, bytes);
        return WorkerResponse.json({
          schema_version: 1,
          input_payload_digest: input.input_payload_digest,
          payload_ref,
          payload_digest,
          summary: {
            status: output.status,
            group_count: output.groups.length,
            candidate_spec_digests: output.candidate_specs.map(
              (spec: any) => spec.spec_digest,
            ),
          },
        });
      }
      const command = input;
      input = JSON.parse(command.original_payload);
      assert.equal(
        await (
          await import("../../../../packages/contracts/src/index.ts")
        ).payloadDigest(new TextEncoder().encode(command.original_payload)),
        command.input_payload_digest,
      );
      const paths = git([
        "--git-dir",
        remote,
        "diff",
        "--name-only",
        base,
        input.state.commit_oid,
      ])
        .split("\n")
        .filter(Boolean);
      const changes = paths.map((path) => {
        let before: string | null = null;
        let after: string | null = null;
        try {
          before = git(["--git-dir", remote, "show", base + ":" + path]);
        } catch {}
        try {
          after = git([
            "--git-dir",
            remote,
            "show",
            input.state.commit_oid + ":" + path,
          ]);
        } catch {}
        return { path, before, after };
      });
      const effects = JSON.parse(
        execFileSync(
          "cargo",
          ["run", "--quiet", "-p", "klocgit-engine", "--bin", "klocgit-engine"],
          {
            cwd: root,
            input: JSON.stringify({
              operation: "analyze",
              future_revision_id: input.revision.id,
              language: "typescript",
              changes,
            }),
            encoding: "utf8",
          },
        ),
      );
      engineCalls++;
      return WorkerResponse.json({
        schema_version: 1,
        input_payload_digest: command.input_payload_digest,
        effects,
        changed_paths: paths,
      });
    },
  };
  const options = {
    modules: true as const,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-08-06",
    durableObjects: {
      OBJECTIVES: { className: "ObjectiveCoordinator", useSQLite: true },
      REFS: { className: "RefCoordinator", useSQLite: true },
    },
    durableObjectsPersist: join(directory, "durable"),
    r2Buckets: ["PAYLOADS"],
    r2Persist: join(directory, "r2"),
    queueProducers: { ANALYSIS_QUEUE: "analysis", DEAD_LETTER_QUEUE: "dlq" },
    queueConsumers: {
      analysis: {
        maxBatchSize: 5,
        maxBatchTimeout: 1,
        maxRetries: 5,
        deadLetterQueue: "dlq",
      },
    },
    bindings: {
      AUTH_SIGNING_KEY: authKey,
      INTERNAL_SIGNING_KEY: internalKey,
      AUTH_ISSUER: "klocgit",
      AUTH_AUDIENCE: "klocgit-api",
      CANONICAL_REF: "refs/heads/main",
      ...optionsOverride.bindings,
      REDUCTION_BUDGET: JSON.stringify({
        max_candidates: 16,
        max_futures: 100,
        max_footprint_entries: 1000,
        max_output_bytes: 1_000_000,
      }),
    },
    serviceBindings,
  };
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = Math.floor(Date.now() / 1000);
  const principal: Principal = {
    sub: "reviewer",
    actor_type: "human",
    iss: "klocgit",
    aud: "klocgit-api",
    iat: now,
    exp: now + 3600,
    grants: [{ scope, actions: ["read", "ingest", "promote"] }],
  };
  async function token(claims = principal) {
    return signToken(claims, authKey);
  }
  async function request(
    path = endpoint,
    method = "GET",
    body?: unknown,
    claims = principal,
    id = randomUUID(),
  ) {
    return mf.dispatchFetch(path, {
      method,
      headers: {
        authorization: "Bearer " + (await token(claims)),
        "content-type": "application/json",
        "Idempotency-Key": id,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function status() {
    return (await request()).json() as Promise<any>;
  }
  async function refCall(command: any, action: string) {
    const namespace = await mf.getDurableObjectNamespace("REFS");
    const name = await hashProjection("klocgit.ref-scope", {
      tenant_id: command.scope.tenant_id,
      organization_id: command.scope.organization_id,
      repo_id: command.scope.repo_id,
      ref: command.ref,
    });
    const grant = {
      schema_version: 1,
      aud: "ref",
      action,
      scope: command.scope,
      actor_id: command.actor_id,
      expires_at: Date.now() + 60_000,
      subject_digest: await hashProjection(
        "klocgit.promotion-command",
        command,
      ),
    };
    return namespace.getByName(name).fetch("https://ref.internal/" + action, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-klocgit-internal": await signToken(grant, internalKey),
      },
      body: JSON.stringify(command),
    });
  }
  function promotion(decision: string, target: string) {
    return {
      schema_version: 1,
      scope,
      ref: "refs/heads/main",
      decision_id: decision,
      basis_digest: "sha256:" + "a".repeat(64),
      expected_oid: base,
      target_oid: target,
      actor_id: "reviewer",
      idempotency_key: randomUUID(),
    };
  }
  return {
    directory,
    base,
    commits,
    actorRefs,
    authKey,
    internalKey,
    principal,
    request,
    status,
    refCall,
    promotion,
    git,
    commit,
    get mf() {
      return mf;
    },
    get engineCalls() {
      return engineCalls;
    },
    obscureReceipt() {
      obscureNextReceipt = true;
    },
    async restart() {
      await mf.dispose();
      mf = new Miniflare(options);
    },
  };
}

export async function until(check: () => Promise<boolean>, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

