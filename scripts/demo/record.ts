import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { hkdfSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { signToken } from "../../apps/worker/src/auth.ts";
import { decisionFixture } from "../../apps/worker/tests/helpers/decisions.ts";
import { until } from "../../apps/worker/tests/helpers/convergence.ts";
import { interactionDemo } from "./interaction.ts";
import {
  beginRecording,
  endRecording,
  finishRecording,
  quietWait,
  sceneStart,
  sceneEnd,
  retainedSeconds,
  guidedShot,
  type RecordedClip,
} from "./presentation.ts";

import { submissionStory, type Beat } from "./story.ts";

const root = resolve(import.meta.dirname, "../..");
const output = join(root, "demo-output");
mkdirSync(join(output, "recordings"), { recursive: true });
const { chromium } = createRequire(join(root, "apps/web/package.json"))(
  "@playwright/test",
);
const cleanup: (() => unknown)[] = [];
const lifecycle = { after: (fn: () => unknown) => cleanup.push(fn) };
const clips: RecordedClip[] = [];
const transcript: {
  time: number;
  seconds: number;
  chapter: string;
  text: string;
}[] = [];
const proof: Record<string, unknown> = {};
let elapsed = 0;
let story: Beat[] = [];
let durations: Record<string, number> = {};

async function ownerSession() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !apiToken)
    throw new Error("Existing Cloudflare deployment access is required");
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" +
      account +
      "/workers/scripts/klocgit/settings",
    {
      headers: { Authorization: "Bearer " + apiToken },
      signal: AbortSignal.timeout(30000),
    },
  );
  const body = await response.json();
  if (!response.ok || !body.success)
    throw new Error("Cloudflare settings could not be read");
  const bindings = body.result.bindings;
  const setting = (name: string) =>
    bindings.find((item: { name: string }) => item.name === name)?.text;
  const actor = setting("ACTOR_ID");
  const organization = JSON.parse(setting("OWNER_SCOPE") ?? "");
  if (!actor || !organization.tenant_id || !organization.organization_id)
    throw new Error("Owner session is not configured");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      apiToken,
      account,
      "klocgit.authentication.schema-1",
      32,
    ),
  ).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(
    {
      sub: actor,
      actor_type: "human",
      iss: setting("AUTH_ISSUER"),
      aud: setting("AUTH_AUDIENCE"),
      iat: now,
      exp: now + 3600,
      grants: [],
      organization_grants: [
        {
          scope: organization,
          actions: [
            "read",
            "ingest",
            "promote",
            "repository:create",
            "repository:fork",
          ],
        },
      ],
    },
    key,
  );
  console.log("::add-mask::" + token);
  return { token, organization };
}

async function api(session: { token: string }, path: string, body?: unknown) {
  const response = await fetch(
    "https://klocgit.vikalpmishra71.workers.dev" + path,
    {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(90000),
      headers: {
        Authorization: "Bearer " + session.token,
        "Content-Type": "application/json",
        "KLoCGit-Version": "2026-10-12",
        ...(body === undefined
          ? {}
          : { "Idempotency-Key": crypto.randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      "Application request failed: " + (result.error?.code ?? response.status),
    );
  return result;
}

async function caption(page: any, chapter: string, mode: string, text: string) {
  await page.evaluate(
    ({ chapter, mode, text }) => {
      document.getElementById("demo-caption")?.remove();
      const strip = document.createElement("div");
      strip.id = "demo-caption";
      strip.style.cssText =
        "position:fixed;bottom:0;left:0;right:0;z-index:999999;background:rgba(0,0,0,.97);border-top:1px solid #343128;padding:18px 32px 20px;font:20px/1.5 system-ui;color:#eeeade;pointer-events:none";
      const label = document.createElement("div");
      label.style.cssText =
        "font:12px/1.4 system-ui;color:#f5ee9e;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px";
      label.textContent = chapter + " · " + mode;
      const copy = document.createElement("div");
      copy.textContent = text;
      strip.append(label, copy);
      document.body.append(strip);
    },
    { chapter, mode, text },
  );
}

async function scene(page: any, id: string, action?: () => Promise<void>) {
  const beat = story.find((item) => item.id === id);
  if (!beat || !durations[id])
    throw new Error("Narration is missing for " + id);
  const start = sceneStart(page);
  const mode = id.startsWith("live.")
    ? "Live Cloudflare"
    : id.startsWith("native.") ||
        id.startsWith("race.") ||
        id.startsWith("policy.")
      ? "Local runtime · real Rust engine"
      : id.startsWith("payment.")
        ? "Local engine · observed container results"
        : "Submission overview";
  await caption(page, beat.title, mode, beat.caption);
  if (action) await action();
  await caption(page, beat.title, mode, beat.caption);
  let shot = 0;
  // Narration runs over changing inspections, rather than a long frozen screen.
  while (retainedSeconds(page, start) < durations[id] + 0.35) {
    const remaining = durations[id] + 0.35 - retainedSeconds(page, start);
    await guidedShot(page, beat.focus, shot++, Math.min(1.8, remaining));
  }
  sceneEnd(page, start, id);
  const seconds = retainedSeconds(page, start);
  transcript.push({
    time: elapsed,
    seconds,
    chapter: beat.title,
    text: beat.narration,
  });
  elapsed += seconds;
}

async function editorial(
  page: any,
  title: string,
  paragraphs: string[],
  code?: string,
) {
  await page.setContent(
    '<html><head><meta charset="utf-8"></head><body></body></html>',
  );
  await page.evaluate(
    ({ title, paragraphs, code }) => {
      document.body.style.cssText =
        "margin:0;background:#000;color:#e8e5d8;font:22px/1.6 system-ui";
      const main = document.createElement("main");
      main.style.cssText = "max-width:1110px;margin:90px auto;padding:0 35px";
      const brand = document.createElement("p");
      brand.textContent = "KLoCGit";
      brand.style.color = "#f5ee9e";
      const heading = document.createElement("h1");
      heading.textContent = title;
      heading.style.cssText =
        "font-size:44px;line-height:1.2;margin:18px 0 30px;letter-spacing:-.035em";
      main.append(brand, heading);
      for (const text of paragraphs) {
        const item = document.createElement("p");
        item.textContent = text;
        main.append(item);
      }
      if (code) {
        const pre = document.createElement("pre");
        pre.textContent = code;
        pre.style.cssText =
          "font:17px/1.7 ui-monospace,monospace;white-space:pre-wrap;border:1px solid #363329;border-radius:12px;padding:22px;color:#f5ee9e;max-height:440px;overflow:hidden";
        main.append(pre);
      }
      document.body.append(main);
    },
    { title, paragraphs, code },
  );
}

const browser = await chromium.launch({ headless: true });
cleanup.push(() => browser.close());
async function clip(chapter: string, run: (page: any) => Promise<void>) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: {
      dir: join(output, "recordings"),
      size: { width: 1600, height: 1000 },
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  await beginRecording(page);
  const began = Date.now();
  try {
    await run(page);
  } catch (error) {
    console.log(
      "KLOCGIT_DEMO_FRAME " +
        (await page.screenshot({ type: "jpeg", quality: 55 })).toString(
          "base64",
        ),
    );
    throw error;
  } finally {
    endRecording(page);
    await context.close();
    const path = await page.video().path();
    clips.push(finishRecording(page, path));
    console.log(
      JSON.stringify({
        chapter,
        seconds: Math.round((Date.now() - began) / 1000),
      }),
    );
  }
}

async function signIn(page: any, url: string, token: string) {
  console.log("::add-mask::" + token);
  await page.goto(url);
  await page.getByRole("button", { name: "Access token", exact: true }).click();
  await page.getByLabel("Access credential").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

try {
  console.log(
    "Preparing real Git, Rust, container, and coordinator scenarios. Executing exact-state candidate evaluations for the recording.",
  );
  const payment = await interactionDemo(cleanup);
  const accepted = await decisionFixture(lifecycle);
  const raced = await decisionFixture(lifecycle);
  const required = await decisionFixture(lifecycle, { partial: true });
  proof.payment = payment.results.map((row) => ({
    label: row.label,
    candidate: row.candidate,
    evidence: row.evidence,
    receipt: row.receipt,
  }));
  proof.convergence = {
    input_refs: accepted.actorRefs,
    packets: await accepted.decisions(),
  };
  const packets = await accepted.decisions();
  story = submissionStory({
    futures: accepted.actorRefs.length,
    groups: packets.length,
    alternatives: packets.reduce(
      (sum, packet) => sum + packet.candidates.length,
      0,
    ),
  });
  writeFileSync(join(output, "story.json"), JSON.stringify(story, null, 2));
  const model = process.env.KLOCGIT_NARRATION_MODEL;
  if (!model)
    throw new Error("The submission requires its local narration model");
  execFileSync(
    process.env.KLOCGIT_NARRATION_PYTHON ?? "python3",
    [
      join(root, "scripts/demo/narrate.py"),
      join(output, "story.json"),
      model,
      join(output, "audio"),
    ],
    {
      stdio: "inherit",
      timeout: 900000,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
      },
    },
  );
  durations = JSON.parse(
    readFileSync(join(output, "audio/durations.json"), "utf8"),
  );

  let current = accepted;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.method ?? "GET";
      const result = await current.mf.dispatchFetch(
        "https://klocgit.demo" + request.url,
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
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
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
      stdio: "ignore",
    },
  );
  cleanup.push(() => vite.kill("SIGTERM"));
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:43173")).ok;
    } catch {
      return false;
    }
  }, 30000);
  const live = await ownerSession();

  await clip("The idea", async (page) => {
    await editorial(page, "More concurrent work. Fewer decisions.", [
      "Git stores the source. KLoCGit coordinates possible states, evidence, decisions, and promotion.",
      "Humans, agents, CI, and ordinary Git clients can all produce work.",
    ]);
    await scene(page, "problem");
  });

  await clip("Isolated repositories", async (page) => {
    await signIn(
      page,
      "https://klocgit.vikalpmishra71.workers.dev/",
      live.token,
    );
    await page
      .getByRole("heading", { name: "Repositories", exact: true })
      .waitFor();
    await scene(page, "live.home");
    const name = "demo-source-" + (process.env.GITHUB_RUN_ID ?? Date.now());
    const base =
      "/api/tenants/" +
      live.organization.tenant_id +
      "/organizations/" +
      live.organization.organization_id +
      "/repos";
    await scene(page, "live.import", async () => {
      await page
        .getByRole("button", { name: "New repository", exact: true })
        .click();
      await page.getByLabel("Repository name", { exact: true }).fill(name);
      await page
        .getByLabel("Description", { exact: true })
        .fill("Cloudflare competition demonstration");
      await page
        .getByLabel("Import from a public Git URL", { exact: true })
        .fill("https://github.com/vik418/KLoCGit.git");
    });
    let repository: any;
    await scene(page, "live.create", async () => {
      const response = page.waitForResponse(
        (result: any) =>
          new URL(result.url()).pathname === base &&
          result.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Create repository", exact: true })
        .click();
      const result = await quietWait(page, () => response);
      repository = await result.json();
      if (!result.ok() || !repository.repo_id)
        throw new Error("Live repository import did not complete");
      await quietWait(page, () =>
        until(async () => {
          const code = await api(
            live,
            base + "/" + repository.repo_id + "/code",
          );
          return !code.empty && code.commits.length > 0;
        }, 180000),
      );
      await page
        .getByRole("button", { name: "All repositories", exact: true })
        .click();
      await page.getByRole("button").filter({ hasText: name }).first().click();
      await page.getByRole("button", { name: "Fork", exact: true }).waitFor();
    });
    await scene(page, "live.browse", async () => {
      const manifest = page.getByRole("button", {
        name: "Cargo.toml",
        exact: true,
      });
      const packageFile = page.getByRole("button", {
        name: "package.json",
        exact: true,
      });
      const file = (await manifest.count()) ? manifest : packageFile;
      await file.click();
      await page.locator("pre").waitFor();
      await page.getByText("Commit history", { exact: true }).click();
    });
    await scene(page, "live.fork", async () => {
      const back = page.getByRole("button", {
        name: "Back to files",
        exact: true,
      });
      if (await back.count()) await back.click();
      await page.getByRole("button", { name: "Fork", exact: true }).click();
      await page
        .getByLabel("Repository name", { exact: true })
        .fill(name + "-producer-1");
      await page
        .getByRole("button", { name: "Create fork", exact: true })
        .click();
      await page
        .getByRole("heading", { name: name + "-producer-1", exact: true })
        .waitFor();
    });
    await scene(page, "live.objective", async () => {
      await page
        .getByLabel("Objective", { exact: true })
        .fill("Improve retries without losing telemetry or source attribution");
      await page
        .getByRole("button", { name: "Create objective", exact: true })
        .click();
      await page
        .getByText("Objective created. Open Attention to review its work.", {
          exact: true,
        })
        .waitFor();
    });
    const forks = await Promise.all(
      [2, 3, 4, 5].map((index) =>
        api(live, base + "/" + repository.repo_id + "/fork", {
          name: name + "-producer-" + index,
          description: "Isolated demo producer " + index,
        }),
      ),
    );
    proof.live = { repository, forks };
    await scene(page, "live.five", async () => {
      await page
        .getByRole("button", { name: "All repositories", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Attention", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Repositories", exact: true })
        .waitFor();
    });
    await scene(page, "live.boundary");
  });

  await clip("Concurrent inputs", async (page) => {
    const input = accepted.actorRefs
      .map(
        (ref, index) =>
          ref +
          "\n" +
          accepted.git([
            "-C",
            join(accepted.directory, "driver"),
            "show",
            "--format=",
            accepted.commits[index],
          ]),
      )
      .join("\n\n");
    await editorial(
      page,
      "Five inputs. Discover the decision.",
      [
        "Identical retry implementations",
        "A materially different retry strategy",
        "Independent telemetry and auth-file changes",
      ],
      input,
    );
    await scene(page, "native.sources");
  });

  await clip("Decision convergence", async (page) => {
    current = accepted;
    await signIn(
      page,
      "http://127.0.0.1:43173",
      await signToken(accepted.principal, accepted.authKey),
    );
    await page
      .getByRole("heading", { name: "Needs your attention", exact: true })
      .waitFor();
    await page
      .getByRole("radio", { name: "Alternative 1", exact: true })
      .first()
      .waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Vikalp Mishra");
    await page
      .getByLabel("Email", { exact: true })
      .fill("vikalpmishra71@gmail.com");
    const packets = await accepted.decisions();
    await scene(page, "native.queue");
    await page.screenshot({ path: join(output, "poster.png") });
    await scene(page, "native.duplicate");
    await scene(page, "native.alternative", async () => {
      const alternatives = page.getByRole("radio", { name: /^Alternative / });
      if ((await alternatives.count()) > 1) await alternatives.nth(1).check();
    });
    await scene(page, "native.blast", async () => {
      const heading = page
        .getByRole("heading", { name: "Public API", exact: true })
        .first();
      await heading.scrollIntoViewIfNeeded();
      const provenance = page
        .getByText("Changed files and source attribution", { exact: true })
        .first();
      await provenance.click();
    });
    await scene(page, "native.provenance", async () => {
      const attribution = page
        .getByText("Changed files and source attribution", { exact: true })
        .first();
      const open = await attribution.evaluate(
        (node: HTMLElement) => node.closest("details")!.open,
      );
      if (!open) await attribution.click();
      await attribution.scrollIntoViewIfNeeded();
    });
    await scene(page, "native.evidence", async () => {
      const button = page
        .getByRole("button", {
          name: "Inspect evidence trusted-sandbox",
          exact: true,
        })
        .first();
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await page.getByLabel("Test receipt", { exact: true }).first().waitFor();
    });
    await scene(page, "native.receipt");
    await scene(page, "native.basis", async () => {
      await page
        .getByText("Exact state and decision basis", { exact: true })
        .first()
        .click();
    });
    const selected = (await accepted.decisions())[0];
    const oldHead = accepted.git([
      "--git-dir",
      join(accepted.directory, "remote.git"),
      "rev-parse",
      "refs/heads/main",
    ]);
    await scene(page, "native.promote", async () => {
      const button = page
        .getByRole("button", { name: "Approve and promote", exact: true })
        .first();
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await page
        .getByRole("heading", {
          name: "Nothing needs your decision",
          exact: true,
        })
        .waitFor({ timeout: 180000 });
      const newHead = accepted.git([
        "--git-dir",
        join(accepted.directory, "remote.git"),
        "rev-parse",
        "refs/heads/main",
      ]);
      const tree = accepted.git([
        "--git-dir",
        join(accepted.directory, "remote.git"),
        "rev-parse",
        newHead + "^{tree}",
      ]);
      if (
        newHead === oldHead ||
        !selected.candidates.some(
          (row) => row.candidate.repo_tree_oids.repo === tree,
        )
      )
        throw new Error(
          "The canonical Git result differs from the reviewed candidate",
        );
      proof.promotion = { oldHead, newHead, tree };
    });
  });

  await clip("Semantic interaction", async (page) => {
    await editorial(
      page,
      "A clean merge can still break behavior.",
      [
        "Future A retries uncertain delivery.",
        "Future B records every charge attempt.",
        "Neither file overlaps the other. Both isolated states pass the trusted payment check.",
      ],
      "A · retry.ts\n" +
        payment.source.retryAfter +
        "\nB · ledger.ts\n" +
        payment.source.ledgerAfter,
    );
    await scene(page, "payment.alone");
    await editorial(
      page,
      "Evaluate the exact combination.",
      payment.results.map((row) => row.label + ": " + row.evidence.result),
      payment.results
        .map(
          (row) =>
            row.label +
            "\nCandidate: " +
            row.candidate.candidate_digest +
            "\nTree: " +
            row.candidate.repo_tree_oids.repo,
        )
        .join("\n\n"),
    );
    await scene(page, "payment.composed");
    const failure = payment.results[2];
    const logs = failure.receipt.checks
      .map((row: any) => row.stdout + "\n" + row.stderr)
      .join("\n")
      .replace(/\u001b\[[0-9;]*m/g, "");
    await editorial(
      page,
      "Two charges. One payment.",
      [
        "The failing receipt belongs to the composed candidate, not either isolated future.",
      ],
      logs.slice(-2600),
    );
    await scene(page, "payment.failure");
    await editorial(
      page,
      "Tests guide the decision; they do not replace it.",
      [
        "Preserve the materially different approaches.",
        "Reject this invalid combination under the explicit payment constraint.",
        "Ask for judgment when alternatives or uncertainty remain.",
      ],
      payment.check,
    );
    await scene(page, "payment.decision");
  });

  await clip("Stale decision protection", async (page) => {
    current = raced;
    await signIn(
      page,
      "http://127.0.0.1:43173",
      await signToken(raced.principal, raced.authKey),
    );
    await page
      .getByRole("radio", { name: "Alternative 1", exact: true })
      .first()
      .waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Vikalp Mishra");
    await page
      .getByLabel("Email", { exact: true })
      .fill("vikalpmishra71@gmail.com");
    const packet = (await raced.decisions())[0];
    const review = await raced.act("review", packet);
    if (!review.ok)
      throw new Error("The stale scenario review was not recorded");
    await scene(page, "race.external", async () => {
      raced.git([
        "-C",
        join(raced.directory, "driver"),
        "push",
        "--force-with-lease=refs/heads/main:" + raced.base,
        "origin",
        raced.commits[2] + ":refs/heads/main",
      ]);
    });
    await scene(page, "race.stale", async () => {
      await page
        .getByText("Review needs updating", { exact: true })
        .first()
        .waitFor({ timeout: 30000 });
      const rejected = await raced.act("promote", packet);
      const result = await rejected.json();
      if (rejected.status !== 409)
        throw new Error("A stale promotion was not rejected");
      proof.stale = { http_status: rejected.status, result };
    });
    await scene(page, "race.reject");
  });

  await clip("Required analysis", async (page) => {
    current = required;
    await signIn(
      page,
      "http://127.0.0.1:43173",
      await signToken(required.principal, required.authKey),
    );
    await page
      .getByRole("radio", { name: "Alternative 1", exact: true })
      .first()
      .waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Vikalp Mishra");
    await page
      .getByLabel("Email", { exact: true })
      .fill("vikalpmishra71@gmail.com");
    await scene(page, "policy.required", async () => {
      await page
        .getByText("Required analysis capability is unavailable", {
          exact: true,
        })
        .first()
        .scrollIntoViewIfNeeded();
    });
    await scene(page, "policy.disabled", async () => {
      const button = page
        .getByRole("button", { name: "Approve and promote", exact: true })
        .first();
      await button.scrollIntoViewIfNeeded();
      if (await button.isEnabled())
        throw new Error("Required missing analysis did not block approval");
      proof.analysis_blocked = true;
    });
  });

  await clip("Where Cloudflare fits", async (page) => {
    await editorial(page, "State, execution, coordination.", [
      "Artifacts: durable isolated Git repositories.",
      "Workers + Durable Objects: API and serialized coordination.",
      "Queues: asynchronous analysis. R2: evidence payloads.",
      "Rust containers: extraction, reduction, composition, and evaluation.",
    ]);
    await scene(page, "cloud.arch");
    await editorial(page, "Demonstrated, with clear boundaries.", [
      "Live: repository import, source browsing, and isolated Artifacts forks.",
      "Local: deterministic reduction, exact-state evaluation, review, Git CAS, and stale-decision rejection.",
      "Full live convergence and large-scale evaluation remain unfinished.",
    ]);
    await scene(page, "cloud.scope");
    await editorial(page, "Explore many states. Accept one coherent result.", [
      "The goal: human attention proportional to meaningful choices, not the amount of generated work.",
      "Open source: github.com/vik418/KLoCGit",
      "Implementation branch: feat/convergence-platform",
    ]);
    await scene(page, "closing");
    console.log(
      "KLOCGIT_DEMO_POSTER " +
        readFileSync(join(output, "poster.png")).toString("base64"),
    );
  });

  writeFileSync(join(output, "clips.json"), JSON.stringify(clips, null, 2));
  writeFileSync(
    join(output, "narration.txt"),
    transcript.map((item) => item.chapter + "\n" + item.text + "\n").join("\n"),
  );
  writeFileSync(
    join(output, "recording.json"),
    JSON.stringify(
      {
        schema_version: 1,
        source_commit: process.env.GITHUB_SHA,
        measured_seconds: elapsed,
        chapters: transcript,
        proof,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ recorded_seconds: elapsed, clips: clips.length }),
  );
} finally {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {}
  }
}
