/**
 * Copy for the non-error ways a voice session ends, plus the alone countdown line.
 *
 * The forward-compatibility case is the point: a server that learns a new
 * disconnect reason before this build does must still produce a sentence, not a
 * blank toast or a raw enum value.
 */

import { describe, expect, it } from "vitest";
import type { VoiceEndedReason } from "@demli/media";
import { aloneCountdownLabel, localizeVoiceEnded } from "./voice-notices";
import type { AppTFunction } from "./i18n";

/** Echoes the key (+ interpolations) so assertions read as key expectations. */
const t = ((key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}|${JSON.stringify(vars)}` : key) as unknown as AppTFunction;

describe("localizeVoiceEnded", () => {
  it("says nothing when nothing ended", () => {
    expect(localizeVoiceEnded(null, t)).toBeNull();
  });

  it("uses the alone copy for an alone-idle close", () => {
    expect(localizeVoiceEnded("alone", t)).toBe("desktop:voice.endedAlone");
  });

  it("uses the handoff copy for a single-session replacement", () => {
    expect(localizeVoiceEnded("session_replaced", t)).toBe("desktop:voice.sessionReplaced");
  });

  it("says the user was removed, never that they joined elsewhere, after a moderator removal", () => {
    expect(localizeVoiceEnded("moderator", t)).toBe("desktop:voice.endedModerator");
  });

  it("falls back to the existing generic copy for an UNKNOWN reason", () => {
    // A newer server (or a newer engine) may name a reason this build has never
    // seen. It must not blank the notice or leak the enum value.
    const future = "some_future_reason" as VoiceEndedReason;
    expect(localizeVoiceEnded(future, t)).toBe("desktop:voice.sessionReplaced");
  });
});

describe("aloneCountdownLabel", () => {
  it("renders nothing while hidden", () => {
    expect(
      aloneCountdownLabel({ phase: "hidden", remainingMs: 0, remainingSeconds: 0 }, t),
    ).toBeNull();
  });

  it("renders the remaining time as M:SS while counting", () => {
    expect(
      aloneCountdownLabel({ phase: "counting", remainingMs: 172_000, remainingSeconds: 172 }, t),
    ).toBe('desktop:voice.aloneCountdown|{"time":"2:52"}');
  });

  it("switches to the closing wording at zero — never '0:00' forever", () => {
    expect(
      aloneCountdownLabel({ phase: "expiring", remainingMs: 0, remainingSeconds: 0 }, t),
    ).toBe("desktop:voice.aloneExpiring");
  });
});
