import { execFileSync } from "node:child_process";
import type { Focus } from "./story.ts";

type Interval = { start: number; end: number; beat_id?: string };
export type RecordedClip = {
  path: string;
  ranges: Interval[];
  omitted: Interval[];
};
const sessions = new WeakMap<
  object,
  { began: number; ended?: number; ranges: Interval[]; omitted: Interval[] }
>();
let instrumented = false;

function pointerOverlay() {
  if (document.getElementById("demo-pointer")) return;
  const style = document.createElement("style");
  style.textContent = `
    #demo-pointer { position:fixed; left:0; top:0; width:14px; height:14px;
      border:2px solid #000; border-radius:50%; background:#f5ee9e;
      box-shadow:0 0 0 3px rgba(245,238,158,.3); z-index:1000001;
      pointer-events:none; opacity:0; transform:translate(-100px,-100px); }
    #demo-action { position:fixed; top:22px; right:24px; max-width:480px;
      background:#000; border:1px solid #f5ee9e; border-radius:9px;
      color:#f5ee9e; padding:10px 16px; font:600 18px/1.4 system-ui;
      z-index:1000000; pointer-events:none; opacity:0; }
    .demo-click { position:fixed; width:38px; height:38px; border-radius:50%;
      border:4px solid #f5ee9e; background:rgba(245,238,158,.2);
      z-index:1000002; pointer-events:none; }
  `;
  const pointer = document.createElement("div");
  pointer.id = "demo-pointer";
  const action = document.createElement("div");
  action.id = "demo-action";
  document.documentElement.append(style, pointer, action);
  document.addEventListener(
    "mousedown",
    (event) => {
      const ring = document.createElement("div");
      ring.className = "demo-click";
      ring.style.left = event.clientX - 23 + "px";
      ring.style.top = event.clientY - 23 + "px";
      document.documentElement.append(ring);
      ring
        .animate(
          [
            { transform: "scale(.65)", opacity: 1 },
            { transform: "scale(2)", opacity: 0 },
          ],
          { duration: 900, easing: "ease-out" },
        )
        .finished.then(() => ring.remove());
    },
    true,
  );
}

async function pointTo(locator: any, verb: string) {
  const page = locator.page();
  await locator.scrollIntoViewIfNeeded();
  // Navigation can replace nodes inserted before the document finishes parsing.
  await page.evaluate(pointerOverlay);
  const box = await locator.boundingBox();
  if (!box) return;
  const label = await locator.evaluate(
    (element: any) =>
      element.labels?.[0]?.textContent ||
      element.getAttribute("aria-label") ||
      element.textContent?.trim() ||
      element.getAttribute("name") ||
      "Field",
  );
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(
    async ({ x, y, label, verb }: any) => {
      const pointer = document.getElementById("demo-pointer")!;
      const action = document.getElementById("demo-action")!;
      action.textContent =
        verb + " · " + label.replace(/\s+/g, " ").slice(0, 65);
      action.style.opacity = "1";
      pointer.style.opacity = "1";
      const target = "translate(" + (x - 7) + "px," + (y - 7) + "px)";
      const motion = pointer.animate(
        [{ transform: pointer.style.transform }, { transform: target }],
        { duration: 450, easing: "ease-in-out", fill: "forwards" },
      );
      await motion.finished;
      pointer.style.transform = target;
      motion.cancel();
    },
    { x, y, label, verb },
  );
  await page.mouse.move(x, y);
  await page.waitForTimeout(250);
}

export async function quietWait<T>(
  page: any,
  run: () => Promise<T>,
): Promise<T> {
  const session = sessions.get(page);
  const began = Date.now();
  try {
    return await run();
  } finally {
    const seconds = (Date.now() - began) / 1000;
    if (session && seconds > 2.5)
      session.omitted.push({
        start: (began - session.began) / 1000 + 0.65,
        end: (Date.now() - session.began) / 1000 - 0.65,
      });
  }
}

export async function beginRecording(page: any) {
  sessions.set(page, { began: Date.now(), ranges: [], omitted: [] });
  await page.addInitScript(pointerOverlay);
  await page.evaluate(pointerOverlay);
  if (instrumented) return;
  instrumented = true;
  const prototype = Object.getPrototypeOf(page.locator("body"));
  for (const method of ["click", "check", "fill", "waitFor"]) {
    const original = prototype[method];
    prototype[method] = async function (...args: any[]) {
      const activePage = this.page();
      if (!sessions.has(activePage)) return original.apply(this, args);
      if (method === "waitFor")
        return quietWait(activePage, () => original.apply(this, args));
      await pointTo(this, method === "fill" ? "Type" : "Click");
      let result;
      if (
        method === "fill" &&
        args[0].length <= 90 &&
        (await this.getAttribute("type")) !== "password"
      ) {
        await original.call(this, "", args[1]);
        result = await this.pressSequentially(args[0], { delay: 22 });
      } else {
        result = await original.apply(
          this,
          method === "click" ? [{ ...args[0], delay: 350 }] : args,
        );
      }
      await activePage.waitForTimeout(650);
      await activePage.evaluate(() => {
        const action = document.getElementById("demo-action");
        if (action) action.style.opacity = "0";
      });
      return result;
    };
  }
}

export function sceneStart(page: any) {
  return (Date.now() - sessions.get(page)!.began) / 1000;
}
export function sceneEnd(page: any, start: number, beat_id: string) {
  sessions.get(page)!.ranges.push({ start, end: sceneStart(page), beat_id });
}

export function keptIntervals(
  range: Interval,
  omitted: Interval[],
): Interval[] {
  let parts = [range];
  for (const cut of omitted)
    parts = parts.flatMap((part) => {
      if (cut.end <= part.start || cut.start >= part.end) return [part];
      return [
        { ...part, end: Math.min(part.end, cut.start) },
        { ...part, start: Math.max(part.start, cut.end) },
      ].filter((item) => item.end - item.start > 0.02);
    });
  return parts;
}

export function retainedSeconds(page: any, start: number): number {
  const session = sessions.get(page)!;
  return keptIntervals(
    { start, end: sceneStart(page) },
    session.omitted,
  ).reduce((sum, part) => sum + part.end - part.start, 0);
}

/** Move through real UI details while narration explains them; never stretch a still. */
export async function guidedShot(
  page: any,
  focus: Focus,
  index: number,
  seconds: number,
) {
  const selectors: Record<Focus, string> = {
    overview: "main h1, main h2, main > p:not(:first-child), main pre",
    repositories:
      "section h1, section form label, section form input, section pre, section summary",
    alternatives: "main h1, fieldset label, [data-slot=card-title]",
    blast:
      "[aria-label='Blast radius'] h4, [aria-label='Blast radius'] details, [aria-label='Blast radius'] li",
    evidence:
      "[aria-label='Evidence'] h4, [aria-label='Evidence'] [data-slot=badge], [aria-label='Test receipt']",
    basis: "details[open] dt, details[open] dd",
    blocked: "[role=alert], [data-slot=card-title], main h1",
  };
  const targets = page.locator(selectors[focus]);
  const count = await targets.count();
  const target = count
    ? targets.nth(index % count)
    : page.locator("main h1").first();
  if (!(await target.count())) {
    await page.waitForTimeout(seconds * 1000);
    return;
  }
  const root = page.locator("#root");
  if (await root.count())
    await root.evaluate((node: HTMLElement, index: number) => {
      node.style.zoom = index % 2 ? "1.16" : "1.08";
    }, index);
  await target.scrollIntoViewIfNeeded();
  await target.evaluate((node: HTMLElement) => {
    node.style.outline = "2px solid #f5ee9e";
    node.style.outlineOffset = "8px";
  });
  if (await target.evaluate((node: HTMLElement) => node.tagName === "PRE"))
    await target.evaluate((node: HTMLElement, index: number) => {
      node.scrollTop = index % 2 ? node.scrollHeight : 0;
    }, index);
  await page.waitForTimeout(seconds * 1000);
  await target.evaluate((node: HTMLElement) => {
    node.style.outline = "";
    node.style.outlineOffset = "";
  });
  if (await root.count())
    await root.evaluate((node: HTMLElement) => {
      node.style.zoom = "";
    });
}

export function endRecording(page: any) {
  sessions.get(page)!.ended = Date.now();
}
export function finishRecording(page: any, path: string): RecordedClip {
  const session = sessions.get(page)!;
  const actual = Number(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  // Capture the recording clock before encoder startup and context-close latency.
  const offset = actual - (session.ended! - session.began) / 1000;
  const adjust = (range: Interval) => ({
    ...range,
    start: Math.max(0, range.start + offset),
    end: Math.min(actual, range.end + offset),
  });
  return {
    path,
    ranges: session.ranges.map(adjust),
    omitted: session.omitted.map(adjust),
  };
}
