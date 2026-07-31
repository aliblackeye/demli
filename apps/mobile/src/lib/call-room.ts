/**
 * DM-call LiveKit room helpers (ADR 0012 §2). A DM call runs in an EPHEMERAL
 * LiveKit room named `dmcall:<callId>` — never a `channels` row. The prefix lets
 * the rest of the app tell a call room apart from an ordinary voice-channel room
 * (whose room string is the channel id): the generic voice bar hides for it, and
 * the gateway occupancy announcer never announces it as a channel (§10/§35).
 *
 * Standalone (imports nothing) so both the realtime layer and UI can share the
 * literal without a circular import.
 */

/** The room-name prefix for every DM-call LiveKit room (`dmcall:<callId>`). */
export const DM_CALL_ROOM_PREFIX = "dmcall:";

/** True when a LiveKit room string is a DM-call room, not a voice-channel room. */
export function isDmCallRoom(roomId: string | null | undefined): boolean {
  return !!roomId && roomId.startsWith(DM_CALL_ROOM_PREFIX);
}
