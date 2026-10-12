import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { createServer } from "node:https";
import { randomBytes } from "node:crypto";
import { readObject } from "../src/routes/objects.ts";
import { signToken } from "../src/auth.ts";
import type { Bindings } from "../src/runtime.ts";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  hashProjection,
  payloadDigest,
  sealCandidate,
  sealFutureRevision,
} from "../../../packages/contracts/src/index.ts";
import { EvidenceStore } from "../src/evidence-store.ts";

const root = resolve(import.meta.dirname, "../../..");
const fixtures = join(root, "tests/fixtures/sandbox");
const image_oid = process.env.KLOCGIT_SANDBOX_IMAGE;
assert.match(image_oid ?? "", /^sha256:[0-9a-f]{64}$/);

// Fixture toolchains are measured from the exact image used by the runner.
const version = (command: string[]) =>
  execFileSync(
    "docker",
    [
      "--host=unix:///var/run/docker.sock",
      "run",
      "--rm",
      "--network=none",
      "--env=HTTP_PROXY=",
      "--env=HTTPS_PROXY=",
      image_oid!,
      ...command,
    ],
    { encoding: "utf8", timeout: 30_000 },
  ).trim();
const fixtureMatrix = {
  schema_version: 1,
  entries: [
    {
      language: "typescript",
      version: version(["node", "--version"]).replace(/^v/, ""),
      image_oid,
    },
    {
      language: "python",
      version: version(["python", "--version"]).replace(/^Python /, ""),
      image_oid,
    },
    {
      language: "go",
      version: version(["go", "version"]).split(" ")[2].replace(/^go/, ""),
      image_oid,
    },
  ],
};

async function snapshot(
  directory: string,
): Promise<{ location: string; tree_oid: string; dispose(): void }> {
  const location = mkdtempSync(join(tmpdir(), "klocgit-state-"));
  cpSync(directory, location, { recursive: true });
  chmodSync(location, 0o755);
  execFileSync("git", ["init", location], { stdio: "ignore" });
  execFileSync("git", ["-C", location, "add", "."], { stdio: "ignore" });
  const tree_oid = execFileSync("git", ["-C", location, "write-tree"], {
    encoding: "utf8",
  }).trim();
  rmSync(join(location, ".git"), { recursive: true, force: true });
  return {
    location,
    tree_oid,
    dispose() {
      rmSync(location, { recursive: true, force: true });
    },
  };
}

async function evaluate(
  workspace: string,
  suite: string,
  checks: { id: string; command: string[] }[],
  overrides = {},
) {
  const code = await snapshot(workspace);
  const trusted = await snapshot(suite);
  const spec_digest = await hashProjection("klocgit.fixture-spec", {
    repo: code.tree_oid,
  });
  const candidate = await sealCandidate({
    candidate_spec_id: spec_digest,
    repo_tree_oids: { repo: code.tree_oid },
    materialization_record: {
      executor_id: "fixture",
      materialized_at: new Date().toISOString(),
      conflicts_encountered: [],
    },
  });
  const policy = {
    schema_version: 1,
    evaluator_id: "trusted-sandbox",
    evaluator_version: "1",
    image_oid,
    language: workspace.endsWith("python")
      ? "python"
      : workspace.endsWith("go")
        ? "go"
        : "typescript",
    supported_toolchains: fixtureMatrix,
    trusted_suite_state_digest: await hashProjection("klocgit.trusted-suite", {
      tree_oid: trusted.tree_oid,
    }),
    checks,
    timeout_ms: 60_000,
    memory_bytes: 536870912,
    pids_limit: 256,
    max_log_bytes: 65536,
    ...overrides,
  };
  try {
    return JSON.parse(
      execFileSync(
        "cargo",
        ["run", "--quiet", "-p", "klocgit-engine", "--bin", "klocgit-engine"],
        {
          cwd: root,
          encoding: "utf8",
          input: JSON.stringify({
            operation: "evaluate",
            workspace: code.location,
            trusted_suite: trusted.location,
            candidate,
            repo_id: "repo",
            policy,
          }),
          timeout: 180_000,
        },
      ),
    );
  } finally {
    code.dispose();
    trusted.dispose();
  }
}

test("Node, Python and Go execute real trusted checks and produce immutable R2 receipts", async (t) => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: "2026-08-06",
    r2Buckets: ["EVIDENCE"],
  });
  t.after(() => mf.dispose());
  const bucket = await mf.getR2Bucket("EVIDENCE");
  const store = new EvidenceStore(bucket as unknown as R2Bucket);
  const cases = [
    {
      language: "typescript",
      checks: [
        {
          id: "vitest",
          command: [
            "node",
            "/opt/node-tools/node_modules/vitest/vitest.mjs",
            "run",
            "--globals",
            "--root",
            "/checks",
            "--config",
            "/checks/vitest.config.cjs",
          ],
        },
        {
          id: "tsc",
          command: [
            "node",
            "/opt/node-tools/node_modules/typescript/bin/tsc",
            "--noEmit",
            "--project",
            "/workspace/tsconfig.json",
          ],
        },
      ],
    },
    {
      language: "python",
      checks: [
        {
          id: "pytest",
          command: [
            "python",
            "-c",
            'import sys,pytest; sys.path.insert(0,"/workspace"); raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","/checks"]))',
          ],
        },
        {
          id: "pyright",
          command: [
            "node",
            "/opt/node-tools/node_modules/pyright/index.js",
            "--project",
            "/checks/pyrightconfig.json",
          ],
        },
      ],
    },
    {
      language: "go",
      checks: [
        { id: "go-test", command: ["go", "test", "-v", "-race", "./..."] },
      ],
    },
  ];
  for (const item of cases) {
    const result = await evaluate(
      join(fixtures, item.language),
      join(fixtures, item.language + "-checks"),
      item.checks,
    );
    assert.equal(
      result.evidence.result,
      "PASSED",
      JSON.stringify(result.receipt),
    );
    assert.equal(result.receipt.checks.length, item.checks.length);
    for (const check of result.receipt.checks)
      assert.equal(check.exit_code, 0, check.stderr);
    const payload = Uint8Array.from(result.payload);
    assert.equal(await payloadDigest(payload), result.evidence.payload_digest);
    const persisted = await store.persist("tenant", result.evidence, payload);
    const second = await store.persist(
      "tenant",
      { ...result.evidence, retention_class: "CANONICAL" },
      payload,
    );
    assert.equal(persisted.evidence_digest, second.evidence_digest);
    assert.deepEqual(
      (await store.load("tenant", persisted.evidence_digest)).payload,
      payload,
    );
  }
});

test("untrusted execution cannot use egress, canonical credentials or writable source", async () => {
  const command = [
    "node",
    "-e",
    'const fs=require("fs");const assert=require("assert/strict");assert.equal(process.env.AUTH_SIGNING_KEY,undefined);assert.equal(process.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(process.env.GITHUB_TOKEN,undefined);assert.equal(fs.readFileSync("/proc/net/route","utf8").trim().split("\\n").length,1);assert.throws(()=>fs.writeFileSync("/workspace/api.ts","changed"));console.log("isolation checks passed");',
  ];
  const result = await evaluate(
    join(fixtures, "typescript"),
    join(fixtures, "typescript-checks"),
    [{ id: "isolation", command }],
  );
  assert.equal(
    result.evidence.result,
    "PASSED",
    JSON.stringify(result.receipt),
  );
});

test("timeouts terminate execution and failed tests remain failed evidence", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "klocgit-failed-check-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  cpSync(join(fixtures, "typescript"), workspace, { recursive: true });
  writeFileSync(
    join(workspace, "api.ts"),
    "export function retries(): number { return 2; }\n",
  );
  const failed = await evaluate(
    workspace,
    join(fixtures, "typescript-checks"),
    [
      {
        id: "vitest",
        command: [
          "node",
          "/opt/node-tools/node_modules/vitest/vitest.mjs",
          "run",
          "--globals",
          "--root",
          "/checks",
          "--config",
          "/checks/vitest.config.cjs",
        ],
      },
    ],
  );
  assert.equal(failed.evidence.result, "FAILED");
  const timed = await evaluate(
    workspace,
    join(fixtures, "typescript-checks"),
    [{ id: "timeout", command: ["node", "-e", "while(true){}"] }],
    { timeout_ms: 300 },
  );
  assert.equal(timed.evidence.result, "ERROR");
  assert.equal(timed.receipt.checks[0].timed_out, true);
});

test("isolated futures pass while their clean composition exposes a semantic interaction", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "klocgit-interaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(fixtures, "interaction"), directory, { recursive: true });
  chmodSync(directory, 0o755);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.org"]);
  git(["add", "."]);
  git(["commit", "-m", "baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  const retryBefore = readFileSync(join(directory, "retry.ts"), "utf8");
  const ledgerBefore = readFileSync(join(directory, "ledger.ts"), "utf8");
  const retryAfter = retryBefore.replace(
    "const attempts = 1;",
    "const attempts = 2;",
  );
  writeFileSync(join(directory, "retry.ts"), retryAfter);
  git(["add", "."]);
  git(["commit", "-m", "retry uncertain delivery"]);
  const a = git(["rev-parse", "HEAD"]);
  git(["checkout", "--detach", base]);
  const ledgerAfter = ledgerBefore.replace(
    "  if (charged.has(id)) return;\n",
    "",
  );
  writeFileSync(join(directory, "ledger.ts"), ledgerAfter);
  git(["add", "."]);
  git(["commit", "-m", "record each attempt"]);
  const b = git(["rev-parse", "HEAD"]);
  const native = (input: unknown) =>
    JSON.parse(
      execFileSync(
        "cargo",
        ["run", "--quiet", "-p", "klocgit-engine", "--bin", "klocgit-engine"],
        {
          cwd: root,
          input: JSON.stringify(input),
          encoding: "utf8",
          timeout: 180_000,
        },
      ),
    );
  const makeSource = async (
    oid: string,
    actor: string,
    path: string,
    before: string,
    after: string,
  ) => {
    const state = {
      repo_id: "repo",
      commit_oid: oid,
      tree_oid: git(["rev-parse", oid + "^{tree}"]),
      parent_oids: git(["show", "-s", "--format=%P", oid])
        .split(" ")
        .filter(Boolean),
    };
    const revision = await sealFutureRevision(state, {
      system_id: "product",
      ref: "refs/futures/" + actor + "/task",
      producer: { actor_id: actor },
      observed_at: new Date().toISOString(),
    });
    const effects = native({
      operation: "analyze",
      future_revision_id: revision.id,
      language: "typescript",
      changes: [{ path, before, after }],
    });
    return {
      repository_path: directory,
      state,
      revision,
      effects,
      changed_paths: [path],
      required_future_ids: [],
    };
  };
  const sources = [
    await makeSource(a, "retry", "retry.ts", retryBefore, retryAfter),
    await makeSource(b, "ledger", "ledger.ts", ledgerBefore, ledgerAfter),
  ];
  const trusted = await snapshot(join(fixtures, "interaction-checks"));
  t.after(() => trusted.dispose());
  const policy = {
    schema_version: 1,
    evaluator_id: "trusted-payment-checks",
    evaluator_version: "1",
    image_oid,
    language: "typescript",
    supported_toolchains: fixtureMatrix,
    trusted_suite_state_digest: await hashProjection("klocgit.trusted-suite", {
      tree_oid: trusted.tree_oid,
    }),
    checks: [
      {
        id: "at-most-once-charge",
        command: [
          "node",
          "/opt/node-tools/node_modules/vitest/vitest.mjs",
          "run",
          "--globals",
          "--root",
          "/checks",
          "--config",
          "/checks/vitest.config.cjs",
        ],
      },
    ],
    timeout_ms: 60_000,
    memory_bytes: 536870912,
    pids_limit: 256,
    max_log_bytes: 65536,
  };
  const outcomes = [];
  for (const selected of [[sources[0]], [sources[1]], sources]) {
    const reduction = native({
      operation: "reduce",
      base_revisions: { repo: base },
      futures: selected.map(({ repository_path: _path, ...future }) => future),
      budget: {
        max_candidates: 16,
        max_futures: 100,
        max_footprint_entries: 1000,
        max_output_bytes: 1_000_000,
      },
    });
    assert.equal(reduction.candidate_specs.length, 1);
    const result = native({
      operation: "evaluate_candidate",
      base_repository: directory,
      repo_id: "repo",
      candidate_spec: reduction.candidate_specs[0],
      sources: selected.map(
        ({
          changed_paths: _changed,
          required_future_ids: _required,
          ...record
        }) => record,
      ),
      trusted_suite: trusted.location,
      policy,
    });
    assert.equal(
      result.evidence.subject_digest,
      result.candidate.candidate_digest,
    );
    outcomes.push(result.evidence.result);
  }
  assert.deepEqual(outcomes, ["PASSED", "PASSED", "FAILED"]);
});

test("native materialization hydrates pinned Artifacts objects over an authenticated broker", async (t) => {
  const certificateDirectory = mkdtempSync(
    join(tmpdir(), "klocgit-broker-tls-"),
  );
  const directory = mkdtempSync(join(tmpdir(), "klocgit-broker-source-"));
  t.after(() => {
    rmSync(certificateDirectory, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  });
  cpSync(join(fixtures, "typescript"), directory, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.org"]);
  writeFileSync(
    join(directory, "api.ts"),
    "export function retries(): number { return 0; }\n",
  );
  writeFileSync(join(directory, "removed.bin"), Buffer.alloc(1024 * 1024, 8));
  git(["add", "."]);
  git(["commit", "-m", "baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  const removedBlob = git(["rev-parse", base + ":removed.bin"]);
  const before = readFileSync(join(directory, "api.ts"), "utf8");
  const after = "export function retries(): number { return 1; }\n";
  writeFileSync(join(directory, "api.ts"), after);
  rmSync(join(directory, "removed.bin"));
  git(["add", "."]);
  git(["commit", "-m", "candidate"]);
  const oid = git(["rev-parse", "HEAD"]);
  const state = {
    repo_id: "repo",
    commit_oid: oid,
    tree_oid: git(["rev-parse", oid + "^{tree}"]),
    parent_oids: git(["show", "-s", "--format=%P", oid])
      .split(" ")
      .filter(Boolean),
  };
  const revision = await sealFutureRevision(state, {
    system_id: "product",
    ref: "refs/futures/fixture/task",
    producer: { actor_id: "fixture" },
    observed_at: new Date().toISOString(),
  });
  const native = (input: unknown) =>
    JSON.parse(
      execFileSync(
        "cargo",
        ["run", "--quiet", "-p", "klocgit-engine", "--bin", "klocgit-engine"],
        {
          cwd: root,
          input: JSON.stringify(input),
          encoding: "utf8",
          timeout: 180_000,
        },
      ),
    );
  const effects = native({
    operation: "analyze",
    future_revision_id: revision.id,
    language: "typescript",
    changes: [{ path: "api.ts", before, after }],
  });
  const reduction = native({
    operation: "reduce",
    base_revisions: { repo: base },
    futures: [
      {
        state,
        revision,
        effects,
        changed_paths: ["api.ts", "removed.bin"],
        required_future_ids: [],
      },
    ],
    budget: {
      max_candidates: 8,
      max_futures: 100,
      max_footprint_entries: 1000,
      max_output_bytes: 1000000,
    },
  });
  const cert = join(certificateDirectory, "cert.pem");
  const key = join(certificateDirectory, "key.pem");
  const ca = join(certificateDirectory, "ca.pem");
  const caKey = join(certificateDirectory, "ca-key.pem");
  const csr = join(certificateDirectory, "server.csr");
  const extension = join(certificateDirectory, "server.ext");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-days",
      "1",
      "-subj",
      "/CN=Fixture CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(
    extension,
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-extfile",
      extension,
    ],
    { stdio: "ignore" },
  );
  const scope = {
    tenant_id: "tenant",
    organization_id: "organization",
    repo_id: "repo",
    objective_id: "task",
  };
  const objectReads: { kind: string; oid: string }[] = [];
  const repository = {
    readCommit: async (hash: string) => ({
      hash,
      treeHash: git(["rev-parse", hash + "^{tree}"]),
      parents: git(["show", "-s", "--format=%P", hash])
        .split(" ")
        .filter(Boolean),
    }),
    readTree: async (hash: string) =>
      git(["ls-tree", hash])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [head, name] = line.split("\t");
          const [mode, type, hash] = head.split(" ");
          return {
            name,
            mode: mode === "040000" ? "40000" : mode,
            hash,
            type:
              type === "tree"
                ? "tree"
                : mode === "100755"
                  ? "exec"
                  : mode === "120000"
                    ? "symlink"
                    : mode === "160000"
                      ? "gitlink"
                      : "blob",
          };
        }),
    readBlob: async (hash: string) =>
      new Blob([
        execFileSync("git", ["-C", directory, "cat-file", "blob", hash]),
      ]),
    [Symbol.dispose]: () => {},
  };
  const secret = randomBytes(32).toString("hex");
  const env = {
    INTERNAL_SIGNING_KEY: secret,
    ARTIFACTS_REPOSITORIES: JSON.stringify([
      { ...scope, artifacts_name: "fixture" },
    ]),
    ARTIFACTS: { get: async () => repository },
  } as unknown as Bindings;
  const token = await signToken(
    {
      schema_version: 1,
      aud: "git-objects",
      action: "read",
      scope,
      expires_at: Date.now() + 300000,
      max_object_bytes: 16 * 1024 * 1024,
    },
    secret,
  );
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const input = JSON.parse(body.toString("utf8"));
        objectReads.push({ kind: input.kind, oid: input.oid });
        const headers = Object.fromEntries(
          Object.entries(request.headers).filter(
            ([, value]) => typeof value === "string",
          ),
        );
        const result = await readObject(
          new Request("https://broker.test/internal/git-objects", {
            method: "POST",
            headers: headers as Record<string, string>,
            body,
          }),
          env,
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(500);
        response.end();
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address !== "string");
  const trusted = await snapshot(join(fixtures, "typescript-checks"));
  t.after(() => trusted.dispose());
  const policy = {
    schema_version: 1,
    evaluator_id: "trusted-broker-checks",
    evaluator_version: "1",
    image_oid,
    language: "typescript",
    supported_toolchains: fixtureMatrix,
    trusted_suite_state_digest: await hashProjection("klocgit.trusted-suite", {
      tree_oid: trusted.tree_oid,
    }),
    checks: [
      {
        id: "vitest",
        command: [
          "node",
          "/opt/node-tools/node_modules/vitest/vitest.mjs",
          "run",
          "--globals",
          "--root",
          "/checks",
          "--config",
          "/checks/vitest.config.cjs",
        ],
      },
    ],
    timeout_ms: 60000,
    memory_bytes: 536870912,
    pids_limit: 256,
    max_log_bytes: 65536,
  };
  const input = {
    operation: "evaluate_objects",
    broker_endpoint:
      "https://127.0.0.1:" + address.port + "/internal/git-objects",
    read_capability: token,
    scope,
    candidate_spec: reduction.candidate_specs[0],
    sources: [{ state, revision, effects }],
    trusted_suite: trusted.location,
    policy,
  };
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "cargo",
      ["run", "--quiet", "-p", "klocgit-engine", "--bin", "klocgit-engine"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SSL_CERT_FILE: ca },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin!.end(JSON.stringify(input));
  });
  const result = JSON.parse(output);
  assert.equal(
    result.evidence.result,
    "PASSED",
    JSON.stringify(result.receipt),
  );
  assert.equal(
    result.evidence.subject_digest,
    result.candidate.candidate_digest,
  );
  assert(
    !objectReads.some(
      (read) => read.kind === "blob" && read.oid === removedBlob,
    ),
  );
  assert(objectReads.some((read) => read.kind === "tree"));
  assert(result.hydrated_bytes < 1024 * 1024);
  assert.equal(git(["rev-parse", "HEAD"]), oid);
});

test("changed source or trusted checks cannot reuse an exact-state authorization", async (t) => {
  const code = await snapshot(join(fixtures, "typescript"));
  const suite = await snapshot(join(fixtures, "typescript-checks"));
  t.after(() => {
    code.dispose();
    suite.dispose();
  });
  const candidate = await sealCandidate({
    candidate_spec_id: await hashProjection("klocgit.fixture-spec", {
      tree: code.tree_oid,
    }),
    repo_tree_oids: { repo: code.tree_oid },
    materialization_record: {
      executor_id: "fixture",
      materialized_at: new Date().toISOString(),
      conflicts_encountered: [],
    },
  });
  const input = {
    operation: "evaluate",
    workspace: code.location,
    trusted_suite: suite.location,
    candidate,
    repo_id: "repo",
    policy: {
      schema_version: 1,
      evaluator_id: "trusted-checks",
      evaluator_version: "1",
      image_oid,
      language: "typescript",
      supported_toolchains: fixtureMatrix,
      trusted_suite_state_digest: await hashProjection(
        "klocgit.trusted-suite",
        { tree_oid: suite.tree_oid },
      ),
      checks: [
        { id: "trusted-check", command: ["node", "-e", "process.exit(0)"] },
      ],
      timeout_ms: 1000,
      memory_bytes: 536870912,
      pids_limit: 256,
      max_log_bytes: 65536,
    },
  };
  const run = () =>
    execFileSync(
      "cargo",
      ["run", "--quiet", "-p", "klocgit-engine", "--bin", "klocgit-engine"],
      {
        cwd: root,
        input: JSON.stringify(input),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      },
    );
  const original = readFileSync(join(code.location, "api.ts"));
  writeFileSync(
    join(code.location, "api.ts"),
    "export function retries() { return 2; }\n",
  );
  assert.throws(run, /RevisionMismatch/);
  writeFileSync(join(code.location, "api.ts"), original);
  writeFileSync(
    join(suite.location, "api.test.ts"),
    "test('unchecked', () => {});\n",
  );
  assert.throws(run, /RevisionMismatch/);
});
