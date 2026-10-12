import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  statSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  hashProjection,
  sealCandidate,
  payloadDigest,
} from "../../../packages/contracts/src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const fixtures = join(root, "tests/fixtures/sandbox");
const image = process.env.KLOCGIT_NATIVE_IMAGE;
assert.match(image ?? "", /^sha256:[0-9a-f]{64}$/);
const docker = (args: string[]) =>
  execFileSync("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

function files(
  directory: string,
): { path: string; bytes: Uint8Array; oid: string; mode: number }[] {
  const result: { path: string; bytes: Uint8Array; oid: string; mode: number }[] = [];
  const visit = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) visit(join(current, entry.name), path + "/");
      else {
        const bytes = readFileSync(join(current, entry.name));
        const oid = execFileSync("git", ["hash-object", "--stdin"], {
          input: bytes,
          encoding: "utf8",
        }).trim();
        result.push({
          path,
          bytes,
          oid,
          mode:
            statSync(join(current, entry.name)).mode & 0o111
              ? 0o100755
              : 0o100644,
        });
      }
    }
  };
  visit(directory, "");
  return result;
}

test("ephemeral VM runs each supported toolchain without a Docker daemon or credentials inside it", async (t) => {
  const cases = [
    {
      language: "typescript",
      version: ["node", "--version"],
      prefix: /^v/,
      commands: [
        [
          "node",
          "/opt/node-tools/node_modules/vitest/vitest.mjs",
          "run",
          "--globals",
          "--root",
          "/checks",
          "--config",
          "/checks/vitest.config.cjs",
        ],
        [
          "node",
          "/opt/node-tools/node_modules/typescript/bin/tsc",
          "--noEmit",
          "--project",
          "/workspace/tsconfig.json",
        ],
      ],
    },
    {
      language: "python",
      version: ["python", "--version"],
      prefix: /^Python /,
      commands: [
        [
          "python",
          "-c",
          'import sys,pytest;sys.path.insert(0,"/workspace");raise SystemExit(pytest.main(["-q","-p","no:cacheprovider","/checks"]))',
        ],
        [
          "node",
          "/opt/node-tools/node_modules/pyright/index.js",
          "--project",
          "/checks/pyrightconfig.json",
        ],
      ],
    },
    {
      language: "go",
      version: ["go", "version"],
      prefix: /^go/,
      commands: [["go", "test", "-v", "-race", "./..."]],
    },
  ];
  for (const item of cases) {
    const session = randomBytes(32).toString("hex");
    const id = docker([
      "create",
      "--network=none",
      "--read-only",
      "--memory=536870912",
      "--memory-swap=536870912",
      "--pids-limit=256",
      "--cpus=1",
      "--cap-drop=ALL",
      "--cap-add=SETUID",
      "--cap-add=SETGID",
      "--cap-add=SETPCAP",
      "--cap-add=KILL",
      "--tmpfs=/tmp:rw,exec,nosuid,nodev,size=268435456",
      "--tmpfs=/workspace:rw,nosuid,nodev,size=268435456",
      "--tmpfs=/checks:rw,nosuid,nodev,size=268435456",
      "--env=KLOCGIT_HOST_ROLE=evaluation",
      "--env=KLOCGIT_HOST_PORT=43191",
      "--env=KLOCGIT_SESSION=" + session,
      image!,
    ]);
    t.after(() => {
      try {
        docker(["rm", "--force", id]);
      } catch {}
    });
    docker(["start", id]);
    // Docker's network=none has no published-port routing. Access the native HTTP
    // service through an exec client; the container retains zero external routes.
    const call = (path: string, payload: unknown, key = session) => {
      const code =
        'import json,urllib.request;body=input().encode();r=urllib.request.Request("http://127.0.0.1:43191"+' +
        JSON.stringify(path) +
        ',body,{"content-type":"application/json","x-klocgit-session":__import__("os").environ["KLOCGIT_SESSION"] if ' +
        JSON.stringify(key === session ? "True" : "False").slice(1, -1) +
        ' else "invalid-session"});print(urllib.request.urlopen(r,timeout=120).read().decode())';
      return JSON.parse(
        execFileSync(
          "docker",
          [
            "--host=unix:///var/run/docker.sock",
            "exec",
            "-i",
            id,
            "python",
            "-c",
            code,
          ],
          {
            input: JSON.stringify(payload),
            encoding: "utf8",
            timeout: 180000,
            stdio: ["pipe", "pipe", "pipe"],
            maxBuffer: 8 * 1024 * 1024,
          },
        ),
      );
    };
    const sourceFiles = files(join(fixtures, item.language));
    const checkFiles = files(join(fixtures, item.language + "-checks"));
    // Independent Git tree construction is the expected state, not a path-count assertion.
    const expectedTree = (entries: typeof sourceFiles) => {
      const scratch = mkdtempSync(join(tmpdir(), "klocgit-expected-tree-"));
      try {
        execFileSync("git", ["init", "--bare", scratch], { stdio: "ignore" });
        for (const file of entries) {
          execFileSync(
            "git",
            ["--git-dir", scratch, "hash-object", "-w", "--stdin"],
            { input: file.bytes, stdio: ["pipe", "ignore", "pipe"] },
          );
          execFileSync(
            "git",
            [
              "--git-dir",
              scratch,
              "update-index",
              "--add",
              "--cacheinfo",
              file.mode.toString(8),
              file.oid,
              file.path,
            ],
            { stdio: "ignore" },
          );
        }
        return execFileSync("git", ["--git-dir", scratch, "write-tree"], {
          encoding: "utf8",
        }).trim();
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    };
    const candidate = await sealCandidate({
      candidate_spec_id: await hashProjection("klocgit.vm-fixture-spec", {
        language: item.language,
        tree: expectedTree(sourceFiles),
      }),
      repo_tree_oids: { repo: expectedTree(sourceFiles) },
      materialization_record: {
        executor_id: "fixture",
        materialized_at: new Date().toISOString(),
        conflicts_encountered: [],
      },
    });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        docker([
          "exec",
          id,
          "python",
          "-c",
          'import urllib.request;urllib.request.urlopen("http://127.0.0.1:43191/health",timeout=1).read()',
        ]);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert(ready, "native host must be ready");
    assert.throws(() => call("/stage", {}, "invalid-session"));
    for (const [kind, entries] of [
      ["workspace", sourceFiles],
      ["checks", checkFiles],
    ] as const)
      for (const file of entries) {
        const middle = Math.floor(file.bytes.length / 2);
        const parts = [file.bytes.slice(0, middle), file.bytes.slice(middle)];
        for (let index = 0; index < parts.length; index++) {
          const transfer = {
            schema_version: 1,
            root: kind,
            path: file.path,
            mode: file.mode,
            blob_oid: file.oid,
            chunk_index: index,
            chunk_count: parts.length,
            payload_hex: Buffer.from(parts[index]).toString("hex"),
          };
          call("/stage", transfer);
          // Redelivery acknowledges identical chunks without charging or rewriting.
          call("/stage", transfer);
          assert.throws(() => call("/stage", { ...transfer, payload_hex: transfer.payload_hex + "00" }));
        }
      }
    const measured = docker(["exec", id, ...item.version]);
    const version =
      item.language === "go"
        ? measured.split(" ")[2].replace(item.prefix, "")
        : measured.replace(item.prefix, "");
    const policy = {
      schema_version: 1,
      evaluator_id: "native-vm",
      evaluator_version: "1",
      image_oid: image,
      language: item.language,
      supported_toolchains: {
        schema_version: 1,
        entries: [{ language: item.language, version, image_oid: image }],
      },
      trusted_suite_state_digest: await hashProjection(
        "klocgit.trusted-suite",
        { tree_oid: expectedTree(checkFiles) },
      ),
      checks: [
        ...item.commands.map((command, index) => ({
          id: item.language + "-" + index,
          command,
        })),
        {
          id: "isolation",
          command: [
            "node",
            "-e",
            'const fs=require("fs"),a=require("assert/strict");a.equal(process.getuid(),10001);a.equal(process.env.KLOCGIT_SESSION,undefined);a.equal(process.env.CLOUDFLARE_API_TOKEN,undefined);a.equal(process.env.AUTH_SIGNING_KEY,undefined);a.equal(fs.existsSync("/var/run/docker.sock"),false);a.equal(fs.readFileSync("/proc/net/route","utf8").trim().split("\\n").length,1);a.throws(()=>fs.writeFileSync("/workspace/unsafe","write"));a.throws(()=>fs.writeFileSync("/checks/unsafe","write"));',
          ],
        },
      ],
      timeout_ms: 60000,
      memory_bytes: 536870912,
      pids_limit: 256,
      max_log_bytes: 65536,
    };
    const output = call("/evaluate", {
      schema_version: 1,
      candidate,
      repo_id: "repo",
      policy,
      environment: {
        schema_version: 1,
        provider: "docker-ephemeral-vm",
        image_oid: image,
        network: "DENIED",
      },
    });
    assert.equal(
      output.evidence.result,
      "PASSED",
      JSON.stringify(output.receipt),
    );
    assert.equal(output.evidence.subject_digest, candidate.candidate_digest);
    assert.equal(
      await payloadDigest(Uint8Array.from(output.payload)),
      output.evidence.payload_digest,
    );
    assert(
      output.receipt.checks.every(
        (check: { exit_code: number }) => check.exit_code === 0,
      ),
    );
    assert.throws(() => call("/stage", {}));
    docker(["rm", "--force", id]);
  }
});
