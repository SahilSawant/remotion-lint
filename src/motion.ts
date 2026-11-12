import { spawn, spawnSync } from "node:child_process";
import type { Config } from "./config.js";
import { HINT, tools } from "./ffmpeg.js";

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
  /**
   * A hitch in steady motion: a frame shown twice (`repeat`), or one skipped (`drop`, a step as big as two), while the
   * motion around it is even. Found per part of the picture, so footage inside a frame is checked too.
   */
  stutters: Array<{ t: number; kind: "repeat" | "drop" }>;
  /** Repeats or drops at a steady rhythm: footage at another frame rate. Reported once per stretch, not counted. */
  cadence: Array<{ from: number; to: number; kind: "repeat" | "drop"; every: number }>;
}

const W = 160, H = 90, SIZE = W * H;

function probeFps(video: string, ffprobe: string): number {
  const r = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", video], { encoding: "utf8" });
  if (r.error) throw new Error(`could not run ${ffprobe}: ${r.error.message} (${HINT})`);
  if (r.status !== 0) throw new Error(`ffprobe could not read ${video}: ${r.stderr.trim()}`);
  // Newer ffprobe builds add a trailing comma ("30/1,"), so read the first fraction rather than the whole line.
  const m = /(\d+(?:\.\d+)?)(?:\/(\d+))?/.exec(r.stdout);
  const fps = m ? Number(m[1]) / Number(m[2] ?? 1) : NaN;
  if (!(fps > 0) || !Number.isFinite(fps)) throw new Error(`${video} has no readable frame rate`);
  return fps;
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const round = (n: number) => Math.round(n * 100) / 100;

const COLS = 4, ROWS = 3, TW = W / COLS, TH = H / ROWS;
/** Mean absolute difference in each of the 4x3 tiles. */
function tileDiffs(a: Uint8Array, b: Uint8Array): Float32Array {
  const out = new Float32Array(COLS * ROWS);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / TH) * COLS;
    for (let x = 0; x < W; x++) out[row + Math.floor(x / TW)] += Math.abs(a[y * W + x] - b[y * W + x]);
  }
  for (let k = 0; k < out.length; k++) out[k] /= TW * TH;
  return out;
}
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Accumulates frames one at a time, keeping only the last two, so memory does not grow with the video. */
class Scanner {
  private prev2?: Uint8Array;
  private prev?: Uint8Array;
  private n = 0;
  readonly diffs: number[] = [];
  readonly pops: number[] = [];
  private popDiffs: number[] = [];
  /** Per tile, aligned with `diffs`: the change from the frame before, and from the frame two before. */
  private one: Float32Array[] = [];
  private two: Array<Float32Array | undefined> = [];

  push(f: Uint8Array) {
    if (this.prev) {
      this.diffs.push(meanAbsDiff(f, this.prev));
      this.one.push(tileDiffs(f, this.prev));
      this.two.push(this.prev2 && tileDiffs(f, this.prev2));
    }
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
      frames: this.n, fps: round(fps), jumps: [], frozen: [], stutters: [], cadence: [],
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
    Object.assign(out, findStutters(this.one, this.two, fps, (t) => planned(t) || [...out.jumps, ...out.pops].some((j) => Math.abs(j.t - t) < 1.5 / fps)));
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

/**
 * Looks, tile by tile, for one odd step in otherwise even motion. Around change `i`, six changes each side (skipping
 * the one right after it, which is the catch-up when a frame was repeated) must be real motion (over 2 grey levels)
 * within 0.7x-1.4x of their median `m`, at the same speed on both sides (within a quarter), allowing one held frame per
 * side so footage at another frame rate still counts as even. Then change `i` is a repeat when it is under 0.15 m, or a
 * drop when it is over 1.5 m and as big as the two-frame changes around it. Repeats or drops at a steady spacing (at
 * least three, the same number of frames apart give or take one) are footage at another frame rate, reported once as cadence.
 */
function findStutters(one: Float32Array[], two: Array<Float32Array | undefined>, fps: number, excused: (t: number) => boolean): Pick<MotionReport, "stutters" | "cadence"> {
  const n = one.length;
  const found = new Map<number, "repeat" | "drop">();
  /** The catch-up step right after a repeated frame: part of that repeat, not a drop of its own. */
  const catchUp = new Set<number>();
  for (let k = 0; k < COLS * ROWS; k++) {
    const d1 = one.map((v) => v[k]);
    const d2 = two.map((v) => v?.[k]);
    for (let i = 6; i < n - 8; i++) {
      if (found.has(i) || catchUp.has(i)) continue;
      // The change right after `i` is left out: after a repeated frame it is the catch-up, twice the usual step.
      const sides = [d1.slice(i - 6, i), d1.slice(i + 2, i + 8)];
      const all = sides.flat();
      const m = median(all.filter((v) => v > 0.15 * median(all)));
      if (!(m > 2)) continue;
      const held = (v: number) => v < 0.15 * m;
      // Even on each side, and the same speed on both: a move that speeds up or slows down is not a stutter.
      const [left, right] = sides.map((side) => median(side.filter((v) => !held(v))));
      if (Math.abs(left - right) > 0.25 * m) continue;
      if (!sides.every((side) => side.filter(held).length <= 1 && side.every((v) => held(v) || (v >= 0.7 * m && v <= 1.4 * m)))) continue;
      if (held(d1[i])) {
        found.set(i, "repeat");
        if (d1[i + 1] > 1.5 * m) catchUp.add(i + 1);
      } else if (d1[i] > 1.5 * m && d1[i + 1] >= 0.6 * m && d1[i + 1] <= 1.6 * m) {
        const pair = median([...d2.slice(i - 6, i), ...d2.slice(i + 2, i + 7)].filter((v): v is number => v !== undefined));
        if (pair > 0 && Math.abs(d1[i] - pair) < 0.3 * pair) found.set(i, "drop");
      }
    }
  }
  const hits = [...found].sort((a, b) => a[0] - b[0]).map(([i, kind]) => ({ i, t: round((i + 1) / fps), kind })).filter((h) => !excused(h.t));
  const cadence: MotionReport["cadence"] = [];
  const inCadence = new Set<number>();
  for (const kind of ["repeat", "drop"] as const) {
    const list = hits.filter((h) => h.kind === kind);
    for (let a = 0; a + 2 < list.length; ) {
      const gap = list[a + 1].i - list[a].i;
      let b = a + 1;
      while (gap > 1 && b + 1 < list.length && Math.abs(list[b + 1].i - list[b].i - gap) <= 1) b++;
      if (b - a < 2) {
        a++;
        continue;
      }
      cadence.push({ from: list[a].t, to: list[b].t, kind, every: Math.round((list[b].i - list[a].i) / (b - a)) });
      for (let c = a; c <= b; c++) inCadence.add(list[c].i);
      a = b + 1;
    }
  }
  return { stutters: hits.filter((h) => !inCadence.has(h.i)).map(({ t, kind }) => ({ t, kind })), cadence };
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
