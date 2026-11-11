import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyse } from "../dist/motion.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-lint-motion-"));
  const video = path.join(dir, "still.mp4");
  const pic = new Uint8Array(W * H).map((_, i) => (i * 7919) % 251);
  const f = Array.from({ length: 300 }, () => pic);
  const enc = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", "30", "-i", "-", "-c:v", "libx264", "-crf", "18", "-g", "100", "-pix_fmt", "yuv420p", video], { input: Buffer.concat(f.map((x) => Buffer.from(x))) });
  assert.equal(enc.status, 0, enc.stderr?.toString());
  const r = spawnSync(process.execPath, [cli, "motion", video, "--json", "--out", dir], { encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).frozen.length, 1);
});

test("the CLI decodes a real video end to end", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-lint-motion-"));
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
