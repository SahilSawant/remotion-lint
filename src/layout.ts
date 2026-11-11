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
  /** The text runs involved (see {@link TextRun.key}); empty for a forbidden word found on a non-text element. */
  keys: string[];
}

/** One visible run of text: where it is, where it can be seen once masks are applied, and how opaque it is. */
export interface TextRun {
  /** The element's identity, stable across frames for as long as React keeps the element. */
  key: string;
  full: Box;
  visible: Box;
  opacity: number;
  /** Every `clip-path` and `mask-image` on the element and its ancestors, with the shape an SVG `url(#id)` points at, so a wipe that changes only its mask still counts as motion. */
  clip: string;
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
 * - `[data-lint-layer="<n>"]`: stacked shots; text under a painted, opaque higher layer that covers it is skipped.
 * - `[data-lint-ignore="<kind> <kind>"]` or `"all"`: switches checks off for an element and everything inside it.
 */
export const measure = ({ minFontPx, safeArea, W, H, overlap, forbidden }: Rules): FrameMeasure => {
  type R = { left: number; top: number; right: number; bottom: number };
  type Run = { el: Element; key: string; text: string; px: number; caps: R[]; full: R; vis: R; opacity: number; clip: string; cut: boolean; embedded: boolean; svg: boolean };
  const clipsOf = (el: Element) => {
    const out: string[] = [];
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      for (const c of [cs.clipPath, cs.maskImage]) {
        if (!c || c === "none") continue;
        const ref = /url\(["']?#([^"')]+)["']?\)/.exec(c);
        out.push(ref ? `${c}=${document.getElementById(ref[1])?.innerHTML ?? ""}` : c);
      }
    }
    return out.join(" | ");
  };
  const w = window as unknown as { __remotionLintIds?: WeakMap<Element, number>; __remotionLintNext?: number };
  const ids = (w.__remotionLintIds ??= new WeakMap());
  const idOf = (el: Element) => {
    if (!ids.has(el)) ids.set(el, (w.__remotionLintNext = (w.__remotionLintNext ?? 0) + 1));
    return String(ids.get(el));
  };
  const toBox = (r: R) => ({ x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top });
  const area = (r: R) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const intersect = (a: R, b: R): R => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const union = (rs: R[]): R => ({ left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) });
  const transparent = (c: string) => !c || c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const paints = (cs: CSSStyleDeclaration) => !transparent(cs.backgroundColor) || cs.backgroundImage !== "none";
  const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + "..." : s);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const skip = (el: Element) => !!el.closest("script, style, noscript, [data-lint-mark]");

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

  /** How much the element is scaled and rotated on screen, from its transforms rather than its bounding box. */
  const transformOf = (el: Element) => {
    if (el instanceof SVGGraphicsElement) {
      const m = el.getScreenCTM();
      return m ? { scale: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)), angle: Math.atan2(m.b, m.a) } : { scale: 1, angle: 0 };
    }
    let s = 1, angle = 0;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.transform && cs.transform !== "none") {
        const m = new DOMMatrix(cs.transform);
        s *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
        angle += Math.atan2(m.b, m.a);
      }
      if (cs.rotate && cs.rotate !== "none") angle += (parseFloat(cs.rotate.split(" ").pop() ?? "0") * Math.PI) / 180;
      if (cs.scale && cs.scale !== "none") {
        const [sx, sy = sx] = cs.scale.split(" ").map(parseFloat);
        s *= Math.sqrt(Math.abs(sx * sy));
      }
      const z = parseFloat((cs as unknown as { zoom: string }).zoom);
      if (z && z !== 1) s *= z;
    }
    return { scale: s, angle };
  };

  /**
   * Line boxes of the element's own text nodes (not its child elements), each shrunk to `ratio` em
   * around its middle. Rotated text keeps its full boxes, because the shrink assumes horizontal lines.
   */
  const linesOf = (el: Element, px: number, ratio: number, rotated: boolean): R[] => {
    if (el instanceof SVGGraphicsElement) {
      const r = el.getBoundingClientRect();
      return r.width && r.height ? [r] : [];
    }
    const out: R[] = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        if (rotated) {
          out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
          continue;
        }
        const h = Math.min(r.height, px * ratio);
        const mid = (r.top + r.bottom) / 2;
        out.push({ left: r.left, right: r.right, top: mid - h / 2, bottom: mid + h / 2 });
      }
    }
    return out;
  };

  const containsBlock = (cs: CSSStyleDeclaration) => cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" || /paint|layout|strict|content/.test(cs.contain);
  /**
   * The part of `r` left visible after every box that actually clips `el`, starting with `el` itself.
   * An absolutely positioned element is only clipped by ancestors on its containing-block chain.
   */
  const clipOf = (el: Element, r: R, tol: number) => {
    let vis = r;
    let cut = false;
    let need: "any" | "positioned" | "transformed" = "any";
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const onChain = e === el || need === "any" || (need === "positioned" && (cs.position !== "static" || containsBlock(cs))) || (need === "transformed" && containsBlock(cs));
      const inset = /^inset\(([^)]*)\)/.exec(cs.clipPath);
      if (inset) {
        const er = e.getBoundingClientRect();
        const parts = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
        const [t, r2 = t, b = t, l = r2] = parts;
        const len = (v: string, size: number) => (v.endsWith("%") ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);
        vis = intersect(vis, { top: er.top + len(t, er.height), right: er.right - len(r2, er.width), bottom: er.bottom - len(b, er.height), left: er.left + len(l, er.width) });
      }
      if (!onChain) continue;
      const cx = cs.overflowX !== "visible", cy = cs.overflowY !== "visible";
      if (cx || cy) {
        const er = e.getBoundingClientRect();
        const bound = { left: cx ? er.left : -Infinity, right: cx ? er.right : Infinity, top: cy ? er.top : -Infinity, bottom: cy ? er.bottom : Infinity };
        if (r.left < bound.left - tol || r.right > bound.right + tol || r.top < bound.top - tol || r.bottom > bound.bottom + tol) cut = true;
        vis = intersect(vis, bound);
      }
      need = cs.position === "absolute" ? "positioned" : cs.position === "fixed" ? "transformed" : "any";
    }
    return { vis, cut };
  };

  const layers = [...document.querySelectorAll<HTMLElement>("[data-lint-layer]")].map((e) => ({
    z: Number(e.dataset.lintLayer), o: opacityOf(e), painted: paints(getComputedStyle(e)), r: e.getBoundingClientRect() as R,
  }));
  const covered = (el: Element, r: R) => {
    const own = el.closest<HTMLElement>("[data-lint-layer]");
    if (!own) return false;
    const z = Number(own.dataset.lintLayer);
    return layers.some((l) => l.z > z && l.painted && l.o > 0.98 && l.r.left <= r.left + 1 && l.r.top <= r.top + 1 && l.r.right >= r.right - 1 && l.r.bottom >= r.bottom - 1);
  };
  const frame: R = { left: 0, top: 0, right: W, bottom: H };
  /** True when an unrelated element painted on top of `el` covers all of `r` (the next scene of a transition, a full-frame card). */
  const overlaid = (el: Element, r: R) => {
    const stack = document.elementsFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    for (const top of stack) {
      if (top === el || el.contains(top) || top.contains(el)) return false;
      const cs = getComputedStyle(top);
      const tr = top.getBoundingClientRect();
      const solid = paints(cs) || top instanceof HTMLImageElement || top instanceof HTMLVideoElement || top instanceof HTMLCanvasElement;
      if (solid && opacityOf(top) > 0.98 && tr.left <= r.left + 1 && tr.top <= r.top + 1 && tr.right >= r.right - 1 && tr.bottom >= r.bottom - 1) return true;
    }
    return false;
  };

  const runs: Run[] = [];
  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || skip(el)) continue;
    seen.add(el);
    if (hidden(el)) continue;
    const svg = el instanceof SVGElement;
    const tf = transformOf(el);
    const turned = Math.abs(Math.sin(tf.angle)) > 0.05;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize) * tf.scale * 10) / 10;
    const lines = linesOf(el, px, 1, turned);
    if (!lines.length) continue;
    const full = union(lines);
    const { vis, cut } = svg ? { vis: full, cut: false } : clipOf(el, full, Math.max(1, px * 0.08));
    const onScreen = intersect(vis, frame);
    if (area(onScreen) < 1 || covered(el, onScreen) || overlaid(el, onScreen)) continue;
    const text = norm(el.textContent ?? "");
    runs.push({ el, key: idOf(el), text, px, caps: linesOf(el, px, 0.75, turned), full, vis: onScreen, opacity: Math.round(opacityOf(el) * 100) / 100, clip: clipsOf(el), cut, embedded: !!el.closest('[data-lint="embedded"]'), svg });
  }

  const issues: Issue[] = [];
  const add = (kind: IssueKind, els: Element[], keys: string[], text: string, r: R, px?: number) => {
    if (!els.some((el) => ignored(el, kind))) issues.push({ kind, text: short(text), keys, ...toBox(r), ...(px ? { px } : {}) });
  };

  for (const t of runs) {
    const one = [t.el], k = [t.key];
    if (t.cut) add("clipped", one, k, t.text, t.full, t.px);
    if (t.embedded) continue;
    if (t.px < minFontPx) add("too-small", one, k, t.text, t.vis, t.px);
    if (t.vis.left < safeArea || t.vis.top < safeArea || t.vis.right > W - safeArea || t.vis.bottom > H - safeArea) add("outside-safe-area", one, k, t.text, t.vis, t.px);
    if (t.svg) continue;

    for (let e: Element | null = t.el; e && e !== document.body; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (!paints(ecs) && !(parseFloat(ecs.borderTopWidth) > 0)) continue;
      const br = e.getBoundingClientRect();
      if (br.width < 40 || br.height < 20) continue;
      if (e === t.el || (br.width >= W - 2 && br.height >= H - 2)) break;
      if (t.vis.left < br.left - 2 || t.vis.right > br.right + 2 || t.vis.top < br.top - 2 || t.vis.bottom > br.bottom + 2) add("escapes-box", one, k, t.text, t.vis, t.px);
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
        add("under-control", one, k, t.text, t.vis, t.px);
        break;
      }
    }
  }

  const film = runs.filter((t) => !t.embedded);
  const near = (a: R, b: R) => Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4 && Math.abs(a.right - b.right) < 4 && Math.abs(a.bottom - b.bottom) < 4;
  for (let i = 0; i < film.length; i++) {
    for (let j = i + 1; j < film.length; j++) {
      const a = film[i], b = film[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.text === b.text && near(a.full, b.full)) continue;
      const hit = a.caps.some((la) => b.caps.some((lb) => area(intersect(la, lb)) > overlap * Math.min(area(la), area(lb))));
      if (hit) add("overlap", [a.el, b.el], [a.key, b.key], `${short(a.text)} <> ${short(b.text)}`, union([a.vis, b.vis]));
    }
  }

  if (forbidden.length) {
    const banned = forbidden.map((f) => new RegExp(f, "i"));
    const nodes: Array<{ n: Text; first: R; last: R; px: number }> = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (tw.nextNode()) {
      const n = tw.currentNode as Text;
      if (!n.textContent?.trim() || !n.parentElement || skip(n.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rs.length) continue;
      nodes.push({ n, first: rs[0], last: rs[rs.length - 1], px: parseFloat(getComputedStyle(n.parentElement).fontSize) });
    }
    /** Joins text nodes, adding a space unless two sit side by side on one line, so "What to" / "do next" never reads "todo". */
    const join = (list: typeof nodes) => {
      let s = "";
      list.forEach((x, i) => {
        if (i) {
          const p = list[i - 1].last, q = x.first;
          const sameLine = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 0.5 * Math.min(p.bottom - p.top, q.bottom - q.top);
          const gap = q.left - p.right;
          if (!sameLine || Math.abs(gap) > 0.3 * x.px) s += " ";
        }
        s += x.n.textContent;
      });
      return norm(s);
    };
    const textOf = (e: Element) => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? norm(e.value) : join(nodes.filter((x) => e.contains(x.n))));
    const memo = new Map<Element, boolean>();
    const matches = (e: Element): boolean => {
      if (!memo.has(e)) memo.set(e, !skip(e) && banned.some((re) => re.test(textOf(e))));
      return memo.get(e)!;
    };
    for (const e of document.body.querySelectorAll("*")) {
      if (!matches(e) || [...e.children].some(matches) || hidden(e)) continue;
      const r = intersect(clipOf(e, e.getBoundingClientRect(), 0).vis, frame);
      if (area(r) < 1 || covered(e, r)) continue;
      add("forbidden-word", [e], [], textOf(e), r);
    }
  }

  return { texts: runs.length, issues, runs: runs.map((t) => ({ key: t.key, full: toBox(t.full), visible: toBox(t.vis), opacity: t.opacity, clip: t.clip })) };
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

const sameBox = (p: Box, q: Box) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.w - q.w) + Math.abs(p.h - q.h) <= 0.5;

/**
 * Whether any run in `keys` is in a different place, size, opacity or mask in `other` than in `now`.
 * A run missing from `other` is not counted as moving: text that appears or disappears at a cut
 * is judged where it stands.
 */
export function moved(keys: string[], now: TextRun[], other: TextRun[]): boolean {
  return keys.some((k) => {
    const p = now.find((r) => r.key === k), q = other.find((r) => r.key === k);
    return !!p && !!q && (!sameBox(p.full, q.full) || !sameBox(p.visible, q.visible) || Math.abs(p.opacity - q.opacity) > 0.01 || p.clip !== q.clip);
  });
}
