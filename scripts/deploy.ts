import { hkdfSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token) throw new Error("Cloudflare deployment credentials are missing.");
const api = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function get(path: string) {
  const response = await fetch(api + path, {
    headers: { Authorization: "Bearer " + token }, redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (response.status === 404) return null;
  if (!response.ok || result.success !== true)
    throw new Error("Cloudflare request failed: " + response.status + " (" + (result.errors ?? []).map((error: { code: number }) => error.code).join(",") + ")");
  return result.result;
}
function wrangler(args: string[]) {
  execFileSync("npx", ["--yes", "wrangler@4.147.0", ...args], {
    stdio: "inherit", timeout: 600000, env: process.env,
  });
}
function derive(info: string) {
  return Buffer.from(hkdfSync("sha256", token!, account!, info, 32)).toString("hex");
}
const authentication = derive("klocgit.authentication.schema-1");
const internal = derive("klocgit.private-transport.schema-1");
console.log("::add-mask::" + authentication);
console.log("::add-mask::" + internal);
const temporary = mkdtempSync(join(tmpdir(), "klocgit-deployment-"));

try {
  const settings = await get("/workers/scripts/klocgit/settings");
  const actor = settings?.bindings?.find((binding: { name: string; type: string }) => binding.name === "ACTOR_ID" && binding.type === "plain_text")?.text;
  if (typeof actor !== "string" || !actor) throw new Error("The existing KLoCGit actor is not configured.");
  if (!settings?.bindings?.some((binding: { name: string; type: string }) => binding.name === "AUTH_TOKEN" && binding.type === "secret_text"))
    throw new Error("The existing KLoCGit owner credential is not configured.");
  const ownerScope = settings.bindings.find((binding: { name: string }) => binding.name === "OWNER_SCOPE")?.text
    ?? JSON.stringify({ tenant_id: account, organization_id: account });
  const scripts = await get("/workers/scripts");
  for (const name of ["klocgit", "klocgit-git-executor"]) {
    const current = scripts.find((script: { id: string }) => script.id === name);
    if (current && !["v1", "convergence-1"].includes(current.migration_tag))
      throw new Error("Existing coordinator migration requires an explicit configuration update.");
  }
  if (!await get("/r2/buckets/klocgit-payloads"))
    wrangler(["r2", "bucket", "create", "klocgit-payloads"]);
  const queues = await get("/queues?per_page=100");
  if (!Array.isArray(queues)) throw new Error("Cloudflare queue metadata has an unsupported shape.");
  for (const name of ["klocgit-analysis", "klocgit-analysis-dlq"])
    if (!queues.some((queue: { queue_name: string }) => queue.queue_name === name))
      wrangler(["queues", "create", name]);

  const engineSecrets = join(temporary, "engine.json");
  const appSecrets = join(temporary, "application.json");
  writeFileSync(engineSecrets, JSON.stringify({ INTERNAL_SIGNING_KEY: internal }), { mode: 0o600 });
  writeFileSync(appSecrets, JSON.stringify({ INTERNAL_SIGNING_KEY: internal, AUTH_SIGNING_KEY: authentication }), { mode: 0o600 });

  // The control Worker already exists, which breaks the service-binding cycle.
  wrangler(["deploy", "--config", "apps/worker/wrangler.engine.toml", "--keep-vars"]);
  wrangler(["secret", "bulk", engineSecrets, "--config", "apps/worker/wrangler.engine.toml"]);
  wrangler(["deploy", "--config", "apps/worker/wrangler.git.toml", "--keep-vars"]);
  wrangler(["secret", "bulk", engineSecrets, "--config", "apps/worker/wrangler.git.toml"]);
  wrangler(["deploy", "--config", "apps/worker/wrangler.toml", "--keep-vars",
    "--var", "OWNER_SCOPE:" + ownerScope, "--var", "ACTOR_ID:" + actor]);
  wrangler(["secret", "bulk", appSecrets, "--config", "apps/worker/wrangler.toml"]);
  console.log("KLoCGit application and native services deployed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
