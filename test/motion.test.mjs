import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyse } from "../dist/motion.js";

const made = [];
/** A temp directory removed when the file's tests finish. */
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const opts = { cuts: [], allow: [], frozenSeconds: 2, failOnFrozen: false };
const W = 160, H = 90;
const frame = (v) => new Uint8Array(W * H).fill(v);
const fade = (n, from = 0) => Array.from({ length: n }, (_, i) => frame(from + i));
const hold = (n, v) => Array.from({ length: n }, () => frame(v));
/** A wipe: a bright edge sweeps left to right over `n` frames. */
const wipe = (n, from, to) =>
  Array.from({ length: n }, (_, k) => {
    const f = frame(from);
    const edge = Math.round(((k + 1) / n) * W);
    for (let y = 0; y < H; y++) f.fill(to, y * W, y * W + edge);
    return f;
  });

/** A smooth pattern, shifted `dx` px right and scaled by `zoom`: what a camera pan or push-in does to the picture. */
const scene = (dx, zoom = 1) => {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x - W / 2) / zoom + W / 2 - dx, v = (y - H / 2) / zoom + H / 2;
    f[y * W + x] = 128 + 50 * Math.sin(u / 7) + 40 * Math.sin(v / 5 + u / 11);
  }
  return f;
};
/** A pan at 1.5 px a frame, with `edit` changing which moment each frame shows. */
const pan = (n, edit = (i) => i) => Array.from({ length: n }, (_, i) => scene(1.5 * edit(i)));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p));

test("a steady, eased, zooming or on-twos pan has no stutter", () => {
  const cases = {
    steady: pan(90),
    eased: Array.from({ length: 90 }, (_, i) => scene(80 * ease(i / 89))),
    zoom: Array.from({ length: 90 }, (_, i) => scene(0, 1 + i * 0.006)),
    "on twos": pan(90, (i) => i - (i % 2)),
  };
  for (const [name, f] of Object.entries(cases)) {
    const r = analyse(f, 30, opts);
    assert.deepEqual([r.stutters, r.cadence, r.jumps, r.pops], [[], [], [], []], name);
  }
});

test("one frame dropped or shown twice in a steady pan is a stutter", () => {
  const drop = analyse(pan(60, (i) => (i >= 30 ? i + 1 : i)), 30, opts);
  assert.deepEqual(drop.stutters, [{ t: 1, kind: "drop" }]);
  const repeat = analyse(pan(60, (i) => (i === 30 ? 29 : i)), 30, opts);
  assert.deepEqual(repeat.stutters, [{ t: 1, kind: "repeat" }]);
  assert.equal(analyse(pan(60, (i) => (i === 30 ? 29 : i)), 30, { ...opts, cuts: [1] }).stutters.length, 0, "unless a cut is planned there");
});

test("24 fps footage in a 30 fps video repeats a frame every 5: reported once as cadence, not as stutters", () => {
  const r = analyse(pan(90, (i) => Math.floor((i * 24) / 30) * 1.25), 30, opts);
  assert.deepEqual(r.stutters, []);
  assert.equal(r.cadence.length, 1);
  assert.equal(r.cadence[0].kind, "repeat");
  assert.equal(r.cadence[0].every, 5);
});

test("a stutter inside footage that fills only part of the frame is found", () => {
  const frames = pan(60, (i) => (i === 30 ? 29 : i)).map((f) => {
    const g = new Uint8Array(W * H).fill(30);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) g[y * W + x] = f[y * W + x];
    return g;
  });
  assert.deepEqual(analyse(frames, 30, opts).stutters, [{ t: 1, kind: "repeat" }]);
});

test("a title sliding over a flat background is not a stutter", () => {
  const frames = Array.from({ length: 90 }, (_, i) => {
    const f = new Uint8Array(W * H).fill(20);
    const left = Math.round(ease(Math.min(1, i / 40)) * 100);
    for (let y = 40; y < 52; y++) f.fill(230, y * W + left, y * W + left + 50);
    return f;
  });
  const r = analyse(frames, 30, opts);
  assert.deepEqual([r.stutters, r.cadence], [[], []]);
});

test("a smooth fade has no jumps, pops or freezes", () => {
  const r = analyse(fade(90), 30, opts);
  assert.deepEqual([r.jumps, r.pops, r.frozen], [[], [], []]);
});

test("a hard cut is a jump, unless it is a planned cut", () => {
  const f = [...hold(30, 40), ...hold(30, 200)];
  assert.deepEqual(analyse(f, 30, opts).jumps.map((j) => j.t), [1]);
  assert.equal(analyse(f, 30, { ...opts, cuts: [1] }).jumps.length, 0);
});

test("a fast full-screen wipe is motion, not a run of jumps", () => {
  const r = analyse([...hold(30, 40), ...wipe(8, 40, 200), ...hold(30, 200)], 30, opts);
  assert.deepEqual(r.jumps, []);
});

test("a wipe animated on twos is motion, not a jump per step", () => {
  const steps = wipe(12, 40, 200).flatMap((f) => [f, f]);
  assert.deepEqual(analyse([...hold(30, 40), ...steps, ...hold(30, 200)], 30, opts).jumps, []);
});

test("footage held for three or four frames (10 fps in 30 fps) is motion, not a jump per step", () => {
  for (const k of [3, 4]) {
    const steps = wipe(12, 40, 200).flatMap((f) => Array.from({ length: k }, () => f));
    assert.deepEqual(analyse([...hold(30, 40), ...steps, ...hold(30, 200)], 30, opts).jumps, [], `held ${k} frames`);
  }
});

test("a hard cut between two still shots is still a jump", () => {
  const r = analyse([...hold(30, 40), ...hold(30, 200), ...hold(30, 90)], 30, opts);
  assert.deepEqual(r.jumps.map((j) => j.t), [1, 2]);
});

test("a flash on a planned cut, or a glitch inside an allowed stretch, is not a pop", () => {
  const flash = [...hold(30, 60), frame(250), ...hold(30, 60)];
  assert.deepEqual(analyse(flash, 30, opts).pops.map((p) => p.t), [1]);
  assert.deepEqual(analyse(flash, 30, { ...opts, cuts: [1] }).pops, []);
  const stray = [...hold(30, 60), frame(200), frame(60), ...hold(30, 200)];
  assert.deepEqual(analyse(stray, 30, { ...opts, cuts: [1] }).pops.map((p) => p.t), [1.03], "a stray frame just after a listed cut is still a pop");
  const glitch = [...hold(30, 60), ...Array.from({ length: 10 }, (_, i) => frame(i % 2 ? 200 : 60)), ...hold(30, 60)];
  assert.ok(analyse(glitch, 30, opts).pops.length > 0);
  const allowed = analyse(glitch, 30, { ...opts, allow: [[1, 1.33]] });
  assert.deepEqual([allowed.pops, allowed.jumps], [[], []]);
});

test("a hard cut straight into a long wipe is still a jump", () => {
  const r = analyse([...hold(30, 40), ...wipe(30, 200, 100), ...hold(30, 100)], 30, opts);
  assert.deepEqual(r.jumps.map((j) => j.t), [1]);
});

test("one odd frame is a single pop and not also a jump", () => {
  const f = fade(60);
  f[30] = frame(200);
  const r = analyse(f, 30, opts);
  assert.deepEqual(r.pops.map((p) => p.t), [1]);
  assert.deepEqual(r.jumps, []);
});

test("a still stretch reports its first and last still frame", () => {
  const f = [...fade(30), ...hold(90, 30), ...fade(30, 31)];
  const r = analyse(f, 30, opts);
  assert.deepEqual(r.frozen, [[1, 3.97]]);
});

const FFMPEG = process.env.REMOTION_LINT_FFMPEG || "ffmpeg";
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;
if (!hasFfmpeg && process.env.REMOTION_LINT_REQUIRE_FFMPEG) throw new Error("ffmpeg is required for this run but was not found");

test("a still picture in a lossy video is one frozen stretch, not split at keyframes", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = tmp("remotion-lint-motion-");
  const video = path.join(dir, "still.mp4");
  const pic = new Uint8Array(W * H).map((_, i) => (i * 7919) % 251);
  const f = Array.from({ length: 300 }, () => pic);
  const enc = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "30", "-i", "-", "-c:v", "libx264", "-crf", "18", "-g", "100", "-pix_fmt", "yuv420p", video], { input: Buffer.concat(f.map((x) => Buffer.from(x))) });
  assert.equal(enc.status, 0, enc.stderr?.toString());
  const r = spawnSync(process.execPath, [cli, "motion", video, "--json", "--out", dir], { encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).frozen.length, 1);
});

test("the CLI decodes a real video end to end", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = tmp("remotion-lint-motion-");
  const video = path.join(dir, "clip.mp4");
  const f = [...hold(30, 40), ...wipe(8, 40, 200), ...hold(30, 200), ...hold(30, 60)];
  f[90] = frame(220);
  const enc = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "30", "-i", "-", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", video], { input: Buffer.concat(f.map((x) => Buffer.from(x))) });
  assert.equal(enc.status, 0, enc.stderr?.toString());
  const r = spawnSync(process.execPath, [cli, "motion", video, "--json", "--out", dir], { encoding: "utf8" });
  const report = JSON.parse(r.stdout);
  assert.equal(report.frames, f.length);
  assert.equal(report.fps, 30);
  assert.deepEqual(report.pops.map((p) => p.t), [3]);
  assert.deepEqual(report.jumps.map((j) => j.t), [2.27]);
  assert.match(spawnSync(process.execPath, [cli, "motion", video, "--out", dir], { encoding: "utf8" }).stdout, /--cuts 2\.27/);
  const planned = JSON.parse(spawnSync(process.execPath, [cli, "motion", video, "--json", "--out", dir, "--cuts", "2.27"], { encoding: "utf8" }).stdout);
  assert.deepEqual([planned.jumps, planned.pops.map((p) => p.t)], [[], [3]]);
  assert.equal(r.status, 1);
});
