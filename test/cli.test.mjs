import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");
const example = path.join(here, "..", "example");

function raw(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: example, encoding: "utf8", timeout: 300_000 });
}

function run(...args) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-lint-"));
  const r = raw(...args, "--out", out, "--json");
  assert.ok(r.stdout, `no output; stderr:\n${r.stderr}`);
  return { code: r.status, report: JSON.parse(r.stdout), out };
}

const kinds = (report) => report.frames.map((f) => f.issues.map((i) => i.kind));

const PLANTED = ["clean", "clipped", "too-small", "outside-safe-area", "overlap", "forbidden-word", "escapes-box", "under-control"];

test("every planted bug is caught, alone, on its own second", () => {
  const { code, report } = run("layout", "Planted", ...PLANTED.map((_, i) => String(i + 0.5)));
  PLANTED.forEach((kind, i) => assert.deepEqual(kinds(report)[i], kind === "clean" ? [] : [kind], `second ${i}: expected ${kind}`));
  assert.equal(code, 1);
});

test("ordinary motion design passes, including mid-transition frames", () => {
  const secs = ["0.2", "0.9", "1.2", "1.9", ...Array.from({ length: 10 }, (_, i) => String(i + 2.5))];
  const { code, report } = run("layout", "Ordinary", ...secs);
  assert.deepEqual(kinds(report), report.frames.map(() => []));
  assert.ok(report.frames[0].skippedWhileMoving.length > 0, "the mid-reveal frame should report what it skipped");
  assert.ok(report.frames[2].skippedWhileMoving.length > 0, "the mid-slide frame should report what it skipped");
  assert.equal(code, 0);
});

test("problems hidden in SVG, rotation, long text, split letters, clips, inputs, slow motion, twins and layers are caught", () => {
  const expected = ["too-small", "too-small", "forbidden-word", "forbidden-word", "clipped", "clipped", "forbidden-word", "clean",
    "clipped", "clipped", "outside-safe-area", "clipped", "outside-safe-area"];
  const { code, report } = run("layout", "Missed", ...expected.map((_, i) => String(i + 0.5)));
  expected.forEach((kind, i) => assert.deepEqual(kinds(report)[i], kind === "clean" ? [] : [kind], `second ${i}: expected ${kind}`));
  assert.equal(code, 1);
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
  assert.match(r.stderr, /Crash errored at frame 15: Error: this composition always fails/);
});

test("an error the page logs while rendering fine is a warning, not a failure", () => {
  const r = raw("layout", "Noisy", "0.5");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /warning: the page logged "Error: analytics beacon blocked"/);
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

test("diff with nothing to compare fails", () => {
  const r = raw("diff", "Clean", "0.5");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /nothing was compared/);
});

test("bad input is a one-line error with exit 2, never a stack trace", () => {
  const cases = [
    [["layout", "Nope", "0.5"], /no composition "Nope"; found: Planted/],
    [["layout", "Clean", "9"], /9s is outside Clean/],
    [["layout", "Clean", "--every", "abc"], /--every must be a positive number/],
    [["layout", "Clean", "0.5", "--every", "1"], /either seconds or --every/],
    [["layout", "Clean", "0.5", "--bogus"], /Unknown option '--bogus'/],
    [["layout", "Clean", "0.5", "--props", "[1]"], /--props must be a JSON object/],
    [["motion", "missing.mp4"], /video not found/],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-lint-config-"));
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

test("no bundle is left behind, after a normal run or a build that fails", () => {
  const ours = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("remotion-lint-bundle-"));
  const before = ours();
  run("layout", "Clean", "0.5");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-lint-config-"));
  const config = path.join(dir, "c.json");
  fs.writeFileSync(config, JSON.stringify({ entryPoint: path.join(example, "src", "broken.ts") }));
  const r = raw("layout", "Clean", "0.5", "--config", config);
  assert.equal(r.status, 2);
  assert.deepEqual(ours().filter((n) => !before.includes(n)), []);
});
