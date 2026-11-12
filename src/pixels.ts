import type { Page } from "playwright";
import { PNG } from "pngjs";
import type { Box, FrameMeasure, Issue, TextRun } from "./layout.js";

/** What the pixels of one frame add to its DOM measurement. */
export interface PixelResult {
  issues: Issue[];
  /** Runs no glyph of which reaches the screen (masked, under an image, painted transparent). */
  invisible: string[];
  /** The frame changed between screenshots (a CSS animation, a GIF, media still loading), so nothing was judged. */
  unstable: boolean;
}

type Mode = "hide" | "magenta" | null;

/**
 * Runs inside the page: paints every glyph as authored (null), hidden, or solid magenta, without touching layout or
 * React. Outlines and shadows are switched off in both other modes, so the difference between them is the glyphs alone.
 */
const paintText = ([mode, target]: [Mode, number | null]) => {
  document.querySelectorAll("style[data-lint-paint]").forEach((n) => n.remove());
  document.querySelectorAll("[data-lint-clip-text]").forEach((e) => e.removeAttribute("data-lint-clip-text"));
  if (!mode) return;
  for (const e of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(e) as CSSStyleDeclaration & { webkitBackgroundClip: string };
    if (cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text") e.setAttribute("data-lint-clip-text", "");
  }
  const fill = mode === "hide" ? "transparent" : "#f0f";
  const s = document.createElement("style");
  s.setAttribute("data-lint-paint", "");
  s.setAttribute("data-lint-mark", "");
  if (target !== null) {
    // One run alone: every other glyph stays as authored, so text stacked with it counts as what it stands out from.
    const me = `[data-lint-run="${target}"]`;
    s.textContent = `${me} { -webkit-text-fill-color: ${fill} !important; -webkit-text-stroke-color: transparent !important; text-shadow: none !important; transition: none !important; }
${me}[data-lint-clip-text] { background: none !important; }
${me} * { -webkit-text-fill-color: currentcolor !important; }
text${me}, ${me} tspan { fill: ${fill} !important; stroke: transparent !important; }`;
    document.querySelectorAll("[data-lint-clip-text]").forEach((e) => e.matches(me) || e.removeAttribute("data-lint-clip-text"));
    document.head.appendChild(s);
    return;
  }
  s.textContent = `*, *::before, *::after { -webkit-text-fill-color: ${fill} !important; -webkit-text-stroke-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; transition: none !important; }
[data-lint-clip-text] { background: none !important; }
text, tspan, textPath { fill: ${fill} !important; stroke: transparent !important; }`;
  document.head.appendChild(s);
};

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const LUM = Float64Array.from({ length: 256 }, (_, i) => lin(i));
const luminance = (d: Buffer, i: number) => 0.2126 * LUM[d[i]] + 0.7152 * LUM[d[i + 1]] + 0.0722 * LUM[d[i + 2]];
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Screenshots the text area three ways (as authored, glyphs hidden, glyphs magenta), then a fourth time as authored to
 * prove nothing moved. Magenta against hidden gives, per pixel, how much glyph is on screen; the authored shot gives
 * what a viewer sees there and right beside it.
 *
 * - invisible: a run with (almost) no glyph pixels: masked away, under an opaque image, or painted transparent.
 * - covered: part of a line under an image, icon or box has far fewer glyph pixels than the rest of that line.
 * - low-contrast: at each edge of a letter, the best WCAG ratio between the letter and what lies within a few pixels
 *   outside it (an outline or shadow counts, since it is there in the authored shot). Fails when a quarter or more of
 *   the edges stay under `minContrast`.
 */
export async function checkPixels(page: Page, m: FrameMeasure, minContrast: number, W: number, H: number): Promise<PixelResult> {
  const result: PixelResult = { issues: [], invisible: [], unstable: false };
  const runs = m.runs.filter((r) => r.lines.length && !r.overVideo);
  if (!runs.length) return result;
  const pad = Math.ceil(Math.max(...runs.map((r) => reach(r.px)))) + 1;
  const all = runs.flatMap((r) => r.lines);
  const x0 = Math.max(0, Math.floor(Math.min(...all.map((b) => b.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...all.map((b) => b.y)) - pad));
  const x1 = Math.min(W, Math.ceil(Math.max(...all.map((b) => b.x + b.w)) + pad));
  const y1 = Math.min(H, Math.ceil(Math.max(...all.map((b) => b.y + b.h)) + pad));
  if (x1 - x0 < 1 || y1 - y0 < 1) return result;
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const shot = async (mode: Mode, target: number | null = null) => {
    await page.evaluate(paintText, [mode, target] as [Mode, number | null]);
    return PNG.sync.read(await page.screenshot({ clip, omitBackground: true })).data;
  };
  // The page behind the composition is transparent here, so where a transparent composition shows nothing the pixels
  // say so (alpha 0) instead of showing the studio's backdrop, and contrast is not judged against it.
  await page.evaluate(() => {
    const s = document.createElement("style");
    s.setAttribute("data-lint-backdrop", "");
    s.setAttribute("data-lint-mark", "");
    s.textContent = "html, body { background: transparent !important; }";
    document.head.appendChild(s);
  });
  let A: Buffer, B: Buffer, C: Buffer, A2: Buffer;
  try {
    A = await shot(null);
    B = await shot("hide");
    C = await shot("magenta");
  } finally {
    A2 = await shot(null);
  }
  try {
    return await judge(A, B, C, A2);
  } finally {
    await page.evaluate(() => document.querySelectorAll("style[data-lint-backdrop]").forEach((n) => n.remove()));
  }

  async function judge(A: Buffer, B: Buffer, C: Buffer, A2: Buffer): Promise<PixelResult> {
    const w = clip.width, h = clip.height;
    let drift = 0;
    for (let i = 0; i < A.length; i += 4) if (Math.max(Math.abs(A[i] - A2[i]), Math.abs(A[i + 1] - A2[i + 1]), Math.abs(A[i + 2] - A2[i + 2])) > 24) drift++;
    if (drift > w * h * 0.002) return { ...result, unstable: true };

    // Glyph coverage 0..1 per pixel, NaN where the background is too close to magenta to tell.
    const coverage = (B: Buffer, C: Buffer) => {
      const alpha = new Float32Array(w * h);
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        const mr = 255 - B[i], mg = 0 - B[i + 1], mb = 255 - B[i + 2];
        const mm = mr * mr + mg * mg + mb * mb;
        if (mm < 3600) {
          alpha[p] = NaN;
          continue;
        }
        // How far the pixel moved from hidden towards magenta, by distance rather than direction: a blend mode turns the
        // magenta into some other colour, but the glyph still changes the pixel.
        const dr = C[i] - B[i], dg = C[i + 1] - B[i + 1], db = C[i + 2] - B[i + 2];
        alpha[p] = Math.min(1, Math.sqrt((dr * dr + dg * dg + db * db) / mm));
      }
      return alpha;
    };
    const shared = coverage(B, C);
    const local = (b: Box) => ({ l: Math.max(0, Math.floor(b.x) - x0), t: Math.max(0, Math.floor(b.y) - y0), r: Math.min(w, Math.ceil(b.x + b.w) - x0), b: Math.min(h, Math.ceil(b.y + b.h) - y0) });
    type Rect = ReturnType<typeof local>;
    const inRect = (x: number, y: number, r: Rect) => x >= r.l && x < r.r && y >= r.t && y < r.b;

    const touches = (a: TextRun, b: TextRun) => {
      const d = reach(Math.max(a.px, b.px));
      return a.lines.some((p) => b.lines.some((q) => p.x - d < q.x + q.w && q.x - d < p.x + p.w && p.y - d < q.y + q.h && q.y - d < p.y + p.h));
    };
    try {
      for (const run of runs) {
        const ink = 0.3 * run.opacity;
        const lines = run.lines.map(local).filter((r) => r.r > r.l && r.b > r.t);
        const alpha = m.runs.some((o) => o !== run && touches(run, o)) ? coverage(await shot("hide", run.index), await shot("magenta", run.index)) : shared;
        let known = 0, inked = 0;
        for (const r of lines) for (let y = r.t; y < r.b; y++) for (let x = r.l; x < r.r; x++) {
          const a = alpha[y * w + x];
          if (Number.isNaN(a)) continue;
          known++;
          if (a >= ink) inked++;
        }
        const area = lines.reduce((s, r) => s + (r.r - r.l) * (r.b - r.t), 0);
        if (!area || known < area * 0.5) continue;
        if (run.paintless || inked / known < 0.01) {
          result.invisible.push(run.key);
          continue;
        }
        if (run.embedded) continue;
        const add = (kind: Issue["kind"], box: Box, extra: Partial<Issue> = {}) => {
          if (!run.ignore.includes(kind)) result.issues.push({ kind, text: run.text, keys: [run.key], px: run.px, ...box, ...extra });
        };

        // Covered: compare glyph density under each occluder with the same rows of the line outside it.
        const hidden: Rect[] = [];
        for (const o of run.occluders.map(local)) {
          if (o.r - o.l < run.px * 0.6 || o.b - o.t < run.px * 0.3) continue;
          const line = lines.find((r) => o.l >= r.l - 1 && o.r <= r.r + 1 && o.t >= r.t - 1 && o.b <= r.b + 1);
          if (!line) continue;
          let ik = 0, it = 0, ok = 0, ot = 0;
          for (let y = o.t; y < o.b; y++) for (let x = line.l; x < line.r; x++) {
            const a = alpha[y * w + x];
            if (Number.isNaN(a)) continue;
            if (inRect(x, y, o)) {
              it++;
              if (a >= ink) ik++;
            } else {
              ot++;
              if (a >= ink) ok++;
            }
          }
          if (it && ot && ok / ot > 0.02 && ik / it < 0.2 * (ok / ot)) hidden.push(o);
        }
        if (hidden.length) {
          const l = Math.min(...hidden.map((o) => o.l)), t = Math.min(...hidden.map((o) => o.t));
          add("covered", { x: l + x0, y: t + y0, w: Math.max(...hidden.map((o) => o.r)) - l, h: Math.max(...hidden.map((o) => o.b)) - t });
        }

        if (!(minContrast > 0)) continue;
        // Low contrast: for each pixel on a letter's edge, the best ratio to any non-glyph pixel within `d` of it.
        const d = Math.round(reach(run.px));
        const solid = 0.75 * run.opacity;
        const best: number[] = [];
        for (const r of lines) for (let y = r.t; y < r.b; y++) for (let x = r.l; x < r.r; x++) {
          const p = y * w + x;
          if (!(alpha[p] >= solid)) continue;
          const edge = [p - 1, p + 1, p - w, p + w].some((q, k) => (k === 0 ? x > 0 : k === 1 ? x < w - 1 : k === 2 ? y > 0 : y < h - 1) && !(alpha[q] >= solid));
          if (!edge) continue;
          if (A[p * 4 + 3] < 250) continue;
          const fill = luminance(A, p * 4);
          let top = 0;
          for (let yy = Math.max(0, y - d); yy <= Math.min(h - 1, y + d); yy++) for (let xx = Math.max(0, x - d); xx <= Math.min(w - 1, x + d); xx++) {
            const q = yy * w + xx;
            if (!(alpha[q] < 0.1) || A[q * 4 + 3] < 250) continue;
            const c = ratio(fill, luminance(A, q * 4));
            if (c > top) top = c;
          }
          if (top) best.push(top);
        }
        if (best.length < 12) continue;
        best.sort((a, b) => a - b);
        const q = best[Math.floor(best.length * 0.25)];
        if (q < minContrast) {
          const v = run.lines;
          const l = Math.min(...v.map((b) => b.x)), t = Math.min(...v.map((b) => b.y));
          add("low-contrast", { x: l, y: t, w: Math.max(...v.map((b) => b.x + b.w)) - l, h: Math.max(...v.map((b) => b.y + b.h)) - t }, { contrast: Math.round(q * 10) / 10 });
        }
      }
    } finally {
      await page.evaluate(paintText, [null, null] as [Mode, number | null]);
    }
    return result;
  }
}

/** How far outside a letter its outline, shadow or background is looked for: about 0.06 em, at least 2 px. */
const reach = (px: number) => Math.max(2, px * 0.06);

/** The frame as the viewer sees it: invisible runs and their issues removed, pixel issues added. */
export function applyPixels(m: FrameMeasure, p: PixelResult): FrameMeasure {
  const gone = new Set(p.invisible);
  const runs: TextRun[] = m.runs.filter((r) => !gone.has(r.key));
  const issues = m.issues.filter((i) => !i.keys.some((k) => gone.has(k)));
  // A UI control over text is already reported as under-control; the same thing is not also "covered".
  const controlled = new Set(issues.filter((i) => i.kind === "under-control").flatMap((i) => i.keys));
  issues.push(...p.issues.filter((i) => i.kind !== "covered" || !i.keys.some((k) => controlled.has(k))));
  return { texts: runs.length, issues, runs };
}
