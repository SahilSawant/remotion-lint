#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "./config.js";
import type { FrameMeasure, Issue } from "./layout.js";
import type { CompositionPage } from "./page.js";

const USAGE = `remotion-lint <command> [options]

  layout <composition> [seconds...]   measure text on each frame; fails on any issue
  diff   <composition> [seconds...]   compare [data-lint=screen] with [data-lint=ref]
  motion <video.mp4>                  find unplanned jumps, single-frame pops, frozen stretches

options
  --every <s>      check every <s> seconds across the whole composition (instead of listing seconds)
  --props <json>   input props, merged over the composition's default props
  --out <dir>      where screenshots and the JSON report go (default: lint-out)
  --config <file>  config file (default: remotion-lint.config.{mjs,js,ts,json} in cwd)
  --json           print the report as JSON instead of lines

exit codes: 0 clean, 1 problems found, 2 the check could not run`;

class UsageError extends Error {}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        every: { type: "string" },
        props: { type: "string" },
        out: { type: "string", default: "lint-out" },
        config: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [command, target, ...rest] = positionals;
  if (!command || !["layout", "diff", "motion"].includes(command)) throw new UsageError(command ? `unknown command "${command}"` : "no command given");
  if (!target) throw new UsageError(command === "motion" ? "give a video file" : "give a composition id");

  const { config, root } = await loadConfig(process.cwd(), values.config);
  if (values.props) {
    try {
      const p = JSON.parse(values.props);
      if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("not an object");
      config.props = { ...config.props, ...p };
    } catch (e) {
      throw new UsageError(`--props must be a JSON object: ${(e as Error).message}`);
    }
  }
  const outDir = path.resolve(values.out!);
  fs.mkdirSync(outDir, { recursive: true });
  const log = (s: string) => { if (!values.json) console.log(s); };

  let failures: number;
  let report: unknown;
  if (command === "motion") {
    if (rest.length || values.every) throw new UsageError("motion takes one video file and no seconds");
    ({ failures, report } = await motion(target, config, log));
  } else {
    ({ failures, report } = await frames(command, target, rest, values.every, config, root, outDir, log));
  }

  const file = path.join(outDir, `${command}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else log(`\n${failures} problem(s). Report: ${file}`);
  return failures ? 1 : 0;
}

async function motion(video: string, config: Config, log: (s: string) => void) {
  const file = path.resolve(video);
  if (!fs.existsSync(file)) throw new Error(`video not found: ${file}`);
  const { checkMotion } = await import("./motion.js");
  const m = await checkMotion(file, config.motion);
  log(`${video}  ${m.frames} frames at ${m.fps} fps`);
  for (const j of m.jumps) log(`  jump   ${j.t}s  change ${j.diff}, against ${j.around} either side`);
  for (const p of m.pops) log(`  pop    ${p.t}s  one frame differs by ${p.diff}`);
  for (const [a, b] of m.frozen) log(`  frozen ${a}s -> ${b}s${config.motion.failOnFrozen ? "" : "  (not counted)"}`);
  return { failures: m.jumps.length + m.pops.length + (config.motion.failOnFrozen ? m.frozen.length : 0), report: m };
}

async function frames(command: string, id: string, rest: string[], every: string | undefined, config: Config, root: string, outDir: string, log: (s: string) => void) {
  if (every && rest.length) throw new UsageError("give either seconds or --every, not both");
  const [{ openComposition }, { lintFrame, screenshotWithMarks, still, TRANSIENT }, { diffFrame }] = await Promise.all([import("./page.js"), import("./layout.js"), import("./diff.js")]);
  const comp = await openComposition({ entryPoint: path.resolve(root, config.entryPoint), id, channel: config.browserChannel, props: config.props, webpackOverride: config.webpackOverride });
  const tag = (sec: number) => `t${sec.toFixed(2).padStart(6, "0")}`;
  try {
    const last = (comp.durationInFrames - 1) / comp.fps;
    let secs: number[];
    if (every) {
      const step = Number(every);
      if (!(step > 0)) throw new UsageError(`--every must be a positive number of seconds, got "${every}"`);
      secs = [];
      for (let s = 0; s <= last + 1e-9; s += step) secs.push(Math.round(s * 1000) / 1000);
    } else {
      secs = rest.map(Number);
    }
    if (!secs.length) throw new UsageError("give seconds to check, or --every <s>");
    const bad = rest.find((s, i) => !Number.isFinite(secs[i]) || secs[i] < 0 || secs[i] > last);
    if (bad !== undefined) throw new UsageError(`${bad}s is outside ${id}, which runs 0 to ${last.toFixed(2)}s`);

    let failures = 0;
    let paired = 0;
    const out: Array<Record<string, unknown>> = [];
    for (const sec of secs) {
      const frame = Math.round(sec * comp.fps);
      await comp.seek(frame);
      if (command === "layout") {
        const m = await lintFrame(comp.page, config.layout, comp.width, comp.height);
        let issues: Issue[] = m.issues;
        let moving: Array<Issue & { settledAt: number | null }> = [];
        const transient = issues.filter((i) => TRANSIENT.includes(i.kind) && i.keys.length);
        if (transient.length) {
          const measureAt = async (g: number) => {
            await comp.seek(g);
            return lintFrame(comp.page, config.layout, comp.width, comp.height);
          };
          moving = await settle(comp, frame, m, transient, measureAt, still);
          issues = issues.filter((i) => !moving.some((x) => x.kind === i.kind && x.keys.join("|") === i.keys.join("|")));
          await comp.seek(frame);
        }
        failures += issues.length;
        out.push({ sec, texts: m.texts, issues, skippedWhileMoving: moving });
        for (const w of comp.warnings.splice(0)) log(`${sec}s  warning: the page logged "${w}"`);
        if (issues.length) await screenshotWithMarks(comp.page, issues, config.layout.safeArea, path.join(outDir, `${tag(sec)}.png`));
        const note = moving.length ? `  (${moving.length} skipped while moving)` : "";
        log(`${sec}s  ${m.texts} text runs  ${issues.length ? issues.map(describe).join(" | ") : "clean"}${note}`);
      } else {
        const d = await diffFrame(comp.page, config.diff.threshold);
        if (!d) {
          log(`${sec}s  no [data-lint="screen"] and [data-lint="ref"] pair on this frame`);
          continue;
        }
        paired++;
        const reasons = [];
        if (d.sizeMismatch) reasons.push(`sizes differ: screen ${d.sizeMismatch.screen}, ref ${d.sizeMismatch.ref}`);
        if (d.mismatchPct > config.diff.maxMismatchPct) reasons.push(`over ${config.diff.maxMismatchPct}%`);
        if (reasons.length) failures++;
        fs.writeFileSync(path.join(outDir, `${tag(sec)}-diff.png`), d.sideBySide);
        out.push({ sec, mismatchPct: d.mismatchPct, width: d.width, height: d.height, hottestRows: d.hottestRows, sizeMismatch: d.sizeMismatch, fail: reasons.length > 0 });
        log(`${sec}s  mismatch ${d.mismatchPct}% of ${d.width}x${d.height}${reasons.length ? `  FAIL: ${reasons.join("; ")}` : ""}  worst rows: ${d.hottestRows.map(([r, p]) => `${r}/12 ${p}%`).join(", ")}`);
      }
    }
    if (command === "diff" && !paired) {
      failures++;
      log(`no frame had a [data-lint="screen"] and [data-lint="ref"] pair, so nothing was compared`);
    }
    return { failures, report: { composition: id, fps: comp.fps, width: comp.width, height: comp.height, frames: out } };
  } finally {
    await comp.close();
  }
}

/**
 * Follows moving text forward, up to one second, until it stops. A problem is skipped only when the
 * text was moving at `frame` and either settles without the problem or slides out of view (it was
 * already partly off-frame or masked when it disappeared). Text that never settles within the second,
 * still has the problem once settled, or simply vanishes at a cut, is counted.
 */
async function settle(
  comp: CompositionPage,
  frame: number,
  now: FrameMeasure,
  list: Issue[],
  measureAt: (frame: number) => Promise<FrameMeasure>,
  still: (keys: string[], a: FrameMeasure["runs"], b: FrameMeasure["runs"]) => boolean,
): Promise<Array<Issue & { settledAt: number | null }>> {
  const last = Math.min(comp.durationInFrames - 1, frame + Math.round(comp.fps));
  const pending = new Set(list);
  const skipped: Array<Issue & { settledAt: number | null }> = [];
  let prev = now.runs;
  for (let g = frame + 1; g <= last && pending.size; g++) {
    const m = await measureAt(g);
    for (const i of [...pending]) {
      const present = i.keys.every((k) => m.runs.some((r) => r.key === k));
      if (!present) {
        pending.delete(i);
        const exiting = i.keys.some((k) => {
          const r = prev.find((x) => x.key === k);
          return !!r && r.visible.w * r.visible.h < r.full.w * r.full.h - 1;
        });
        if (g > frame + 1 && exiting) skipped.push({ ...i, settledAt: null });
        continue;
      }
      if (!still(i.keys, prev, m.runs)) continue;
      pending.delete(i);
      if (g === frame + 1) continue;
      const persists = m.issues.some((x) => x.kind === i.kind && x.keys.join("|") === i.keys.join("|"));
      if (!persists) skipped.push({ ...i, settledAt: Math.round(((g - 1) / comp.fps) * 100) / 100 });
    }
    prev = m.runs;
  }
  return skipped;
}

function describe(i: Issue): string {
  return `${i.kind}: "${i.text}"${i.px ? ` (${i.px}px)` : ""}`;
}

main().then(
  (code) => { process.exitCode = code; },
  (e: Error) => {
    console.error(`remotion-lint: ${e.message}`);
    if (e instanceof UsageError) console.error(`\n${USAGE}`);
    process.exitCode = 2;
  },
);
