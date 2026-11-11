import { bundle, type WebpackOverrideFn } from "@remotion/bundler";
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

/** A composition loaded in a real browser, ready to be moved to any frame. */
export interface CompositionPage {
  page: Page;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  /** Shows `frame`, resolves once it is ready and fonts have loaded, and throws if the composition errored. */
  seek(frame: number): Promise<void>;
  /** Errors the page logged that did not stop it rendering, such as a failed network request. */
  warnings: string[];
  close(): Promise<void>;
}

/** Options for {@link openComposition}. */
export interface OpenOptions {
  entryPoint: string;
  id: string;
  channel?: string;
  props?: Record<string, unknown>;
  webpackOverride?: WebpackOverrideFn;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".json": "application/json",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mov": "video/quicktime",
};

/**
 * The globals Remotion's own renderer sets before a page loads (see `setPropsAndEnv` in
 * `@remotion/renderer`), so the composition runs on its render path, with input props available
 * to `calculateMetadata`. Runs in the page; must stay self-contained.
 */
function renderEnvironment(inputProps: string) {
  const w = window as any;
  w.remotion_puppeteerTimeout = 60_000;
  w.remotion_isMainTab = true;
  w.remotion_mediaCacheSizeInBytes = null;
  w.remotion_initialMemoryAvailable = null;
  w.remotion_sampleRate = 48_000;
  w.process = w.process ?? {};
  w.process.env = w.process.env ?? {};
  w.process.env.NODE_ENV = "production";
  w.remotion_broadcastChannel = new BroadcastChannel("remotion-video-frame-extraction");
  w.remotion_envVariables = "{}";
  w.remotion_inputProps = inputProps;
  w.remotion_initialFrame = 0;
  w.remotion_attempt = 1;
  w.remotion_proxyPort = 0;
  w.remotion_audioEnabled = false;
  w.remotion_videoEnabled = true;
  w.remotion_logLevel = "error";
  const blocked = (what: string) => () => {
    w.remotion_cancelledError = new Error(`${what}() was called; it cannot run in a headless browser`).stack;
    return false;
  };
  w.alert = blocked("alert");
  w.confirm = blocked("confirm");
}

/** Serves `dir` on a random local port, with Range support so media elements can seek. */
function serve(dir: string): Promise<http.Server> {
  const root = path.resolve(dir) + path.sep;
  const server = http.createServer((req, res) => {
    const p = path.resolve(root, "." + decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = fs.statSync(p).size;
    const type = TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      fs.createReadStream(p, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * An error thrown while React rendered a component: React's own wording, or an error whose stack
 * passes through React's render loop. Anything else a page logs (a failed request) is only a warning.
 */
const RENDER_ERROR = /error occurred in the <|\bat (?:renderWithHooks|beginWork|performUnitOfWork|workLoopSync|workLoopConcurrent|renderRootSync|commitRoot)\b/;

/**
 * Bundles the entry point, serves it, and opens composition `id` in Chromium.
 *
 * Remotion has no public API for showing a frame in a page you can inspect, so this uses the
 * same window hooks its own renderer drives (`remotion_setBundleMode`, `remotion_setFrame`,
 * `remotion_renderReady`). They are kept to this one function so a Remotion change breaks one place.
 */
export async function openComposition({ entryPoint, id, channel, props, webpackOverride }: OpenOptions): Promise<CompositionPage> {
  if (!fs.existsSync(entryPoint)) throw new Error(`entry point not found: ${entryPoint} (set entryPoint in remotion-lint.config.mjs)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-lint-bundle-"));
  let server: http.Server | undefined;
  let browser: Browser | undefined;
  const cleanup = async () => {
    await browser?.close().catch(() => {});
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await bundle({ entryPoint, outDir: dir, webpackOverride: webpackOverride ?? ((c) => c) });
    server = await serve(dir);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch(channel ? { channel } : {});
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.addInitScript(renderEnvironment, JSON.stringify(props ?? {}));
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const first = m.text().split("\n")[0];
      (RENDER_ERROR.test(m.text()) ? errors : warnings).push(first);
    });
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => typeof (window as any).remotion_setBundleMode === "function");
    await page.evaluate(() => (window as any).remotion_setBundleMode({ type: "evaluation" }));
    await page.waitForFunction(() => (window as any).remotion_renderReady === true || !!(window as any).remotion_cancelledError, null, { timeout: 60_000 });
    const meta = await page.evaluate(async (compId) => {
      const w = window as any;
      const ids: string[] = typeof w.remotion_getCompositionNames === "function" ? w.remotion_getCompositionNames() : (await w.getStaticCompositions()).map((x: any) => x.id);
      if (!ids.includes(compId)) return { found: false as const, ids };
      const c = typeof w.remotion_calculateComposition === "function" ? await w.remotion_calculateComposition(compId) : (await w.getStaticCompositions()).find((x: any) => x.id === compId);
      return { found: true as const, fps: c.fps as number, durationInFrames: c.durationInFrames as number, width: c.width as number, height: c.height as number, props: c.serializedResolvedPropsWithCustomSchema as string };
    }, id);
    if (!meta.found) throw new Error(`no composition "${id}"; found: ${meta.ids.join(", ") || "none"}`);
    await page.setViewportSize({ width: meta.width, height: meta.height });
    await page.evaluate(([compId, m, p]) => {
      (window as any).remotion_setBundleMode({
        type: "composition", compositionName: compId, serializedResolvedPropsWithSchema: p,
        compositionDurationInFrames: m.durationInFrames, compositionFps: m.fps, compositionHeight: m.height, compositionWidth: m.width,
        compositionDefaultCodec: "h264", compositionDefaultOutName: compId, compositionDefaultVideoImageFormat: "png",
        compositionDefaultPixelFormat: "yuv420p", compositionDefaultProResProfile: null, compositionDefaultSampleRate: 48000,
      });
    }, [id, meta, meta.props] as const);

    let mounted = false;
    const ready = async (frame: number) => {
      try {
        await page.waitForFunction(() => (window as any).remotion_renderReady === true || !!(window as any).remotion_cancelledError, null, { timeout: 60_000 });
      } catch {
        throw new Error(`frame ${frame} was not ready after 60 s (a delayRender() that never resolves, or media the browser cannot play; try browserChannel: "chrome")`);
      }
      const cancelled = await page.evaluate(() => (window as any).remotion_cancelledError as string | undefined);
      if (cancelled) errors.push(String(cancelled).split("\n")[0]);
    };
    const fail = (frame: number) => {
      if (errors.length) throw new Error(`${id} errored at frame ${frame}: ${errors.splice(0).join("; ")}`);
    };
    return {
      page, fps: meta.fps, width: meta.width, height: meta.height, durationInFrames: meta.durationInFrames, warnings,
      async seek(frame) {
        await ready(frame);
        fail(frame);
        await page.evaluate(([f, compId]) => (window as any).remotion_setFrame(f, compId, 1), [frame, id] as const);
        await ready(frame);
        await page.evaluate(() => document.fonts.ready);
        fail(frame);
        if (!mounted) {
          mounted = await page.evaluate(() => !!document.querySelector("#remotion-canvas")?.firstElementChild);
          if (!mounted) {
            const version = await page.evaluate(() => String((window as any).remotion_version ?? "unknown"));
            throw new Error(`${id} did not mount at frame ${frame}; Remotion ${version} may not be supported (please open an issue)`);
          }
        }
      },
      close: cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
