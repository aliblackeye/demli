/**
 * Mobile copy for the non-error ways a voice session ends, plus the alone
 * countdown line. Twin of the desktop `voice-notices.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { VoiceEndedReason } from "@demli/media";
import type { AppTFunction } from "@/lib/i18n";
import { aloneCountdownLabel, localizeVoiceEnded } from "./voice-ended";

/** Echoes the key (+ interpolations) so assertions read as key expectations. */
const t = ((key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}|${JSON.stringify(vars)}` : key) as unknown as AppTFunction;

describe("localizeVoiceEnded", () => {
  it("says nothing when nothing ended", () => {
    expect(localizeVoiceEnded(null, t)).toBeNull();
  });

  it("uses the alone copy for an alone-idle close", () => {
    expect(localizeVoiceEnded("alone", t)).toBe("mobile:voice.endedAlone");
  });

  it("uses the handoff copy for a single-session replacement", () => {
    expect(localizeVoiceEnded("session_replaced", t)).toBe("mobile:voice.sessionReplaced");
  });

  it("falls back to the existing generic copy for an UNKNOWN reason", () => {
    const future = "some_future_reason" as VoiceEndedReason;
    expect(localizeVoiceEnded(future, t)).toBe("mobile:voice.sessionReplaced");
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
    ).toBe('mobile:voice.aloneCountdown|{"time":"2:52"}');
  });

  it("switches to the closing wording at zero", () => {
    expect(
      aloneCountdownLabel({ phase: "expiring", remainingMs: 0, remainingSeconds: 0 }, t),
    ).toBe("mobile:voice.aloneExpiring");
  });
});
