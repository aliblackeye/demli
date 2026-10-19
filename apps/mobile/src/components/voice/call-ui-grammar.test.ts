/**
 * Source invariants for the Koyu Masa call UI on the phone (M16 Wave 4).
 *
 * The mobile app is not rendered under vitest (node env, no RN runtime), so —
 * like `stage-shell.test.ts` and `seat-model.test.ts` — these pin WIRING facts
 * in the source. Each block names the regression it exists to catch; each was
 * checked to go red under that mutation.
 *
 *  1. ONE danger grammar on every control surface: a cut-off STATE (muted,
 *     deafened) is the pink wash (`danger`), the one action that ends your
 *     presence is the solid pink disc (`dangerSolid`), and a media feature that is
 *     merely off (camera, screen share) is never pink. The founder has already
 *     reported the "red when not sharing" bug once.
 *  2. Joining is the warm action: the incoming ring's Accept is coral, not the
 *     retired green.
 *  3. Speaking is the shared coral frame on every video/avatar surface — not a
 *     per-file green border that drifts.
 *  4. No inline colour literals on the call surfaces: everything comes from the
 *     theme tokens, so a palette change reaches the call UI.
 *  5. The breathing motion respects reduced motion.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VOICE = __dirname;
const CALL = join(__dirname, "..", "call");
const WATCH = join(__dirname, "..", "watch");
const APP = join(__dirname, "..", "..", "..", "app", "(app)");

const read = (path: string): string => readFileSync(path, "utf8");

/** Strip block, JSX and line comments so prose never counts as code. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The JSX element (props included) that renders `icon={<Name>}` first after `from`. */
function elementWithIcon(source: string, icon: string): string {
  const at = source.indexOf(`icon={${icon}}`);
  expect(at, `no control with icon={${icon}}`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<", at);
  const end = source.indexOf("/>", at);
  return source.slice(start, end);
}

describe("one danger grammar on every call control surface", () => {
  const dock = code(read(join(VOICE, "VoiceControls.tsx")));
  const stageBar = code(read(join(VOICE, "StageControlBar.tsx")));
  const miniBar = code(read(join(VOICE, "VoiceMiniBar.tsx")));

  it("leave / hang up is the solid pink disc everywhere", () => {
    // Mutation: drop the dock's leave back to the wash (`danger`).
    expect(elementWithIcon(dock, "PhoneOff")).toContain('variant="dangerSolid"');
    expect(elementWithIcon(stageBar, "PhoneOff")).toContain('variant="dangerSolid"');
    expect(elementWithIcon(miniBar, "PhoneOff")).toContain('variant="dangerSolid"');
  });

  it("muted is the pink WASH, live mic is neutral", () => {
    // Mutation: paint a muted mic solid, or leave it neutral.
    expect(dock).toMatch(/variant=\{micEnabled \? "secondary" : "danger"\}/);
    expect(stageBar).toMatch(/variant=\{micEnabled \? "veil" : "danger"\}/);
    expect(miniBar).toMatch(/variant=\{micEnabled \? "secondary" : "danger"\}/);
  });

  it("deafened is the pink wash too", () => {
    expect(dock).toMatch(/variant=\{deafened \? "danger" : "secondary"\}/);
  });

  it("a camera or screen share that is OFF is never pink", () => {
    // The founder's bug: "ekran paylaşmamışken kırmızı gösteriyor". On = the coral
    // `active` wash; off = the neutral default. No danger variant on either.
    for (const surface of [dock, stageBar]) {
      for (const icon of ["cameraEnabled ? Video : VideoOff", "screenShareEnabled ? ScreenShareOff : ScreenShare"]) {
        const el = elementWithIcon(surface, icon);
        expect(el).not.toMatch(/variant="danger/);
        expect(el).toMatch(/active=\{(cameraEnabled|screenShareEnabled)\}/);
      }
    }
  });
});

describe("the incoming ring: decline pink, accept coral", () => {
  const overlay = code(read(join(CALL, "IncomingCallOverlay.tsx")));
  const busy = code(read(join(CALL, "BusyCallBanner.tsx")));

  it("accept is the warm coral action, not the retired green", () => {
    // Mutation: put `colors.online` back on the accept disc.
    expect(elementWithIcon(overlay, "Phone")).toContain('variant="accent"');
    expect(elementWithIcon(overlay, "PhoneOff")).toContain('variant="dangerSolid"');
    expect(elementWithIcon(busy, "Phone")).toContain('variant="accent"');
    expect(elementWithIcon(busy, "PhoneOff")).toContain('variant="dangerSolid"');
    expect(overlay).not.toContain("colors.online");
    expect(busy).not.toContain("colors.online");
  });
});

describe("speaking is the one shared coral frame", () => {
  it.each(["CameraTile.tsx", "ParticipantTile.tsx", "DraggableCameraPip.tsx"])(
    "%s mounts SpeakingFrame and has no green speaking border",
    (file) => {
      // Mutation: reintroduce `borderColor: speaking ? colors.online : …`.
      const body = code(read(join(VOICE, file)));
      expect(body).toContain("<SpeakingFrame speaking={speaking}");
      expect(body).not.toMatch(/speaking \? colors\.online/);
    },
  );

  it("the frame is coral", () => {
    const chrome = code(read(join(VOICE, "stage-chrome.tsx")));
    expect(chrome).toMatch(/inset 0 0 0 2px \$\{colors\.accent\}/);
  });
});

describe("no inline colour literals on the call surfaces", () => {
  const files = [
    ...readdirSync(VOICE).map((f) => join(VOICE, f)),
    ...readdirSync(CALL).map((f) => join(CALL, f)),
    ...readdirSync(WATCH).map((f) => join(WATCH, f)),
    join(APP, "call.tsx"),
    join(APP, "recent-calls.tsx"),
    join(APP, "voice", "[channelId].tsx"),
  ].filter((f) => f.endsWith(".tsx"));

  it("finds the files it guards", () => {
    // A gate over zero files is green and watching nothing.
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files)("%s draws only from theme tokens", (file) => {
    // Mutation: write `backgroundColor: "#000"` or `"rgba(0,0,0,0.5)"` anywhere.
    const body = code(read(file));
    expect(body).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/);
    expect(body).not.toMatch(/["'`]rgba?\(/);
  });
});

describe("breathing motion respects reduced motion", () => {
  it("the breath loop is skipped under reduced motion", () => {
    // Mutation: drop the `reduced` guard and the ring breathes for everyone.
    const chrome = code(read(join(VOICE, "stage-chrome.tsx")));
    const breath = chrome.slice(chrome.indexOf("export function useBreath"));
    expect(breath).toContain("useReducedMotion()");
    expect(breath).toMatch(/if \(!active \|\| reduced\)/);
  });

  it("the ring screen breathes only while genuinely ringing", () => {
    const ring = code(read(join(CALL, "RingingScreen.tsx")));
    expect(ring).toContain("useBreath(pulse)");
  });
});
