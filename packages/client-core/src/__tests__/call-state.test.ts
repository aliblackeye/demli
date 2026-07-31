import { describe, expect, it } from "vitest";
import type { DmCall, Group, User } from "@demli/types";
import {
  callEndedMessage,
  callReducer,
  initialCallState,
  isCallActive,
  isCallLive,
  isCallRinging,
  type CallState,
} from "../dm-calls/call-state.js";

// --- fixtures ---------------------------------------------------------------

function user(id: string): User {
  return {
    id,
    username: id,
    displayName: id,
    avatarUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function dmCall(overrides: Partial<DmCall> = {}): DmCall {
  return {
    id: "call-1",
    dmId: "dm-1",
    roomName: "dmcall:call-1",
    callerId: "me",
    calleeId: "friend",
    media: "audio",
    status: "ringing",
    upgradedToGroupId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:00:30.000Z",
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function group(id = "grp-1"): Group {
  return {
    id,
    name: "Group",
    iconUrl: null,
    ownerId: "me",
    streamId: "stream-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Reduce a sequence of actions from the idle state. */
function reduce(...actions: Parameters<typeof callReducer>[1][]): CallState {
  return actions.reduce((s, a) => callReducer(s, a), initialCallState);
}

// --- ringing ----------------------------------------------------------------

describe("callReducer — ringing", () => {
  it("outgoing_started puts the caller into outgoing(ringing)", () => {
    const state = reduce({ type: "outgoing_started", call: dmCall() });
    expect(state.phase).toBe("outgoing");
    expect(state.role).toBe("caller");
    expect(state.callId).toBe("call-1");
    expect(state.roomName).toBe("dmcall:call-1");
    expect(state.media).toBe("audio");
    expect(state.surface).toEqual({ kind: "dm", dmId: "dm-1" });
    expect(state.expiresAt).toBe("2026-01-01T00:00:30.000Z");
    expect(state.peer).toBeNull();
    expect(isCallRinging(state)).toBe(true);
    expect(isCallLive(state)).toBe(true);
  });

  it("invited puts the callee into incoming(ringing) with the hydrated caller", () => {
    const caller = user("friend");
    const state = reduce({
      type: "invited",
      callId: "call-9",
      media: "video",
      caller,
      surface: { kind: "dm", dmId: "dm-1" },
      expiresAt: "2026-01-01T00:00:30.000Z",
    });
    expect(state.phase).toBe("incoming");
    expect(state.role).toBe("callee");
    expect(state.callId).toBe("call-9");
    expect(state.media).toBe("video");
    expect(state.peer).toBe(caller);
    expect(state.roomName).toBeNull(); // the callee learns the room only on accept
  });

  it("parks a second invite as pendingInvite while a call is already live", () => {
    const active = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
    );
    const next = callReducer(active, {
      type: "invited",
      callId: "call-2",
      media: "video",
      caller: user("other"),
      surface: { kind: "dm", dmId: "dm-2" },
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    // Primary slot is untouched — only the busy banner is parked.
    expect(next.phase).toBe("active");
    expect(next.callId).toBe("call-1");
    expect(next.pendingInvite).toEqual({
      callId: "call-2",
      media: "video",
      caller: user("other"),
      surface: { kind: "dm", dmId: "dm-2" },
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
  });
});

// --- busy banner (second concurrent invite) ---------------------------------

describe("callReducer — busy banner (pendingInvite)", () => {
  const parkedInvite = {
    callId: "call-2",
    media: "audio" as const,
    caller: user("other"),
    surface: { kind: "dm" as const, dmId: "dm-2" },
    expiresAt: "2026-01-01T00:01:00.000Z",
  };

  /** An active call with a second invite already parked. */
  function activeWithParked(): CallState {
    return reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "invited", ...parkedInvite },
    );
  }

  it("ignores a duplicate delivery of the already-parked invite (same reference)", () => {
    const state = activeWithParked();
    const next = callReducer(state, { type: "invited", ...parkedInvite });
    expect(next).toBe(state);
  });

  it("ignores a second invite that duplicates the current call id (same reference)", () => {
    const active = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
    );
    const next = callReducer(active, {
      type: "invited",
      callId: "call-1", // same as the live call
      media: "audio",
      caller: user("friend"),
      surface: { kind: "dm", dmId: "dm-1" },
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    expect(next).toBe(active);
  });

  it("clear_pending_invite drops the parked invite (matching id)", () => {
    const state = activeWithParked();
    const next = callReducer(state, { type: "clear_pending_invite", callId: "call-2" });
    expect(next.pendingInvite).toBeNull();
    expect(next.phase).toBe("active"); // primary call untouched
  });

  it("clear_pending_invite for a different id is a no-op (same reference)", () => {
    const state = activeWithParked();
    const next = callReducer(state, { type: "clear_pending_invite", callId: "other" });
    expect(next).toBe(state);
  });

  it("promote_active turns the parked invite into the ACTIVE call (no ring phase)", () => {
    const state = activeWithParked();
    const next = callReducer(state, {
      type: "promote_active",
      invite: parkedInvite,
      roomName: "dmcall:call-2",
    });
    expect(next.phase).toBe("active"); // straight to active — no incoming flash
    expect(next.role).toBe("callee");
    expect(next.callId).toBe("call-2");
    expect(next.roomName).toBe("dmcall:call-2");
    expect(next.peer).toEqual(user("other"));
    expect(next.surface).toEqual({ kind: "dm", dmId: "dm-2" });
    expect(next.pendingInvite).toBeNull();
  });

  it("ending the primary call also clears the parked invite", () => {
    const state = activeWithParked();
    const next = callReducer(state, { type: "ended", callId: "call-1", reason: "hung_up" });
    expect(next.phase).toBe("ended");
    expect(next.pendingInvite).toBeNull();
  });

  it("rings normally (no parking) when the slot is free", () => {
    const state = reduce({
      type: "invited",
      callId: "call-9",
      media: "audio",
      caller: user("friend"),
      surface: { kind: "dm", dmId: "dm-9" },
      expiresAt: "2026-01-01T00:00:30.000Z",
    });
    expect(state.phase).toBe("incoming");
    expect(state.pendingInvite).toBeNull();
  });
});

// --- accept -----------------------------------------------------------------

describe("callReducer — accept → active", () => {
  it("accepted_by_peer moves the caller from outgoing to active and sets the peer", () => {
    const callee = user("friend");
    const state = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee },
    );
    expect(state.phase).toBe("active");
    expect(state.peer).toBe(callee);
    expect(state.expiresAt).toBeNull();
    expect(isCallActive(state)).toBe(true);
  });

  it("accept_confirmed moves the callee from incoming to active and records the room", () => {
    const state = reduce(
      {
        type: "invited",
        callId: "call-1",
        media: "audio",
        caller: user("friend"),
        surface: { kind: "dm", dmId: "dm-1" },
        expiresAt: "2026-01-01T00:00:30.000Z",
      },
      { type: "accept_confirmed", callId: "call-1", roomName: "dmcall:call-1" },
    );
    expect(state.phase).toBe("active");
    expect(state.roomName).toBe("dmcall:call-1");
    expect(state.expiresAt).toBeNull();
  });

  it("ignores accepted_by_peer for a different call (stale)", () => {
    const outgoing = reduce({ type: "outgoing_started", call: dmCall() });
    const next = callReducer(outgoing, {
      type: "accepted_by_peer",
      callId: "some-other-call",
      callee: user("x"),
    });
    expect(next).toBe(outgoing);
  });
});

// --- terminal (decline / cancel / timeout / hangup) -------------------------

describe("callReducer — terminal transitions", () => {
  it("ended(canceled) closes an outgoing ring", () => {
    const state = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "ended", callId: "call-1", reason: "canceled" },
    );
    expect(state.phase).toBe("ended");
    expect(state.endedReason).toBe("canceled");
    expect(state.expiresAt).toBeNull();
    // The peer/surface are kept so the outcome screen can render.
    expect(state.callId).toBe("call-1");
  });

  it("ended(declined) closes an incoming ring", () => {
    const state = reduce(
      {
        type: "invited",
        callId: "call-1",
        media: "audio",
        caller: user("friend"),
        surface: { kind: "dm", dmId: "dm-1" },
        expiresAt: "2026-01-01T00:00:30.000Z",
      },
      { type: "ended", callId: "call-1", reason: "declined" },
    );
    expect(state.phase).toBe("ended");
    expect(state.endedReason).toBe("declined");
  });

  it("ended(timeout) closes the call", () => {
    const state = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "ended", callId: "call-1", reason: "timeout" },
    );
    expect(state.phase).toBe("ended");
    expect(state.endedReason).toBe("timeout");
  });

  it("ended(session_replaced) is a clean terminal (single-session eviction)", () => {
    const state = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "ended", callId: "call-1", reason: "session_replaced" },
    );
    expect(state.phase).toBe("ended");
    expect(state.endedReason).toBe("session_replaced");
  });

  it("ignores an ended for a different call (same reference)", () => {
    const active = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
    );
    const next = callReducer(active, { type: "ended", callId: "other", reason: "hung_up" });
    expect(next).toBe(active);
  });

  it("ignores an ended while idle (same reference)", () => {
    const next = callReducer(initialCallState, {
      type: "ended",
      callId: "call-1",
      reason: "hung_up",
    });
    expect(next).toBe(initialCallState);
  });
});

// --- upgrade ----------------------------------------------------------------

describe("callReducer — group upgrade", () => {
  it("upgraded re-points an active call to the group voice channel, staying active", () => {
    const g = group("grp-7");
    const state = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "upgraded", callId: "call-1", group: g, voiceChannelId: "vc-1" },
    );
    expect(state.phase).toBe("active"); // still active — media never moves
    expect(state.roomName).toBe("dmcall:call-1"); // room unchanged (§6)
    expect(state.surface).toEqual({
      kind: "group",
      groupId: "grp-7",
      voiceChannelId: "vc-1",
      group: g,
    });
  });

  it("ignores upgraded while merely ringing (not yet active)", () => {
    const outgoing = reduce({ type: "outgoing_started", call: dmCall() });
    const next = callReducer(outgoing, {
      type: "upgraded",
      callId: "call-1",
      group: group(),
      voiceChannelId: "vc-1",
    });
    expect(next).toBe(outgoing);
  });
});

// --- adopt / reset / pending ------------------------------------------------

describe("callReducer — adopt / reset / pending", () => {
  it("adopts a live ringing call as outgoing when we are the caller", () => {
    const state = reduce({
      type: "adopt",
      call: dmCall({ status: "ringing", callerId: "me" }),
      role: "caller",
    });
    expect(state.phase).toBe("outgoing");
    expect(state.role).toBe("caller");
  });

  it("adopts a live active call as active", () => {
    const state = reduce({
      type: "adopt",
      call: dmCall({ status: "active", startedAt: "2026-01-01T00:00:10.000Z" }),
      role: "caller",
    });
    expect(state.phase).toBe("active");
    expect(state.expiresAt).toBeNull();
  });

  it("reset returns to idle from an ended call", () => {
    const ended = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "ended", callId: "call-1", reason: "canceled" },
    );
    const idle = callReducer(ended, { type: "reset" });
    expect(idle).toEqual(initialCallState);
    expect(isCallLive(idle)).toBe(false);
  });

  it("toggles the pending flag without changing the phase", () => {
    const outgoing = reduce({ type: "outgoing_started", call: dmCall() });
    const pending = callReducer(outgoing, { type: "pending", pending: true });
    expect(pending.pending).toBe(true);
    expect(pending.phase).toBe("outgoing");
    // No-op when already at the requested value (same reference).
    expect(callReducer(pending, { type: "pending", pending: true })).toBe(pending);
  });
});

// --- resync races (call-UX plan K2.2) ---------------------------------------

describe("callReducer — resync races", () => {
  it("a late outgoing_started never drags a resynced ACTIVE call back to outgoing", () => {
    // The callee accepted (and we resynced onto that) while `POST /dm-calls` was
    // still in flight. The late 201 must not re-open the ring — it would arm a
    // timeout that later kills a call both sides are talking on.
    const active = reduce({
      type: "adopt",
      call: dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" }),
      role: "caller",
    });
    const after = callReducer(active, { type: "outgoing_started", call: dmCall() });
    expect(after.phase).toBe("active");
    expect(after.expiresAt).toBeNull();
    expect(after).toBe(active); // roomName already known → no-op, no re-notify
  });

  it("a late outgoing_started for a DIFFERENT call still starts that call", () => {
    const active = reduce({
      type: "adopt",
      call: dmCall({ id: "call-1", status: "active" }),
      role: "caller",
    });
    const after = callReducer(active, {
      type: "outgoing_started",
      call: dmCall({ id: "call-2" }),
    });
    expect(after.phase).toBe("outgoing");
    expect(after.callId).toBe("call-2");
  });

  it("adopting the SAME call keeps the peer profile and a parked invite", () => {
    // A resync row carries ids only; the peer profile came from `call.accepted`
    // and the parked invite belongs to a second caller who must not vanish.
    const active = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      {
        type: "invited",
        callId: "call-2",
        media: "audio",
        caller: user("other"),
        surface: { kind: "dm", dmId: "dm-2" },
        expiresAt: "2026-01-01T00:00:40.000Z",
      },
    );
    expect(active.pendingInvite?.callId).toBe("call-2");

    const resynced = callReducer(active, {
      type: "adopt",
      call: dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" }),
      role: "caller",
    });
    expect(resynced.peer?.id).toBe("friend");
    expect(resynced.pendingInvite?.callId).toBe("call-2");
  });

  it("adopting a DIFFERENT call clears the previous slot's peer and parked invite", () => {
    const active = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
    );
    const other = callReducer(active, {
      type: "adopt",
      call: dmCall({ id: "call-9", status: "active" }),
      role: "callee",
    });
    expect(other.callId).toBe("call-9");
    expect(other.peer).toBeNull();
    expect(other.pendingInvite).toBeNull();
  });
});

// --- the media seat (ADR 0023 §1) -------------------------------------------

describe("callReducer — seat", () => {
  it("is orthogonal to the phase: an ACTIVE call can be seated anywhere", () => {
    const active = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "seat", seat: "here" },
    );
    for (const seat of ["elsewhere", "vacant", "here"] as const) {
      const moved = callReducer(active, { type: "seat", seat });
      // The row is untouched: only which DEVICE holds the audio changed.
      expect(moved.phase).toBe("active");
      expect(moved.callId).toBe("call-1");
      expect(moved.seat).toBe(seat);
      expect(moved.endedReason).toBeNull();
    }
  });

  it("re-adopting the SAME call keeps the seat we already settled", () => {
    const seated = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "seat", seat: "here" },
    );
    // A reconnect resync re-adopts the row it already holds — forgetting the seat
    // here would make the controller re-derive it and, at worst, re-join a room
    // this device is already in.
    const readopted = callReducer(seated, {
      type: "adopt",
      call: dmCall({ status: "active" }),
      role: "caller",
    });
    expect(readopted.seat).toBe("here");
  });

  it("adopting a DIFFERENT call starts from no seat", () => {
    const seated = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "seat", seat: "here" },
    );
    const other = callReducer(seated, {
      type: "adopt",
      call: dmCall({ id: "call-9", status: "active" }),
      role: "callee",
    });
    expect(other.seat).toBe("vacant");
  });

  it("ignores a seat change once the call is over", () => {
    const ended = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "ended", callId: "call-1", reason: "hung_up" },
    );
    // A late media notification must not drag a terminal slot back into looking
    // live — same reference, so the store skips the notify too.
    expect(callReducer(ended, { type: "seat", seat: "here" })).toBe(ended);
    expect(callReducer(initialCallState, { type: "seat", seat: "here" })).toBe(initialCallState);
  });

  it("vacates the seat on a terminal", () => {
    const ended = reduce(
      { type: "outgoing_started", call: dmCall() },
      { type: "accepted_by_peer", callId: "call-1", callee: user("friend") },
      { type: "seat", seat: "here" },
      { type: "ended", callId: "call-1", reason: "hung_up" },
    );
    expect(ended.seat).toBe("vacant");
  });
});

// --- user-facing text -------------------------------------------------------

describe("callEndedMessage", () => {
  it("is role-aware", () => {
    expect(callEndedMessage("timeout", "caller")).toBe("No answer");
    expect(callEndedMessage("timeout", "callee")).toBe("Missed call");
    expect(callEndedMessage("session_replaced", null)).toBe(
      "You joined a call on another device",
    );
  });
});
