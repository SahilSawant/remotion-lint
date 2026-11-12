import { spawn } from "node:child_process";
import path from "node:path";

/** The ffmpeg and ffprobe to run: `REMOTION_LINT_FFMPEG` / `REMOTION_LINT_FFPROBE`, else the ones on the PATH. */
export function tools() {
  const ffmpeg = process.env.REMOTION_LINT_FFMPEG || "ffmpeg";
  const ffprobe = process.env.REMOTION_LINT_FFPROBE || path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/ffmpeg/i, "ffprobe"));
  return { ffmpeg, ffprobe: ffmpeg.includes(path.sep) || process.env.REMOTION_LINT_FFPROBE ? ffprobe : "ffprobe" };
}

export const HINT = "install ffmpeg, or point REMOTION_LINT_FFMPEG and REMOTION_LINT_FFPROBE at the binaries";

/** Runs a binary to completion. Rejects only when it cannot be started; a failed run resolves with its exit code. */
export function run(bin: string, args: string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const out: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
  });
}
