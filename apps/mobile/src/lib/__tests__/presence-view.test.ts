/**
 * Self-presence previews. The bug this pins: the settings identity card, the
 * custom-status preview and your own profile card were hard-coded "online", so
 * a user on Do Not Disturb or Invisible saw a green dot in "how others see you".
 */
import { describe, expect, it } from "vitest";
import { SELECTABLE_PRESENCE_STATUSES } from "@demli/types";
import { presenceAsOthersSeeIt } from "../presence-view";

describe("presenceAsOthersSeeIt", () => {
  it("invisible is seen as offline", () => {
    expect(presenceAsOthersSeeIt("invisible")).toBe("offline");
  });

  it("every other choice is seen as itself — never forced to online", () => {
    expect(presenceAsOthersSeeIt("dnd")).toBe("dnd");
    expect(presenceAsOthersSeeIt("idle")).toBe("idle");
    expect(presenceAsOthersSeeIt("online")).toBe("online");
  });

  it("covers every selectable status", () => {
    for (const s of SELECTABLE_PRESENCE_STATUSES) {
      expect(presenceAsOthersSeeIt(s)).toBe(s === "invisible" ? "offline" : s);
    }
  });
});
