/**
 * Source-invariant guards for the ONE mobile voice/call stage shell (call-ux-plan
 * W3).
 *
 * WHY SOURCE-INVARIANT AND NOT A RENDER TEST. The bug these guard against is a
 * MISSING MOUNT: `ParticipantTile`'s long-press calls the module-level
 * `openParticipantVolumeSheet`, the controller store updates — and if nobody
 * rendered `<ParticipantVolumeSheet>`, nothing appears. A render test of the
 * tile passes in exactly that broken state, because the tile is not what is
 * broken. What has to be true is a WIRING fact about the two screens, and this
 * file asserts that fact directly. (`gates-that-lie`: a gate must fail when the
 * defect is reintroduced — see the mutation notes on each block.)
 *
 * The mobile app is not rendered under vitest (node env, no RN runtime), so
 * reading the modules' source is the honest way to assert wiring here; it is the
 * same technique `pip-overlay.test.ts` and `voice-channel-nav.test.ts` use.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VOICE = join(__dirname);
const CALL = join(__dirname, "..", "call");

const read = (path: string): string => readFileSync(path, "utf8");

const voiceStage = read(join(VOICE, "VoiceStage.tsx"));
const inCallView = read(join(CALL, "InCallView.tsx"));
const voiceRoom = read(join(VOICE, "VoiceRoomScreen.tsx"));
const useStageTiles = read(join(VOICE, "use-stage-tiles.ts"));
const cameraStage = read(join(VOICE, "CameraStage.tsx"));

/** Strip block + line comments so prose about a symbol never counts as usage. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the per-user volume sheet is actually hosted (the dead control)", () => {
  it("mounts the sheet host in the SHARED stage shell", () => {
    // Mutation that must fail this: delete the <ParticipantVolumeSheet /> mount
    // from VoiceStage — i.e. the exact state the DM call shipped in.
    expect(code(voiceStage)).toContain("<ParticipantVolumeSheet");
  });

  it("reaches BOTH surfaces, because both render the shared shell", () => {
    // Mutation that must fail this: point either screen back at its own stage
    // assembly (ScreenShareStage/CameraStage directly) instead of VoiceStage.
    expect(code(inCallView)).toContain("<VoiceStage");
    expect(code(voiceRoom)).toContain("<VoiceStage");
  });

  it("hosts the sheet EXACTLY once, so the controller has one listener", () => {
    // Two mounts would render two modals off one controller store. The shell is
    // the only place allowed to mount it.
    const mounts = [voiceStage, inCallView, voiceRoom]
      .map(code)
      .join("\n")
      .match(/<ParticipantVolumeSheet/g);
    expect(mounts).toHaveLength(1);
  });

  it("still has a trigger wired to that host", () => {
    // The host is only meaningful if a tile can open it — guards the other half
    // of the seam (deleting the long-press would leave a host nothing opens).
    const tile = code(read(join(VOICE, "ParticipantTile.tsx")));
    expect(tile).toContain("openParticipantVolumeSheet");
  });
});

describe("the stage bar and the audio-route picker reach both surfaces", () => {
  it("mounts the in-stage control bar in the shared shell", () => {
    // It used to live under components/call/ and existed ONLY in the DM call.
    expect(code(voiceStage)).toContain("<StageControlBar");
  });

  it("offers the audio output route on both surfaces", () => {
    expect(code(inCallView)).toContain("<AudioOutputControl");
    expect(code(voiceRoom)).toContain("<AudioOutputControl");
  });
});

describe("there is exactly ONE tile builder", () => {
  it("builds tiles from the SHARED media model, not a local copy", () => {
    // Mutation that must fail this: reimplement tiles by hand in the hook.
    expect(code(useStageTiles)).toContain("buildTiles");
    expect(code(useStageTiles)).toContain("@demli/media");
  });

  it("has no copy-pasted tile memo left in either screen", () => {
    // The duplicated 18-line memo's fingerprint: each screen zipping the roster
    // to camera tracks itself. Neither screen may join tracks to participants
    // any more — they call the shared hook.
    for (const source of [inCallView, voiceRoom]) {
      const body = code(source);
      expect(body).not.toContain("camByIdentity");
      expect(body).not.toContain("useRemoteCameras");
      expect(body).not.toContain("useLocalCameraTrack");
      expect(body).toContain("useStageTiles");
    }
  });
});

describe("the stage layout comes from the shared model", () => {
  it("resolves grid/focus + the K3 filmstrip via resolveStage", () => {
    // Mutation that must fail this: go back to a hand-rolled
    // `tiles.filter(t => t.identity !== focused)` filmstrip.
    const body = code(cameraStage);
    expect(body).toContain("resolveStage");
    expect(body).toContain("speakerFilmstrip");
    expect(body).toContain("@demli/media");
  });

  it("feeds the filmstrip from the ONE active-speaker tracker", () => {
    // A momentary `speaking` flag here would strobe the strip; `recent` carries
    // the shared 300 ms attack / 5 s release hysteresis.
    expect(code(cameraStage)).toContain("useActiveSpeakers");
    expect(code(cameraStage)).toContain("recentSpeakers");
  });

  it("derives focus keys with the shared key helper, not a string literal", () => {
    expect(code(cameraStage)).toContain("participantKey");
  });
});

describe("the K4 self-view", () => {
  it("is mounted on the focus stage and carried into fullscreen", () => {
    expect(code(cameraStage)).toContain("<SelfViewPip");
    expect(code(cameraStage)).toContain("selfViewTile");
  });

  it("renders a camera-off placeholder rather than disappearing", () => {
    // The founder's literal requirement: the box must STATE that the camera is
    // off. Mutation that must fail this: drop `cameraOff` and let the overlay
    // fall back to a bare avatar (or render nothing).
    const selfView = code(read(join(VOICE, "SelfViewPip.tsx")));
    expect(selfView).toContain("cameraOff");
    const pip = code(read(join(VOICE, "DraggableCameraPip.tsx")));
    expect(pip).toContain("PipCameraOff");
    expect(pip).toContain("voice.selfView.cameraOff");
  });

  it("defaults to ON and remembers its corner", () => {
    const store = code(read(join(__dirname, "..", "..", "stores", "self-view-store.ts")));
    expect(store).toMatch(/enabled:\s*true/);
    expect(store).toContain("corner");
    expect(store).toContain("persist");
  });
});

describe("the deleted duplicate really is gone", () => {
  it("has no components/call/CallStageControls.tsx left behind", () => {
    // It moved to voice/StageControlBar.tsx so BOTH surfaces mount it. A stale
    // copy would let the two bars drift apart again.
    expect(() => read(join(CALL, "CallStageControls.tsx"))).toThrow();
  });
});
