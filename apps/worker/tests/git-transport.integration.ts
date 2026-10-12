import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as portServer } from "node:net";
import test from "node:test";
import { hashProjection, sealCandidate } from "../../../packages/contracts/src/index.ts";

const image = process.env.KLOCGIT_NATIVE_IMAGE;
assert.match(image ?? "", /^sha256:[0-9a-f]{64}$/);
const docker = (args: string[]) =>
  execFileSync("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();

async function availablePort(): Promise<number> {
  const server = portServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("native receive-pack CAS rejects stale and concurrent promotions and retains bound receipts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "klocgit-git-transport-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: directory,
      input,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  git(["init", "--bare", remote]);
  git(["--git-dir", remote, "config", "http.receivepack", "true"]);
  const blob = git(
    ["--git-dir", remote, "hash-object", "-w", "--stdin"],
    "base",
  );
  const tree = git(
    ["--git-dir", remote, "mktree"],
    "100644 blob " + blob + "\tstate.txt\n",
  );
  const base = git(["--git-dir", remote, "commit-tree", tree, "-m", "base"]);
  git(["--git-dir", remote, "update-ref", "refs/heads/main", base]);
  const targets = ["first", "second"].map((value) => {
    const blob = git(
      ["--git-dir", remote, "hash-object", "-w", "--stdin"],
      value,
    );
    const tree = git(
      ["--git-dir", remote, "mktree"],
      "100644 blob " + blob + "\tstate.txt\n",
    );
    const commit = git([
      "--git-dir",
      remote,
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      value,
    ]);
    git([
      "--git-dir",
      remote,
      "update-ref",
      "refs/futures/fixture/" + value,
      commit,
    ]);
    return commit;
  });
  const key = join(directory, "tls.key"),
    cert = join(directory, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const transportToken = randomBytes(32).toString("hex");
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      if (request.headers.authorization !== "Bearer " + transportToken) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(request.url!, "https://localhost");
      const backend = spawn(git(["--exec-path"]) + "/git-http-backend", [], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: directory,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: request.headers["content-length"] ?? "",
          REMOTE_USER: "fixture",
          SERVER_PROTOCOL: "HTTP/1.1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      request.pipe(backend.stdin);
      backend.stderr.resume();
      const pieces: Buffer[] = [];
      let size = 0;
      backend.stdout.on("data", (piece) => {
        size += piece.length;
        if (size > 8 * 1024 * 1024) {
          backend.kill("SIGKILL");
          return;
        }
        pieces.push(piece);
      });
      backend.on("close", () => {
        const bytes = Buffer.concat(pieces);
        const boundary = bytes.indexOf("\r\n\r\n");
        if (boundary < 0) {
          response.writeHead(502).end();
          return;
        }
        const headers = bytes
          .subarray(0, boundary)
          .toString("utf8")
          .split("\r\n");
        let status = 200;
        for (const header of headers) {
          const separator = header.indexOf(":");
          if (separator < 0) continue;
          const name = header.slice(0, separator),
            value = header.slice(separator + 1).trim();
          if (name.toLowerCase() === "status")
            status = Number(value.split(" ")[0]);
          else response.setHeader(name, value);
        }
        response.writeHead(status).end(bytes.subarray(boundary + 4));
      });
      backend.on("error", () => response.writeHead(502).end());
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const remoteUrl =
    "https://127.0.0.1:" +
    (server.address() as { port: number }).port +
    "/remote.git";
  const instances = [];
  for (let index = 0; index < 2; index++) {
    const port = await availablePort(),
      session = randomBytes(32).toString("hex");
    // Host networking is confined to this transport contract test. Evaluation
    // isolation is exercised independently with network=none.
    const id = docker([
      "create",
      "--network=host",
      "--read-only",
      "--cap-drop=ALL",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=268435456",
      "--mount=type=bind,src=" + cert + ",dst=/fixture-ca.pem,readonly",
      "--env=SSL_CERT_FILE=/fixture-ca.pem",
      "--env=KLOCGIT_HOST_ROLE=git",
      "--env=KLOCGIT_HOST_PORT=" + port,
      "--env=KLOCGIT_SESSION=" + session,
      image!,
    ]);
    t.after(() => {
      try {
        docker(["rm", "--force", id]);
      } catch {}
    });
    docker(["start", id]);
    const endpoint = "http://127.0.0.1:" + port;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        ready = (await fetch(endpoint + "/health")).ok;
        if (ready) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready);
    const call = async (action: string, payload: unknown) => {
      const response = await fetch(endpoint + action, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-klocgit-session": session,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120000),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    instances.push({ call, id });
  }
  const scope = {
    tenant_id: "tenant",
    organization_id: "organization",
    repo_id: "repo",
    objective_id: "objective",
  };
  const commands = await Promise.all(
    targets.map(async (target_oid) => {
      const command = {
        scope,
        ref: "refs/heads/main",
        expected_oid: base,
        target_oid,
        idempotency_key: randomUUID(),
      };
      return {
        schema_version: 1,
        remote: remoteUrl,
        artifact_token: transportToken,
        ref_name: command.ref,
        expected_oid: base,
        target_oid,
        idempotency_key: command.idempotency_key,
        operation_digest: await hashProjection("klocgit.git-cas", command),
      };
    }),
  );
  const outcomes = await Promise.all(
    instances.map((instance, index) =>
      instance.call("/git/cas", commands[index]),
    ),
  );
  const applied = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => outcome.body.status === "APPLIED");
  assert.equal(applied.length, 1, JSON.stringify(outcomes));
  const winner = applied[0].index;
  assert.equal(
    git(["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    targets[winner],
  );
  const duplicate = await instances[winner].call("/git/cas", commands[winner]);
  assert.deepEqual(duplicate.body, applied[0].outcome.body);
  const stale = await instances[winner].call("/git/cas", {
    ...commands[1 - winner],
    idempotency_key: randomUUID(),
  });
  assert.equal(stale.body.status, "NO_EFFECT");
  const receipt = await instances[winner].call("/git/operation", {
    idempotency_key: commands[winner].idempotency_key,
    operation_digest: commands[winner].operation_digest,
  });
  assert.equal(receipt.body.status, "APPLIED");
  const workspace = join(directory, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "state.txt"), "novel composed state");
  const localObjects = join(directory, "candidate-objects.git");
  git(["init", "--bare", localObjects]);
  const novelBlob = git(["--git-dir", localObjects, "hash-object", "-w", "--stdin"], "novel composed state");
  const scratchTree = git(["--git-dir", localObjects, "mktree"], "100644 blob " + novelBlob + "\tstate.txt\n");
  const candidate = await sealCandidate({ candidate_spec_id: await hashProjection("test.novel-spec", {}), repo_tree_oids: { repo: scratchTree },
    materialization_record: { executor_id: "test", materialized_at: new Date().toISOString(), conflicts_encountered: [] } });
  const basis_digest = await hashProjection("test.novel-basis", { candidate_digest: candidate.candidate_digest });
  const prepare = JSON.parse(execFileSync("target/debug/klocgit-engine", [], {
    input: JSON.stringify({ operation: "prepare_commit", workspace, candidate, repo_id: "repo", expected_oid: targets[winner],
      decision_id: "novel-decision", basis_digest, author: { name: "Engineer", email: "engineer@example.test", unix_timestamp: 1700000000 },
      max_pack_bytes: 1024 * 1024 }), encoding: "utf8",
  }));
  assert.throws(() => git(["--git-dir", remote, "cat-file", "-e", prepare.target_oid]));
  assert.throws(() => git(["--git-dir", remote, "cat-file", "-e", prepare.tree_oid]));
  const novelOperation = { scope, ref: "refs/heads/main", expected_oid: targets[winner], target_oid: prepare.target_oid, idempotency_key: randomUUID() };
  const novel = await instances[winner].call("/git/cas", { schema_version: 1, remote: remoteUrl, artifact_token: transportToken,
    ref_name: novelOperation.ref, expected_oid: novelOperation.expected_oid, target_oid: novelOperation.target_oid,
    idempotency_key: novelOperation.idempotency_key, operation_digest: await hashProjection("klocgit.git-cas", novelOperation),
    pack_hex: prepare.pack_hex, pack_payload_digest: prepare.payload_digest, candidate_tree_oid: prepare.tree_oid });
  assert.equal(novel.body.status, "APPLIED", JSON.stringify(novel));
  assert.equal(git(["--git-dir", remote, "rev-parse", "refs/heads/main"]), prepare.target_oid);
  assert.equal(git(["--git-dir", remote, "show", "refs/heads/main:state.txt"]), "novel composed state");
  assert.equal(git(["--git-dir", remote, "rev-parse", "refs/heads/main^"]), targets[winner]);

  const fresh = await instances[1 - winner].call("/git/operation", {
    idempotency_key: commands[winner].idempotency_key,
    operation_digest: commands[winner].operation_digest,
  });
  assert.equal(fresh.body.status, "UNKNOWN");
});
