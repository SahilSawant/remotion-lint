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
5.5s  1 text runs  forbidden-word: "Project Nightjar launches"
6.5s  1 text runs  escapes-box: "Fell out of its card" (48px)
7.5s  1 text runs  under-control: "Text under a button" (48px)

7 problem(s). Report: lint-out/layout.json
```

Each failing frame also leaves a screenshot with the problem boxed and labelled.

Exit codes: `0` clean, `1` problems found, `2` the check could not run (a bad composition id, a composition that
throws, a missing file, a build error). A composition that crashes is never reported as clean: an uncaught page error,
`cancelRender()`, or an error thrown while React renders a component stops the run. Other errors the page logs, such
as a blocked network request, are printed as warnings and listed under `warnings` in the JSON report. Ctrl-C stops
the run at any point, even mid-build (exit 130), and removes the temporary bundle. An entry file that throws while
loading fails at once with its own message.

**When in doubt, it reports.** remotion-lint never guesses that something is fine. Where it cannot tell (text over a
photo, a layer it cannot see through, motion that never settles), it reports the problem; silence the ones you mean
with `data-lint-ignore`.

## Why

A model looking at a grid of frames will tell you a video "looks good". It can't tell you that a headline lost its
last four characters to `overflow: hidden`, or that a caption sits 20 px inside the edge. Those are measurements, and
the page already holds them: every text run's box, its rendered font size, the box it lives in. remotion-lint reads
them directly, so the answer is a number and the exit code is the count.

## Install

```bash
npm install --save-dev remotion-lint @remotion/bundler@<your remotion version>
npx playwright install chromium
```

If your project already uses Playwright at another version, that command may install a browser for your copy
rather than remotion-lint's. remotion-lint checks for its browser before it bundles anything, and if it is missing,
prints the exact command for its own copy.

Requires Node 22+ and Remotion 4.0.53 or later. Install `@remotion/bundler` at the same version as `remotion` (if they differ, remotion-lint stops and says which
version to install); CI runs
the suite against 4.0.53, 4.0.200, 4.0.350 and a pinned recent release.

## Commands

### `layout`: text on screen

```bash
npx remotion-lint layout <composition> 1.5 4 7.25   # specific seconds
npx remotion-lint layout <composition> --every 0.5  # sweep the whole composition
```

| Check | Fails when |
| --- | --- |
| `clipped` | text runs past the edge of any ancestor that hides overflow (or has `contain: paint`), past a `clip-path` shape, or off the edge of the frame |
| `too-small` | the rendered font size, after every transform and scale, is under `minFontPx` (default 28) |
| `outside-safe-area` | text comes closer to an edge than `safeArea` (default `"5%"`: title-safe, 5% of the width left and right and 5% of the height top and bottom, landscape or portrait) |
| `overlap` | a line of one text run shares more than `overlap` of the smaller line's cap-height box with a line of another (default 15%), however faint or transparent the text is. Copies of the same text offset by up to 0.15 em (outline, drop shadow, retro offset, a glitch title's colour copies) are not an overlap. Other text positioned on top of its parent's text is compared with it |
| `forbidden-word` | any element's text, or an input's value, matches a pattern in `forbidden`. Letters split across spans that sit side by side are joined, letters spaced out one by one ("N i g h t") are read as the word, and the spaces between word spans are kept, so "What to" + "do next" never reads "todo" |
| `escapes-box` | text sits outside the nearest ancestor that draws a background or border |
| `under-control` | a small solid shape such as a button or badge is drawn on top of the text (a translucent or blended highlight is not) |
| `low-contrast` | along a quarter or more of its letters' edges, the text stands out from what is right beside it on screen by less than `minContrast` (default 3, the WCAG ratio for large text). Measured on the rendered pixels, so text over a photo, a gradient or a busy pattern is judged by what is really behind each letter, and an outline or shadow counts as the edge it is |
| `covered` | part of a line is hidden under an image, icon or box: far fewer of its letters reach the screen there than in the rest of that line |

`minFontPx` is pixels on a 1080p frame and scales with the composition's shorter side: on a 3840x2160 composition
the minimum is 56 px, on 1280x720 it is about 19 px, and a vertical 1080x1920 video uses it as given. `safeArea` can
also be px on a 1080p frame, one number or `[left/right, top/bottom]`, scaled the same way.

Lines are measured one by one from the element's own text, so a decorative child (an accent bar, an icon) is not
counted as text. Clipping uses the font's em box and overlap uses roughly its cap height, rather than ascent and
descent, so tight leading down to about 0.7 is not an overlap. An all-caps line (or one set in capitals with
`text-transform`) is tested for clipping by the middle 0.8 em where capitals sit, so a per-line mask down to
`line-height: 0.8` is not a clip, and a tighter one that cuts into the letters is. Text with opacity under 0.5, hidden text, text fully
outside its `clip-path` shape, and text under a layer nothing can show through are ignored. Only a plain, solid,
fully opaque colour with no mask, filter, clip-path or blend mode counts as such a layer: a vignette, tint, scrim,
gradient, image or video never hides the text under it by its CSS alone; the pixel checks below then decide
whether any of its letters still reach the screen. Forbidden words are searched down to 5% opacity, so a faint
watermark is still found. Clipping follows CSS: a box only clips what it contains, so an absolutely positioned child
escapes an `overflow: hidden` parent that is not its containing block.

**Things in motion.** A title sliding in crosses the edge, a reveal is clipped by its mask, and two titles cross
during a fade or wipe; that is the design, not a bug. So when a problem involves text that is moving (its position,
size, visible area, opacity or mask, including the SVG shape a `url(#id)` clip points at, differs on the frame
before or after), remotion-lint follows that text frame by frame for up to a second. As soon as the same text is on
screen without the problem (a slide-in that lands clear, a credit line fully in frame, a lower third settled into a
drifting shot) the problem is passing: it is printed as `moving, not counted`, listed under `moving` in the report,
and does not fail the run. Text on its way out is also followed backward, to where it was before it left. The
problem counts if the text comes to rest still showing it, or shows it for as long as it can be followed: a caption
too small through a whole push-in, a title that drifts into the margin and stays there, a word still animating when
its scene cuts away, a marquee always cut by its box. Text is followed by what it says (numbers aside, so a counter
counting up while it slides in is still the same text) and its font size, so the verdict is the same whichever
seconds you check. Text whose words change, like a typewriter, is judged frame by frame as if it stood still.

**What the pixels decide.** Each checked frame is also screenshotted around its text three ways: as authored, with
every glyph hidden, and with every glyph painted solid magenta (outlines and shadows off in both). The difference
between the last two is where letters reach the screen, whatever the CSS says: text no letter of which shows
(under an opaque image, masked away, painted transparent) is not counted at all, and none of its other problems are
reported. A fourth screenshot as authored must match the first; if anything moved in between (a CSS animation, a
GIF, media still loading), the frame gets a warning and these pixel checks are skipped for it. `low-contrast` and
`covered` follow moving text like every other check, so a fade-in passes once it is readable. `minContrast: 0`
switches `low-contrast` off.

**Not covered:** text drawn on a `<canvas>` or baked into a video or image is not read. Text from `::before` and
`::after` is read from its CSS `content` for `too-small` and `forbidden-word` only. SVG `<text>` is checked for size,
safe area, running off the frame, forbidden words and contrast, not for clipping by its own boxes. A plain `<video>`
element (Remotion's `<Video>`) is not trusted to show the right frame in a headless browser, so text over it is not
checked for contrast or covering.

**Video.** `<OffthreadVideo>` shows its real frames: like Remotion's renderer, remotion-lint asks ffmpeg for the frame
at that moment (the last frame once the clip has ended, with transparency for `transparent` VP8/VP9 video), so text
over footage is judged against what is behind it then. This needs `ffmpeg` and `ffprobe` (see `motion` below). Without
them, for a file not served with the project (`staticFile`), or for HDR footage (which would show washed out without
tone mapping), the frame is shown blank with a warning, and text over it is not checked for contrast or covering.

### `diff`: a component against the real thing

Put the component you rebuilt and a screenshot of the real app side by side in a composition, and mark them. Mark
the `<Img>` itself: a wrapping `<div>` is a few pixels taller than the image it holds.

```tsx
<div data-lint="screen"><RebuiltScoreCard /></div>
<Img data-lint="ref" src={staticFile("real-score-card.png")} />
```

```bash
npx remotion-lint diff <composition> 0.5 3
```

Each frame reports the share of pixels that differ and the worst rows, writes a side-by-side image (screen,
reference, diff), and fails over `maxMismatchPct` of the whole box (default 1%; a pixel counts as different past `threshold`, default
0.12), over `maxBandPct` of any one of the 12 bands (default 2%), when the two boxes are different sizes, or when part
of either box is off screen and so was not compared. The band rule is what catches a changed number or word, which
is a small share of the whole card but a large share of its row. Raise both if your reference is a screenshot with
different font smoothing. A run
where no frame has the pair fails too, so a typo in the attribute cannot pass silently, and each skipped frame says
why (one of the two is missing, or a box is empty or off screen). The two boxes must not overlap: laid one over the
other, as an onion skin, both would capture the same blended pixels, so remotion-lint refuses (exit 2).

### `motion`: glitches in the rendered file

```bash
npx remotion render <composition> out.mp4
npx remotion-lint motion out.mp4 --cuts 4.5,9,12.25   # the cuts you meant to make
```

Every hard cut is a jump until it is listed, with `--cuts` or `motion.cuts` in the config. When a run reports jumps
and no cuts were given, it prints the `--cuts` line that would plan them all, so you can check that list against your
edit. A one-frame flash on the cut frame itself is not a pop either (a stray or black frame just after it still is), and `motion.allow: [[from, to]]` excuses jumps and pops
inside a stretch you meant (a glitch effect, a strobe).

| Finding | Meaning |
| --- | --- |
| jump | one frame-to-frame change far bigger than the two nearest changes on each side (looking up to 8 frames away), not near a planned cut. A fast wipe changes the picture every frame, and footage animated on twos, threes or fours (10 fps in a 30 fps file) every few frames, so they are motion, not jumps. A cut straight into motion that is nearly as big as the cut itself can be missed. Changes are measured on the whole frame at 160x90, so a glitch in a small object, or a flash that lasts two frames, may not show |
| pop | one frame that differs from both neighbours while they match each other (counted once, not also as jumps) |
| frozen | nothing changes for longer than `frozenSeconds` (reported, not failed, unless `failOnFrozen`) |
| repeat / drop | a stutter in steady motion: one frame shown twice (and the next step catching up), or one skipped (a single step as big as two). Checked in each of 12 parts of the picture, so footage inside the frame counts. Only motion that is clearly even for six frames on each side, at the same speed before and after, is judged: a move that eases, speeds up or slows down never is |
| cadence | repeats or drops at a steady rhythm, such as 24 fps footage in a 30 fps video (a frame repeated every 5): footage at another frame rate, reported once per stretch, not failed |

Not covered: a hitch in motion that is uneven anyway (eased, accelerating, or small and jittery like a cursor), or a
dropped frame where the motion is too fast for a one-frame step and a two-frame step to differ at 160x90.

Frames are streamed from ffmpeg at 160x90 greyscale, so memory stays flat on long 4K files. Needs `ffmpeg` and
`ffprobe` on your PATH, or set `REMOTION_LINT_FFMPEG` and `REMOTION_LINT_FFPROBE` to full builds elsewhere. The
cut-down ffmpeg that Remotion ships for rendering cannot output raw frames, so it will not work here.

## Marking up your composition

| Attribute | Effect |
| --- | --- |
| `data-lint="embedded"` | another app's UI shown inside your video (a phone, a screen recording). Its text is only checked for clipping and forbidden words, because it is supposed to look like the real thing |
| `data-lint-layer="<n>"` | stacked shots during a transition. Text in a layer is skipped where a higher layer with a solid, fully opaque background covers it |
| `data-lint-ignore="<kind> <kind>"` | switches those checks off for the element and everything inside it; `"all"` switches all of them off. For `overlap`, marking either element of the pair is enough |
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
  layout: { minFontPx: 28, safeArea: "5%", overlap: 0.15, forbidden: ["\\blorem\\b", "TODO"], minContrast: 3 },
  diff: { threshold: 0.12, maxMismatchPct: 1, maxBandPct: 2 },
  motion: { cuts: [11.5, 20.4], allow: [[30, 31.5]], frozenSeconds: 2, failOnFrozen: false },
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
(`src/page.ts`), the package accepts Remotion 4.0.53 and later, and the test suite runs against a pinned Remotion version so a
break shows up as a failing test, not a silent pass.

## Related

[remotion-qa](https://github.com/GroMarketing/remotion-qa) checks the rendered mp4 for social-platform safe zones,
dead air and captions that leave too fast. It's a good complement: remotion-lint checks the page, remotion-qa checks
the file.

## Background

This started as the QA gate for a product launch film built in Remotion, where every scene was checked by script
before anyone watched it. Thanks to [Magicweave](https://magicweave.xyz), where it was first used.

## License

MIT
