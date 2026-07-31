/**
 * The pure half of the alone-idle warning: surface eligibility + countdown math.
 *
 * The eligibility test is the load-bearing one. The server NEVER ejects anyone
 * from a SERVER voice channel however long they sit there alone, so a countdown
 * shown in one would be telling the user something false about their own app.
 */

import { describe, expect, it } from "vitest";
import {
  ALONE_GRACE_MS,
  aloneCountdownAt,
  formatAloneCountdown,
  isAloneEjectableSurface,
  type VoiceSurfaceKind,
} from "../alone-watch.js";
import { voiceEndedReasonFromEvent } from "../state.js";

describe("isAloneEjectableSurface", () => {
  it("is TRUE only for the two surfaces the server actually sweeps", () => {
    expect(isAloneEjectableSurface("call")).toBe(true);
    expect(isAloneEjectableSurface("groupDm")).toBe(true);
  });

  it("is FALSE for a server voice channel — sitting alone there is legitimate", () => {
    expect(isAloneEjectableSurface("server")).toBe(false);
  });

  it("fails safe for every non-answer (unknown / unresolved)", () => {
    // A surface we could not classify, and one that has not been resolved yet,
    // both mean "show nothing" — an uncertain warning is worse than no warning.
    expect(isAloneEjectableSurface("unknown")).toBe(false);
    expect(isAloneEjectableSurface(null)).toBe(false);
    expect(isAloneEjectableSurface(undefined)).toBe(false);
  });

  it("never returns true for a kind outside the affirmative pair", () => {
    // Guards the fail-safe shape itself: if a new VoiceSurfaceKind is added, it
    // is excluded until someone deliberately opts it in here.
    const kinds: VoiceSurfaceKind[] = ["call", "groupDm", "server", "unknown"];
    const ejectable = kinds.filter(isAloneEjectableSurface);
    expect(ejectable).toEqual(["call", "groupDm"]);
  });
});

describe("aloneCountdownAt", () => {
  it("hides when there is no deadline (not alone / not ejectable / not connected)", () => {
    expect(aloneCountdownAt(null, 1_000)).toEqual({
      phase: "hidden",
      remainingMs: 0,
      remainingSeconds: 0,
    });
  });

  it("counts down from a full window and rounds seconds UP", () => {
    const now = 1_000_000;
    const fresh = aloneCountdownAt(now + ALONE_GRACE_MS, now);
    expect(fresh.phase).toBe("counting");
    expect(fresh.remainingMs).toBe(ALONE_GRACE_MS);
    expect(fresh.remainingSeconds).toBe(180); // reads "3:00", not "2:59"

    // Mid-window, with a fractional second left over.
    const mid = aloneCountdownAt(now + 8_400, now);
    expect(mid.phase).toBe("counting");
    expect(mid.remainingSeconds).toBe(9); // ceil(8.4)
  });

  it("shows the last visible second as 0:01, never 0:00", () => {
    const now = 5_000;
    expect(aloneCountdownAt(now + 1, now).remainingSeconds).toBe(1);
  });

  it("switches to `expiring` at zero and clamps — never negative", () => {
    const now = 10_000;
    expect(aloneCountdownAt(now, now)).toEqual({
      phase: "expiring",
      remainingMs: 0,
      remainingSeconds: 0,
    });
    // Well past the deadline (the server ejects on a 60s tick, so this is the
    // normal 3-4 minute window) — still clamped, still just "expiring".
    expect(aloneCountdownAt(now - 45_000, now)).toEqual({
      phase: "expiring",
      remainingMs: 0,
      remainingSeconds: 0,
    });
  });
});

describe("voiceEndedReasonFromEvent", () => {
  it("maps the server's `alone` reason to the engine's ended reason", () => {
    expect(voiceEndedReasonFromEvent("alone")).toBe("alone");
  });

  it("returns null for every reason this client does not handle", () => {
    // `moderator` belongs to the moderation surface, and a newer server will send
    // reasons this build has never heard of. Both must fall through to the
    // existing behavior rather than be coerced into the nearest known reason.
    expect(voiceEndedReasonFromEvent("moderator")).toBeNull();
    expect(voiceEndedReasonFromEvent("some_future_reason")).toBeNull();
    expect(voiceEndedReasonFromEvent("")).toBeNull();
  });
});

describe("formatAloneCountdown", () => {
  it("renders M:SS with a zero-padded seconds field", () => {
    expect(formatAloneCountdown(180)).toBe("3:00");
    expect(formatAloneCountdown(172)).toBe("2:52");
    expect(formatAloneCountdown(61)).toBe("1:01");
    expect(formatAloneCountdown(9)).toBe("0:09");
  });

  it("clamps garbage instead of rendering '-0:-1'", () => {
    expect(formatAloneCountdown(0)).toBe("0:00");
    expect(formatAloneCountdown(-30)).toBe("0:00");
  });
});
