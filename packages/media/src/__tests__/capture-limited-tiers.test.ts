/**
 * A quality tier the device cannot capture must not be offered.
 *
 * Android's screen capturer is pinned to 30fps inside
 * `ScreenCaptureController.java` (`DEFAULT_FPS = 30`, also passed to
 * `changeCaptureFormat`), and `applyConstraints` throws because the controller
 * does not override it. Picking 60 therefore produced no extra frames — it only
 * raised the encoder's bitrate ceiling from 4.5 to 6.5 Mbps at 1080p. The user
 * paid uplink for frames that did not exist, and the picker looked like it worked.
 *
 * 15 is NOT in the same category and stays: capping the ENCODER below the capture
 * rate is a real reduction. Only the tier above the capture rate is fiction.
 */
import { describe, expect, it } from "vitest";
import {
  ANDROID_SCREEN_CAPTURE_MAX_FPS,
  clampScreenShareQualityToFps,
  SCREEN_SHARE_FRAME_RATES,
  screenShareFrameRatesUpTo,
} from "../quality.js";

describe("capture-limited frame-rate tiers", () => {
  it("offers Android exactly what it can capture", () => {
    expect(screenShareFrameRatesUpTo(ANDROID_SCREEN_CAPTURE_MAX_FPS)).toEqual([15, 30]);
  });

  it("leaves a surface that can capture 60 untouched", () => {
    // Desktop: Electron's desktopCapturer honours the requested rate.
    expect(screenShareFrameRatesUpTo(60)).toEqual(SCREEN_SHARE_FRAME_RATES);
  });

  it("pulls a saved 60fps tier down without losing the resolution", () => {
    // The user chose 2K deliberately; only the cadence was impossible.
    expect(clampScreenShareQualityToFps("1440p60", 30)).toBe("1440p30");
    expect(clampScreenShareQualityToFps("1080p60", 30)).toBe("1080p30");
  });

  it("does not touch a tier that is already within reach", () => {
    expect(clampScreenShareQualityToFps("720p15", 30)).toBe("720p15");
    expect(clampScreenShareQualityToFps("720p30", 30)).toBe("720p30");
  });

  it("keeps the Android ceiling a real tier, not an invented number", () => {
    // If someone edits the constant to 45, the encoder matrix has no such column
    // and every lookup silently falls back. Fail loudly instead.
    expect(SCREEN_SHARE_FRAME_RATES).toContain(ANDROID_SCREEN_CAPTURE_MAX_FPS);
  });
});
