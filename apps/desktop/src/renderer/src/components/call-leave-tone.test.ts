/**
 * Leaving a call is ONE action with ONE look, on every surface.
 *
 * CallControls defines `off` as "something you normally have is cut" (mic
 * muted, deafened) and `leave` as the only solid pink fill. The sidebar voice
 * panel and the DM call dock used `off` for disconnect / hang-up / cancel, so a
 * muted-mic cell and the leave circle were the same pink wash, while the very
 * same action was solid pink on the pill, the stage bar and the banners (M16
 * audit; design doc §1.5: hang-up / leave-room controls are solid pink).
 *
 * This walks every <CallControl> on the call surfaces and requires each control
 * that ends your presence — the PhoneOff / LogOut glyphs — to use tone="leave",
 * and no state toggle to borrow it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SURFACES = [
  "VoicePanel.tsx",
  "CallDock.tsx",
  "CallPill.tsx",
  "StageControlBar.tsx",
  "CallLayer.tsx",
  "IncomingCallDialog.tsx",
] as const;

function controls(file: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
  // A <CallControl …/> element spans from its opening tag to the first `/>`.
  return [...source.matchAll(/<CallControl\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

/** The glyphs that mean "end my presence in this call". */
const ENDS_PRESENCE = /icon=\{(?:[^}]*\b(?:PhoneOff|LogOut)\b[^}]*)\}/;

describe("leave / hang-up controls use the leave tone everywhere", () => {
  it.each(SURFACES)("%s", (file) => {
    const all = controls(file);
    expect(all.length, `${file} renders no CallControl — did the surface move?`).toBeGreaterThan(0);
    const ends = all.filter((c) => ENDS_PRESENCE.test(c));
    for (const control of ends) {
      expect(control, `${file}: a leave/hang-up control must be tone="leave"`).toMatch(/tone="leave"/);
    }
    for (const control of all.filter((c) => !ENDS_PRESENCE.test(c))) {
      expect(control, `${file}: only a leave/hang-up control may use the leave tone`).not.toMatch(
        /tone="leave"/,
      );
    }
  });

  it("the sidebar card and the DM dock both carry a leave control", () => {
    // Guards against passing the rule above by deleting the control.
    expect(controls("VoicePanel.tsx").filter((c) => ENDS_PRESENCE.test(c))).toHaveLength(1);
    expect(controls("CallDock.tsx").filter((c) => ENDS_PRESENCE.test(c))).toHaveLength(2);
  });
});
