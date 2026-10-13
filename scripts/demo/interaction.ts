import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashProjection, sealFutureRevision } from "../../packages/contracts/src/index.ts";

const root = resolve(import.meta.dirname, "../..");
const fixtures = join(root, "tests/fixtures/sandbox");

export function native(input: unknown) {
  return JSON.parse(execFileSync(join(root, "target/debug/klocgit-engine"), [], {
    cwd: root, input: JSON.stringify(input), encoding: "utf8",
    timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  }));
}

/** Execute the three exact states; displayed results always come from these receipts. */
export async function interactionDemo(cleanup: (() => unknown)[]) {
  const directory = mkdtempSync(join(tmpdir(), "klocgit-demo-payment-"));
  const checks = mkdtempSync(join(tmpdir(), "klocgit-demo-checks-"));
  cleanup.push(() => { rmSync(directory, { recursive: true, force: true }); rmSync(checks, { recursive: true, force: true }); });
  cpSync(join(fixtures, "interaction"), directory, { recursive: true });
  cpSync(join(fixtures, "interaction-checks"), checks, { recursive: true });
  chmodSync(directory, 0o755); chmodSync(checks, 0o755);
  const git = (location: string, args: string[]) => execFileSync("git", ["-C", location, ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  git(directory, ["init"]); git(directory, ["config", "user.name", "KLoCGit demo"]);
  git(directory, ["config", "user.email", "demo@example.invalid"]);
  git(directory, ["add", "."]); git(directory, ["commit", "-m", "Payment baseline"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  const retryBefore = readFileSync(join(directory, "retry.ts"), "utf8");
  const ledgerBefore = readFileSync(join(directory, "ledger.ts"), "utf8");
  const retryAfter = retryBefore.replace("const attempts = 1;", "const attempts = 2;");
  const ledgerAfter = ledgerBefore.replace("  if (charged.has(id)) return;\n", "");
  if (retryAfter === retryBefore || ledgerAfter === ledgerBefore) throw new Error("Payment scenario does not match its source");
  writeFileSync(join(directory, "retry.ts"), retryAfter);
  git(directory, ["add", "."]); git(directory, ["commit", "-m", "Retry uncertain delivery"]);
  const a = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["checkout", "--detach", base]);
  writeFileSync(join(directory, "ledger.ts"), ledgerAfter);
  git(directory, ["add", "."]); git(directory, ["commit", "-m", "Record each delivery attempt"]);
  const b = git(directory, ["rev-parse", "HEAD"]);

  const observe = async (oid: string, actor: string, path: string, before: string, after: string) => {
    const state = { repo_id: "repo", commit_oid: oid, tree_oid: git(directory, ["rev-parse", oid + "^{tree}"]),
      parent_oids: git(directory, ["show", "-s", "--format=%P", oid]).split(" ").filter(Boolean) };
    const revision = await sealFutureRevision(state, { system_id: "payments",
      ref: "refs/futures/" + actor + "/payment", producer: { actor_id: actor }, observed_at: new Date().toISOString() });
    const effects = native({ operation: "analyze", future_revision_id: revision.id,
      language: "typescript", changes: [{ path, before, after }] });
    return { repository_path: directory, state, revision, effects, changed_paths: [path], required_future_ids: [] };
  };
  const sources = [
    await observe(a, "retry-producer", "retry.ts", retryBefore, retryAfter),
    await observe(b, "ledger-producer", "ledger.ts", ledgerBefore, ledgerAfter),
  ];
  git(checks, ["init"]); git(checks, ["add", "."]);
  const trustedTree = git(checks, ["write-tree"]); rmSync(join(checks, ".git"), { recursive: true, force: true });
  const image = process.env.KLOCGIT_SANDBOX_IMAGE;
  if (!/^sha256:[0-9a-f]{64}$/.test(image ?? "")) throw new Error("The evaluator image must be content addressed");
  const nodeVersion = execFileSync("docker", ["--host=unix:///var/run/docker.sock", "run", "--rm",
    "--network=none", "--env=HTTP_PROXY=", "--env=HTTPS_PROXY=", image!, "node", "--version"], {
    encoding: "utf8", timeout: 30000,
  }).trim().replace(/^v/, "");
  const policy = { schema_version: 1, evaluator_id: "trusted-payment-checks", evaluator_version: "1",
    image_oid: image, language: "typescript",
    supported_toolchains: { schema_version: 1, entries: [{ language: "typescript", version: nodeVersion, image_oid: image }] },
    trusted_suite_state_digest: await hashProjection("klocgit.trusted-suite", { tree_oid: trustedTree }),
    checks: [{ id: "at-most-once-charge", command: ["node", "/opt/node-tools/node_modules/vitest/vitest.mjs",
      "run", "--globals", "--root", "/checks", "--config", "/checks/vitest.config.cjs"] }],
    timeout_ms: 60000, memory_bytes: 536870912, pids_limit: 256, max_log_bytes: 65536,
  };
  const results = [];
  for (const [label, selected] of [["Retry only", [sources[0]]], ["Ledger only", [sources[1]]], ["Retry + ledger", sources]] as const) {
    const reduction = native({ operation: "reduce", base_revisions: { repo: base },
      futures: selected.map(({ repository_path: _path, ...source }) => source),
      budget: { max_candidates: 16, max_futures: 100, max_footprint_entries: 1000, max_output_bytes: 1000000 } });
    if (reduction.candidate_specs.length !== 1) throw new Error("Expected one exact state per payment selection");
    const result = native({ operation: "evaluate_candidate", base_repository: directory, repo_id: "repo",
      candidate_spec: reduction.candidate_specs[0],
      sources: selected.map(({ changed_paths: _paths, required_future_ids: _ids, ...source }) => source),
      trusted_suite: checks, policy });
    if (result.evidence.subject_digest !== result.candidate.candidate_digest) throw new Error("Receipt subject differs from the executed state");
    results.push({ label, ...result });
  }
  if (results.map(item => item.evidence.result).join(",") !== "PASSED,PASSED,FAILED")
    throw new Error("The recorded payment interaction was not reproduced");
  return { results, source: { retryBefore, retryAfter, ledgerBefore, ledgerAfter },
    check: readFileSync(join(fixtures, "interaction-checks/payment.test.ts"), "utf8") };
}
