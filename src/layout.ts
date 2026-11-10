import type { Page } from "playwright";
import type { Config } from "./config.js";

/** The kinds of layout problem remotion-lint reports. */
export type IssueKind = "clipped" | "too-small" | "outside-safe-area" | "overlap" | "forbidden-word" | "escapes-box" | "under-control";

/** A box on screen, in CSS px of the composition. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One problem on one frame, with the on-screen box that shows it. */
export interface Issue extends Box {
  kind: IssueKind;
  text: string;
  px?: number;
}

/** One visible run of text: where it is, and where it can be seen once masks are applied. */
export interface TextRun {
  text: string;
  full: Box;
  visible: Box;
}

/** What one frame measured. */
export interface FrameMeasure {
  texts: number;
  issues: Issue[];
  runs: TextRun[];
}

type Rules = Config["layout"] & { W: number; H: number };

/**
 * Runs inside the page: finds every visible run of text, measures it line by line, and returns
 * what breaks the rules. Must stay self-contained, because Playwright serialises it into the page.
 *
 * - `[data-lint="embedded"]`: another app's UI inside the video; only clipping and forbidden words are checked.
 * - `[data-lint-layer="<n>"]`: stacked shots; text under an opaque higher layer that covers it is skipped.
 * - `[data-lint-ignore="<kind> <kind>"]` or `"all"`: switches checks off for an element and everything inside it.
 */
export const measure = ({ minFontPx, safeArea, W, H, overlap, forbidden }: Rules): FrameMeasure => {
  type R = { left: number; top: number; right: number; bottom: number };
  type Run = { el: Element; text: string; px: number; lines: R[]; full: R; vis: R; cut: boolean; embedded: boolean; svg: boolean };
  const toBox = (r: R) => ({ x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top });
  const area = (r: R) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const intersect = (a: R, b: R): R => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const union = (rs: R[]): R => ({ left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) });
  const transparent = (c: string) => !c || c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + "..." : s);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  const opacityOf = (el: Element | null) => {
    let a = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
    return a;
  };
  const hidden = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.display === "none") return true;
    }
    return opacityOf(el) < 0.5;
  };
  const ignored = (el: Element, kind: string): boolean => {
    const host = el.closest("[data-lint-ignore]");
    if (!host) return false;
    const list = (host.getAttribute("data-lint-ignore") ?? "").split(/\s+/);
    return list.includes("all") || list.includes(kind) || (host.parentElement ? ignored(host.parentElement, kind) : false);
  };

  /** How much the element is scaled on screen, from its transforms rather than its bounding box. */
  const scaleOf = (el: Element) => {
    if (el instanceof SVGGraphicsElement) {
      const m = el.getScreenCTM();
      return m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
    }
    let s = 1;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.transform && cs.transform !== "none") {
        const m = new DOMMatrix(cs.transform);
        s *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      }
      if (cs.scale && cs.scale !== "none") {
        const [sx, sy = sx] = cs.scale.split(" ").map(parseFloat);
        s *= Math.sqrt(Math.abs(sx * sy));
      }
      const z = parseFloat((cs as unknown as { zoom: string }).zoom);
      if (z && z !== 1) s *= z;
    }
    return s;
  };

  /** Each line's box, shrunk vertically to the em box: the font's ascent and descent overstate where letters are. */
  const linesOf = (el: Element, px: number): R[] => {
    if (el instanceof SVGGraphicsElement) {
      const r = el.getBoundingClientRect();
      return r.width && r.height ? [r] : [];
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const out: R[] = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const h = Math.min(r.height, px);
      const mid = (r.top + r.bottom) / 2;
      out.push({ left: r.left, right: r.right, top: mid - h / 2, bottom: mid + h / 2 });
    }
    return out;
  };

  /** The part of `r` left visible after every clipping ancestor of `el`, plus the ancestors that cut into it. */
  const clipOf = (el: Element, r: R, tol: number) => {
    let vis = r;
    let cut = false;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const cx = cs.overflowX !== "visible", cy = cs.overflowY !== "visible";
      if (!cx && !cy) continue;
      const er = e.getBoundingClientRect();
      const bound = { left: cx ? er.left : -Infinity, right: cx ? er.right : Infinity, top: cy ? er.top : -Infinity, bottom: cy ? er.bottom : Infinity };
      if (r.left < bound.left - tol || r.right > bound.right + tol || r.top < bound.top - tol || r.bottom > bound.bottom + tol) cut = true;
      vis = intersect(vis, bound);
    }
    return { vis, cut };
  };

  const layers = [...document.querySelectorAll<HTMLElement>("[data-lint-layer]")].map((e) => ({ z: Number(e.dataset.lintLayer), o: opacityOf(e), r: e.getBoundingClientRect() as R }));
  const covered = (el: Element, r: R) => {
    const own = el.closest<HTMLElement>("[data-lint-layer]");
    if (!own) return false;
    const z = Number(own.dataset.lintLayer);
    return layers.some((l) => l.z > z && l.o > 0.98 && l.r.left <= r.left + 1 && l.r.top <= r.top + 1 && l.r.right >= r.right - 1 && l.r.bottom >= r.bottom - 1);
  };
  const frame: R = { left: 0, top: 0, right: W, bottom: H };

  const runs: Run[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || el.closest("script, style, noscript, [data-lint-mark]")) continue;
    seen.add(el);
    if (hidden(el)) continue;
    const svg = el instanceof SVGElement;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize) * scaleOf(el) * 10) / 10;
    const lines = linesOf(el, px);
    if (!lines.length) continue;
    const full = union(lines);
    const { vis, cut } = svg ? { vis: full, cut: false } : clipOf(el, full, Math.max(1, px * 0.08));
    const onScreen = intersect(vis, frame);
    if (area(onScreen) < 1 || covered(el, onScreen)) continue;
    runs.push({ el, text: norm(el.textContent ?? ""), px, lines, full, vis: onScreen, cut, embedded: !!el.closest('[data-lint="embedded"]'), svg });
  }

  const issues: Array<{ kind: string; text: string; x: number; y: number; w: number; h: number; px?: number }> = [];
  const add = (kind: string, el: Element, text: string, r: R, px?: number) => {
    if (!ignored(el, kind)) issues.push({ kind, text: short(text), ...toBox(r), ...(px ? { px } : {}) });
  };

  for (const t of runs) {
    if (t.cut) add("clipped", t.el, t.text, t.full, t.px);
    if (t.embedded) continue;
    if (t.px < minFontPx) add("too-small", t.el, t.text, t.vis, t.px);
    if (t.vis.left < safeArea || t.vis.top < safeArea || t.vis.right > W - safeArea || t.vis.bottom > H - safeArea) add("outside-safe-area", t.el, t.text, t.vis, t.px);
    if (t.svg) continue;

    for (let e: Element | null = t.el; e && e !== document.body; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (transparent(ecs.backgroundColor) && !(parseFloat(ecs.borderTopWidth) > 0) && ecs.backgroundImage === "none") continue;
      const br = e.getBoundingClientRect();
      if (br.width < 40 || br.height < 20) continue;
      if (e === t.el || (br.width >= W - 2 && br.height >= H - 2)) break;
      if (t.vis.left < br.left - 2 || t.vis.right > br.right + 2 || t.vis.top < br.top - 2 || t.vis.bottom > br.bottom + 2) add("escapes-box", t.el, t.text, t.vis, t.px);
      break;
    }

    for (const c of document.querySelectorAll("div, span, button")) {
      if (c.contains(t.el) || t.el.contains(c) || c.closest('[data-lint="embedded"]')) continue;
      if (transparent(getComputedStyle(c).backgroundColor) || opacityOf(c) < 0.5) continue;
      const cr = c.getBoundingClientRect();
      if (cr.width < 24 || cr.height < 24 || cr.width > 240 || cr.height > 240) continue;
      const i = intersect(t.vis, cr);
      if (i.right - i.left <= 4 || i.bottom - i.top <= (t.vis.bottom - t.vis.top) * 0.3) continue;
      const stack = document.elementsFromPoint((i.left + i.right) / 2, (i.top + i.bottom) / 2);
      const ic = stack.findIndex((e) => c === e || c.contains(e));
      const it = stack.findIndex((e) => e === t.el || t.el.contains(e));
      if (ic >= 0 && (it < 0 || ic < it)) {
        add("under-control", t.el, t.text, t.vis, t.px);
        break;
      }
    }
  }

  const film = runs.filter((t) => !t.embedded);
  for (let i = 0; i < film.length; i++) {
    for (let j = i + 1; j < film.length; j++) {
      const a = film[i], b = film[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const hit = a.lines.some((la) => b.lines.some((lb) => area(intersect(la, lb)) > overlap * Math.min(area(la), area(lb))));
      if (hit) add("overlap", a.el, `${short(a.text)} <> ${short(b.text)}`, union([a.vis, b.vis]));
    }
  }

  if (forbidden.length) {
    const banned = forbidden.map((f) => new RegExp(f, "i"));
    const textOf = (e: Element) => norm(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : e.textContent ?? "");
    const matches = (e: Element) => !e.closest("script, style, noscript, [data-lint-mark]") && banned.some((re) => re.test(textOf(e)));
    for (const e of document.body.querySelectorAll("*")) {
      if (!matches(e) || [...e.children].some(matches) || hidden(e)) continue;
      const r = intersect(e.getBoundingClientRect(), frame);
      if (area(r) < 1 || covered(e, r)) continue;
      add("forbidden-word", e, textOf(e), r);
    }
  }

  return { texts: runs.length, issues: issues as Issue[], runs: runs.map((t) => ({ text: t.text, full: toBox(t.full), visible: toBox(t.vis) })) };
};

const COLOUR: Record<IssueKind, string> = {
  clipped: "#e00000", "forbidden-word": "#b00020", "too-small": "#c77700", "outside-safe-area": "#0077cc",
  overlap: "#c000a8", "escapes-box": "#d35400", "under-control": "#d35400",
};

/** Measures the frame currently shown on `page`. */
export async function lintFrame(page: Page, layout: Config["layout"], W: number, H: number): Promise<FrameMeasure> {
  return page.evaluate(measure, { ...layout, W, H });
}

/** Draws the safe area and a labelled box round each issue, screenshots, then removes the marks. */
export async function screenshotWithMarks(page: Page, issues: Issue[], safeArea: number, file: string): Promise<void> {
  await page.evaluate(([list, safe, colour]) => {
    const mark = (style: Partial<CSSStyleDeclaration>, label = "", c = "") => {
      const d = document.createElement("div");
      d.setAttribute("data-lint-mark", "");
      Object.assign(d.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none", font: "600 14px monospace" }, style);
      if (label) {
        const t = document.createElement("span");
        Object.assign(t.style, { position: "absolute", left: "-3px", bottom: "100%", padding: "2px 6px", background: c, color: "#fff", whiteSpace: "nowrap" });
        t.textContent = label;
        d.appendChild(t);
      }
      document.body.appendChild(d);
    };
    mark({ left: `${safe}px`, top: `${safe}px`, right: `${safe}px`, bottom: `${safe}px`, border: "1px dashed rgba(0,119,204,0.6)" });
    for (const i of list) {
      const c = colour[i.kind];
      mark({ left: `${i.x - 3}px`, top: `${i.y - 3}px`, width: `${i.w + 6}px`, height: `${i.h + 6}px`, border: `3px solid ${c}` }, i.kind + (i.px ? ` ${i.px}px` : ""), c);
    }
  }, [issues, safeArea, COLOUR] as const);
  await page.screenshot({ path: file });
  await page.evaluate(() => document.querySelectorAll("[data-lint-mark]").forEach((n) => n.remove()));
}

/** Kinds that are expected while something is moving: a slide-in crosses the edge, a reveal is clipped by its mask. */
export const TRANSIENT: IssueKind[] = ["clipped", "outside-safe-area"];

/** True when the run with this text has a different full or visible box in `other`, i.e. it is mid-transition. */
export function isMoving(issue: Issue, now: TextRun[], other: TextRun[]): boolean {
  const text = issue.text.endsWith("...") ? issue.text.slice(0, -3) : issue.text;
  const a = now.find((r) => r.text.startsWith(text));
  const b = other.find((r) => r.text.startsWith(text));
  if (!a || !b) return false;
  const moved = (p: Box, q: Box) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.w - q.w) + Math.abs(p.h - q.h) > 0.5;
  return moved(a.full, b.full) || moved(a.visible, b.visible);
}
