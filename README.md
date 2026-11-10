# remotion-lint

A layout linter for [Remotion](https://www.remotion.dev) videos. It opens your real bundle in a browser, jumps to the
frames you ask for, measures every piece of text on screen, and fails the build when something is wrong.

```
$ npx remotion-lint layout Planted 0.5 1.5 2.5 3.5 4.5 5.5 6.5 7.5
0.5s  1 text runs  clean
1.5s  1 text runs  clipped: "This headline is far too long for its box" (48px)
2.5s  1 text runs  too-small: "Fine print nobody can read" (14px)
3.5s  1 text runs  outside-safe-area: "Hugging the edge" (48px)
4.5s  2 text runs  overlap: "First line <> Second line"
5.5s  1 text runs  forbidden-word: "Project Nightjar launches" (48px)
6.5s  1 text runs  escapes-box: "Fell out of its card" (48px)
7.5s  1 text runs  under-control: "Text under a button" (48px)

7 problem(s). Report: lint-out/layout.json
```

Each failing frame also leaves a screenshot with the problem boxed and labelled.

Exit codes: `0` clean, `1` problems found, `2` the check could not run (a bad composition id, a composition that
throws, a missing file). A composition that crashes is never reported as clean.

## Why

A model looking at a grid of frames will tell you a video "looks good". It can't tell you that a headline lost its
last four characters to `overflow: hidden`, or that a caption sits 20 px inside the edge. Those are measurements, and
the page already holds them: every text run's box, its rendered font size, the box it lives in. remotion-lint reads
them directly, so the answer is a number and the exit code is the count.

## Install

```bash
npm install --save-dev remotion-lint
npx playwright install chromium
```

Requires Node 20+ and Remotion 4.

## Commands

### `layout`: text on screen

```bash
npx remotion-lint layout <composition> 1.5 4 7.25   # specific seconds
npx remotion-lint layout <composition> --every 0.5  # sweep the whole composition
```

| Check | Fails when |
| --- | --- |
| `clipped` | text runs past the edge of any ancestor that hides overflow, on any side |
| `too-small` | the rendered font size, after every transform and scale, is under `minFontPx` (default 28 at your composition's size) |
| `outside-safe-area` | text comes closer than `safeArea` px to any edge (default 100) |
| `overlap` | a line of one text run shares more than `overlap` of the smaller line box with a line of another (default 15%) |
| `forbidden-word` | any element's full text, or an input's value, matches a pattern in `forbidden`, even when split across spans |
| `escapes-box` | text sits outside the nearest ancestor that draws a background or border |
| `under-control` | a small filled shape such as a button or badge is drawn on top of the text |

Lines are measured one by one, and each line's box is the font's em box rather than its ascent and descent, so tight
leading is not an overlap. Text with opacity under 0.5, hidden text, and text fully behind a mask are ignored.

**Things in motion.** A title sliding in crosses the edge and a reveal is clipped by its mask; that is the design, not
a bug. When a frame has a `clipped` or `outside-safe-area` problem, remotion-lint looks at the next frame too. If that
text, or the part of it you can see, has moved, the problem is listed under `skippedWhileMoving` and not counted.
Once the text settles, it is checked like anything else.

**Not covered:** text drawn on a `<canvas>`, in a video or image, or by CSS `::before`/`::after`. SVG `<text>` is
checked for size, safe area and forbidden words, not for clipping. `under-control` relies on hit testing, so a shape
with `pointer-events: none` is not seen.

### `diff`: a component against the real thing

Put the component you rebuilt and a screenshot of the real app side by side in a composition, and mark them:

```tsx
<div data-lint="screen"><RebuiltScoreCard /></div>
<div data-lint="ref"><Img src={staticFile("real-score-card.png")} /></div>
```

```bash
npx remotion-lint diff <composition> 0.5 3
```

Each frame reports the share of pixels that differ and the worst rows, writes a side-by-side image (screen,
reference, diff), and fails over `maxMismatchPct` (default 10%) or when the two boxes are different sizes. A run
where no frame has the pair fails too, so a typo in the attribute cannot pass silently.

### `motion`: glitches in the rendered file

```bash
npx remotion render <composition> out.mp4
npx remotion-lint motion out.mp4
```

| Finding | Meaning |
| --- | --- |
| jump | one frame-to-frame change far bigger than the changes either side of it, not near a planned cut. A fast wipe changes every frame, so it is motion, not a jump |
| pop | one frame that differs from both neighbours while they match each other (counted once, not also as jumps) |
| frozen | nothing changes for longer than `frozenSeconds` (reported, not failed, unless `failOnFrozen`) |

Frames are streamed from ffmpeg at 160x90 greyscale, so memory stays flat on long 4K files. Needs `ffmpeg` and
`ffprobe` on your PATH, or set `REMOTION_LINT_FFMPEG` and `REMOTION_LINT_FFPROBE` (for example to the binaries
Remotion installs).

## Marking up your composition

| Attribute | Effect |
| --- | --- |
| `data-lint="embedded"` | another app's UI shown inside your video (a phone, a screen recording). Its text is only checked for clipping and forbidden words, because it is supposed to look like the real thing |
| `data-lint-layer="<n>"` | stacked shots during a transition. Text in a layer covered by an opaque higher layer is skipped |
| `data-lint-ignore="<kind> <kind>"` | switches those checks off for the element and everything inside it; `"all"` switches all of them off |
| `data-lint="screen"` / `"ref"` | the pair `diff` compares |

## Config

`remotion-lint.config.mjs` (or `.js`, `.json`, or `.ts` on Node 22.18 and later) in the directory you run from. Every
field is optional, and an unknown key or a wrong type is an error rather than silently ignored.

```js
import { enableTailwind } from "@remotion/tailwind";

/** @type {import("remotion-lint").UserConfig} */
export default {
  entryPoint: "src/index.ts",
  webpackOverride: (c) => enableTailwind(c), // the same override as in remotion.config.ts
  props: { title: "Launch" }, // merged over the composition's default props; --props on the command line wins
  layout: { minFontPx: 28, safeArea: 100, overlap: 0.15, forbidden: ["\\blorem\\b", "TODO"] },
  diff: { threshold: 0.12, maxMismatchPct: 10 },
  motion: { cuts: [11.5, 20.4], frozenSeconds: 2, failOnFrozen: false },
  browserChannel: "", // "chrome" to use your installed Chrome
};
```

remotion-lint does not read `remotion.config.ts`, so repeat any webpack override there (Tailwind, aliases, loaders).
Playwright's bundled Chromium cannot decode H.264 or AAC: if your composition uses `<Video>` or `<Audio>` with mp4
or m4a files, set `browserChannel: "chrome"`.

## In CI

```yaml
- run: npx playwright install --with-deps chromium
- run: npx remotion-lint layout MyVideo --every 0.5
```

The step fails on any problem (exit 1) and on any error (exit 2).

## How it works, and the one caveat

remotion-lint bundles your project with `@remotion/bundler`, serves it, and opens it in Playwright's Chromium. To show
a given frame it uses the same window hooks Remotion's own renderer uses (`remotion_setBundleMode`,
`remotion_setFrame`). They are not a public API, so a Remotion release could change them. They live in one function
(`src/page.ts`), the package accepts Remotion 4 only, and the test suite runs against a pinned Remotion version so a
break shows up as a failing test, not a silent pass.

## Related

[remotion-qa](https://github.com/GroMarketing/remotion-qa) checks the rendered mp4 for social-platform safe zones,
dead air and captions that leave too fast. It's a good complement: remotion-lint checks the page, remotion-qa checks
the file.

## Background

This started as the QA gate for a product launch film built in Remotion, where every scene was checked by script
before anyone watched it. Built with [Claude Code](https://claude.com/claude-code). Thanks to
[Magicweave](https://magicweave.xyz), where it was first used.

## License

MIT
