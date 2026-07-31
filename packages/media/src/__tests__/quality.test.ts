/**
 * Screen-share quality MATRIX + mapping helpers. The engine-level plumbing
 * (profile → publish options) is covered in engine.test.ts; this file pins the
 * profile VALUES + the axis/legacy mapping so a silent retune (or a broken
 * backward-compat path) can't slip through review.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREEN_SHARE_QUALITY,
  isScreenShareQuality,
  MIC_BITRATE_STEPS_KBPS,
  micAudioPresetForBitrate,
  normalizeScreenShareQuality,
  SCREEN_SHARE_CONTENT_HINT,
  SCREEN_SHARE_DEGRADATION_PREFERENCE,
  SCREEN_SHARE_FRAME_RATES,
  SCREEN_SHARE_QUALITIES,
  SCREEN_SHARE_QUALITY_PROFILES,
  SCREEN_SHARE_RESOLUTIONS,
  screenShareEncodingForQuality,
  screenShareFrameRateOf,
  screenShareQualityId,
  screenShareResolutionOf,
  type ScreenShareQuality,
} from "../index.js";

describe("screen share quality matrix", () => {
  it("covers every {resolution × frame-rate} cell (4 × 3 = 12 profiles)", () => {
    expect(SCREEN_SHARE_RESOLUTIONS).toEqual(["480p", "720p", "1080p", "1440p"]);
    expect(SCREEN_SHARE_FRAME_RATES).toEqual([15, 30, 60]);
    expect(Object.keys(SCREEN_SHARE_QUALITY_PROFILES)).toHaveLength(12);
    for (const resolution of SCREEN_SHARE_RESOLUTIONS) {
      for (const frameRate of SCREEN_SHARE_FRAME_RATES) {
        const id = screenShareQualityId(resolution, frameRate);
        expect(SCREEN_SHARE_QUALITY_PROFILES[id]).toBeDefined();
        expect(screenShareResolutionOf(id)).toBe(resolution);
        expect(screenShareFrameRateOf(id)).toBe(frameRate);
      }
    }
  });

  it("pins the calibrated bitrate ceilings (no uncapped tier)", () => {
    const bitrate = (id: ScreenShareQuality): number =>
      SCREEN_SHARE_QUALITY_PROFILES[id].maxBitrateBps;
    // 480p
    expect(bitrate("480p15")).toBe(800_000);
    expect(bitrate("480p30")).toBe(1_200_000);
    expect(bitrate("480p60")).toBe(1_800_000);
    // 720p
    expect(bitrate("720p15")).toBe(1_500_000);
    expect(bitrate("720p30")).toBe(2_500_000);
    expect(bitrate("720p60")).toBe(4_000_000);
    // 1080p
    expect(bitrate("1080p15")).toBe(3_000_000);
    expect(bitrate("1080p30")).toBe(4_500_000);
    expect(bitrate("1080p60")).toBe(6_500_000);
    // 1440p (2K) — trimmed when the publish codec moved to VP9 (see quality.ts).
    expect(bitrate("1440p15")).toBe(4_000_000);
    expect(bitrate("1440p30")).toBe(5_000_000);
    expect(bitrate("1440p60")).toBe(7_000_000);
    // Every cell is finite + positive — the "no uncapped layer" invariant.
    for (const id of SCREEN_SHARE_QUALITIES) {
      expect(SCREEN_SHARE_QUALITY_PROFILES[id].maxBitrateBps).toBeGreaterThan(0);
      expect(Number.isFinite(SCREEN_SHARE_QUALITY_PROFILES[id].maxBitrateBps)).toBe(true);
    }
  });

  it("pins the 16:9 capture dimensions per resolution", () => {
    expect(SCREEN_SHARE_QUALITY_PROFILES["480p30"]).toMatchObject({
      resolution: "480p",
      width: 854,
      height: 480,
      frameRate: 30,
    });
    expect(SCREEN_SHARE_QUALITY_PROFILES["720p60"]).toMatchObject({
      width: 1280,
      height: 720,
      frameRate: 60,
    });
    expect(SCREEN_SHARE_QUALITY_PROFILES["1080p30"]).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(SCREEN_SHARE_QUALITY_PROFILES["1440p60"]).toMatchObject({
      width: 2560,
      height: 1440,
    });
  });

  it("defaults to 1080p30 and lists profiles lowest → highest bitrate", () => {
    expect(DEFAULT_SCREEN_SHARE_QUALITY).toBe("1080p30");
    const bitrates = SCREEN_SHARE_QUALITIES.map(
      (id) => SCREEN_SHARE_QUALITY_PROFILES[id].maxBitrateBps,
    );
    const sorted = [...bitrates].sort((a, b) => a - b);
    expect(bitrates).toEqual(sorted);
  });

  it("maps a profile to a livekit screenShareEncoding", () => {
    expect(screenShareEncodingForQuality("1440p60")).toEqual({
      maxBitrate: 7_000_000,
      maxFramerate: 60,
    });
    expect(screenShareEncodingForQuality("720p30")).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
    });
  });

  it("exposes the motion content hint + maintain-framerate degradation trade", () => {
    expect(SCREEN_SHARE_CONTENT_HINT).toBe("motion");
    expect(SCREEN_SHARE_DEGRADATION_PREFERENCE).toBe("maintain-framerate");
  });

  it("guards untrusted quality values (localStorage)", () => {
    expect(isScreenShareQuality("1080p30")).toBe(true);
    expect(isScreenShareQuality("1440p60")).toBe(true);
    expect(isScreenShareQuality("balanced")).toBe(false); // legacy tier — not a matrix id
    expect(isScreenShareQuality("ultra")).toBe(false);
    expect(isScreenShareQuality("2160p30")).toBe(false); // 4K not offered
    expect(isScreenShareQuality(null)).toBe(false);
    expect(isScreenShareQuality(42)).toBe(false);
  });

  it("normalizes legacy tiers + garbage to a valid matrix id (persist survives)", () => {
    // Legacy Smooth / Balanced / Cinema → nearest matrix cell.
    expect(normalizeScreenShareQuality("smooth")).toBe("720p30");
    expect(normalizeScreenShareQuality("balanced")).toBe("1080p30");
    expect(normalizeScreenShareQuality("cinema")).toBe("1080p60");
    // A current id passes through untouched.
    expect(normalizeScreenShareQuality("1440p60")).toBe("1440p60");
    // Anything else → the default.
    expect(normalizeScreenShareQuality("garbage")).toBe(DEFAULT_SCREEN_SHARE_QUALITY);
    expect(normalizeScreenShareQuality(null)).toBe(DEFAULT_SCREEN_SHARE_QUALITY);
    expect(normalizeScreenShareQuality(undefined)).toBe(DEFAULT_SCREEN_SHARE_QUALITY);
  });
});

describe("micAudioPresetForBitrate", () => {
  it("mirrors the livekit AudioPresets steps exactly", () => {
    for (const step of MIC_BITRATE_STEPS_KBPS) {
      expect(micAudioPresetForBitrate(step)).toEqual({ maxBitrate: step * 1000 });
    }
  });

  it("snaps to the nearest step and rounds ties up", () => {
    expect(micAudioPresetForBitrate(50)).toEqual({ maxBitrate: 48_000 });
    expect(micAudioPresetForBitrate(56)).toEqual({ maxBitrate: 64_000 }); // tie → up
    expect(micAudioPresetForBitrate(1)).toEqual({ maxBitrate: 12_000 });
    expect(micAudioPresetForBitrate(500)).toEqual({ maxBitrate: 128_000 });
  });
});
