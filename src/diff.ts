import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Page } from "playwright";

/** How far a component on screen drifted from its reference on one frame. */
export interface DiffResult {
  mismatchPct: number;
  width: number;
  height: number;
  /** The three worst rows of a 12-row grid, as [row (1-based), percentage of that row's cells that differ]. */
  hottestRows: Array<[number, number]>;
  /** A side-by-side PNG: screen, reference, diff. */
  sideBySide: Buffer;
  /** Set when the two boxes differ in size by more than a pixel; only their common top-left area is compared. */
  sizeMismatch?: { screen: string; ref: string };
}

function crop(src: PNG, x: number, y: number, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return out;
}

/**
 * Compares `[data-lint="screen"]` with `[data-lint="ref"]` on the frame currently shown.
 * The reference is usually a screenshot of the real app placed beside the rebuilt component
 * in a test composition. Returns null when the frame has no such pair.
 */
export async function diffFrame(page: Page, threshold: number): Promise<DiffResult | null> {
  const boxes = await page.evaluate(() =>
    ["screen", "ref"].map((k) => {
      const e = document.querySelector(`[data-lint="${k}"]`);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );
  const [s, r] = boxes;
  if (!s || !r) return null;
  const shot = PNG.sync.read(await page.screenshot());
  const w = Math.min(s.w, r.w, shot.width - s.x, shot.width - r.x);
  const h = Math.min(s.h, r.h, shot.height - s.y, shot.height - r.y);
  if (w < 1 || h < 1) return null;
  const a = crop(shot, s.x, s.y, w, h);
  const b = crop(shot, r.x, r.y, w, h);
  const diff = new PNG({ width: w, height: h });
  const bad = pixelmatch(a.data, b.data, diff.data, w, h, { threshold, includeAA: false, alpha: 0.25 });

  const rows = 12;
  const rowPct: Array<[number, number]> = [];
  for (let ry = 0; ry < rows; ry++) {
    let n = 0, tot = 0;
    for (let y = Math.floor((ry * h) / rows); y < Math.floor(((ry + 1) * h) / rows); y++) {
      for (let x = 0; x < w; x++) {
        tot++;
        const i = (y * w + x) * 4;
        if (diff.data[i] > 200 && diff.data[i + 1] < 80) n++;
      }
    }
    rowPct.push([ry + 1, tot ? Math.round((n / tot) * 100) : 0]);
  }

  const side = new PNG({ width: w * 3 + 20, height: h });
  PNG.bitblt(a, side, 0, 0, w, h, 0, 0);
  PNG.bitblt(b, side, 0, 0, w, h, w + 10, 0);
  PNG.bitblt(diff, side, 0, 0, w, h, w * 2 + 20, 0);
  return {
    mismatchPct: Math.round((bad / (w * h)) * 1000) / 10,
    width: w,
    height: h,
    hottestRows: rowPct.sort((x, y) => y[1] - x[1]).slice(0, 3),
    sideBySide: PNG.sync.write(side),
    ...(Math.abs(s.w - r.w) > 1 || Math.abs(s.h - r.h) > 1 ? { sizeMismatch: { screen: `${s.w}x${s.h}`, ref: `${r.w}x${r.h}` } } : {}),
  };
}
