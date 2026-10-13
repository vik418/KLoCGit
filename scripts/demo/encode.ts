import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RecordedClip } from "./presentation.ts";

const output = resolve(import.meta.dirname, "../../demo-output");
const clips: RecordedClip[] = JSON.parse(readFileSync(join(output, "clips.json"), "utf8"));
const encoded: string[] = [];
for (const [index, clip] of clips.entries()) {
  let kept = clip.ranges;
  for (const cut of clip.omitted) {
    kept = kept.flatMap(range => {
      if (cut.end <= range.start || cut.start >= range.end) return [range];
      return [{ start:range.start, end:Math.min(range.end, cut.start) },
        { start:Math.max(range.start, cut.end), end:range.end }].filter(part => part.end - part.start > .15);
    });
  }
  if (!kept.length) continue;
  const labels = kept.map((_, i) => "[s" + i + "]").join("");
  const filters = ["[0:v]split=" + kept.length + labels];
  kept.forEach((range, i) => filters.push("[s" + i + "]trim=start=" + range.start.toFixed(3) +
    ":end=" + range.end.toFixed(3) + ",setpts=PTS-STARTPTS[v" + i + "]"));
  filters.push(kept.map((_, i) => "[v" + i + "]").join("") +
    "concat=n=" + kept.length + ":v=1:a=0,scale=-2:1080,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[out]");
  const file = join(output, "chapter-" + index + ".mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", clip.path,
    "-filter_complex", filters.join(";"), "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast",
    "-crf", "20", "-pix_fmt", "yuv420p", "-r", "25", "-an", file], { stdio:"inherit", timeout:300000 });
  encoded.push(file);
  console.log(JSON.stringify({ chapter:index, retained_seconds:kept.reduce((sum, part) => sum + part.end - part.start, 0) }));
}
const playlist = join(output, "edited-clips.txt");
writeFileSync(playlist, encoded.map(path => "file '" + path.replaceAll("'", "'\\''") + "'").join("\n"));
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
  "-i", playlist, "-c", "copy", "-movflags", "+faststart", join(output, "klocgit-demo.mp4")],
  { stdio:"inherit", timeout:300000 });

for (const second of [10, 30]) {
  const preview = join(output, "preview-" + second + ".jpg");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(second),
    "-i", join(output, "klocgit-demo.mp4"), "-frames:v", "1", "-q:v", "4", preview],
    { stdio:"inherit", timeout:30000 });
  console.log("KLOCGIT_DEMO_PREVIEW " + readFileSync(preview).toString("base64"));
}
