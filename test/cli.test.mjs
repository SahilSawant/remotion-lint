import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const made = [];
/** A temp directory removed when the file's tests finish. */
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");
const example = path.join(here, "..", "example");

function raw(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: example, encoding: "utf8", timeout: 300_000 });
}

function run(...args) {
  const out = tmp("remotion-lint-");
  const r = raw(...args, "--out", out, "--json");
  assert.ok(r.stdout, `no output; stderr:\n${r.stderr}`);
  return { code: r.status, report: JSON.parse(r.stdout), out };
}

const kinds = (report) => report.frames.map((f) => f.issues.map((i) => i.kind));
const movingKinds = (report) => report.frames.map((f) => f.moving.map((i) => i.kind));
/** Checks each frame against "clean", a failing kind, or "moving:<kind>" (nothing counted, and <kind> among the moving). */
function expectFrames(report, expected) {
  expected.forEach((e, i) => {
    const [got, mov] = [kinds(report)[i], movingKinds(report)[i]];
    if (e === "clean") assert.deepEqual([got, mov], [[], []], `frame ${i}: expected clean`);
    else if (e.startsWith("moving:")) assert.ok(!got.length && mov.includes(e.slice(7)), `frame ${i}: expected ${e}, got ${JSON.stringify([got, mov])}`);
    else assert.deepEqual(got, [e], `frame ${i}: expected ${e}`);
  });
}

const PLANTED = ["clean", "clipped", "too-small", "outside-safe-area", "overlap", "forbidden-word", "escapes-box", "under-control"];

test("every planted bug is caught, alone, on its own second", () => {
  const { code, report } = run("layout", "Planted", ...PLANTED.map((_, i) => String(i + 0.5)));
  PLANTED.forEach((kind, i) => assert.deepEqual(kinds(report)[i], kind === "clean" ? [] : [kind], `second ${i}: expected ${kind}`));
  assert.equal(code, 1);
});

test("ordinary motion design passes, including mid-transition frames", () => {
  const secs = ["0.2", "0.9", "1.2", "1.9", ...Array.from({ length: 18 }, (_, i) => String(i + 2.5))];
  const { code, report } = run("layout", "Ordinary", ...secs);
  expectFrames(report, ["moving:clipped", "clean", "moving:clipped", "clean", ...secs.slice(4).map((x) => (x === "16.5" ? "moving:clipped" : "clean"))]);
  assert.equal(code, 0);
});

test("problems hidden in SVG, rotation, long text, split letters, clips, inputs, slow motion, twins and layers are caught", () => {
  const expected = ["too-small", "too-small", "forbidden-word", "forbidden-word", "clipped", "clipped", "forbidden-word", "clean",
    "clipped", "clipped", "outside-safe-area", "clipped", "outside-safe-area"];
  const { code, report } = run("layout", "Missed", ...expected.map((_, i) => String(i + 0.5)));
  expectFrames(report, expected);
  assert.equal(code, 1);
});

test("text that is moving and settles clear is shown, not counted", () => {
  const { code, report } = run("layout", "Moving", "0.1", "2.1");
  expectFrames(report, ["moving:too-small", "moving:escapes-box"]);
  assert.equal(code, 0);
});

test("a verdict does not depend on which other seconds are checked, or on sweeping", () => {
  for (const [id, sec, want] of [["Ordinary", "1.2", "moving:clipped"], ["Moving", "2", "moving:escapes-box"], ["Moving", "2.1", "moving:escapes-box"]]) {
    expectFrames(run("layout", id, sec).report, [want]);
  }
  for (const [id, step] of [["Ordinary", "0.1"], ["Moving", "0.1"], ["Transitions", "0.1"], ["Drift", "0.1"]]) {
    const { code, report } = run("layout", id, "--every", step);
    assert.equal(code, 0, `${id} --every ${step}: ${JSON.stringify(report.frames.filter((f) => f.issues.length).map((f) => [f.sec, f.issues.map((i) => i.kind)]))}`);
  }
});

test("where a guess would pass a real problem, the problem is reported", () => {
  const expected = ["overlap", "overlap", "too-small", "too-small", "too-small", "clipped", "overlap", "forbidden-word", "clipped", "overlap",
    "clean", "clean", "clean", "clipped", "too-small", "forbidden-word", "clipped", "too-small"];
  const secs = expected.map((_, i) => String(i + (i === 8 ? 0.9 : 0.5)));
  const { code, report } = run("layout", "Cautious", ...secs);
  expected.forEach((e, i) => assert.deepEqual(kinds(report)[i], e === "clean" ? [] : [e], `second ${secs[i]}: expected ${e}`));
  assert.match(JSON.stringify(report.warnings), /OffthreadVideo/);
  assert.equal(code, 1);
});

test("pixels decide what is seen: outlines, gradients, emoji and SVG pass; grey on grey, busy pictures, covering icons and ::before text fail; masked, transparent and image-covered text is skipped", () => {
  const expected = ["clean", "low-contrast", "clean", "clean", "clean", "clean", "too-small", "covered", "clean", "moving:low-contrast", "low-contrast", "clean", "clean", "too-small", "clean", "clean"];
  const secs = expected.map((_, i) => String(i + (i === 9 ? 0.2 : 0.5)));
  const { code, report } = run("layout", "Pixels", ...secs);
  expectFrames(report, expected);
  const seen = report.frames.map((f) => f.texts);
  for (const i of [0, 1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 14]) assert.equal(seen[i], 1, `second ${secs[i]}: the text is on screen, so it must be counted`);
  for (const i of [5, 8, 15]) assert.equal(seen[i], 0, `second ${secs[i]}: no one can see this text`);
  assert.equal(code, 1);
});

test("problems that stay put fail, even in one-second scenes, rotated, off the frame, or on a counter whose digits change", () => {
  const { code, report } = run("layout", "Static", "0.5", "0.95", "1.5", "2.5", "3.5", "4.5", "5.5");
  expectFrames(report, ["clipped", "clipped", "clipped", "clipped", "clean", "clipped", "clipped"]);
  assert.equal(code, 1);
});

test("Remotion's fade and wipe transitions are motion, and each scene alone is clean", () => {
  const { code, report } = run("layout", "Transitions", "0.5", "2.5", "3.5", "4.5", "6.5");
  expectFrames(report, ["clean", "moving:overlap", "clean", "moving:overlap", "clean"]);
  assert.equal(code, 0);
});

test("vignettes, tints, scrims, click-through layers, faint watermarks and slow push-ins hide nothing", () => {
  const expected = ["too-small", "too-small", "too-small", "too-small", "forbidden-word", "clean", "too-small"];
  const { code, report } = run("layout", "Overlays", ...expected.map((_, i) => String(i + 0.5)));
  expectFrames(report, expected);
  assert.equal(code, 1);
});

test("font size and safe area scale with the composition: 30 px on a 4K frame is too small", () => {
  const { code, report } = run("layout", "FourK", "0.5");
  assert.deepEqual(kinds(report), [["too-small"]]);
  assert.equal(code, 1);
});

test("a second given twice, or two seconds on one frame, is checked once", () => {
  const { code, report } = run("layout", "Planted", "2.5", "2.51", "2.5");
  assert.equal(report.frames.length, 1);
  assert.equal(code, 1);
});

test("--props reach calculateMetadata", () => {
  assert.equal(raw("layout", "Meta", "2.5").status, 2);
  assert.equal(run("layout", "Meta", "2.5", "--props", '{"n":3}').code, 0);
});

test("a clean composition passes, and small text inside an embedded screen is allowed", () => {
  const { code, report } = run("layout", "Clean", "--every", "0.5");
  assert.equal(report.frames.length, 4);
  assert.equal(code, 0);
});

test("default props reach the composition, and --props overrides them", () => {
  assert.equal(run("layout", "WithProps", "0.5").code, 0);
  const { code, report } = run("layout", "WithProps", "0.5", "--props", '{"title":"nightjar"}');
  assert.deepEqual(kinds(report), [["forbidden-word"]]);
  assert.equal(code, 1);
});

test("a composition that throws is an error, never a pass", () => {
  const r = raw("layout", "Crash", "0.5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Crash errored at frame 15: (Error: )?this composition always fails/);
});

test("an error the page logs while rendering fine is a warning, not a failure", () => {
  const r = raw("layout", "Noisy", "0.5");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /warning: the page logged "Error: analytics beacon blocked"/);
  const { report } = run("layout", "Noisy", "0.5");
  assert.deepEqual(report.warnings, [{ sec: 0.5, message: "Error: analytics beacon blocked" }]);
});

test("a failing frame leaves a marked screenshot behind", () => {
  const { out } = run("layout", "Planted", "2.5");
  assert.ok(fs.existsSync(path.join(out, "t002.50.png")));
});

test("diff passes a matching component and fails a drifted one", () => {
  const { code, report } = run("diff", "Diff", "0.5", "1.5");
  const [same, drifted] = report.frames;
  assert.equal(same.mismatchPct, 0);
  assert.equal(same.fail, false);
  assert.ok(drifted.mismatchPct > 10, `drifted only ${drifted.mismatchPct}%`);
  assert.equal(code, 1);
});

test("diff fails when the two boxes are different sizes", () => {
  const { code, report } = run("diff", "DiffSize", "0.5");
  assert.deepEqual(report.frames[0].sizeMismatch, { screen: "300x600", ref: "300x200" });
  assert.equal(code, 1);
});

test("diff with nothing to compare fails, and says why", () => {
  let r = raw("diff", "Clean", "0.5");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no \[data-lint="screen"\] on this frame/);
  assert.match(r.stdout, /nothing was compared/);
  r = raw("diff", "DiffEmpty", "0.5");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /box is empty or off screen/);
});

test("diff fails on one changed number, by the band it sits in", () => {
  const r = raw("diff", "DiffNumber", "0.5");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /band \d+\/12 differs by \d+%, over 2%/);
});

test("diff fails when part of a box is off screen and was not compared", () => {
  const r = raw("diff", "DiffPartial", "0.5");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /only \d+x\d+ of the boxes is on screen/);
});

test("an entry that throws while loading fails at once with its own message", () => {
  const dir = tmp("remotion-lint-config-");
  const config = path.join(dir, "c.json");
  fs.writeFileSync(config, JSON.stringify({ entryPoint: path.join(example, "src", "throws.ts") }));
  const started = Date.now();
  const r = raw("layout", "Clean", "0.5", "--config", config);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the project threw while loading: .*module scope boom/);
  assert.ok(Date.now() - started < 25_000, `took ${Date.now() - started} ms`);
});

test("a broken link in public/ is named, not reported as a bare ENOENT", () => {
  const dir = tmp("remotion-lint-public-");
  for (const f of ["node_modules", "src", "package.json"]) fs.symlinkSync(path.join(example, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, "public"));
  fs.symlinkSync("../missing/vo", path.join(dir, "public", "vo"));
  fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ entryPoint: "src/index.ts" }));
  const r = spawnSync(process.execPath, [cli, "layout", "Clean", "0.5", "--config", "c.json"], { cwd: dir, encoding: "utf8", timeout: 300_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /public\/vo is a link to \.\.\/missing\/vo, which does not exist/);
  assert.doesNotMatch(r.stderr, /realpath/);
});

test("--version prints the version, and old screenshots are cleared from --out", () => {
  assert.match(raw("--version").stdout, /^\d+\.\d+\.\d+\n$/);
  const { out } = run("layout", "Planted", "2.5");
  assert.ok(fs.existsSync(path.join(out, "t002.50.png")));
  raw("layout", "Clean", "0.5", "--out", out);
  assert.ok(!fs.existsSync(path.join(out, "t002.50.png")));
});

test("diff refuses a reference laid over the rebuild, since both crops would be the same pixels", () => {
  const r = raw("diff", "DiffOnion", "0.5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /overlap; place them side by side/);
});

test("bad input is a one-line error with exit 2, never a stack trace", () => {
  const cases = [
    [["layout", "Nope", "0.5"], /no composition "Nope"; found: Planted/],
    [["layout", "Clean", "9"], /9s is outside Clean/],
    [["layout", "Clean", "1.5s"], /"1.5s" is not a number of seconds/],
    [["layout", "Clean", ""], /"" is not a number of seconds/],
    [["layout", "Clean", "--every", "abc"], /--every must be a positive number/],
    [["layout", "Clean", "0.5", "--every", "1"], /either seconds or --every/],
    [["layout", "Clean", "0.5", "--bogus"], /Unknown option '--bogus'/],
    [["layout", "Clean", "0.5", "--props", "[1]"], /--props must be a JSON object/],
    [["motion", "missing.mp4"], /video not found/],
    [["motion", "x.mp4", "--cuts", "1,abc"], /--cuts takes seconds/],
    [["layout", "BadMeta", "0.5"], /calculateMetadata of BadMeta threw: metadata exploded/],
    [["frobnicate", "x"], /unknown command "frobnicate"/],
  ];
  for (const [args, message] of cases) {
    const r = raw(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: exit ${r.status}`);
    assert.match(r.stderr, message);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${args.join(" ")} printed a stack trace`);
  }
});

test("a config with an unknown key or a bad pattern is refused", () => {
  const dir = tmp("remotion-lint-config-");
  const write = (c) => {
    const f = path.join(dir, "c.json");
    fs.writeFileSync(f, JSON.stringify(c));
    return f;
  };
  let r = raw("layout", "Clean", "0.5", "--config", write({ layout: { minFontPX: 99 } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option "layout.minFontPX"/);
  r = raw("layout", "Clean", "0.5", "--config", write({ layout: { forbidden: ["("] } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a valid regular expression/);
  r = raw("layout", "Clean", "0.5", "--config", write({ layout: { overlap: -5 } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"layout.overlap" must be between 0 and 1, got -5/);
});

/** Starts a sweep, sends Ctrl-C once `ready(stdout)` holds, and returns the exit code and stderr. */
async function interrupt(ready) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [cli, "layout", "Planted", "--every", "0.05", "--out", tmp("remotion-lint-")], { cwd: example });
  let out = "", err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  const exited = new Promise((resolve) => child.on("exit", (c, sig) => resolve(c ?? sig)));
  const t = setInterval(() => {
    if (ready(out)) {
      clearInterval(t);
      child.kill("SIGINT");
    }
  }, 50);
  const code = await exited;
  clearInterval(t);
  return { code, err };
}

const bundles = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("remotion-lint-bundle-"));

test("Ctrl-C mid-run exits 130 quietly and leaves no bundle behind", { timeout: 120_000 }, async () => {
  const before = bundles();
  const { code, err } = await interrupt((out) => out.includes("text runs"));
  assert.equal(code, 130);
  assert.doesNotMatch(err, /not ready after/);
  assert.deepEqual(bundles().filter((n) => !before.includes(n)), []);
});

test("Ctrl-C while the bundle is still building exits 130 and leaves no bundle behind", { timeout: 120_000 }, async () => {
  const before = bundles();
  const { code } = await interrupt(() => bundles().some((n) => !before.includes(n)));
  assert.equal(code, 130);
  assert.deepEqual(bundles().filter((n) => !before.includes(n)), []);
});

test("no bundle is left behind, after a normal run or a build that fails", () => {
  const before = bundles();
  run("layout", "Clean", "0.5");
  const dir = tmp("remotion-lint-config-");
  const config = path.join(dir, "c.json");
  fs.writeFileSync(config, JSON.stringify({ entryPoint: path.join(example, "src", "broken.ts") }));
  const r = raw("layout", "Clean", "0.5", "--config", config);
  assert.equal(r.status, 2);
  assert.deepEqual(bundles().filter((n) => !before.includes(n)), []);
});
