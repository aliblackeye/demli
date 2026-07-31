/**
 * The mobile pickers must not re-import the full frame-rate list.
 *
 * `SCREEN_SHARE_FRAME_RATES` is the right export for desktop and the wrong one
 * here: Android captures at a fixed 30fps, so the 60 chip it produces is a control
 * that cannot do what it says (§35). The filtered list is one identifier away from
 * the unfiltered one, and swapping them back compiles, renders, and passes every
 * behavioural test — the defect is visible only as a chip that should not be there.
 *
 * Source-level for that reason. Two surfaces offer the tier and both must stay
 * filtered; a new third surface is the case this cannot see, which is why the
 * constant carries the explanation rather than this test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const PICKERS = [
  "VideoSettings.tsx",
  join("voice", "ScreenShareQualitySheet.tsx"),
];

describe.each(PICKERS)("%s", (relative) => {
  const source = readFileSync(join(COMPONENTS, relative), "utf8");
  /** Comments name the banned symbol to explain the ban; they must not trip it. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("offers frame rates through the capture-limited helper", () => {
    expect(code).toMatch(/screenShareFrameRatesUpTo\(ANDROID_SCREEN_CAPTURE_MAX_FPS\)/);
  });

  it("never maps over the unfiltered tier list", () => {
    expect(code).not.toMatch(/SCREEN_SHARE_FRAME_RATES/);
  });
});
