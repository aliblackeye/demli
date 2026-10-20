/**
 * The stage bar's mic button must tell a screen reader when you are muted
 * (pre-release a11y audit). The Koyu Masa rewrite drew "muted" through the
 * danger VARIANT and dropped `active={!micEnabled}`, so the button was always
 * announced as not-selected — muted and live sounded identical.
 *
 * `selected` restores the announcement without changing the look (`active` on
 * the danger variant would draw it solid pink instead of the wash).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { iconButtonAccessibilityState } from "../ui/kit-math";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("stage bar mic announces muted", () => {
  it("passes the muted state to the button's accessibility state", () => {
    const code = readFileSync(join(HERE, "StageControlBar.tsx"), "utf8");
    const start = code.indexOf("icon={micEnabled ? Mic : MicOff}");
    expect(start).toBeGreaterThan(-1);
    const mic = code.slice(start, code.indexOf("/>", start));
    expect(mic).toMatch(/selected=\{!micEnabled\}|active=\{!micEnabled\}/);
  });

  it("selected overrides the drawn state for the announcement", () => {
    expect(iconButtonAccessibilityState(false, false, true)).toEqual({ selected: true });
    expect(iconButtonAccessibilityState(false, false, false)).toEqual({ selected: false });
    // Default: announced exactly as drawn.
    expect(iconButtonAccessibilityState(false, true)).toEqual({ selected: true });
    expect(iconButtonAccessibilityState(true, true)).toEqual({ checked: true });
    expect(iconButtonAccessibilityState(true, false, true)).toEqual({ checked: true });
  });
});
