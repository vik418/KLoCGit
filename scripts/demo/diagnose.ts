import { hkdfSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { signToken } from "../../apps/worker/src/auth.ts";
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const secret = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !secret) throw new Error("Cloudflare access is required");
const cloud = "https://api.cloudflare.com/client/v4/accounts/" + account;
async function cf(path: string) {
  const response = await fetch(cloud + path, { headers: { Authorization: "Bearer " + secret }, signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  return { status: response.status, success: body.success, result: body.result, errors: body.errors?.map((row: { code: number }) => row.code) };
}
const settings = await cf("/workers/scripts/klocgit/settings");
const setting = (name: string) => settings.result.bindings.find((row: { name: string }) => row.name === name)?.text;
const organization = JSON.parse(setting("OWNER_SCOPE"));
const key = Buffer.from(hkdfSync("sha256", secret, account, "klocgit.authentication.schema-1", 32)).toString("hex");
const now = Math.floor(Date.now() / 1000);
const token = await signToken({ sub: setting("ACTOR_ID"), actor_type: "human", iss: setting("AUTH_ISSUER"), aud: setting("AUTH_AUDIENCE"),
  iat: now, exp: now + 900, grants: [], organization_grants: [{ scope: organization, actions: ["read"] }] }, key);
console.log("::add-mask::" + token);
const base = "/api/tenants/" + organization.tenant_id + "/organizations/" + organization.organization_id + "/repos";
async function app(path: string) {
  const response = await fetch("https://klocgit.vikalpmishra71.workers.dev" + path, {
    headers: { Authorization: "Bearer " + token, "KLoCGit-Version": "2026-10-12" }, signal: AbortSignal.timeout(30000) });
  return { status: response.status, body: await response.json() };
}
const listed = await app(base);
for (const repository of listed.body.repositories.filter((row: { name: string }) => row.name.startsWith("demo-source-"))) {
  console.log(JSON.stringify({ repository: repository.name, state: repository.state }));
  const read = await app(base + "/" + repository.repo_id + "/token");
  if (read.status !== 200) { console.log(JSON.stringify({ read_status: read.status, error: read.body.error })); continue; }
  console.log("::add-mask::" + read.body.token);
  const refs = execFileSync("git", ["-c", "http.extraHeader=Authorization: Bearer " + read.body.token, "ls-remote", "--symref", read.body.remote], {
    encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(JSON.stringify({ repository: repository.name, git_refs: refs.trim() }));
  const physical = new URL(read.body.remote).pathname.split("/").at(-1)!.replace(/\.git$/, "");
  const meta = await cf("/artifacts/namespaces/klocgit/repos/" + encodeURIComponent(physical));
  console.log(JSON.stringify({ metadata_status: meta.status, metadata: meta.success ? meta.result : undefined, error_codes: meta.errors }));
  const head = refs.split("\n").find(line => line.endsWith("\tHEAD"))?.split("\t")[0];
  for (const ref of ["HEAD", "main", "refs/heads/main", ...(head ? [head] : [])]) {
    const raw = await cf("/artifacts/namespaces/klocgit/repos/" + encodeURIComponent(physical) + "/log?ref=" + encodeURIComponent(ref) + "&limit=1");
    console.log(JSON.stringify({ repository: repository.name, ref, rest_status: raw.status, rest_result: raw.result, rest_errors: raw.errors }));
  }
  for (const ref of ["HEAD", "refs/heads/main", ...(head ? [head] : [])]) {
    const code = await app(base + "/" + repository.repo_id + "/code?ref=" + encodeURIComponent(ref));
    console.log(JSON.stringify({ repository: repository.name, ref, app_status: code.status, empty: code.body.empty,
      commit_oid: code.body.commit_oid, count: code.body.commits?.length, error: code.body.error }));
  }
}
throw new Error("Diagnostic capture completed; recording paused until repository history is reconciled");
