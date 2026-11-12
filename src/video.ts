import fs from "node:fs";
import path from "node:path";
import { HINT, run, tools } from "./ffmpeg.js";

interface Info {
  codec: string;
  hdr: boolean;
}

/**
 * Answers `<OffthreadVideo>`'s frame requests (`http://localhost:0/proxy?src=…&time=…&transparent=…`) the way
 * Remotion's renderer does: ffmpeg extracts the frame at `time` seconds of the file as a PNG. Returns null, after one
 * warning per video, when it cannot (no ffmpeg, a file outside the bundle, HDR footage it would wash out); the caller
 * then shows a blank frame and text over it is not judged by its pixels.
 */
export function videoFrames(bundleDir: string, base: string, warn: (message: string) => void): (url: string) => Promise<Buffer | null> {
  const root = path.resolve(bundleDir) + path.sep;
  const origin = new URL(base).origin;
  const { ffmpeg, ffprobe } = tools();
  const frames = new Map<string, Promise<Buffer | null>>();
  const infos = new Map<string, Promise<Info | null>>();
  const said = new Set<string>();
  const once = (key: string, message: string) => {
    if (!said.has(key)) warn(`<OffthreadVideo> frames ${message}; the text and layout around the video are checked, not the video`);
    said.add(key);
  };

  const probe = (file: string) => {
    if (!infos.has(file)) {
      infos.set(file, run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,color_transfer", "-of", "json", file]).then(
        (r) => {
          if (r.code !== 0) return null;
          const s = JSON.parse(r.stdout.toString()).streams?.[0] ?? {};
          return { codec: String(s.codec_name ?? ""), hdr: /smpte2084|arib-std-b67/.test(String(s.color_transfer ?? "")) };
        },
        () => null,
      ));
    }
    return infos.get(file)!;
  };

  const extract = async (url: string): Promise<Buffer | null> => {
    const q = new URL(url).searchParams;
    const src = q.get("src") ?? "";
    const time = Math.max(0, Number(q.get("time")) || 0);
    const alpha = q.get("transparent") === "true";
    let file: string | undefined;
    let local = false;
    try {
      const u = new URL(src);
      const p = path.resolve(root, "." + decodeURIComponent(u.pathname));
      local = u.origin === origin && p.startsWith(root);
      if (local) file = p;
    } catch {}
    const name = file ? path.basename(file) : src.length > 80 ? src.slice(0, 77) + "..." : src;
    if (!file || !fs.existsSync(file)) {
      once(src, `of ${name} are shown blank: ${local ? "the file does not exist" : "only files served with the project (staticFile) can be read"}`);
      return null;
    }
    const info = await probe(file);
    if (!info) {
      try {
        await run(ffprobe, ["-version"]);
        once(file, `of ${name} are shown blank: ffprobe could not read it`);
      } catch {
        once("ffmpeg", `are shown blank: ffmpeg was not found (${HINT})`);
      }
      return null;
    }
    if (info.hdr) {
      once(file, `of ${name} are shown blank: it is HDR, which would show washed out without tone mapping`);
      return null;
    }
    // VP8/VP9 keep alpha in a side channel that only the libvpx decoders read.
    const decoder = alpha && info.codec === "vp9" ? ["-c:v", "libvpx-vp9"] : alpha && info.codec === "vp8" ? ["-c:v", "libvpx"] : [];
    const out = ["-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-pix_fmt", alpha ? "rgba" : "rgb24", "-"];
    try {
      let r = await run(ffmpeg, ["-loglevel", "error", ...decoder, "-ss", String(time), "-i", file, ...out]);
      // Past the last frame ffmpeg returns nothing; the renderer shows the last frame, so does this.
      if (r.code === 0 && !r.stdout.length) r = await run(ffmpeg, ["-loglevel", "error", ...decoder, "-sseof", "-1", "-i", file, "-vf", "reverse", ...out]);
      if (r.code === 0 && r.stdout.length) return r.stdout;
      once(file, `of ${name} are shown blank: ffmpeg could not decode it (${r.stderr.trim().split("\n")[0] || `exit ${r.code}`})`);
    } catch {
      once("ffmpeg", `are shown blank: ffmpeg was not found (${HINT})`);
    }
    return null;
  };

  return (url) => {
    if (!frames.has(url)) {
      frames.set(url, extract(url));
      // A sweep asks for thousands of frames; keep the recent ones, which are the ones asked for again.
      if (frames.size > 64) frames.delete(frames.keys().next().value!);
    }
    return frames.get(url)!;
  };
}
