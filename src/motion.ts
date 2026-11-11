import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import type { Config } from "./config.js";

/** What the motion check found in a rendered video. */
export interface MotionReport {
  frames: number;
  fps: number;
  /** A frame-to-frame change far bigger than the two nearest changes on each side (within 8 frames), not near a planned cut. */
  jumps: Array<{ t: number; diff: number; around: number }>;
  /** A single frame that differs from both neighbours while they match each other, not at a planned cut or in an allowed stretch. */
  pops: Array<{ t: number; diff: number }>;
  /** Stretches with no visible change, as [first still frame, last still frame] in seconds. */
  frozen: Array<[number, number]>;
}

const W = 160, H = 90, SIZE = W * H;

function tools() {
  const ffmpeg = process.env.REMOTION_LINT_FFMPEG || "ffmpeg";
  const ffprobe = process.env.REMOTION_LINT_FFPROBE || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, "ffprobe"));
  return { ffmpeg, ffprobe: ffmpeg.includes(path.sep) || process.env.REMOTION_LINT_FFPROBE ? ffprobe : "ffprobe" };
}

const HINT = "install ffmpeg, or point REMOTION_LINT_FFMPEG and REMOTION_LINT_FFPROBE at the binaries";

function probeFps(video: string, ffprobe: string): number {
  const r = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video], { encoding: "utf8" });
  if (r.error) throw new Error(`could not run ${ffprobe}: ${r.error.message} (${HINT})`);
  if (r.status !== 0) throw new Error(`ffprobe could not read ${video}: ${r.stderr.trim()}`);
  const [n, d = 1] = r.stdout.trim().split("/").map(Number);
  const fps = n / d;
  if (!(fps > 0) || !Number.isFinite(fps)) throw new Error(`${video} has no readable frame rate`);
  return fps;
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Accumulates frames one at a time, keeping only the last two, so memory does not grow with the video. */
class Scanner {
  private prev2?: Uint8Array;
  private prev?: Uint8Array;
  private n = 0;
  readonly diffs: number[] = [];
  readonly pops: number[] = [];
  private popDiffs: number[] = [];

  push(f: Uint8Array) {
    if (this.prev) this.diffs.push(meanAbsDiff(f, this.prev));
    if (this.prev && this.prev2) {
      const a = meanAbsDiff(this.prev, this.prev2);
      if (a > 4 && meanAbsDiff(f, this.prev2) < a * 0.3) {
        this.pops.push(this.n - 1);
        this.popDiffs.push(a);
      }
    }
    this.prev2 = this.prev;
    this.prev = f;
    this.n++;
  }

  report(fps: number, opts: Config["motion"]): MotionReport {
    const d = this.diffs;
    const allowed = (t: number) => opts.allow.some(([a, b]) => t >= a - 0.07 && t <= b + 0.07);
    const planned = (t: number) => opts.cuts.some((c) => Math.abs(t - c) < 0.07) || allowed(t);
    // Only the frame on the cut itself: a stray or black frame just after a listed cut is still a pop.
    const onCut = (t: number) => opts.cuts.some((c) => Math.abs(t - c) < 0.5 / fps) || allowed(t);
    const out: MotionReport = {
      frames: this.n, fps: round(fps), jumps: [], frozen: [],
      pops: this.pops.map((i, k) => ({ t: round(i / fps), diff: round(this.popDiffs[k]) })).filter((p) => !onCut(p.t)),
    };
    const nearPop = (i: number) => this.pops.some((p) => p === i || p === i + 1);
    // Footage held for several frames (on threes, 10 fps in 30 fps) changes only every few frames, so compare each
    // change with the nearest real changes either side, not with the held frames in between.
    const nearest = (i: number, step: number) => {
      const out: number[] = [];
      for (let j = i + step; j >= 0 && j < d.length && Math.abs(j - i) <= 8 && out.length < 2; j += step) if (d[j] > 0.05) out.push(d[j]);
      return out;
    };
    d.forEach((v, i) => {
      const around = Math.max(0, ...nearest(i, -1), ...nearest(i, 1));
      const t = (i + 1) / fps;
      if (v > 6 && v > 4 * (around + 0.3) && !nearPop(i) && !planned(t)) out.jumps.push({ t: round(t), diff: round(v), around: round(around) });
    });
    const minRun = Math.round(opts.frozenSeconds * fps);
    // A lossy codec refreshes a still picture at each keyframe: one small blip inside a still stretch is not motion.
    const flat = d.map((v) => v < 0.02);
    const isStill = (i: number) => flat[i] || (d[i] < 2 && !!flat[i - 1] && !!flat[i + 1]);
    let start = -1;
    for (let i = 0; i <= d.length; i++) {
      const still = i < d.length && isStill(i);
      if (still && start < 0) start = i;
      if (!still && start >= 0) {
        if (i - start >= minRun) out.frozen.push([round(start / fps), round(i / fps)]);
        start = -1;
      }
    }
    return out;
  }
}

/** The pure analysis on already-decoded 160x90 greyscale frames. */
export function analyse(frames: Uint8Array[], fps: number, opts: Config["motion"]): MotionReport {
  const s = new Scanner();
  for (const f of frames) s.push(f);
  return s.report(fps, opts);
}

/** Decodes `video` with ffmpeg, streaming, and scans it for unplanned jumps, single-frame pops and frozen stretches. */
export async function checkMotion(video: string, opts: Config["motion"]): Promise<MotionReport> {
  const { ffmpeg, ffprobe } = tools();
  const fps = probeFps(video, ffprobe);
  const scanner = new Scanner();
  const proc = spawn(ffmpeg, ["-loglevel", "error", "-i", video, "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"]);
  let pending: Buffer = Buffer.alloc(0);
  let stderr = "";
  proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
  proc.stdout.on("data", (b: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, b]) : b;
    let o = 0;
    for (; o + SIZE <= pending.length; o += SIZE) scanner.push(new Uint8Array(pending.subarray(o, o + SIZE)));
    pending = pending.subarray(o);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", (e) => reject(new Error(`could not run ${ffmpeg}: ${e.message} (${HINT})`)));
    proc.on("close", resolve);
  });
  if (code !== 0) throw new Error(`ffmpeg could not decode ${video}: ${stderr.trim()}`);
  const report = scanner.report(fps, opts);
  if (report.frames < 3) throw new Error(`${video} has ${report.frames} frame(s); the motion check needs at least 3`);
  return report;
}
