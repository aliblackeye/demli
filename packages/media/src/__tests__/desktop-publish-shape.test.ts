/**
 * DESKTOP publish shape — a containment guard for the mobile screen-share fix.
 *
 * The mobile grain fix (apps/mobile/src/media/livekit-room.ts) sets
 * `publishDefaults.screenShareSimulcastLayers: []` so the phone publishes ONE
 * encoding instead of a full-resolution layer plus a half-resolution duplicate.
 * That is correct for a phone, which cannot constrain its capture (it always
 * encodes its whole ~2.6 MP panel) and has no VP9 encode hardware to fall back on.
 *
 * It would NOT be correct to copy onto desktop, and this file exists so that copy
 * fails loudly instead of silently changing what every desktop viewer receives:
 *
 *  - Desktop publishes VP9 with SVC. `computeVideoEncodings` takes the SVC branch
 *    (`scalabilityMode` + `isSVCCodec`) and never reaches the simulcast-preset code
 *    that `screenShareSimulcastLayers` feeds — so the key is dead weight at best.
 *  - Desktop DOES constrain its capture to the chosen profile
 *    (apps/desktop/.../screen-share.ts caps width/height/frameRate), so its encoder
 *    is already sized to the tier. The mobile problem does not exist there.
 *  - The desktop ladder is what lets a small tile be served a low layer; removing it
 *    would push full-resolution video at every viewer.
 *
 * Source-level assertions on purpose: `createLiveKitRoom` constructs a web
 * `livekit-client` Room, and standing up that graph under node buys nothing here —
 * what needs pinning is the option set this file declares.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LIVEKIT = join(dirname(fileURLToPath(import.meta.url)), "..", "livekit.ts");
const source = readFileSync(LIVEKIT, "utf8");

describe("desktop room publish defaults are unaffected by the mobile fix", () => {
  it("does NOT adopt the mobile single-encoding screen-share override", () => {
    expect(source).not.toContain("screenShareSimulcastLayers");
  });

  it("still publishes VP9 with the legacy-decoder backup", () => {
    expect(source).toMatch(/const VIDEO_CODEC: VideoCodec = "vp9"/);
    expect(source).toContain("videoCodec: VIDEO_CODEC");
    expect(source).toContain("backupCodec: true");
  });

  it("still asks adaptiveStream for physical pixels", () => {
    expect(source).toContain('adaptiveStream: { pixelDensity: "screen" }');
  });

  it("still lets the SFU pause unwatched layers", () => {
    expect(source).toContain("dynacast: true");
  });
});

describe("the shared quality matrix is untouched by the mobile fix", () => {
  it("keeps the 1080p30 ceiling both platforms publish against", async () => {
    const { SCREEN_SHARE_QUALITY_PROFILES } = await import("../quality.js");
    const profile = SCREEN_SHARE_QUALITY_PROFILES["1080p30"];
    expect(profile.maxBitrateBps).toBe(4_500_000);
    expect(profile.frameRate).toBe(30);
    expect(profile.width).toBe(1920);
    expect(profile.height).toBe(1080);
  });

  it("still sheds resolution rather than frame-rate under pressure", async () => {
    const { SCREEN_SHARE_DEGRADATION_PREFERENCE } = await import("../quality.js");
    // Deliberately unchanged. On mobile this is part of why grain appeared, but the
    // remedy applied there was to stop wasting encoder budget, NOT to make the film
    // stutter. Flipping this would change desktop's film behaviour too.
    expect(SCREEN_SHARE_DEGRADATION_PREFERENCE).toBe("maintain-framerate");
  });
});
