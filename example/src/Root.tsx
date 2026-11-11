import React from "react";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
import { AbsoluteFill, Composition, Img, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

const font: React.CSSProperties = { fontFamily: "Helvetica, Arial, sans-serif", fontSize: 48, color: "#111" };
const at = (left: number, top: number): React.CSSProperties => ({ position: "absolute", left, top });

/** One second per planted bug. The test suite expects exactly this kind at this second. */
export const PLANTED: Array<[number, string, React.ReactNode]> = [
  [0, "clean", <div style={{ ...font, ...at(200, 200) }}>A clean title</div>],
  [1, "clipped", (
    <div style={{ ...at(200, 200), width: 300, overflow: "hidden" }}>
      <div style={{ ...font, whiteSpace: "nowrap" }}>This headline is far too long for its box</div>
    </div>
  )],
  [2, "too-small", <div style={{ ...font, ...at(200, 200), fontSize: 14 }}>Fine print nobody can read</div>],
  [3, "outside-safe-area", <div style={{ ...font, ...at(20, 500) }}>Hugging the edge</div>],
  [4, "overlap", (
    <>
      <div style={{ ...font, ...at(400, 400) }}>First line</div>
      <div style={{ ...font, ...at(420, 410) }}>Second line</div>
    </>
  )],
  [5, "forbidden-word", <div style={{ ...font, ...at(200, 200) }}>Project Nightjar launches</div>],
  [6, "escapes-box", (
    <div style={{ ...at(200, 200), width: 400, height: 120, background: "#e8eef7" }}>
      <div style={{ ...font, position: "absolute", left: 20, top: 140 }}>Fell out of its card</div>
    </div>
  )],
  [7, "under-control", (
    <>
      <div style={{ ...font, ...at(400, 400) }}>Text under a button</div>
      <div style={{ ...at(480, 400), width: 60, height: 60, borderRadius: 30, background: "#2a6" }} />
    </>
  )],
];

const Planted: React.FC = () => (
  <AbsoluteFill style={{ background: "#fff" }}>
    {PLANTED.map(([sec, , node]) => (
      <Sequence key={sec} from={sec * 30} durationInFrames={30}>
        {node}
      </Sequence>
    ))}
  </AbsoluteFill>
);

/** Small text inside a phone mock is the phone's own UI: only clipping and words are checked there. */
const Clean: React.FC = () => (
  <AbsoluteFill style={{ background: "#fff" }}>
    <div style={{ ...font, ...at(200, 150) }}>Everything here is fine</div>
    <div data-lint="embedded" style={{ ...at(1200, 200), width: 390, height: 700, background: "#000", borderRadius: 40 }}>
      <div style={{ ...font, fontSize: 13, color: "#fff", position: "absolute", left: 24, top: 40 }}>9:41</div>
    </div>
  </AbsoluteFill>
);

const Card: React.FC<{ variant: "a" | "b" }> = ({ variant }) => (
  <div style={{ width: 400, height: 300, background: variant === "a" ? "#f4f4f4" : "#1d1d1f", position: "relative" }}>
    <div style={{ ...font, position: "absolute", left: 24, top: 24, fontSize: 36, color: variant === "a" ? "#111" : "#fff" }}>Score</div>
    <div style={{ ...font, position: "absolute", left: 24, top: 120, fontSize: 96, color: variant === "a" ? "#111" : "#fff" }}>1,240</div>
  </div>
);

/** A rebuilt component beside its reference. Second 0 matches; second 1 is in the wrong theme. */
const Diff: React.FC = () => {
  const drifted = useCurrentFrame() >= 30;
  return (
    <AbsoluteFill style={{ background: "#fff", flexDirection: "row", alignItems: "flex-start", gap: 100, padding: 200 }}>
      <div data-lint="screen"><Card variant={drifted ? "b" : "a"} /></div>
      <div data-lint="ref"><Card variant="a" /></div>
    </AbsoluteFill>
  );
};


const Reveal: React.FC<{ frames?: number }> = ({ frames = 20 }) => {
  const y = interpolate(useCurrentFrame(), [0, frames], [100, 0], { extrapolateRight: "clamp" });
  return (
    <div style={{ ...at(200, 200), overflow: "hidden", height: 96 }}>
      <div style={{ ...font, fontSize: 96, lineHeight: 1, transform: `translateY(${y}%)` }}>Revealed title</div>
    </div>
  );
};

const WordCaption: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ ...font, ...at(200, 400) }}>
      {"Ship the first draft".split(" ").map((w, i) => (
        <React.Fragment key={i}>
          {i ? " " : ""}
          <span style={{ display: "inline-block", transform: `scale(${spring({ frame: frame - i * 3, fps, config: { damping: 200 } })})` }}>{w}</span>
        </React.Fragment>
      ))}
    </div>
  );
};

const SlideIn: React.FC = () => {
  const x = interpolate(useCurrentFrame(), [0, 15], [-700, 200], { extrapolateRight: "clamp" });
  return <div style={{ ...font, ...at(x, 300) }}>Sliding in from the left</div>;
};

/** Normal motion design. The test suite checks these seconds and expects no problems at all. */
export const ORDINARY: Array<[number, string, React.ReactNode]> = [
  [0, "mask reveal, mid-move at 0.2 s, settled at 0.9 s", <Reveal />],
  [1, "slide-in, crossing the edge at 1.1 s, settled at 1.9 s", <SlideIn />],
  [2, "highlight behind a word", (
    <>
      <div style={{ ...at(395, 392), width: 130, height: 66, background: "#ffe066" }} />
      <div style={{ ...font, ...at(200, 400) }}>A highlighted word</div>
    </>
  )],
  [3, "badge overhanging a card", (
    <div style={{ ...at(300, 300), width: 500, height: 200, background: "#eef2f7" }}>
      <div style={{ ...font, position: "absolute", left: 24, top: 60 }}>Card title</div>
      <span style={{ ...font, fontSize: 32, position: "absolute", right: -30, top: -24, background: "#e33", color: "#fff", padding: "4px 12px" }}>NEW</span>
    </div>
  )],
  [4, "tight leading", (
    <div style={{ ...at(200, 300), fontFamily: "Georgia, serif", fontSize: 96, lineHeight: 0.9 }}>
      <div>Two lines set</div>
      <div>tight together</div>
    </div>
  )],
  [5, "wrapped inline spans", (
    <p style={{ ...font, ...at(200, 300), width: 600, margin: 0 }}>
      <span>The first span is long enough to wrap onto a second line,</span> <span>and the second follows it.</span>
    </p>
  )],
  [6, "two blocks that only spell a banned word if glued together", (
    <>
      <div style={{ ...font, ...at(200, 200) }}>What to</div>
      <div style={{ ...font, ...at(200, 400) }}>do next</div>
    </>
  )],
  [7, "outline text: a stroked copy stacked on a filled copy", (
    <>
      <div style={{ ...font, ...at(200, 200), fontSize: 120, WebkitTextStroke: "6px #000", color: "transparent" }}>OUTLINE</div>
      <div style={{ ...font, ...at(200, 200), fontSize: 120, color: "#fc0" }}>OUTLINE</div>
    </>
  )],
  [8, "an intended overlap, switched off on the second element", (
    <>
      <div style={{ ...font, ...at(400, 400) }}>Behind</div>
      <div data-lint-ignore="overlap" style={{ ...font, ...at(420, 410), color: "#c00" }}>In front</div>
    </>
  )],
  [9, "very tight caps headline", (
    <div style={{ ...at(200, 300), fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 800, fontSize: 120, lineHeight: 0.8 }}>
      <div>BIG BOLD</div>
      <div>HEADLINE</div>
    </div>
  )],
  [10, "heading with a full-width accent bar as a child", (
    <div style={{ ...font, ...at(300, 300), position: "absolute" }}>
      Heading with a bar
      <div style={{ position: "absolute", left: -300, top: 70, width: 1920, height: 6, background: "#2a6" }} />
    </div>
  )],
  [11, "absolute text inside an overflow box that is not its containing block", (
    <div style={{ width: 300, height: 50, overflow: "hidden", marginTop: 100, marginLeft: 100 }}>
      <div style={{ ...font, ...at(700, 500) }}>Not clipped by that box</div>
    </div>
  )],
  [12, "a giant pale chapter number behind a title, marked as intended", (
    <>
      <div data-lint-ignore="overlap" style={{ ...font, ...at(200, 120), fontSize: 400, fontWeight: 900, color: "#eeeeee" }}>01</div>
      <div style={{ ...font, ...at(260, 300), fontSize: 72 }}>Chapter one</div>
    </>
  )],
  [13, "a retro offset copy of a headline", (
    <>
      <div style={{ ...font, ...at(206, 206), fontSize: 120, fontWeight: 900, color: "#f0f" }}>RETRO</div>
      <div style={{ ...font, ...at(200, 200), fontSize: 120, fontWeight: 900, color: "#0cf" }}>RETRO</div>
    </>
  )],
  [14, "a marker highlight drawn over a word, multiplied", (
    <>
      <div style={{ ...font, ...at(200, 400) }}>A marked word</div>
      <div style={{ ...at(395, 392), width: 130, height: 66, background: "#ffe066", mixBlendMode: "multiply" }} />
    </>
  )],
  [15, "subtitles 70 px above the bottom edge", <div style={{ ...font, position: "absolute", left: 400, bottom: 70 }}>Subtitles sit low on the frame</div>],
  [16, "a mask reveal that takes most of a second", <Reveal frames={24} />],
  [17, "word-by-word spring caption, with real spaces between the word spans", <WordCaption />],
];

const caption = <div style={{ ...font, ...at(200, 500), fontSize: 14 }}>Fine print nobody can read</div>;
const PushIn: React.FC = () => (
  <AbsoluteFill style={{ transform: `scale(${1 + useCurrentFrame() * 0.001})` }}>
    <div style={{ ...font, ...at(200, 900), fontSize: 14 }}>Fine print on a slow push-in</div>
  </AbsoluteFill>
);

/** Finishing layers and camera moves that must not hide a problem underneath. Each second must report its kind. */
export const OVERLAYS: Array<[number, string, React.ReactNode]> = [
  [0, "too-small", <>{caption}<AbsoluteFill style={{ background: "radial-gradient(circle, transparent 60%, rgba(0,0,0,.5))" }} /></>],
  [1, "too-small", <>{caption}<AbsoluteFill style={{ background: "#ff8800", mixBlendMode: "multiply" }} /></>],
  [2, "too-small", <>{caption}<AbsoluteFill style={{ background: "rgba(0,0,0,0.15)" }} /></>],
  [3, "too-small", (
    <>
      <Img src={`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#cde"/></svg>')}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      <AbsoluteFill style={{ pointerEvents: "none" }}>{caption}</AbsoluteFill>
    </>
  )],
  [4, "forbidden-word", <div style={{ ...font, ...at(200, 300), fontSize: 120, fontWeight: 900, opacity: 0.4 }}>NIGHTJAR DRAFT</div>],
  [5, "clean", <>{caption}<AbsoluteFill style={{ background: "#fff" }} /></>],
  [6, "too-small", <PushIn />],
];

const Push: React.FC = () => (
  <div style={{ ...font, ...at(20, 500), transformOrigin: "left top", transform: `scale(${1 + useCurrentFrame() * 0.001})` }}>Parked at the edge</div>
);

const Twins: React.FC = () => {
  const x = interpolate(useCurrentFrame(), [0, 29], [200, 600]);
  return (
    <>
      <div style={{ ...font, ...at(x, 200) }}>Score board total</div>
      <div style={{ ...at(200, 500), width: 200, overflow: "hidden" }}>
        <div style={{ ...font, whiteSpace: "nowrap" }}>Score board total</div>
      </div>
    </>
  );
};

/** Problems the first version missed. Each second must report exactly its kind. */
export const MISSED: Array<[number, string, React.ReactNode]> = [
  [0, "too-small", (
    <svg style={at(200, 200)} width={600} height={100}>
      <text x={0} y={50} fontSize={10}>Tiny SVG label</text>
    </svg>
  )],
  [1, "too-small", <div style={{ ...font, ...at(200, 400), fontSize: 14, width: 800, transform: "rotate(8deg)" }}>Rotated fine print that is still too small to read</div>],
  [2, "forbidden-word", <div style={{ ...font, ...at(200, 200), width: 1400 }}>A long sentence that runs well past sixty characters before naming Nightjar</div>],
  [3, "forbidden-word", (
    <div style={{ ...font, ...at(200, 200), display: "flex" }}>
      {"Nightjar".split("").map((c, i) => <span key={i}>{c}</span>)}
    </div>
  )],
  [4, "clipped", (
    <div style={{ ...at(200, 200), width: 300, overflow: "hidden", display: "flex", justifyContent: "flex-end" }}>
      <div style={{ ...font, whiteSpace: "nowrap", flexShrink: 0 }}>Cut off on the left side</div>
    </div>
  )],
  [5, "clipped", (
    <div style={{ ...at(200, 200), width: 300, height: 200, overflow: "hidden" }}>
      <div style={{ width: 900 }}>
        <div style={{ ...font, whiteSpace: "nowrap" }}>Cut by an outer mask only</div>
      </div>
    </div>
  )],
  [6, "forbidden-word", <input readOnly value="nightjar" style={{ ...font, ...at(200, 200), width: 400 }} />],
  [7, "clean", <div data-lint-ignore="too-small" style={{ ...font, ...at(200, 200), fontSize: 14 }}>Small on purpose, and marked so</div>],
  [8, "clipped", <div style={{ ...font, ...at(200, 200), width: 300, overflow: "hidden", whiteSpace: "nowrap" }}>Clipped by its own box</div>],
  [9, "clipped", <div style={{ ...font, ...at(200, 200), width: 300, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>Cut short with an ellipsis</div>],
  [10, "outside-safe-area", <Push />],
  [11, "clipped", <Twins />],
  [12, "outside-safe-area", (
    <>
      <div data-lint-layer="1" style={{ position: "absolute", inset: 0 }}>
        <div style={{ ...font, ...at(20, 600) }}>Under a see-through layer</div>
      </div>
      <div data-lint-layer="2" style={{ position: "absolute", inset: 0 }}>
        <div style={{ ...font, ...at(800, 400), opacity: 0.6 }}>Draft</div>
      </div>
    </>
  )],
];

const Strip: React.FC<{ items: Array<[number, string, React.ReactNode]>; seconds?: number }> = ({ items, seconds = 1 }) => (
  <AbsoluteFill style={{ background: "#fff" }}>
    {items.map(([sec, , node]) => (
      <Sequence key={sec} from={sec * 30 * seconds} durationInFrames={30 * seconds}>
        {node}
      </Sequence>
    ))}
  </AbsoluteFill>
);

const WithProps: React.FC<{ title: string }> = ({ title }) => <div style={{ ...font, ...at(200, 200) }}>{title.toUpperCase()}</div>;

const Noisy: React.FC = () => {
  React.useEffect(() => console.error("Error: analytics beacon blocked"), []);
  return <div style={{ ...font, ...at(200, 200) }}>Renders fine, logs an error</div>;
};

const Counter: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <div style={{ ...at(200, 300), width: 160, overflow: "hidden", transformOrigin: "left top", transform: `scale(${1 + f * 0.0015})` }}>
      <div style={{ ...font, whiteSpace: "nowrap" }}>${(1_000_000 + Math.floor(f / 3) * 1234).toLocaleString("en-US")}</div>
    </div>
  );
};

const ScalePop: React.FC = () => {
  const { fps } = useVideoConfig();
  return <div style={{ ...font, ...at(400, 400), fontSize: 72, transform: `scale(${spring({ frame: useCurrentFrame(), fps })})` }}>Pop in</div>;
};

const CardRise: React.FC = () => {
  const y = interpolate(useCurrentFrame(), [0, 15], [60, 0], { extrapolateRight: "clamp" });
  return (
    <div style={{ ...at(300, 300), width: 500, height: 120, background: "#eef2f7" }}>
      <div style={{ ...font, position: "absolute", left: 24, top: 30 + y }}>Rising into its card</div>
    </div>
  );
};

const Title: React.FC<{ text: string; bg: string }> = ({ text, bg }) => (
  <AbsoluteFill style={{ background: bg, justifyContent: "center", alignItems: "center" }}>
    <div style={font}>{text}</div>
  </AbsoluteFill>
);

/** Three centred titles joined by Remotion's own transitions, fade then wipe, each title at rest for a second between them. */
const Transitions: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence durationInFrames={90}><Title text="First scene title" bg="#fff" /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 30 })} />
    <TransitionSeries.Sequence durationInFrames={90}><Title text="Second scene title" bg="#f4f4f4" /></TransitionSeries.Sequence>
    <TransitionSeries.Transition presentation={wipe()} timing={linearTiming({ durationInFrames: 30 })} />
    <TransitionSeries.Sequence durationInFrames={90}><Title text="Third scene title" bg="#fff" /></TransitionSeries.Sequence>
  </TransitionSeries>
);

/** Moving text that settles clear: shown as warnings, never counted. Two seconds per item, so each has time to settle. */
export const MOVING: Array<[number, string, React.ReactNode]> = [
  [0, "a spring scale-in starting from zero", <ScalePop />],
  [1, "text rising into its card", <CardRise />],
];

const Typewriter: React.FC = () => (
  <div style={{ ...font, ...at(200, 300), width: 500, overflow: "hidden", whiteSpace: "nowrap" }}>
    {"This caption keeps typing until the cut".slice(0, useCurrentFrame() * 2)}
  </div>
);

const ZoomChunk: React.FC = () => (
  <>
    <div style={{ ...font, ...at(400, 400) }}>Static headline here</div>
    <div style={{ ...font, ...at(420, 410), color: "#c00", transform: `scale(${1 + useCurrentFrame() * 0.002})` }}>A caption chunk</div>
  </>
);

const pair = (style: React.CSSProperties) => (
  <>
    <div style={{ ...font, ...at(400, 400), ...style }}>First line</div>
    <div style={{ ...font, ...at(420, 410), ...style }}>Second line</div>
  </>
);
const smallCaption = <div style={{ ...font, ...at(200, 500), fontSize: 14 }}>Fine print nobody can read</div>;

/** Cases where a guess would have passed a real problem. Each second must report exactly its kind. */
export const CAUTIOUS: Array<[number, string, React.ReactNode]> = [
  [0, "overlap", <AbsoluteFill style={{ background: "linear-gradient(#000, #223)" }}>{pair({ color: "#fff" })}</AbsoluteFill>],
  [1, "overlap", pair({ fontSize: 96, fontWeight: 900, color: "transparent", backgroundImage: "linear-gradient(90deg, #f0f, #0cf)", WebkitBackgroundClip: "text", backgroundClip: "text" })],
  [2, "too-small", <>{smallCaption}<AbsoluteFill style={{ background: "#000", maskImage: "linear-gradient(to top, black, transparent 40%)" }} /></>],
  [3, "too-small", <>{smallCaption}<AbsoluteFill style={{ background: "#000", filter: "opacity(0.2)" }} /></>],
  [4, "too-small", <>{smallCaption}<OffthreadVideo src={staticFile("overlay.mp4")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} /></>],
  [5, "clipped", <div style={{ ...font, ...at(200, 200), clipPath: "inset(0 40% 0 0)", whiteSpace: "nowrap" }}>A title cut by its clip path at rest</div>],
  [6, "overlap", (
    <div style={{ ...font, ...at(200, 200), width: 400 }}>
      A title long enough to wrap onto three lines here
      <div style={{ position: "absolute", top: 70, color: "#c00" }}>Subtitle</div>
    </div>
  )],
  [7, "forbidden-word", (
    <div style={{ ...font, ...at(200, 200), display: "flex", gap: "0.4em" }}>
      {"Nightjar".split("").map((c, i) => <span key={i}>{c}</span>)}
    </div>
  )],
  [8, "clipped", <Typewriter />],
  [9, "overlap", <ZoomChunk />],
  [10, "clean", <div style={{ ...font, ...at(20, 500), clipPath: "circle(0% at 50% 50%)" }}>Nightjar, not revealed yet</div>],
  [11, "clean", (
    <div style={{ ...at(200, 300), fontFamily: "Helvetica, Arial, sans-serif", fontWeight: 900, fontSize: 140, lineHeight: 0.8 }}>
      <div style={{ overflow: "hidden" }}>BUILD</div>
      <div style={{ overflow: "hidden" }}>FASTER</div>
    </div>
  )],
  [12, "clean", (
    <div style={{ ...font, ...at(200, 200) }}>
      {"What to do next".split(" ").map((w, i) => <React.Fragment key={i}>{i ? " " : ""}<span>{w}</span></React.Fragment>)}
    </div>
  )],
  [13, "clipped", <div style={{ ...at(200, 200), width: 300, height: 80, contain: "paint" }}><div style={{ ...font, whiteSpace: "nowrap" }}>Cut by a paint containment box</div></div>],
  [14, "too-small", <div style={{ visibility: "hidden" }}><div style={{ ...font, ...at(200, 300), fontSize: 14, visibility: "visible" }}>Visible inside a hidden parent</div></div>],
];

/** Problems that stay put. Each must fail even inside short scenes. */
export const STATIC: Array<[number, string, React.ReactNode]> = [
  [0, "clipped", <div style={{ ...font, ...at(200, 200), width: 420, overflow: "hidden", whiteSpace: "nowrap" }}>A headline truncated for the whole scene</div>],
  [1, "clipped", <div style={{ ...font, ...at(200, 200), width: 420, overflow: "hidden", whiteSpace: "nowrap" }}>Another headline cut for its scene</div>],
  [2, "outside-safe-area", <div style={{ ...font, fontSize: 72, ...at(960, 100), transform: "rotate(90deg)", transformOrigin: "left top", whiteSpace: "nowrap" }}>A sideways label that runs off the bottom</div>],
  [3, "clean", <div style={{ ...font, ...at(200, 200), clipPath: "inset(0 100% 0 0)" }}>Nightjar, hidden by a clip-path before its reveal</div>],
  [4, "clipped", <Counter />],
  [5, "clipped", <div style={{ ...font, ...at(1600, 400), whiteSpace: "nowrap" }}>A title that runs off the right edge</div>],
];

const Meta: React.FC<{ n: number }> = ({ n }) => <div style={{ ...font, ...at(200, 200) }}>{n} seconds long</div>;

const Crash: React.FC = () => {
  throw new Error("this composition always fails");
};

export const Root: React.FC = () => (
  <>
    <Composition id="Planted" component={Planted} durationInFrames={PLANTED.length * 30} fps={30} width={1920} height={1080} />
    <Composition id="Clean" component={Clean} durationInFrames={60} fps={30} width={1920} height={1080} />
    <Composition id="Diff" component={Diff} durationInFrames={60} fps={30} width={1920} height={1080} />
    <Composition id="Ordinary" component={() => <Strip items={ORDINARY} />} durationInFrames={ORDINARY.length * 30} fps={30} width={1920} height={1080} />
    <Composition id="Missed" component={() => <Strip items={MISSED} />} durationInFrames={MISSED.length * 30} fps={30} width={1920} height={1080} />
    <Composition id="WithProps" component={WithProps} defaultProps={{ title: "hello props" }} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="Crash" component={Crash} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="Noisy" component={Noisy} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="Moving" component={() => <Strip items={MOVING} seconds={2} />} durationInFrames={MOVING.length * 60} fps={30} width={1920} height={1080} />
    <Composition id="Static" component={() => <Strip items={STATIC} />} durationInFrames={STATIC.length * 30} fps={30} width={1920} height={1080} />
    <Composition id="Transitions" component={Transitions} durationInFrames={210} fps={30} width={1920} height={1080} />
    <Composition id="DiffSize" component={() => (
      <AbsoluteFill style={{ background: "#fff", flexDirection: "row", alignItems: "flex-start", gap: 100, padding: 200 }}>
        <div data-lint="screen" style={{ width: 300, height: 600, background: "#f4f4f4" }} />
        <div data-lint="ref" style={{ width: 300, height: 200, background: "#f4f4f4" }} />
      </AbsoluteFill>
    )} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="Overlays" component={() => <Strip items={OVERLAYS} />} durationInFrames={OVERLAYS.length * 30} fps={30} width={1920} height={1080} />
    <Composition id="Cautious" component={() => <Strip items={CAUTIOUS} />} durationInFrames={CAUTIOUS.length * 30} fps={30} width={1920} height={1080} />
    <Composition id="DiffPartial" component={() => (
      <AbsoluteFill style={{ background: "#fff" }}>
        <div data-lint="screen" style={{ ...at(200, 200), width: 600, height: 300, background: "#f4f4f4" }}><div style={{ ...at(420, 0), width: 180, height: 300, background: "#e33" }} /></div>
        <div data-lint="ref" style={{ ...at(1500, 200), width: 600, height: 300, background: "#f4f4f4" }} />
      </AbsoluteFill>
    )} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="FourK" component={() => <div style={{ ...font, ...at(400, 400), fontSize: 30 }}>Thirty pixels on a 4K frame</div>} durationInFrames={30} fps={30} width={3840} height={2160} />
    <Composition id="BadMeta" component={Meta} defaultProps={{ n: 1 }} calculateMetadata={() => { throw new Error("metadata exploded"); }} fps={30} width={1920} height={1080} />
    <Composition id="DiffOnion" component={() => (
      <AbsoluteFill style={{ background: "#fff" }}>
        <div data-lint="screen" style={at(200, 200)}><Card variant="b" /></div>
        <div data-lint="ref" style={{ ...at(200, 200), opacity: 0.5 }}><Card variant="a" /></div>
      </AbsoluteFill>
    )} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="DiffEmpty" component={() => (
      <AbsoluteFill style={{ background: "#fff", flexDirection: "row", alignItems: "flex-start", gap: 100, padding: 200 }}>
        <div data-lint="screen" style={{ position: "relative" }}><div style={{ position: "absolute" }}><Card variant="a" /></div></div>
        <div data-lint="ref"><Card variant="a" /></div>
      </AbsoluteFill>
    )} durationInFrames={30} fps={30} width={1920} height={1080} />
    <Composition id="Meta" component={Meta} defaultProps={{ n: 1 }} calculateMetadata={({ props }) => ({ durationInFrames: props.n * 30 })} fps={30} width={1920} height={1080} />
  </>
);
