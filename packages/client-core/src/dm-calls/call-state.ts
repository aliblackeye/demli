/**
 * DM-call finite state machine (ADR 0012 §4 / plan Wave 5) — the SHARED, pure,
 * framework-free call lifecycle model that both desktop and mobile consume.
 *
 * It is a THIN layer ABOVE the voice FSM (`@demli/media`), never a clone of
 * it (CLAUDE.md §11): the media engine owns join/leave/mute/reconnect for the
 * LiveKit room; this FSM owns the CALL's signaling lifecycle (ring → active →
 * ended) and which SURFACE the call is presented on. Media never crosses the
 * WebSocket (§10/§35) — this model only tracks control state.
 *
 * Two mirrored lifelines share one state slot:
 *
 *   caller:  idle → outgoing(ringing) → active → ended
 *   callee:  idle → incoming(ringing) → active → ended
 *
 * driven by the `call.invite` / `call.accepted` / `call.ended` / `call.upgraded`
 * events and — for the single-session handoff — a `voice.session_replaced` on the
 * call's own room. On `call.upgraded` the SAME call re-points from a "dm" surface
 * to a "group" voice channel WITHOUT touching media (ADR 0012 §6): the two
 * originals stay on the same LiveKit room, so the FSM never tears media down.
 *
 * This file is a PURE reducer + selectors — no I/O, no timers, no engine, no
 * network. The imperative controller (`call-controller.ts`) drives it and wires
 * the api client, the media engine, and the ring timer around it. Keeping the
 * transitions pure is what makes the acceptance-criteria unit tests trivial.
 */

import type {
  CallEndReason,
  CallId,
  CallMedia,
  ChannelId,
  DmCall,
  DmId,
  Group,
  GroupId,
  User,
} from "@demli/types";

/**
 * The lifecycle phase of the single active call slot (ADR 0012 §4):
 * - `idle`     — no call.
 * - `outgoing` — WE are calling; the callee is ringing (caller only).
 * - `incoming` — SOMEONE is calling us; we are ringing (callee only).
 * - `active`   — accepted; media is (being) established on the call room.
 * - `ended`    — terminal; `endedReason` says why. The UI shows a brief outcome
 *   then calls the controller's `dismiss()` to return to `idle`.
 */
export type CallPhase = "idle" | "outgoing" | "incoming" | "active" | "ended";

/** Which side of the call this client is on — set once at ring time. */
export type CallRole = "caller" | "callee";

/**
 * Where THIS DEVICE's media sits relative to the call's room (ADR 0023 §1).
 *
 * A DM call is two layers, and collapsing them into one is what made "leave"
 * mean "hang up on the other person" and made a desktop resync kick a phone out
 * of a live conversation:
 *
 *   MEMBERSHIP — the `dm_calls` row. "There is a live call here, both of you
 *                belong to it." That is {@link CallPhase}.
 *   SEAT       — the LiveKit room. "Which device is actually in the audio right
 *                now." That is this.
 *
 * - `here`      — media is live on THIS device. The full in-call experience.
 * - `elsewhere` — the account is in the room on ANOTHER device. This device shows
 *                 a compact "you're in this call — bring it here" band and must
 *                 NOT join on its own: LiveKit allows one connection per identity,
 *                 so joining would disconnect the device that is actually talking.
 *                 Taking the seat over is a deliberate user action.
 * - `vacant`    — the account is in no room, but the call row is alive: we left
 *                 and can walk back in until the server's alone-grace elapses.
 *
 * `phase: "active"` holds in all three — the call is one thing, the seat moves.
 */
export type CallSeat = "here" | "elsewhere" | "vacant";

/**
 * What surface the live call is presented on. A fresh 1-1 call is a `dm` surface;
 * after a seamless group upgrade (`call.upgraded`) the SAME call re-points to a
 * `group` voice channel (ADR 0012 §6 — media never moves). The `group` object is
 * present for the two originals (their `call.upgraded` carries the full group) and
 * absent for the freshly-invited third person (whose `call.invite{target:group}`
 * carries only the ids — the UI hydrates the group by `groupId`).
 */
export type CallSurface =
  | { kind: "dm"; dmId: DmId }
  | {
      kind: "group";
      groupId: GroupId;
      voiceChannelId: ChannelId;
      group?: Group;
    };

/**
 * Why a call ended, from the FSM's perspective. A SUPERSET of the wire
 * {@link CallEndReason}: it adds the client-only `"session_replaced"` — this
 * device's call ended because the user joined a voice session elsewhere
 * (single-active-session handoff, ADR 0012 §5). That is not a server `call.ended`
 * reason; it is derived locally from `voice.session_replaced` on the call room.
 */
export type CallEndedReason = CallEndReason | "session_replaced";

/**
 * A SECOND `call.invite` that arrived while the slot was already busy. It is NOT
 * a second call slot — media is never touched for it. It only carries the data a
 * compact "X is calling you" busy banner needs (accept-and-switch / decline).
 * Mirrors the {@link CallAction} `invited` payload.
 */
export interface PendingInvite {
  callId: CallId;
  media: CallMedia;
  caller: User;
  surface: CallSurface;
  /** ISO ring deadline; the controller drops the banner locally once it passes. */
  expiresAt: string;
}

/**
 * The complete, serializable call state a platform store wraps and the UI binds
 * to. One PRIMARY slot: at most one call is tracked at a time. A SECOND invite
 * that arrives while that slot is busy is PARKED in {@link CallState.pendingInvite}
 * (the compact busy banner) instead of being silently dropped.
 */
export interface CallState {
  phase: CallPhase;
  /**
   * Where this device's media sits for the call in {@link CallState.phase}
   * (ADR 0023 §1). Orthogonal to the phase: `active` + `elsewhere` is a perfectly
   * normal, showable state — "you are in this call, on your phone".
   */
  seat: CallSeat;
  /** `caller` | `callee`, or null while idle. Survives into `active`/`ended`. */
  role: CallRole | null;
  callId: CallId | null;
  /**
   * The LiveKit room the media engine is (or will be) joined to
   * (`dmcall:<callId>`). Known for the caller at `outgoing` (from the start
   * response) and for the callee only once accepted (the accept response carries
   * it). Stays constant across a group upgrade — media never moves. Null while
   * idle or while a callee is still ringing.
   */
  roomName: string | null;
  /** Media the call was started with (`audio` | `video`); screen share is in-call. */
  media: CallMedia;
  /** The DM or (post-upgrade) group voice channel this call lives on. */
  surface: CallSurface | null;
  /**
   * The OTHER party. For a callee: the caller (from `call.invite`). For a caller:
   * the callee, known once they answer (`call.accepted`). Null until known (and on
   * a start-409 rejoin, where only ids are available).
   */
  peer: User | null;
  /** ISO ring deadline while ringing (drives the caller's timeout timer); null otherwise. */
  expiresAt: string | null;
  /** Set only while `phase === "ended"`; null otherwise. */
  endedReason: CallEndedReason | null;
  /**
   * True while an async control action (start / accept) is in flight, so the UI
   * can disable the relevant button. Not a phase — a phase is the settled state.
   */
  pending: boolean;
  /**
   * A SECOND `call.invite` parked while this slot is busy (the compact busy
   * banner). Null whenever nothing is waiting. Cleared when: the user acts on it
   * (accept-and-switch / decline), its own ring window elapses, its caller
   * cancels, or the primary call ends.
   */
  pendingInvite: PendingInvite | null;
}

/** The idle, no-call state — also the target of `reset` / `dismiss`. */
export const initialCallState: CallState = {
  phase: "idle",
  seat: "vacant",
  role: null,
  callId: null,
  roomName: null,
  media: "audio",
  surface: null,
  peer: null,
  expiresAt: null,
  endedReason: null,
  pending: false,
  pendingInvite: null,
};

/**
 * The internal transition alphabet driven by the controller. These are NOT wire
 * events — the controller maps `call.*` events + local action outcomes onto them,
 * so the reducer stays free of protocol/engine/network concerns.
 */
export type CallAction =
  /** Caller's `POST /dm-calls` succeeded — we hold the call + its room. */
  | { type: "outgoing_started"; call: DmCall }
  /** `call.invite` arrived (dm OR group-upgrade ring) — we are the callee. */
  | {
      type: "invited";
      callId: CallId;
      media: CallMedia;
      caller: User;
      surface: CallSurface;
      expiresAt: string;
    }
  /** `call.accepted` arrived — the peer answered our outgoing call. */
  | { type: "accepted_by_peer"; callId: CallId; callee: User }
  /** Our own accept succeeded and media joined — we are the callee going active. */
  | { type: "accept_confirmed"; callId: CallId; roomName: string }
  /** `call.upgraded` — re-point the surface to the group voice channel (media stays). */
  | {
      type: "upgraded";
      callId: CallId;
      group: Group;
      voiceChannelId: ChannelId;
    }
  /** Adopt an already-live call from a start-409 (`{ error, call }`) rejoin. */
  | { type: "adopt"; call: DmCall; role: CallRole }
  /** Any terminal outcome (server `call.ended`, local hangup/cancel/decline, eviction). */
  | { type: "ended"; callId: CallId | null; reason: CallEndedReason }
  /**
   * Accept-and-switch (busy banner): the parked invite becomes the ACTIVE call
   * directly. The controller has already ended the previous call and minted +
   * joined the new media, so we skip the `incoming` ring phase entirely — no
   * ring flash, no ringtone during the switch. Carried EXPLICITLY (not read from
   * `state.pendingInvite`) so a racing `call.ended` can't lose it.
   */
  | { type: "promote_active"; invite: PendingInvite; roomName: string }
  /** Drop the parked busy-banner invite (declined / timed out / its caller canceled). */
  | { type: "clear_pending_invite"; callId: CallId }
  /**
   * This device's media seat moved (ADR 0023 §1): we joined the room (`here`),
   * we walked out of it (`vacant`), or the account's seat is on another device
   * (`elsewhere`). Never changes the call's PHASE — the row is untouched.
   */
  | { type: "seat"; seat: CallSeat }
  /** In-flight toggle for async control actions. */
  | { type: "pending"; pending: boolean }
  /** Dismiss an ended call back to idle. */
  | { type: "reset" };

/** Ringing (either direction). */
export function isCallRinging(state: CallState): boolean {
  return state.phase === "outgoing" || state.phase === "incoming";
}

/** Media should be (or is) live. */
export function isCallActive(state: CallState): boolean {
  return state.phase === "active";
}

/** A call is occupying the slot (ringing or active) — a 2nd invite is parked, not dropped. */
export function isCallLive(state: CallState): boolean {
  return state.phase !== "idle" && state.phase !== "ended";
}

/** A second invite is parked (drives the compact busy banner). */
export function hasPendingInvite(state: CallState): boolean {
  return state.pendingInvite !== null;
}

/**
 * Is the call live but its media somewhere OTHER than this device (ADR 0023 §1)?
 * The condition for the compact "you're in this call — bring it here / rejoin"
 * band, and the condition under which this device must never auto-join.
 */
export function isCallSeatedAway(state: CallState): boolean {
  return isCallLive(state) && state.seat !== "here";
}

/** Phase from a persisted call row + our role (used by `adopt`). */
function phaseForAdopt(call: DmCall, role: CallRole): CallPhase {
  if (call.status === "active") return "active";
  if (call.status === "ringing") return role === "caller" ? "outgoing" : "incoming";
  // Any terminal status → nothing to rejoin; treat as ended.
  return "ended";
}

/**
 * The pure DM-call transition function. Unknown or out-of-phase actions return the
 * SAME state reference (so the controller's store skips a no-op notify). Stale
 * events — a `call.ended` / `accepted_by_peer` / `upgraded` whose `callId` is not
 * the current call — are ignored the same way.
 */
export function callReducer(state: CallState, action: CallAction): CallState {
  switch (action.type) {
    case "outgoing_started": {
      const { call } = action;
      // RESYNC RACE (call-UX plan K2.2): the callee can accept — and this client
      // can already have RESYNCED itself to `active` off that accept — while the
      // `POST /dm-calls` response is still in flight. When that late response
      // lands for the SAME call, it must NOT drag a live call back to `outgoing`
      // (the founder's "accepted but never connects": a ringing UI over a room
      // both sides are actually in, ended by the ring timeout). Fill in only what
      // the resync could not know, keep the phase.
      if (state.callId === call.id && (state.phase === "active" || state.phase === "ended")) {
        const roomName = state.roomName ?? call.roomName;
        if (roomName === state.roomName) return state;
        return { ...state, roomName };
      }
      return {
        phase: "outgoing",
        // The room is joined right after this response lands, not before it —
        // the controller reports the seat once the engine is actually in.
        seat: "vacant",
        role: "caller",
        callId: call.id,
        roomName: call.roomName,
        media: call.media,
        surface: { kind: "dm", dmId: call.dmId },
        peer: null,
        expiresAt: call.expiresAt,
        endedReason: null,
        pending: false,
        pendingInvite: null,
      };
    }

    case "invited": {
      const slotFree = state.phase === "idle" || state.phase === "ended";
      if (!slotFree) {
        // A SECOND invite while the slot is busy: PARK it as the busy-banner
        // invite instead of dropping it (so the caller isn't left ringing into a
        // silent timeout). Ignore a duplicate delivery of the current call or of
        // an already-parked invite (same reference → no re-notify).
        if (action.callId === state.callId) return state;
        if (state.pendingInvite?.callId === action.callId) return state;
        return {
          ...state,
          pendingInvite: {
            callId: action.callId,
            media: action.media,
            caller: action.caller,
            surface: action.surface,
            expiresAt: action.expiresAt,
          },
        };
      }
      return {
        phase: "incoming",
        // Ringing is not sitting in a room — the callee has no grant yet.
        seat: "vacant",
        role: "callee",
        callId: action.callId,
        // The callee learns the room only from the accept response.
        roomName: null,
        media: action.media,
        surface: action.surface,
        peer: action.caller,
        expiresAt: action.expiresAt,
        endedReason: null,
        pending: false,
        pendingInvite: null,
      };
    }

    case "accepted_by_peer": {
      // ANSWERED ELSEWHERE. The server now sends this to the callee's own
      // sessions as well, because a user signed in on a phone AND a desktop is
      // the normal case and only the device that pressed Accept used to learn
      // anything: the desktop went on ringing at a call already in progress.
      // Founder: "telefondan gelen bi aramaya cevap verdiğimde pcde hala arama
      // devam ediyormuş gibi gözüküyor".
      //
      // Stop ringing here; the controller's resync then adopts the live call so
      // the other device SHOWS the call rather than merely falling silent —
      // which is the second half of the same report ("pcde aramada olduğum
      // gözükmüyor"). The device that accepted is `pending`/`active` by now and
      // falls through to the guard below, so its own echo changes nothing.
      if (state.phase === "incoming" && state.callId === action.callId) {
        return initialCallState;
      }
      if (state.phase !== "outgoing" || state.callId !== action.callId) return state;
      return {
        ...state,
        phase: "active",
        peer: action.callee,
        expiresAt: null,
        pending: false,
      };
    }

    case "accept_confirmed": {
      if (state.phase !== "incoming" || state.callId !== action.callId) return state;
      return {
        ...state,
        phase: "active",
        // The controller only dispatches this AFTER the engine joined, so the
        // seat is ours by construction.
        seat: "here",
        roomName: action.roomName,
        expiresAt: null,
        pending: false,
      };
    }

    case "upgraded": {
      // Only an ACTIVE call we are actually in can be upgraded.
      if (state.phase !== "active" || state.callId !== action.callId) return state;
      return {
        ...state,
        surface: {
          kind: "group",
          groupId: action.group.id,
          voiceChannelId: action.voiceChannelId,
          group: action.group,
        },
      };
    }

    case "adopt": {
      const { call, role } = action;
      const phase = phaseForAdopt(call, role);
      // Adopting the call we ALREADY track (a start-409 re-tap, or a resync of the
      // very call this slot holds) must not throw away what only the event stream
      // knew: the peer's profile (the accepted/invite payload carries it, the
      // persisted row carries only ids) and a parked busy-banner invite (a resync
      // is about the PRIMARY slot and may never silently drop a second caller).
      const sameCall = state.callId === call.id;
      return {
        phase,
        // Adopting says nothing about MEDIA — the controller settles the seat
        // right after, from the media plane's answer (`inRoom`) plus this
        // device's own engine. Re-adopting the call we already hold must not
        // forget that we are the device in the room.
        seat: sameCall ? state.seat : "vacant",
        role,
        callId: call.id,
        roomName: call.roomName,
        media: call.media,
        surface: { kind: "dm", dmId: call.dmId },
        peer: sameCall ? state.peer : null,
        expiresAt: phase === "outgoing" || phase === "incoming" ? call.expiresAt : null,
        endedReason: null,
        pending: false,
        pendingInvite: sameCall ? state.pendingInvite : null,
      };
    }

    case "promote_active": {
      // The parked invite becomes the ACTIVE call directly (media already joined
      // by the controller) — its callId/surface/peer/room replace the primary
      // slot with no intermediate incoming ring. Carried in the action, so a
      // racing `call.ended` from tearing the previous call down cannot lose it.
      const { invite, roomName } = action;
      return {
        phase: "active",
        // Media was joined before this action was dispatched (that is the point
        // of promoting straight to `active`), so the seat is here.
        seat: "here",
        role: "callee",
        callId: invite.callId,
        roomName,
        media: invite.media,
        surface: invite.surface,
        peer: invite.caller,
        expiresAt: null,
        endedReason: null,
        pending: false,
        pendingInvite: null,
      };
    }

    case "clear_pending_invite": {
      // Drop the parked invite only if it is still the one referenced (a newer
      // parked invite or an already-cleared slot is left untouched → same ref).
      if (state.pendingInvite === null || state.pendingInvite.callId !== action.callId) {
        return state;
      }
      return { ...state, pendingInvite: null };
    }

    case "ended": {
      if (state.phase === "idle" || state.phase === "ended") return state;
      // Ignore a terminal for some OTHER call (a null callId is a local force-end).
      if (action.callId !== null && action.callId !== state.callId) return state;
      // The primary call ending also clears any parked busy-banner invite.
      return {
        ...state,
        phase: "ended",
        // A call that is over has no seat anywhere, on any device.
        seat: "vacant",
        endedReason: action.reason,
        expiresAt: null,
        pending: false,
        pendingInvite: null,
      };
    }

    case "seat": {
      // Nothing to seat when no call occupies the slot — and an `ended` slot must
      // not be dragged back into looking live by a late media notification.
      if (state.phase === "idle" || state.phase === "ended") return state;
      if (state.seat === action.seat) return state;
      return { ...state, seat: action.seat };
    }

    case "pending": {
      if (state.pending === action.pending) return state;
      return { ...state, pending: action.pending };
    }

    case "reset":
      return state.phase === "idle" ? state : { ...initialCallState };

    default: {
      // Exhaustiveness guard — a new action type must be handled above.
      const _never: never = action;
      return _never;
    }
  }
}

/**
 * User-facing outcome text for an ended call (CLAUDE.md §26) — the UI renders
 * these, never a raw reason string. Role-aware where it matters: the caller sees
 * "Declined", the callee that was rung-out sees "Missed call", etc.
 */
export function callEndedMessage(reason: CallEndedReason, role: CallRole | null): string {
  switch (reason) {
    case "declined":
      return "Call declined";
    case "canceled":
      return role === "callee" ? "Missed call" : "Call canceled";
    case "timeout":
      return role === "caller" ? "No answer" : "Missed call";
    case "hung_up":
      return "Call ended";
    case "busy":
      return "User is busy";
    case "failed":
      return "Call failed";
    case "upgraded":
      return "Moved to a group call";
    case "session_replaced":
      return "You joined a call on another device";
    default: {
      // Exhaustiveness guard — a new reason must be handled above.
      const _never: never = reason;
      return _never;
    }
  }
}
