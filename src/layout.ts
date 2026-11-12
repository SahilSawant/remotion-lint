import type { Page } from "playwright";
import type { Config } from "./config.js";

/** The kinds of layout problem remotion-lint reports. */
export type IssueKind = "clipped" | "too-small" | "outside-safe-area" | "overlap" | "forbidden-word" | "escapes-box" | "under-control" | "low-contrast" | "covered";

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
  /** For `low-contrast`: the WCAG contrast ratio three quarters of the letters' edges reach. */
  contrast?: number;
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
  /** Its element carries `data-lint-run` with this number until the next measurement, so a screenshot can single it out. */
  index: number;
  text: string;
  px: number;
  /** Each line box of the run, cut to what is on screen. */
  lines: Box[];
  /** Parts of the lines with an unrelated image, icon, video or painted box stacked above the text. */
  occluders: Box[];
  /** Pixels say nothing here: the run is over video, which this tool cannot show (see page.ts). */
  overVideo: boolean;
  embedded: boolean;
  /** Its fill is transparent and nothing else draws its glyphs (no background-clip: text, stroke or shadow). */
  paintless: boolean;
  /** Pixel kinds switched off for this run by `data-lint-ignore`. */
  ignore: IssueKind[];
}

/** What one frame measured. */
export interface FrameMeasure {
  texts: number;
  issues: Issue[];
  runs: TextRun[];
}

type Rules = Config["layout"] & { safeX: number; safeY: number; W: number; H: number };

/**
 * Runs inside the page: finds every visible run of text, measures it line by line, and returns
 * what breaks the rules. Must stay self-contained, because Playwright serialises it into the page.
 *
 * - `[data-lint="embedded"]`: another app's UI inside the video; only clipping and forbidden words are checked.
 * - `[data-lint-layer="<n>"]`: stacked shots; text under a fully opaque higher layer that covers it is skipped.
 * - `[data-lint-ignore="<kind> <kind>"]` or `"all"`: switches checks off for an element and everything inside it.
 */
export const measure = ({ minFontPx, safeX, safeY, W, H, overlap, forbidden }: Rules): FrameMeasure => {
  // Hit testing must see every element, including ones with pointer-events: none. Paint and layout are unchanged.
  const probe = document.createElement("style");
  probe.setAttribute("data-lint-mark", "");
  probe.textContent = "* { pointer-events: auto !important; }";
  document.head.appendChild(probe);
  try {
    type R = { left: number; top: number; right: number; bottom: number };
    type Run = { el: Element; key: string; text: string; own: string; px: number; caps: R[]; lines: R[]; full: R; vis: R; opacity: number; clip: string; cut: boolean; offFrame: boolean; embedded: boolean; svg: boolean };
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
    /**
     * A name for a run that survives React remounting or re-wrapping it (seeking out of its <Sequence> and back, a
     * transition adding wrappers): its text with numbers blanked, so a counter keeps its name while it counts, and its
     * CSS font size, numbered in document order when both repeat. A typewriter, whose words change, gets a new name
     * each frame and is judged as if it stood still.
     */
    const keyCount = new Map<string, number>();
    const keyOf = (text: string, el: Element) => {
      const base = `${text.replace(/\d[\d.,:]*/g, "#")}|${getComputedStyle(el).fontSize}`;
      const n = (keyCount.get(base) ?? 0) + 1;
      keyCount.set(base, n);
      return `${base}#${n}`;
    };
    const toBox = (r: R) => ({ x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top });
    const area = (r: R) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
    const intersect = (a: R, b: R): R => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
    const union = (rs: R[]): R => ({ left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)), right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) });
    /** [r, g, b, a] of a computed colour, or null for a format this does not read. */
    const rgba = (c: string): number[] | null => {
      const m = /^rgba?\(([^)]+)\)$/.exec(c);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return [r, g, b, a];
    };
    const transparent = (c: string) => !c || c === "transparent" || rgba(c)?.[3] === 0;
    const paints = (cs: CSSStyleDeclaration) => !transparent(cs.backgroundColor) || cs.backgroundImage !== "none";
    /**
     * Paints a solid, fully opaque colour that nothing can show through: normal blending, and no mask, filter or
     * clip-path on it or any ancestor. Anything less (a tint, gradient, vignette, masked scrim, image or video) does not hide text.
     */
    const opaque = (el: Element) => {
      const cs = getComputedStyle(el);
      if (rgba(cs.backgroundColor)?.[3] !== 1 || cs.mixBlendMode !== "normal") return false;
      for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
        const c = getComputedStyle(e);
        if ((c.maskImage && c.maskImage !== "none") || c.filter !== "none" || c.clipPath !== "none" || c.mixBlendMode !== "normal") return false;
      }
      return true;
    };
    /** `r` lies inside `el`'s box, away from its rounded corners. */
    const inside = (el: Element, r: R) => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      const k = Math.max(...[cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius].map((v) => parseFloat(v) || 0));
      return b.left + k <= r.left + 1 && b.top + k <= r.top + 1 && b.right - k >= r.right - 1 && b.bottom - k >= r.bottom - 1;
    };
    const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + "..." : s);
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const skip = (el: Element) => !!el.closest("script, style, noscript, [data-lint-mark]");

    const opacityOf = (el: Element | null) => {
      let a = 1;
      for (let e = el; e && e !== document.documentElement; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
      return a;
    };
    const hidden = (el: Element, minOpacity = 0.5) => {
      if (getComputedStyle(el).visibility === "hidden") return true;
      for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) if (getComputedStyle(e).display === "none") return true;
      return opacityOf(el) < minOpacity;
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

    /**
     * The bounding box of a `clip-path` basic shape on `e` (inset, circle, ellipse, polygon), or null for none or a
     * shape this does not read (`path()`, `url()`).
     */
    const clipShape = (e: Element, clip: string): R | null => {
      const m = /^(inset|circle|ellipse|polygon)\((.*)\)/.exec(clip);
      if (!m) return null;
      const b = e.getBoundingClientRect();
      const len = (v: string, size: number) => (v.endsWith("%") ? (parseFloat(v) / 100) * size : parseFloat(v) || 0);
      const KEY: Record<string, string> = { left: "0%", top: "0%", center: "50%", right: "100%", bottom: "100%" };
      const pos = (at: string | undefined) => {
        const [x = "50%", y = "50%"] = (at ?? "").trim().split(/\s+/).filter(Boolean).map((v) => KEY[v] ?? v);
        return [b.left + len(x, b.width), b.top + len(y, b.height)];
      };
      const [shapeArgs, at] = m[2].split(/\s+at\s+/);
      if (m[1] === "inset") {
        const [t, r2 = t, bo = t, l = r2] = m[2].split(/\s+round\s+/)[0].trim().split(/\s+/);
        return { top: b.top + len(t, b.height), right: b.right - len(r2, b.width), bottom: b.bottom - len(bo, b.height), left: b.left + len(l, b.width) };
      }
      if (m[1] === "circle") {
        const [cx, cy] = pos(at);
        const rad = len(shapeArgs.trim() || "50%", Math.hypot(b.width, b.height) / Math.SQRT2);
        return { left: cx - rad, right: cx + rad, top: cy - rad, bottom: cy + rad };
      }
      if (m[1] === "ellipse") {
        const [cx, cy] = pos(at);
        const [rx = "50%", ry = "50%"] = shapeArgs.trim().split(/\s+/).filter(Boolean);
        const ax = len(rx, b.width), ay = len(ry, b.height);
        return { left: cx - ax, right: cx + ax, top: cy - ay, bottom: cy + ay };
      }
      const pts = m[2].replace(/^\s*(nonzero|evenodd)\s*,/, "").split(",").map((p) => p.trim().split(/\s+/));
      const xs = pts.map(([x]) => b.left + len(x, b.width)), ys = pts.map(([, y]) => b.top + len(y ?? "0", b.height));
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
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
        const shape = clipShape(e, cs.clipPath);
        if (shape) {
          if (r.left < shape.left - tol || r.right > shape.right + tol || r.top < shape.top - tol || r.bottom > shape.bottom + tol) cut = true;
          vis = intersect(vis, shape);
        }
        if (!onChain) continue;
        const contained = /paint|strict|content/.test(cs.contain);
        const cx = contained || cs.overflowX !== "visible", cy = contained || cs.overflowY !== "visible";
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
      z: Number(e.dataset.lintLayer), o: opacityOf(e), el: e,
    }));
    const covered = (el: Element, r: R) => {
      const own = el.closest<HTMLElement>("[data-lint-layer]");
      if (!own) return false;
      const z = Number(own.dataset.lintLayer);
      return layers.some((l) => l.z > z && l.o > 0.98 && opaque(l.el) && inside(l.el, r));
    };
    const frame: R = { left: 0, top: 0, right: W, bottom: H };
    /**
     * True when an unrelated element painted on top of `el` hides all of `r` (the next scene of a transition, a full-frame
     * card). Only a plain solid colour counts (see `opaque`); images and video never do, since they may be transparent.
     */
    const overlaid = (el: Element, r: R) => {
      const stack = document.elementsFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      for (const top of stack) {
        if (top === el || el.contains(top) || top.contains(el)) return false;
        if (opacityOf(top) > 0.98 && opaque(top) && inside(top, r)) return true;
      }
      return false;
    };

    document.querySelectorAll("[data-lint-run]").forEach((e) => e.removeAttribute("data-lint-run"));
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
      const tol = Math.max(1, px * 0.08);
      const text = norm(el.textContent ?? "");
      // Capitals and figures sit inside the middle 0.8 em of the em box, so an all-caps line is tested by that band,
      // with only a pixel of tolerance: a tight mask around it cuts nothing until it cuts into the letters.
      const caps = getComputedStyle(el).textTransform === "uppercase" || !/\p{Ll}/u.test(text);
      const clip = svg ? { vis: full, cut: false } : caps ? clipOf(el, union(linesOf(el, px, 0.8, turned)), 1) : clipOf(el, full, tol);
      const offFrame = full.left < -tol || full.top < -tol || full.right > W + tol || full.bottom > H + tol;
      const onScreen = intersect(clip.vis, frame);
      if (area(onScreen) < 1 || covered(el, onScreen) || overlaid(el, onScreen)) continue;
      const own = norm([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(""));
      const shown = lines.map((l) => intersect(l, onScreen)).filter((l) => area(l) >= 1);
      runs.push({ el, key: keyOf(text, el), text, own, px, caps: linesOf(el, px, 0.75, turned), lines: shown, full, vis: onScreen, opacity: Math.round(opacityOf(el) * 100) / 100, clip: clipsOf(el), cut: clip.cut || offFrame, offFrame, embedded: !!el.closest('[data-lint="embedded"]'), svg });
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
      if (!t.offFrame && (t.vis.left < safeX || t.vis.top < safeY || t.vis.right > W - safeX || t.vis.bottom > H - safeY)) add("outside-safe-area", one, k, t.text, t.vis, t.px);
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
        const ccs = getComputedStyle(c);
        if (transparent(ccs.backgroundColor) || ccs.mixBlendMode !== "normal" || (rgba(ccs.backgroundColor)?.[3] ?? 1) < 0.9 || opacityOf(c) < 0.5) continue;
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
    /** True when `inner`'s text flows inside `outer`'s (a <b> in a <p>), not when it is positioned on top of it. */
    const inFlow = (outer: Element, inner: Element) => {
      for (let e: Element | null = inner; e && e !== outer; e = e.parentElement) if (/absolute|fixed/.test(getComputedStyle(e).position)) return false;
      return true;
    };
    /** Copies of one text offset by up to 0.15 em: an outline, a drop shadow or a retro offset, not two things colliding. */
    const near = (a: R, b: R, px: number) => {
      const d = Math.max(4, px * 0.15);
      return Math.abs(a.left - b.left) < d && Math.abs(a.top - b.top) < d && Math.abs(a.right - b.right) < d && Math.abs(a.bottom - b.bottom) < d;
    };
    for (let i = 0; i < film.length; i++) {
      for (let j = i + 1; j < film.length; j++) {
        const a = film[i], b = film[j];
        if ((a.el.contains(b.el) && inFlow(a.el, b.el)) || (b.el.contains(a.el) && inFlow(b.el, a.el))) continue;
        if (a.own === b.own && near(a.full, b.full, Math.max(a.px, b.px))) continue;
        const hit = a.caps.some((la) => b.caps.some((lb) => area(intersect(la, lb)) > overlap * Math.min(area(la), area(lb))));
        if (hit) add("overlap", [a.el, b.el], [a.key, b.key], `${short(a.text)} <> ${short(b.text)}`, union([a.vis, b.vis]));
      }
    }

    if (forbidden.length) {
      const banned = forbidden.map((f) => new RegExp(f, "i"));
      const nodes: Array<{ n: Text; first: R; last: R; px: number; space: boolean }> = [];
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const n = tw.currentNode as Text;
        if (!n.textContent || !n.parentElement || skip(n.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const rs = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        if (!rs.length) continue;
        nodes.push({ n, first: rs[0], last: rs[rs.length - 1], px: parseFloat(getComputedStyle(n.parentElement).fontSize), space: !n.textContent.trim() });
      }
      /**
       * Joins text nodes as they read: a rendered space (or no-break space) between spans stays a space, and two pieces
       * get a space unless they sit side by side on one line (closer than 0.15 em, or 0.6 em between single letters), so
       * "What to" / "do next" never reads "todo" and a tracked-out "N i g h t j a r" reads "Nightjar".
       */
      const join = (list: typeof nodes) => {
        let s = "";
        let prev: (typeof nodes)[number] | undefined;
        for (const x of list) {
          if (x.space) {
            s += " ";
            continue;
          }
          if (prev && !s.endsWith(" ")) {
            const p = prev.last, q = x.first;
            const sameLine = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 0.5 * Math.min(p.bottom - p.top, q.bottom - q.top);
            const gap = Math.abs(q.left - p.right);
            // Letters set one per span are read as one word even when tracked out; whole words need to touch.
            const letters = prev.n.textContent!.trim().length === 1 && x.n.textContent!.trim().length === 1;
            if (!sameLine || gap > (letters ? 0.6 : 0.15) * x.px) s += " ";
          }
          s += x.n.textContent;
          prev = x;
        }
        return norm(s);
      };
      /** Also reads letters spaced out one by one ("N i g h t j a r") as the word they spell. */
      const spelled = (t: string) => t.replace(/(?<=(?:^|\s)\p{L})\s(?=\p{L}(?:\s|$))/gu, "");
      const textOf = (e: Element) => (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? norm(e.value) : join(nodes.filter((x) => e.contains(x.n))));
      const memo = new Map<Element, boolean>();
      const matches = (e: Element): boolean => {
        if (!memo.has(e)) {
          const t = textOf(e);
          memo.set(e, !skip(e) && banned.some((re) => re.test(t) || re.test(spelled(t))));
        }
        return memo.get(e)!;
      };
      for (const e of document.body.querySelectorAll("*")) {
        if (!matches(e) || [...e.children].some(matches) || hidden(e, 0.05)) continue;
        const r = intersect(clipOf(e, e.getBoundingClientRect(), 0).vis, frame);
        if (area(r) < 1 || covered(e, r)) continue;
        add("forbidden-word", [e], [], textOf(e), r);
      }
    }

    // Text from CSS `content` on ::before and ::after has no text node: its literal strings are read from the style.
    for (const el of document.body.querySelectorAll("*")) {
      if (skip(el) || hidden(el)) continue;
      for (const pseudo of ["::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        if (!cs.content || cs.content === "none" || cs.content === "normal") continue;
        const text = norm([...cs.content.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")).join(""));
        if (!/[\p{L}\p{N}]/u.test(text) || cs.display === "none" || cs.visibility === "hidden") continue;
        const r = intersect(el.getBoundingClientRect(), frame);
        const px = Math.round(parseFloat(cs.fontSize) * transformOf(el).scale * 10) / 10;
        if (!el.closest('[data-lint="embedded"]') && px < minFontPx) add("too-small", [el], [], `${pseudo} ${text}`, r, px);
        if (forbidden.some((f) => new RegExp(f, "i").test(text))) add("forbidden-word", [el], [], text, r);
      }
    }

    const replaced = (e: Element) => /^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED|PICTURE)$/.test(e.tagName) || (e instanceof SVGElement && !(e instanceof SVGTextContentElement) && e.tagName !== "svg");
    const related = (a: Element, b: Element) => a === b || a.contains(b) || b.contains(a);
    /** Unrelated things painted above the run's lines, found by hit testing a grid over each line. */
    const occludersOf = (t: Run): R[] => {
      const found = new Map<Element, R[]>();
      const step = Math.max(8, t.px * 0.5);
      for (const l of t.lines) {
        for (let x = l.left + step / 2; x < l.right; x += step) {
          for (const fy of [0.35, 0.65]) {
            const stack = document.elementsFromPoint(x, l.top + (l.bottom - l.top) * fy);
            const mine = stack.findIndex((e) => related(e, t.el));
            for (const e of mine < 0 ? stack : stack.slice(0, mine)) {
              if (related(e, t.el) || skip(e) || opacityOf(e) < 0.05) continue;
              const cs = getComputedStyle(e);
              if (!replaced(e) && !paints(cs) && !(parseFloat(cs.borderTopWidth) > 0)) continue;
              const list = found.get(e) ?? [];
              if (!list.includes(l)) list.push(l);
              found.set(e, list);
            }
          }
        }
      }
      const out: R[] = [];
      for (const [e, ls] of found) for (const l of ls) {
        const r = intersect(e.getBoundingClientRect(), l);
        if (area(r) >= 1) out.push(r);
      }
      return out;
    };
    const videos = [...document.querySelectorAll("video, img")].filter((e) => e.tagName === "VIDEO" || /^https?:\/\/localhost:0\/proxy/.test((e as HTMLImageElement).src)).map((e) => e.getBoundingClientRect());
    const isClipText = (cs: CSSStyleDeclaration) => cs.backgroundClip === "text" || (cs as unknown as { webkitBackgroundClip: string }).webkitBackgroundClip === "text";
    const paintless = (el: Element) => {
      const cs = getComputedStyle(el);
      if (!transparent((cs as unknown as { webkitTextFillColor: string }).webkitTextFillColor) || cs.textShadow !== "none" || parseFloat((cs as unknown as { webkitTextStrokeWidth: string }).webkitTextStrokeWidth) > 0) return false;
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) if (isClipText(getComputedStyle(e))) return false;
      return true;
    };
    const PIXEL_KINDS = ["low-contrast", "covered"] as const;

    return {
      texts: runs.length,
      issues,
      runs: runs.map((t, i) => ({
        key: t.key, full: toBox(t.full), visible: toBox(t.vis), opacity: t.opacity, clip: t.clip, index: (t.el.setAttribute("data-lint-run", String(i)), i), text: short(t.text), px: t.px,
        lines: t.lines.map(toBox), occluders: t.svg ? [] : occludersOf(t).map(toBox), overVideo: videos.some((v) => area(intersect(v, t.vis)) >= 1),
        embedded: t.embedded, paintless: !t.svg && paintless(t.el), ignore: PIXEL_KINDS.filter((k) => ignored(t.el, k)),
      })),
    };
  } finally {
    probe.remove();
  }
};

const COLOUR: Record<IssueKind, string> = {
  clipped: "#e00000", "forbidden-word": "#b00020", "too-small": "#c77700", "outside-safe-area": "#0077cc",
  overlap: "#c000a8", "escapes-box": "#d35400", "under-control": "#d35400", "low-contrast": "#7a4dd8", covered: "#d35400",
};

/** Measures the frame currently shown on `page`, with rules already scaled to the composition (see `scaleLayout`). */
export async function lintFrame(page: Page, rules: Config["layout"] & { safeX: number; safeY: number }, W: number, H: number): Promise<FrameMeasure> {
  return page.evaluate(measure, { ...rules, W, H });
}

/** Draws the safe area and a labelled box round each issue, screenshots, then removes the marks. */
export async function screenshotWithMarks(page: Page, issues: Issue[], safe: { x: number; y: number }, file: string): Promise<void> {
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
    mark({ left: `${safe.x}px`, top: `${safe.y}px`, right: `${safe.x}px`, bottom: `${safe.y}px`, border: "1px dashed rgba(0,119,204,0.6)" });
    for (const i of list) {
      const c = colour[i.kind];
      mark({ left: `${i.x - 3}px`, top: `${i.y - 3}px`, width: `${i.w + 6}px`, height: `${i.h + 6}px`, border: `3px solid ${c}` }, i.kind + (i.px ? ` ${i.px}px` : ""), c);
    }
  }, [issues, safe, COLOUR] as const);
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
