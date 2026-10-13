import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { signToken } from "../src/auth.ts";
import { decisionFixture } from "./helpers/decisions.ts";
import { until, scope } from "./helpers/convergence.ts";

const root = resolve(import.meta.dirname, "../../..");
const { chromium } = createRequire(join(root, "apps/web/package.json"))(
  "@playwright/test",
);

async function browserFixture(
  t: { after: (fn: () => unknown) => void },
  partial = false,
) {
  const f = await decisionFixture(t, { partial });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.method ?? "GET";
      const result = await f.mf.dispatchFetch(
        "https://klocgit.test" + request.url,
        {
          method,
          headers: request.headers as Record<string, string>,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: Buffer.concat(chunks) }),
        },
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body) {
        response.end();
        return;
      }
      const reader = result.body.getReader();
      response.on("close", () => {
        void reader.cancel().catch(() => undefined);
      });
      while (!response.destroyed) {
        const next = await reader.read();
        if (next.done) break;
        response.write(Buffer.from(next.value));
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  let output = "";
  const vite = spawn(
    process.execPath,
    [
      join(root, "apps/web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "43173",
      "--strictPort",
    ],
    {
      cwd: join(root, "apps/web"),
      env: {
        ...process.env,
        KLOCGIT_API_ORIGIN: "http://127.0.0.1:" + address.port,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  vite.stdout.on("data", (data) => {
    output += data;
  });
  vite.stderr.on("data", (data) => {
    output += data;
  });
  t.after(() => {
    vite.kill("SIGTERM");
    server.closeAllConnections();
    server.close();
  });
  await until(async () => {
    if (vite.exitCode !== null) throw new Error("Web server exited: " + output);
    try {
      return (await fetch("http://127.0.0.1:43173")).ok;
    } catch {
      return false;
    }
  }, 20000);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto("http://127.0.0.1:43173");
  await page
    .getByLabel("Access credential")
    .fill(await signToken(f.principal, f.authKey));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "Needs your attention" }).waitFor();
  await page.getByLabel("Name", { exact: true }).fill("Fixture");
  await page.getByLabel("Email", { exact: true }).fill("fixture@example.org");
  await page
    .getByRole("radio", { name: "Alternative 1", exact: true })
    .waitFor();
  return { f, page };
}

test("mobile triage inspects real blast radius and receipts, then promotes the reviewed Git tree", async (t) => {
  const { f, page } = await browserFixture(t);
  const [packet] = await f.decisions();
  await page
    .getByRole("heading", { name: "Public API", exact: true })
    .waitFor();
  await page
    .getByText("Changed files and source attribution", { exact: true })
    .click();
  assert((await page.locator("body").textContent()).includes("retry.ts"));
  await page
    .getByRole("button", {
      name: "Inspect evidence trusted-sandbox",
      exact: true,
    })
    .click();
  await page.getByLabel("Test receipt", { exact: true }).waitFor();
  assert(
    (
      await page.getByLabel("Test receipt", { exact: true }).textContent()
    ).includes("vitest"),
  );
  assert(
    (
      await page.getByLabel("Test receipt", { exact: true }).textContent()
    ).includes(packet.candidates[0].candidate.candidate_digest),
  );
  await page.getByText("Live updates connected", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(0, 0, 0)",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  console.log(
    "KLOCGIT_SCREENSHOT " + (await page.screenshot()).toString("base64"),
  );
  await page
    .getByRole("button", { name: "Approve and promote", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Nothing needs your decision" })
    .waitFor({ timeout: 30000 });
  const remote = join(f.directory, "remote.git");
  const head = f.git(["--git-dir", remote, "rev-parse", "refs/heads/main"]);
  assert.notEqual(head, f.base);
  assert.equal(
    f.git(["--git-dir", remote, "rev-parse", head + "^{tree}"]),
    packet.candidates[0].candidate.repo_tree_oids[scope.repo_id],
  );
});

test("required missing analysis blocks approval in the actual browser", async (t) => {
  const { f, page } = await browserFixture(t, true);
  await page
    .getByText("Required analysis capability is unavailable", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Approve and promote", exact: true })
      .isEnabled(),
    false,
  );
  assert.equal(f.prepared, 0);
});

test("an external push appears as a stale review in the live attention stream", async (t) => {
  const { f, page } = await browserFixture(t);
  f.git([
    "-C",
    join(f.directory, "driver"),
    "push",
    "--force-with-lease=refs/heads/main:" + f.base,
    "origin",
    f.commits.at(-1)! + ":refs/heads/main",
  ]);
  await page
    .getByText("Review needs updating", { exact: true })
    .waitFor({ timeout: 15000 });
  assert.equal(
    await page
      .getByRole("button", { name: "Approve and promote", exact: true })
      .isEnabled(),
    false,
  );
  assert.equal(f.prepared, 0);
});
