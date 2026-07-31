/**
 * "You are alone in here" — the CLIENT half of the server's alone-idle sweep
 * (`apps/api/src/lib/dm-call-sweeper.ts`, `DEFAULT_ALONE_GRACE_MS`).
 *
 * WHAT THE SERVER DOES: the last person left in a CALL surface — a 1-1 DM call
 * room, or a group-DM voice channel — is force-removed from the SFU three minutes
 * later, and told why through `voice.disconnected` with `reason: "alone"`. A
 * SERVER voice channel is deliberately exempt: sitting alone in one all day is a
 * legitimate thing to do (music, "I'm here"), and the server never touches it.
 *
 * WHAT THIS MODULE DOES: gives the user that same information BEFORE it happens,
 * so a disconnect is never a surprise. It is pure arithmetic over a deadline —
 * no timers, no state, no I/O:
 *
 *  - the engine records a `aloneDeadlineAt` timestamp the moment you become the
 *    only person in an EJECTABLE room (and clears it the instant anyone joins),
 *  - the UI ticks locally against that stable timestamp and renders the warning.
 *
 * Deliberately NOT a countdown the engine ticks: a per-second engine `setState`
 * would push a new snapshot into every store subscriber once a second for three
 * minutes (§27). A stable deadline + a local tick in the one component that
 * displays it costs nothing anywhere else.
 *
 * THE CLIENT NEVER ACTS ON THE DEADLINE. When it elapses the UI switches to
 * "disconnecting…" and waits: the server is the only authority on who leaves a
 * room, and the real ejection lands somewhere in the 3-4 minute range (a 3 minute
 * window checked by a 60s tick). A client that hung up on itself at 3:00 would be
 * inventing a disconnect the server had not decided on yet.
 */

/**
 * How long the server lets the last participant sit alone before ejecting them.
 * MUST mirror `DEFAULT_ALONE_GRACE_MS` in `apps/api/src/lib/dm-call-sweeper.ts`
 * — this is a display of the server's rule, not a second rule.
 */
export const ALONE_GRACE_MS = 3 * 60_000;

/**
 * What KIND of voice surface the engine is currently connected to, mirroring the
 * server's `VoiceRoomKind` (`classifyVoiceRoom`). The client resolves this from
 * data it ALREADY has (the group's `kind`, or a `dmcall:` room), never from a new
 * server contract.
 *
 * - `call`    — a 1-1 DM call room (`dmcall:<callId>`).
 * - `groupDm` — a voice channel of a flat group chat or a DM (`kind` ∈ {group, dm}),
 *               including the voice channel a seamless upgrade pins to a call room.
 * - `server`  — a voice channel of a real server (`kind = "server"`). NEVER warned,
 *               because it is never ejected.
 * - `unknown` — the surface could not be resolved. Treated exactly like `server`:
 *               a warning we are not sure about is worse than no warning at all.
 */
export type VoiceSurfaceKind = "call" | "groupDm" | "server" | "unknown";

/**
 * Is this surface one the server's alone-idle sweep actually acts on?
 *
 * FAIL-SAFE BY CONSTRUCTION: only the two affirmative kinds return true, so a
 * null/undefined surface (not resolved yet), a server channel, and anything we
 * cannot classify all mean "show nothing". Warning someone in a server voice
 * channel that they are about to be disconnected would be a lie — they are not.
 */
export function isAloneEjectableSurface(kind: VoiceSurfaceKind | null | undefined): boolean {
  return kind === "call" || kind === "groupDm";
}

/**
 * The countdown's display phase.
 * - `hidden`     — nothing to show (not alone, not an ejectable surface, no deadline).
 * - `counting`   — alone, with time left: show "alone, leaving in M:SS".
 * - `expiring`   — the window has elapsed; the server's eject is due. Show
 *                  "disconnecting…" and WAIT — never leave on our own.
 */
export type AloneCountdownPhase = "hidden" | "counting" | "expiring";

export interface AloneCountdown {
  phase: AloneCountdownPhase;
  /** Milliseconds left, clamped at 0 — never negative. */
  remainingMs: number;
  /**
   * Whole seconds left, clamped at 0. `ceil` so a fresh 3:00 window reads "3:00"
   * rather than "2:59" and the last visible second is "0:01", not "0:00" (which
   * is what the `expiring` phase says in words instead).
   */
  remainingSeconds: number;
}

const HIDDEN: AloneCountdown = { phase: "hidden", remainingMs: 0, remainingSeconds: 0 };

/**
 * Resolve the countdown for a deadline at a point in time. Pure: the caller owns
 * both the clock and the tick rate.
 *
 * A null deadline is the normal "not alone / not ejectable / not connected" case
 * and yields `hidden` — the engine clears the deadline the instant someone joins,
 * which is exactly what makes the warning vanish immediately (and the window
 * restart from a full 3:00 if they leave again).
 */
export function aloneCountdownAt(deadlineAt: number | null, now: number): AloneCountdown {
  if (deadlineAt === null) return HIDDEN;
  const remainingMs = deadlineAt - now;
  if (remainingMs <= 0) return { phase: "expiring", remainingMs: 0, remainingSeconds: 0 };
  return {
    phase: "counting",
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
  };
}

/**
 * `M:SS` for the countdown label (172 → "2:52"). Negative input is clamped to
 * "0:00" so a late tick can never render "-0:-1".
 */
export function formatAloneCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
