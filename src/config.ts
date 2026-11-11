import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WebpackOverrideFn } from "@remotion/bundler";

/** Everything remotion-lint can be told. Every field has a default. */
export interface Config {
  /** Remotion entry point, relative to the config file. */
  entryPoint: string;
  /** The same function you give Remotion's `Config.overrideWebpackConfig` (Tailwind, aliases, loaders). */
  webpackOverride?: WebpackOverrideFn;
  /** Input props merged over each composition's resolved default props. */
  props: Record<string, unknown>;
  layout: {
    /** Smallest allowed rendered font size in px on a 1080p frame; scaled by the composition's shorter side / 1080. */
    minFontPx: number;
    /**
     * Margin text must stay inside: a percentage of each side ("5%": 5% of the width left and right, 5% of the height
     * top and bottom), or px on a 1080p frame, one number or [left/right, top/bottom], scaled like minFontPx.
     */
    safeArea: number | [number, number] | `${number}%`;
    /** Fraction of the smaller line box two text runs may share before it counts as an overlap. */
    overlap: number;
    /** Regular expressions (case-insensitive) that must never appear on screen. */
    forbidden: string[];
  };
  diff: {
    /** pixelmatch colour threshold, 0..1. */
    threshold: number;
    /** A frame fails when more than this percentage of the screen differs from its reference. */
    maxMismatchPct: number;
    /** A frame also fails when more than this percentage of any one of 12 horizontal bands differs: a changed word or number. */
    maxBandPct: number;
  };
  motion: {
    /** Planned cuts in seconds: a jump within 0.07 s, or a pop on the cut frame itself, is not reported. `--cuts` adds to these. */
    cuts: number[];
    /** Stretches [from, to] in seconds where jumps and pops are intended (a glitch effect, a strobe). */
    allow: Array<[number, number]>;
    /** Report a stretch with no change at all longer than this many seconds. */
    frozenSeconds: number;
    /** Count frozen stretches as failures, not only as findings. */
    failOnFrozen: boolean;
  };
  /** Playwright browser channel, e.g. "chrome". Empty uses Playwright's bundled Chromium. */
  browserChannel: string;
}

/** Input shape for a config file: any field may be left out. */
export type UserConfig = Partial<Omit<Config, "layout" | "diff" | "motion">> & {
  layout?: Partial<Config["layout"]>;
  diff?: Partial<Config["diff"]>;
  motion?: Partial<Config["motion"]>;
};

/** Identity helper that gives a config file type checking. */
export const defineConfig = (c: UserConfig): UserConfig => c;

export const defaults: Config = {
  entryPoint: "src/index.ts",
  props: {},
  layout: { minFontPx: 28, safeArea: "5%", overlap: 0.15, forbidden: [] },
  diff: { threshold: 0.12, maxMismatchPct: 1, maxBandPct: 2 },
  motion: { cuts: [], allow: [], frozenSeconds: 2, failOnFrozen: false },
  browserChannel: "",
};

const NAMES = ["remotion-lint.config.mjs", "remotion-lint.config.js", "remotion-lint.config.ts", "remotion-lint.config.json"];

/** Loads the config from `file`, or the first known name in `cwd`, validated and merged over the defaults. */
export async function loadConfig(cwd: string, file?: string): Promise<{ config: Config; root: string; file?: string }> {
  const found = file ? path.resolve(cwd, file) : NAMES.map((n) => path.join(cwd, n)).find((p) => fs.existsSync(p));
  if (!found) return { config: merge({}), root: cwd };
  if (!fs.existsSync(found)) throw new Error(`config file not found: ${found}`);
  if (found.endsWith(".ts") && !(process.features as { typescript?: unknown }).typescript) {
    throw new Error(`${path.basename(found)} needs Node 22.18 or later to load TypeScript; rename it to .mjs`);
  }
  let user: unknown;
  try {
    user = found.endsWith(".json") ? JSON.parse(fs.readFileSync(found, "utf8")) : (await import(pathToFileURL(found).href)).default ?? {};
  } catch (e) {
    throw new Error(`could not load ${path.basename(found)}: ${(e as Error).message}`);
  }
  validate(user, path.basename(found));
  return { config: merge(user as UserConfig), root: path.dirname(found), file: found };
}

/** Merges a partial config over the defaults, one section at a time. */
export function merge(user: UserConfig): Config {
  return {
    ...defaults,
    ...user,
    props: { ...defaults.props, ...user.props },
    layout: { ...defaults.layout, forbidden: [...defaults.layout.forbidden], ...user.layout },
    diff: { ...defaults.diff, ...user.diff },
    motion: { ...defaults.motion, cuts: [...defaults.motion.cuts], allow: [...defaults.motion.allow], ...user.motion },
  };
}

type Kind = "string" | "number" | "boolean" | "function" | "object" | "string[]" | "number[]" | "margin" | "ranges";
const SCHEMA: Record<string, Kind | Record<string, Kind>> = {
  entryPoint: "string",
  webpackOverride: "function",
  props: "object",
  browserChannel: "string",
  layout: { minFontPx: "number", safeArea: "margin", overlap: "number", forbidden: "string[]" },
  diff: { threshold: "number", maxMismatchPct: "number", maxBandPct: "number" },
  motion: { cuts: "number[]", allow: "ranges", frozenSeconds: "number", failOnFrozen: "boolean" },
};

function check(value: unknown, kind: Kind): boolean {
  if (kind === "string[]") return Array.isArray(value) && value.every((v) => typeof v === "string");
  if (kind === "number[]") return Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isFinite(v));
  if (kind === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (kind === "margin") return check(value, "number") || (check(value, "number[]") && (value as number[]).length === 2) || (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value));
  if (kind === "ranges") return Array.isArray(value) && value.every((v) => check(v, "number[]") && (v as number[]).length === 2 && (v as number[])[0] <= (v as number[])[1]);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === kind;
}

/** Throws on an unknown key, a wrong type, or a forbidden pattern that is not a valid regular expression. */
export function validate(user: unknown, name = "config"): void {
  if (!check(user, "object")) throw new Error(`${name} must export an object`);
  for (const [key, value] of Object.entries(user as Record<string, unknown>)) {
    const spec = SCHEMA[key];
    if (!spec) throw new Error(`${name}: unknown option "${key}" (known: ${Object.keys(SCHEMA).join(", ")})`);
    if (typeof spec === "string") {
      if (!check(value, spec)) throw new Error(`${name}: "${key}" must be ${spec === "object" ? "an object" : `a ${spec}`}`);
      continue;
    }
    if (!check(value, "object")) throw new Error(`${name}: "${key}" must be an object`);
    for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
      const kind = spec[sub];
      if (!kind) throw new Error(`${name}: unknown option "${key}.${sub}" (known: ${Object.keys(spec).join(", ")})`);
      if (!check(v, kind)) throw new Error(`${name}: "${key}.${sub}" must be ${kind === "margin" ? 'a number, [x, y] or a percentage like "5%"' : kind === "ranges" ? "a list of [from, to] seconds" : `a ${kind}`}`);
    }
  }
  const u = user as UserConfig;
  const range = (label: string, v: number | undefined, min: number, max = Infinity) => {
    if (v !== undefined && (v < min || v > max)) throw new Error(`${name}: "${label}" must be ${max === Infinity ? `at least ${min}` : `between ${min} and ${max}`}, got ${v}`);
  };
  range("layout.minFontPx", u.layout?.minFontPx, 0);
  for (const v of [u.layout?.safeArea ?? []].flat()) range("layout.safeArea", typeof v === "string" ? parseFloat(v) : v, 0, typeof v === "string" ? 50 : Infinity);
  range("layout.overlap", u.layout?.overlap, 0, 1);
  range("diff.threshold", u.diff?.threshold, 0, 1);
  range("diff.maxMismatchPct", u.diff?.maxMismatchPct, 0, 100);
  range("diff.maxBandPct", u.diff?.maxBandPct, 0, 100);
  range("motion.frozenSeconds", u.motion?.frozenSeconds, 0.01);
  for (const c of u.motion?.cuts ?? []) range("motion.cuts", c, 0);
  for (const f of u.layout?.forbidden ?? []) {
    try {
      new RegExp(f, "i");
    } catch {
      throw new Error(`${name}: layout.forbidden "${f}" is not a valid regular expression`);
    }
  }
}

/** The layout rules for a `width`x`height` composition: pixel sizes are given for a 1080p frame and scale with the shorter side; a percentage safe area is a share of each side. */
export function scaleLayout(layout: Config["layout"], width: number, height: number): Config["layout"] & { safeX: number; safeY: number } {
  const k = Math.min(width, height) / 1080;
  const s = layout.safeArea;
  if (typeof s === "string") return { ...layout, minFontPx: layout.minFontPx * k, safeX: (parseFloat(s) / 100) * width, safeY: (parseFloat(s) / 100) * height };
  const [x, y] = typeof s === "number" ? [s, s] : s;
  return { ...layout, minFontPx: layout.minFontPx * k, safeX: x * k, safeY: y * k };
}
