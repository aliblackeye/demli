/**
 * Mobile screen-share PUBLISH shape — the founder's "yayın grenleniyor, bulanık,
 * 1080p 30hz seçmişti" report.
 *
 * Two things are pinned here, and they are pinned at different levels on purpose:
 *
 *  1. What WE hand the SDK (`createMobileVoiceRoom`'s RoomOptions) — captured by
 *     mocking the `Room` constructor, so it is the real constructed value rather
 *     than a re-reading of the literal.
 *  2. What the SDK DOES with it — asserted against livekit-client's own
 *     `computeVideoEncodings`, imported from the installed package source. This is
 *     the half that actually matters: `screenShareSimulcastLayers: []` only helps
 *     because `sortPresets([])` returns `[]` rather than `undefined`, which makes
 *     `computeVideoEncodings` fall through to a single full-resolution encoding.
 *     If a livekit upgrade ever changes that fall-through, asserting our own option
 *     literal would still pass while the grain came back — so we measure the SDK.
 *
 * The numbers below are for the founder's exact configuration: quality tier
 * `1080p30` (4.5 Mbps ceiling from packages/media/src/quality.ts) published from a
 * phone whose capture is its full physical panel, 1080x2400 portrait. Mobile capture
 * size is NOT constrainable from JS — see the header of ../screen-capture.ts for the
 * verification — so the panel size is the input, not a choice.
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCREEN_SHARE_QUALITY_PROFILES } from "@demli/media";

// --- the RN graph this module drags in, stubbed so it can load under node -----
const roomConstructorCalls: unknown[] = [];

vi.mock("@livekit/react-native", () => ({
  AudioSession: {
    configureAudio: vi.fn(),
    startAudioSession: vi.fn(),
    stopAudioSession: vi.fn(),
  },
}));

vi.mock("livekit-client", () => {
  class FakeRoom {
    localParticipant = {};
    constructor(options: unknown) {
      roomConstructorCalls.push(options);
    }
    on() {
      return this;
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: new Proxy({}, { get: (_t, k) => String(k) }),
    Track: { Source: new Proxy({}, { get: (_t, k) => String(k) }) },
    VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  };
});

vi.mock("../livekit-globals", () => ({ ensureLiveKitGlobals: vi.fn() }));
vi.mock("../audio-profile", () => ({
  androidAudioTypeOptionsFor: vi.fn(() => ({})),
  getActiveAudioProfile: vi.fn(() => ({})),
}));
vi.mock("../local-audio-meter", () => ({ createRNLocalAudioMeter: vi.fn() }));
vi.mock("../permissions", () => ({
  mediaError: vi.fn(),
  normalizeMediaError: vi.fn(),
  ensureMicPermission: vi.fn(),
  ensureCameraPermission: vi.fn(),
}));

/** The founder's phone panel: 1080x2400 portrait (a very ordinary Android panel). */
const PANEL_WIDTH = 1080;
const PANEL_HEIGHT = 2400;
/** The tier the founder had selected. */
const TIER = "1080p30" as const;

/** Only the fields these assertions read — enough to keep the test honest, no `any`. */
interface CapturedRoomOptions {
  adaptiveStream?: unknown;
  dynacast?: unknown;
  publishDefaults?: Record<string, unknown>;
  videoCaptureDefaults?: unknown;
}

async function mobileRoomOptions(): Promise<CapturedRoomOptions> {
  roomConstructorCalls.length = 0;
  const { createMobileVoiceRoom } = await import("../livekit-room");
  createMobileVoiceRoom();
  expect(roomConstructorCalls).toHaveLength(1);
  return roomConstructorCalls[0] as CapturedRoomOptions;
}

describe("mobile room options (what we hand the SDK)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("publishes screen share as a SINGLE encoding (no half-res duplicate)", async () => {
    const options = await mobileRoomOptions();
    expect(options.publishDefaults?.screenShareSimulcastLayers).toEqual([]);
  });

  it("asks adaptiveStream for the real device pixel density when SUBSCRIBING", async () => {
    const options = await mobileRoomOptions();
    expect(options.adaptiveStream).toEqual({ pixelDensity: "screen" });
  });

  it("does NOT force a codec — mobile stays on VP8 until a device getStats says otherwise", async () => {
    const options = await mobileRoomOptions();
    // Deliberate: most Android SoCs have no VP9 ENCODE hardware, so VP9 would be a
    // software encode of ~2.6 MP and would be paid for in shed resolution (the
    // engine's screen-share degradationPreference is maintain-framerate).
    expect(options.publishDefaults?.videoCodec).toBeUndefined();
  });

  it("does not clobber the mic publish defaults it inherits from the SDK", async () => {
    const options = await mobileRoomOptions();
    // livekit spread-merges publishDefaults over its own defaults, so absence here
    // means "inherit audioPreset: music, dtx, red, stopMicTrackOnMute: false".
    // Setting any of them by accident is a voice regression, not a screen-share fix.
    for (const key of ["audioPreset", "dtx", "red", "forceStereo", "stopMicTrackOnMute"]) {
      expect(options.publishDefaults).not.toHaveProperty(key);
    }
  });

  it("leaves CAMERA simulcast alone (the fix is screen-share scoped)", async () => {
    const options = await mobileRoomOptions();
    expect(options.publishDefaults?.videoSimulcastLayers).toBeUndefined();
    expect(options.publishDefaults?.simulcast).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What livekit-client ACTUALLY builds from those options. Imported from the
// installed package's shipped source; `computeVideoEncodings` is internal (not on
// the public entry), so it is required by path.
// ---------------------------------------------------------------------------
const SUBPATH = "node_modules/livekit-client/src/room/participant/publishUtils.ts";

/**
 * livekit-client's `exports` map has no subpath entry, so neither a bare import nor
 * `require.resolve` can reach the internal module. Walk up to whichever node_modules
 * the package is hoisted into and address the file directly.
 */
function resolvePublishUtils(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, SUBPATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${SUBPATH}. livekit-client no longer ships its TS source; ` +
      "re-pin the screen-share encoding assertions against whatever it does ship.",
  );
}

const publishUtilsPath = pathToFileURL(resolvePublishUtils()).href;

describe("livekit-client encoding math for the mobile screen share", () => {
  // The first import transforms livekit-client's TS source, which can exceed the
  // 5 s per-test budget on a loaded machine; pay that cost outside the assertions.
  beforeAll(async () => {
    await import(publishUtilsPath);
  }, 60_000);

  it("collapses to ONE full-resolution encoding at the tier's full bitrate", async () => {
    const { computeVideoEncodings } = await import(publishUtilsPath);
    const profile = SCREEN_SHARE_QUALITY_PROFILES[TIER];

    const encodings = computeVideoEncodings(true, PANEL_WIDTH, PANEL_HEIGHT, {
      simulcast: true, // livekit's default, still on for the camera
      screenShareEncoding: {
        maxBitrate: profile.maxBitrateBps,
        maxFramerate: profile.frameRate,
      },
      screenShareSimulcastLayers: [], // <- the fix
    });

    expect(encodings).toHaveLength(1);
    expect(encodings[0].scaleResolutionDownBy).toBe(1);
    expect(encodings[0].maxBitrate).toBe(profile.maxBitrateBps);

    const total = encodings.reduce(
      (sum: number, e: { maxBitrate?: number }) => sum + (e.maxBitrate ?? 0),
      0,
    );
    // The whole 4.5 Mbps tier goes to the layer people actually watch.
    expect(total).toBe(4_500_000);
  });

  it("REGRESSION GUARD: without the fix it asks for 25% more than the tier allows", async () => {
    const { computeVideoEncodings } = await import(publishUtilsPath);
    const profile = SCREEN_SHARE_QUALITY_PROFILES[TIER];

    // Exactly the old behaviour: no screenShareSimulcastLayers key at all.
    const encodings = computeVideoEncodings(true, PANEL_WIDTH, PANEL_HEIGHT, {
      simulcast: true,
      screenShareEncoding: {
        maxBitrate: profile.maxBitrateBps,
        maxFramerate: profile.frameRate,
      },
    });

    // Two layers: a half-res duplicate nobody watches, plus the real one.
    expect(encodings).toHaveLength(2);
    expect(encodings[0].scaleResolutionDownBy).toBe(2);
    expect(encodings[1].scaleResolutionDownBy).toBe(1);

    const total = encodings.reduce(
      (sum: number, e: { maxBitrate?: number }) => sum + (e.maxBitrate ?? 0),
      0,
    );
    // 1.125 Mbps of duplicate on top of the 4.5 Mbps tier ceiling.
    expect(total).toBe(5_625_000);
    expect(total / profile.maxBitrateBps).toBeCloseTo(1.25, 5);
  });

  it("also removes the duplicate's encoder cost (pixels per frame)", async () => {
    const { computeVideoEncodings } = await import(publishUtilsPath);
    const profile = SCREEN_SHARE_QUALITY_PROFILES[TIER];
    const opts = {
      simulcast: true,
      screenShareEncoding: {
        maxBitrate: profile.maxBitrateBps,
        maxFramerate: profile.frameRate,
      },
    };

    const pixels = (encodings: { scaleResolutionDownBy?: number }[]) =>
      encodings.reduce((sum, e) => {
        const s = e.scaleResolutionDownBy ?? 1;
        return sum + (PANEL_WIDTH / s) * (PANEL_HEIGHT / s);
      }, 0);

    const before = pixels(
      await import(publishUtilsPath).then((m) =>
        m.computeVideoEncodings(true, PANEL_WIDTH, PANEL_HEIGHT, opts),
      ),
    );
    const after = pixels(
      computeVideoEncodings(true, PANEL_WIDTH, PANEL_HEIGHT, {
        ...opts,
        screenShareSimulcastLayers: [],
      }),
    );

    // The phone stops encoding a 540x1200 copy on every frame: 3.24 MP -> 2.59 MP.
    expect(before).toBeCloseTo(3_240_000, -3);
    expect(after).toBeCloseTo(2_592_000, -3);
    expect(after / before).toBeCloseTo(0.8, 2);
  });
});
