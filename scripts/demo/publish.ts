import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const output = join(root, "demo-output");
const file = join(output, "klocgit-demo.mp4");
const media = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8" }));
const duration = Number(media.format.duration);
if (!Number.isFinite(duration) || duration < 300 || duration > 600) throw new Error("The competition video must be between five and ten minutes");
if (statSync(file).size >= 2 * 1024 * 1024 * 1024) throw new Error("The video exceeds the submission upload limit");

const temporary = mkdtempSync(join(tmpdir(), "klocgit-demo-publish-"));
const run = process.env.GITHUB_RUN_ID;
if (!run || !/^\d+$/.test(run)) throw new Error("The recording needs an immutable run identifier");
const prefix = "demo/" + run + "/";
const names = ["klocgit-demo.mp4", "poster.png", "narration.txt"];
function wrangler(args: string[]) {
  execFileSync("npx", ["--yes", "wrangler@4.147.0", ...args], { cwd: root, stdio: "inherit", timeout: 300000 });
}
try {
  for (const name of names) wrangler(["r2", "object", "put", "klocgit-payloads/" + prefix + name,
    "--remote", "--file", join(output, name), "--content-type", name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".png") ? "image/png" : "text/plain"]);
  const player = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>KLoCGit demo</title><style>body{margin:0;background:#000;color:#e7e5d8;font:16px/1.6 system-ui}main{max-width:1100px;margin:40px auto;padding:24px}h1{font-size:32px;letter-spacing:-.03em}a{color:#f5ee9e}video{width:100%;border:1px solid #333;border-radius:12px}nav{display:flex;gap:24px;flex-wrap:wrap}</style><main><h1>KLoCGit</h1><p>Software-state convergence. Live repository flow and a clearly labeled local convergence demonstration.</p><video controls preload=\"metadata\" poster=\"/poster.png\" src=\"/klocgit-demo.mp4\"></video><nav><a href=\"/klocgit-demo.mp4?download=1\">Download MP4</a><a href=\"/narration.txt\">Read captions</a><a href=\"https://github.com/vik418/KLoCGit/tree/feat/convergence-platform\">Source code</a></nav></main></html>";
  const worker = "const files = new Set(" + JSON.stringify(names) + ");\nexport default {async fetch(request, env) {\n" +
    "const url = new URL(request.url); if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', {status:405});\n" +
    "if (url.pathname === '/') return new Response(" + JSON.stringify(player) + ",{headers:{'content-type':'text/html;charset=utf-8'}});\n" +
    "const name=url.pathname.slice(1); if (!files.has(name)) return new Response('Not found',{status:404});\n" +
    "const object=await env.DEMO_ASSETS.get(env.DEMO_PREFIX+name,{range:request.headers}); if (!object) return new Response('Not found',{status:404});\n" +
    "const headers=new Headers(); object.writeHttpMetadata(headers); headers.set('etag',object.httpEtag); headers.set('accept-ranges','bytes'); headers.set('cache-control','public,max-age=3600');\n" +
    "const partial=object.range && 'offset' in object.range && 'length' in object.range; if(partial) headers.set('content-range','bytes '+object.range.offset+'-'+(object.range.offset+object.range.length-1)+'/'+object.size);\n" +
    "headers.set('content-length',String(partial?object.range.length:object.size)); if(url.searchParams.get('download')==='1') headers.set('content-disposition','attachment; filename=\"'+name+'\"');\n" +
    "return new Response(request.method==='HEAD'?null:object.body,{status:partial?206:200,headers});\n}};\n";
  writeFileSync(join(temporary, "worker.js"), worker);
  writeFileSync(join(temporary, "wrangler.toml"), [
    'name = "klocgit-demo"', 'main = "worker.js"', 'compatibility_date = "2026-08-06"', 'workers_dev = true',
    '[vars]', "DEMO_PREFIX = " + JSON.stringify(prefix),
    '[[r2_buckets]]', 'binding = "DEMO_ASSETS"', 'bucket_name = "klocgit-payloads"',
  ].join("\n"));
  wrangler(["deploy", "--config", join(temporary, "wrangler.toml")]);
  const deployment = { schema_version: 1, seconds: duration, bytes: statSync(file).size, source_commit: process.env.GITHUB_SHA,
    watch_url: "https://klocgit-demo.vikalpmishra71.workers.dev/",
    download_url: "https://klocgit-demo.vikalpmishra71.workers.dev/klocgit-demo.mp4?download=1" };
  writeFileSync(join(output, "download.json"), JSON.stringify(deployment, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY,
    "# KLoCGit demo\n\n[Watch video](" + deployment.watch_url + ")\n\n[Download MP4](" + deployment.download_url + ")\n\n" +
    Math.round(duration) + " seconds. Live Cloudflare and local convergence sections are labeled.\n", { flag: "a" });
  console.log(JSON.stringify(deployment));
} finally { rmSync(temporary, { recursive: true, force: true }); }
