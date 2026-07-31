/**
 * Source-level invariants for the mobile SEAT model (ADR 0023 / call-as-room W4).
 *
 * WHY a source test: the seat model itself lives in `@demli/client-core` and is
 * covered there behaviourally. What no test there can see is THIS app calling the
 * WRONG METHOD — and that is not hypothetical, it is the bug this wave fixes:
 * mobile's Leave button called `hangup()`, which ends the call for everyone, while
 * the founder's model is "mobilde ayrıl butonuna basıp ayrılıp bu süre içerisinde
 * masaüstünden o call'a katılabilmeliyim". Both methods exist on the same
 * controller, both return `Promise<void>`, and calling the wrong one type-checks
 * perfectly and fails silently — for the peer, not for the person pressing it.
 *
 * The same is true of the seat GATE: rendering `InCallView` at `seat !== "here"`
 * compiles fine and produces a call screen with no media and dead controls, which
 * is what the user saw after a handoff. Nothing but a wiring assertion catches a
 * gate that is simply deleted.
 *
 * vitest here is node-only "pure logic" by policy (there is no RN harness that
 * could import these modules), so these seams are pinned as source invariants.
 * Each assertion below was verified to go RED under the mutation it describes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(import.meta.url); // …/src/components/call/<this file>
const MOBILE = join(HERE, "..", "..", "..", ".."); // …/apps/mobile
const REPO = join(MOBILE, "..", ".."); // repo root

function read(...segments: string[]): string {
  return readFileSync(join(...segments), "utf8");
}

const IN_CALL = read(MOBILE, "src/components/call/InCallView.tsx");
const SEAT_AWAY = read(MOBILE, "src/components/call/SeatAwayView.tsx");
const MINI_BAR = read(MOBILE, "src/components/call/CallMiniBar.tsx");
const CALL_SCREEN = read(MOBILE, "app/(app)/call.tsx");

/** Just the `call` branch of a catalog — the only part these invariants read. */
interface CallCatalog {
  call: Record<string, string>;
}

const I18N = join(REPO, "packages/i18n/src/locales");
const MOBILE_TR = JSON.parse(read(I18N, "tr/mobile.json")) as CallCatalog;
const MOBILE_EN = JSON.parse(read(I18N, "en/mobile.json")) as CallCatalog;
const DESKTOP_TR = JSON.parse(read(I18N, "tr/desktop.json")) as CallCatalog;
const DESKTOP_EN = JSON.parse(read(I18N, "en/desktop.json")) as CallCatalog;

/** The body of a `const <name> = () => { … }` arrow, for precise assertions. */
function arrowBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = () => {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  expect(end, `${name} body not closed at top level`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("mobile seat model — Leave ≠ Hang up (ADR 0023 §2)", () => {
  it("the in-call Leave button releases the SEAT, it does not end the call", () => {
    const endCall = arrowBody(IN_CALL, "endCall");
    // The whole wave in one assertion: leaving a room is not hanging up on the
    // other person. `hangup()` here is the regression — it closes the row, sends
    // the peer `call.ended`, and destroys the rejoin window the founder asked for.
    expect(endCall).toContain("controller.leaveRoom()");
    expect(endCall).not.toContain("controller.hangup()");
    // Ringing has no room to walk out of yet — that stays a cancel.
    expect(endCall).toContain("controller.cancel()");
  });

  it("does not decide last-one-out for itself — that lives in the controller", () => {
    // `leaveRoom()` already falls through to a real hang-up when nobody is left
    // behind. A second copy of that rule here is how the platforms drift on who
    // closes the row (and it needs remote-participant state this view lacks).
    expect(IN_CALL).not.toContain("getRemoteParticipantCount");
    expect(IN_CALL).not.toContain(".hangup()");
  });

  it("labels the button by what it DOES", () => {
    // "Hang up" over an action that no longer hangs up is the same lie as the
    // wrong method, just visible.
    expect(IN_CALL).toContain('t("mobile:call.leaveRoom")');
  });
});

describe("mobile seat model — the seat-away band (ADR 0023 §1, §3)", () => {
  it("gates the live-media surface on the seat being HERE", () => {
    // Without this gate an `elsewhere`/`vacant` call renders the full stage over a
    // room this device is not in: no audio, every control dead, no explanation.
    expect(CALL_SCREEN).toContain('state.seat !== "here"');
    expect(CALL_SCREEN).toContain("<SeatAwayView");
    // The gate must come BEFORE the InCallView return, or it never runs.
    expect(CALL_SCREEN.indexOf('state.seat !== "here"')).toBeLessThan(
      CALL_SCREEN.indexOf("<InCallView"),
    );
  });

  it("only the deliberate user action takes the seat — never an auto-join", () => {
    // LiveKit allows one connection per identity, so joining on our own would
    // disconnect whichever device is actually talking (ADR 0023 §3).
    expect(SEAT_AWAY).toContain("joinHere()");
    expect(SEAT_AWAY).not.toContain("useEffect");
    // Ending the call for everyone stays reachable from the band.
    expect(SEAT_AWAY).toContain("hangup()");
  });

  it("distinguishes elsewhere from vacant — they are different situations", () => {
    // "You're on this call on another device" and "You left the call" must not
    // collapse into one message: only one of them costs the other device its audio.
    expect(SEAT_AWAY).toContain('state.seat === "elsewhere"');
    expect(SEAT_AWAY).toContain("mobile:call.seatElsewhere");
    expect(SEAT_AWAY).toContain("mobile:call.seatVacant");
    expect(SEAT_AWAY).toContain("mobile:call.bringHere");
    expect(SEAT_AWAY).toContain("mobile:call.rejoin");
  });

  it("the global mini bar reports the seat, not just the phase", () => {
    // It is the ONLY surface showing a seat-away call while the user is off the
    // /call route — saying "In call" there is a lie about this phone, and without
    // its rejoin action the founder's scenario has no entry point from the app.
    expect(MINI_BAR).toContain('state.seat === "here"');
    expect(MINI_BAR).toContain("mobile:call.seatElsewhere");
    expect(MINI_BAR).toContain("mobile:call.seatVacant");
    expect(MINI_BAR).toContain("joinHere()");
  });
});

describe("mobile seat model — one voice with desktop (packages/i18n)", () => {
  // The user is looking at BOTH devices in this exact state, so the two platforms
  // explaining it with different words is a product bug, not a copy nit. Mobile
  // reuses desktop's wording verbatim rather than inventing its own.
  const SHARED = [
    "leaveRoom",
    "seatElsewhere",
    "seatElsewhereHint",
    "seatVacant",
    "seatVacantHint",
    "bringHere",
    "rejoin",
  ] as const;

  it.each(SHARED)("mobile:call.%s matches desktop:call.* in TR and EN", (key) => {
    expect(MOBILE_TR.call[key], `tr/mobile.json call.${key} missing`).toBeTruthy();
    expect(MOBILE_EN.call[key], `en/mobile.json call.${key} missing`).toBeTruthy();
    expect(MOBILE_TR.call[key]).toBe(DESKTOP_TR.call[key]);
    expect(MOBILE_EN.call[key]).toBe(DESKTOP_EN.call[key]);
  });
});
