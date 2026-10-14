import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keptIntervals, type RecordedClip } from "./presentation.ts";

const output = resolve(import.meta.dirname, "../../demo-output");
const clips: RecordedClip[] = JSON.parse(
  readFileSync(join(output, "clips.json"), "utf8"),
);
const encoded: string[] = [];
const chapters: { id: string; start: number; seconds: number }[] = [];
let elapsed = 0;
for (const clip of clips)
  for (const range of clip.ranges) {
    if (!range.beat_id)
      throw new Error("A submission scene needs its narration identity");
    const kept = keptIntervals(range, clip.omitted);
    if (!kept.length)
      throw new Error("A narrated scene has no recorded footage");
    const start = kept[0].start;
    const seconds =
      Math.ceil(
        kept.reduce((sum, part) => sum + part.end - part.start, 0) * 25,
      ) / 25;
    const filters = [
      "[0:v]split=" + kept.length + kept.map((_, i) => "[s" + i + "]").join(""),
    ];
    kept.forEach((part, i) =>
      filters.push(
        "[s" +
          i +
          "]trim=start=" +
          (part.start - start).toFixed(3) +
          ":end=" +
          (part.end - start).toFixed(3) +
          ",setpts=PTS-STARTPTS[v" +
          i +
          "]",
      ),
    );
    filters.push(
      kept.map((_, i) => "[v" + i + "]").join("") +
        "concat=n=" +
        kept.length +
        ":v=1:a=0,scale=-2:1080,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=25,tpad=stop_mode=clone:stop_duration=0.1[out]",
    );
    filters.push(
      "[1:a]apad,atrim=end=" + seconds + ",asetpts=PTS-STARTPTS[audio]",
    );
    const file = join(output, "scene-" + range.beat_id + ".mp4");
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        start.toFixed(3),
        "-t",
        (range.end - start).toFixed(3),
        "-i",
        clip.path,
        "-i",
        join(output, "audio", range.beat_id + ".wav"),
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[out]",
        "-map",
        "[audio]",
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        file,
      ],
      { stdio: "inherit", timeout: 180000 },
    );
    encoded.push(file);
    chapters.push({ id: range.beat_id, start: elapsed, seconds });
    elapsed += seconds;
    console.log(JSON.stringify({ scene: range.beat_id, seconds }));
  }
if (elapsed < 300 || elapsed > 600)
  throw new Error(
    "Submission narration and demonstrations must run for five to ten minutes",
  );
const playlist = join(output, "edited-clips.txt");
writeFileSync(
  playlist,
  encoded
    .map((path) => "file '" + path.replaceAll("'", "'\\''") + "'")
    .join("\n"),
);
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    playlist,
    "-c:v",
    "copy",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    join(output, "klocgit-demo.mp4"),
  ],
  { stdio: "inherit", timeout: 300000 },
);
writeFileSync(join(output, "chapters.json"), JSON.stringify(chapters, null, 2));
for (const second of [45, 165, 260]) {
  const preview = join(output, "preview-" + second + ".jpg");
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(second),
      "-i",
      join(output, "klocgit-demo.mp4"),
      "-frames:v",
      "1",
      "-q:v",
      "4",
      preview,
    ],
    { stdio: "inherit", timeout: 30000 },
  );
  console.log(
    "KLOCGIT_DEMO_PREVIEW " + readFileSync(preview).toString("base64"),
  );
}
