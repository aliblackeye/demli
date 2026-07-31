import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverEvent } from "@demli/protocol";
import type { DmCall, Group, User } from "@demli/types";
import type { DmCallTokenResponse } from "@demli/protocol";
import { ApiClientError } from "../api-client.js";
import {
  createCallController,
  type CallApi,
  type CallVoiceEngine,
} from "../dm-calls/call-controller.js";

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

function tokenResponse(call: DmCall): DmCallTokenResponse {
  return {
    call,
    url: "ws://livekit.test",
    token: "jwt-token",
    roomName: call.roomName,
    identity: call.callerId,
    expiresAt: "2026-06-01T00:00:00.000Z",
  };
}

/** A hand-driven timer so the ring timeout fires deterministically. */
function fakeTimers() {
  let scheduled: { cb: () => void; ms: number } | null = null;
  return {
    setTimer: vi.fn((cb: () => void, ms: number) => {
      scheduled = { cb, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimer: vi.fn(() => {
      scheduled = null;
    }),
    /** True while a ring-timeout is armed. */
    isArmed: () => scheduled !== null,
    /** The delay (ms) the armed timeout was scheduled with (real clamp/NaN math). */
    delay: () => scheduled?.ms,
    /** Fire the armed timeout (like the 30s ring window elapsing). */
    fire: () => {
      const s = scheduled;
      scheduled = null;
      s?.cb();
    },
  };
}

/** Flush pending microtasks so fire-and-forget engine/api calls settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(overrides: Partial<Parameters<typeof createCallController>[0]> = {}) {
  // The engine fake tracks WHICH room it is connected to, because the controller's
  // media-repair paths (call-UX plan K2.3) branch on that — a fake that always
  // claims nothing/everything is joined would hide both the "join twice" and the
  // "never joined" bug.
  const joinedRooms = new Set<string>();
  const engine = {
    join: vi.fn(async (roomName: string) => {
      joinedRooms.add(roomName);
    }),
    leave: vi.fn(async () => {
      joinedRooms.clear();
    }),
    isConnectedTo: (roomName: string) => joinedRooms.has(roomName),
  } satisfies CallVoiceEngine;

  // Plain mock object so each method keeps its `Mock` type in assertions; it is
  // cast to `CallApi` only when handed to the controller.
  const api = {
    startDmCall: vi.fn(),
    acceptDmCall: vi.fn(),
    rejectDmCall: vi.fn(async () => ({ call: dmCall({ status: "declined" }) })),
    cancelDmCall: vi.fn(async () => ({ call: dmCall({ status: "canceled" }) })),
    hangupDmCall: vi.fn(async () => ({ call: dmCall({ status: "ended" }) })),
    upgradeDmCall: vi.fn(async () => ({ group: group(), voiceChannelId: "vc-1" })),
    getMediaToken: vi.fn(),
    // Default: the server says nothing is live. Tests that exercise the resync
    // (K2.2) override this.
    getActiveDmCall: vi.fn(async () => ({ call: null })),
  };

  const timers = fakeTimers();
  const signalVoiceJoin = vi.fn();

  const controller = createCallController({
    api: api as unknown as CallApi,
    engine,
    currentUserId: "me",
    signalVoiceJoin,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });

  return { controller, api, engine, timers, signalVoiceJoin };
}

/** Drive a caller to the active state (start → peer accepts). */
async function callerActive(env: ReturnType<typeof setup>) {
  env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
  await env.controller.startCall({ dmId: "dm-1", media: "audio" });
  env.controller.applyServerEvent(
    serverEvent.callAccepted({
      callId: "call-1",
      target: { kind: "dm", dmId: "dm-1" },
      callee: user("friend"),
    }),
  );
}

let env: ReturnType<typeof setup>;
beforeEach(() => {
  env = setup();
});

// --- caller start -----------------------------------------------------------

describe("createCallController — start (caller)", () => {
  it("starts an outgoing call, joins media with the minted token, and arms the ring timer", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));

    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    const state = env.controller.getState();
    expect(state.phase).toBe("outgoing");
    expect(state.role).toBe("caller");
    expect(state.callId).toBe("call-1");
    expect(state.roomName).toBe("dmcall:call-1");
    expect(env.api.startDmCall).toHaveBeenCalledWith({ dmId: "dm-1", media: "audio" });
    expect(env.engine.join).toHaveBeenCalledWith("dmcall:call-1", {
      url: "ws://livekit.test",
      token: "jwt-token",
    });
    expect(env.timers.isArmed()).toBe(true);
  });

  it("does nothing when a call is already live", async () => {
    env.api.startDmCall.mockResolvedValue(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(env.api.startDmCall).toHaveBeenCalledTimes(1);
  });

  it("adopts the existing call on a start 409 (rejoin), without a second media join", async () => {
    const existing = dmCall({ status: "active", callerId: "me", startedAt: "2026-01-01T00:00:10.000Z" });
    // Media is ALREADY live on the call room (the common re-tap case: the user is
    // in the call and pressed the button again).
    await env.engine.join(existing.roomName);
    env.engine.join.mockClear();
    env.api.startDmCall.mockRejectedValueOnce(
      new ApiClientError("CONFLICT", "A call is already in progress.", 409, null, {
        error: { code: "CONFLICT" },
        call: existing,
      }),
    );

    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    await flush();

    const state = env.controller.getState();
    expect(state.phase).toBe("active");
    expect(state.role).toBe("caller");
    expect(state.callId).toBe("call-1");
    expect(env.engine.join).not.toHaveBeenCalled();
    // Media was already up, so there was nothing to repair — no resync needed.
    expect(env.api.getActiveDmCall).not.toHaveBeenCalled();
  });

  // Regression (founder P0, 2026-07-27 — "zil durmuyor"). Pressing "call" on a DM
  // where the PEER is already ringing us 409s back THAT call; adopting it lands
  // us in `incoming`, which is what starts the ringtone. The adopt path used to
  // arm the give-up timer only for the caller role, so this ring had NO upper
  // bound at all — it depended entirely on the peer's `call.ended` ever arriving.
  it("arms a bounded ring timer when the adopted call is one we are being RUNG on", async () => {
    const incoming = dmCall({ status: "ringing", callerId: "friend", calleeId: "me" });
    env.api.startDmCall.mockRejectedValueOnce(
      new ApiClientError("CONFLICT", "A call is already in progress.", 409, null, {
        error: { code: "CONFLICT" },
        call: incoming,
      }),
    );

    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    const state = env.controller.getState();
    expect(state.phase).toBe("incoming");
    expect(state.role).toBe("callee");
    // The ring can now end on its own, whatever the peer does or fails to do.
    expect(env.timers.isArmed()).toBe(true);
    env.timers.fire();
    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("timeout");
  });
});

// --- ring timeout -----------------------------------------------------------

describe("createCallController — ring timeout", () => {
  it("cancels with reason=timeout when the caller's ring window elapses", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    env.timers.fire();
    await flush();

    expect(env.api.cancelDmCall).toHaveBeenCalledWith("call-1", "timeout");
    const state = env.controller.getState();
    expect(state.phase).toBe("ended");
    expect(state.endedReason).toBe("timeout");
    expect(env.engine.leave).toHaveBeenCalled();
  });

  // Regression: the ring delay MUST stay bounded by the ring window. A server
  // deadline read against a device clock that runs behind the server would
  // otherwise schedule the timeout minutes/hours out → the founder's "rings
  // forever". (The other tests fire the timer by hand and never exercise `ms`.)
  it("clamps the caller ring delay to the window despite a far-future deadline (clock skew)", async () => {
    const farFuture = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // +6h
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall({ expiresAt: farFuture })));

    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    expect(env.timers.delay()).toBeGreaterThan(0);
    expect(env.timers.delay()).toBeLessThanOrEqual(30_000);
  });

  it("falls back to the full window (not setTimeout(NaN)) for an unparseable deadline", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall({ expiresAt: "not-a-date" })));

    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    expect(env.timers.delay()).toBe(30_000);
  });
});

// --- callee ring timeout (independent safety net, the "rings forever" fix) ---

describe("createCallController — callee ring timeout", () => {
  function ring() {
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        caller: user("friend"),
        media: "audio",
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
    );
  }

  it("arms an independent give-up timer on a fresh inbound ring", () => {
    ring();
    expect(env.controller.getState().phase).toBe("incoming");
    expect(env.timers.isArmed()).toBe(true);
  });

  it("ends a stuck incoming ring locally as missed when the caller never cancels", () => {
    ring();

    env.timers.fire(); // the caller's `call.ended` never arrived

    const state = env.controller.getState();
    expect(state.phase).toBe("ended");
    // "timeout" renders "Missed call" for the callee (call-state.ts).
    expect(state.endedReason).toBe("timeout");
    // The callee cannot author a server terminal, and never joined media.
    expect(env.api.cancelDmCall).not.toHaveBeenCalled();
    expect(env.api.rejectDmCall).not.toHaveBeenCalled();
    expect(env.engine.leave).not.toHaveBeenCalled();
  });

  it("clears the give-up timer once the callee answers", async () => {
    ring();
    env.api.acceptDmCall.mockResolvedValueOnce(
      tokenResponse(dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" })),
    );

    await env.controller.accept();

    expect(env.timers.isArmed()).toBe(false);
    expect(env.controller.getState().phase).toBe("active");
  });
});

// --- callee accept / decline ------------------------------------------------

describe("createCallController — incoming (callee)", () => {
  function ring() {
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        caller: user("friend"),
        media: "audio",
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
    );
  }

  it("rings on call.invite with the hydrated caller", () => {
    ring();
    const state = env.controller.getState();
    expect(state.phase).toBe("incoming");
    expect(state.role).toBe("callee");
    expect(state.peer?.id).toBe("friend");
  });

  it("accept mints the callee token, joins media, and goes active", async () => {
    ring();
    env.api.acceptDmCall.mockResolvedValueOnce(
      tokenResponse(dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" })),
    );

    await env.controller.accept();

    expect(env.api.acceptDmCall).toHaveBeenCalledWith("call-1");
    expect(env.engine.join).toHaveBeenCalledWith("dmcall:call-1", {
      url: "ws://livekit.test",
      token: "jwt-token",
    });
    const state = env.controller.getState();
    expect(state.phase).toBe("active");
    expect(state.roomName).toBe("dmcall:call-1");
    expect(env.timers.isArmed()).toBe(false);
  });

  it("decline rejects the call and never joins/leaves media", async () => {
    ring();
    await env.controller.decline();

    expect(env.api.rejectDmCall).toHaveBeenCalledWith("call-1");
    expect(env.engine.join).not.toHaveBeenCalled();
    expect(env.engine.leave).not.toHaveBeenCalled();
    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("declined");
  });
});

// --- accept while ALREADY in a voice session (founder P0 crash) --------------

describe("createCallController — accept while already in a voice session (§5)", () => {
  it("leaves the current room BEFORE joining the call room, so accept does not throw", async () => {
    // A fake engine that enforces the REAL media FSM's JOIN guard: JOIN is legal
    // only from idle/error (§11), so a `join` WITHOUT a preceding `leave` throws
    // exactly as the real engine's `InvalidVoiceCommandError` does. It starts
    // "connected" to stand in for the user already being in a server voice room —
    // the founder's constant state when a DM call arrives. `calls` records the
    // order so we can assert leave-precedes-join directly.
    let connected = true;
    const calls: string[] = [];
    const engine: CallVoiceEngine = {
      join: vi.fn(async () => {
        calls.push("join");
        if (connected) throw new Error("Voice command JOIN is not allowed while connected.");
        connected = true;
      }),
      leave: vi.fn(async () => {
        calls.push("leave");
        connected = false;
      }),
    };
    const api = {
      startDmCall: vi.fn(),
      acceptDmCall: vi.fn(async () =>
        tokenResponse(dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" })),
      ),
      rejectDmCall: vi.fn(),
      cancelDmCall: vi.fn(),
      hangupDmCall: vi.fn(),
      upgradeDmCall: vi.fn(),
      getMediaToken: vi.fn(),
    };
    const onError = vi.fn();
    const timers = fakeTimers();
    const controller = createCallController({
      api: api as unknown as CallApi,
      engine,
      currentUserId: "me",
      onError,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        caller: user("friend"),
        media: "audio",
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
    );

    await controller.accept();

    // The old room was left FIRST, then the call room joined — the exact order the
    // FSM guard requires. Before the fix, join ran first on a connected engine and
    // threw InvalidVoiceCommand → the founder's crash/freeze.
    expect(calls).toEqual(["leave", "join"]);
    expect(engine.join).toHaveBeenCalledWith("dmcall:call-1", {
      url: "ws://livekit.test",
      token: "jwt-token",
    });
    // Accept SUCCEEDED — the call is active, never wedged or thrown.
    expect(controller.getState().phase).toBe("active");
    expect(onError).not.toHaveBeenCalled();
  });
});

// --- busy banner: a second invite while already in a call -------------------

describe("createCallController — busy banner (second invite while active)", () => {
  /** Park a second incoming invite (call-2) on top of the active call. */
  function parkSecondInvite() {
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-2",
        target: { kind: "dm", dmId: "dm-2" },
        caller: user("other"),
        media: "audio",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    );
  }

  it("parks a second invite instead of ringing or touching media", async () => {
    await callerActive(env);
    env.engine.join.mockClear();
    env.engine.leave.mockClear();

    parkSecondInvite();

    const state = env.controller.getState();
    expect(state.phase).toBe("active"); // primary call unchanged
    expect(state.callId).toBe("call-1");
    expect(state.pendingInvite?.callId).toBe("call-2");
    expect(state.pendingInvite?.caller.id).toBe("other");
    // No second ring, no media churn.
    expect(env.engine.join).not.toHaveBeenCalled();
    expect(env.engine.leave).not.toHaveBeenCalled();
  });

  it("declinePendingInvite rejects the parked caller and keeps the current call", async () => {
    await callerActive(env);
    parkSecondInvite();
    env.engine.leave.mockClear();

    await env.controller.declinePendingInvite();

    expect(env.api.rejectDmCall).toHaveBeenCalledWith("call-2");
    const state = env.controller.getState();
    expect(state.phase).toBe("active"); // current call still running
    expect(state.callId).toBe("call-1");
    expect(state.pendingInvite).toBeNull();
    expect(env.engine.leave).not.toHaveBeenCalled(); // current media untouched
  });

  it("acceptPendingInvite ends the current call, then joins the parked one", async () => {
    await callerActive(env);
    parkSecondInvite();
    env.api.acceptDmCall.mockResolvedValueOnce(
      tokenResponse(dmCall({ id: "call-2", roomName: "dmcall:call-2", status: "active" })),
    );

    await env.controller.acceptPendingInvite();
    await flush();

    // Current call was ended server-side and media released before the switch.
    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    expect(env.engine.leave).toHaveBeenCalled();
    // Then the parked call was accepted and its NEW room joined.
    expect(env.api.acceptDmCall).toHaveBeenCalledWith("call-2");
    expect(env.engine.join).toHaveBeenLastCalledWith("dmcall:call-2", {
      url: "ws://livekit.test",
      token: "jwt-token",
    });
    const state = env.controller.getState();
    expect(state.phase).toBe("active");
    expect(state.callId).toBe("call-2");
    expect(state.pendingInvite).toBeNull();
  });

  it("drops the banner when the parked caller cancels (call.ended for the parked id)", async () => {
    await callerActive(env);
    parkSecondInvite();

    env.controller.applyServerEvent(
      serverEvent.callEnded({ callId: "call-2", reason: "canceled" }),
    );

    const state = env.controller.getState();
    expect(state.pendingInvite).toBeNull();
    expect(state.phase).toBe("active"); // current call untouched
    expect(state.callId).toBe("call-1");
  });

  it("drops the banner when the parked invite's own ring window elapses", async () => {
    await callerActive(env);
    parkSecondInvite();
    expect(env.controller.getState().pendingInvite?.callId).toBe("call-2");

    env.timers.fire(); // the parked invite's expiresAt timer

    expect(env.controller.getState().pendingInvite).toBeNull();
    expect(env.controller.getState().phase).toBe("active");
  });
});

// --- cancel / hangup --------------------------------------------------------

describe("createCallController — cancel / hangup", () => {
  it("cancel withdraws an outgoing ring and leaves media", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    await env.controller.cancel();

    expect(env.api.cancelDmCall).toHaveBeenCalledWith("call-1", "canceled");
    expect(env.engine.leave).toHaveBeenCalled();
    expect(env.controller.getState().endedReason).toBe("canceled");
  });

  it("hangup ends an active call and leaves media", async () => {
    await callerActive(env);
    expect(env.controller.getState().phase).toBe("active");

    await env.controller.hangup();

    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    expect(env.engine.leave).toHaveBeenCalled();
    expect(env.controller.getState().endedReason).toBe("hung_up");
  });

  it("ends locally when the peer hangs up (call.ended)", async () => {
    await callerActive(env);

    env.controller.applyServerEvent(
      serverEvent.callEnded({ callId: "call-1", reason: "hung_up" }),
    );
    await flush();

    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("hung_up");
    expect(env.engine.leave).toHaveBeenCalled();
  });
});

// --- upgrade (seamless group) -----------------------------------------------

describe("createCallController — group upgrade (§6)", () => {
  it("upgrade calls the endpoint; the surface swaps only on our own call.upgraded", async () => {
    await callerActive(env);

    await env.controller.upgrade({ inviteeUserId: "third" });
    expect(env.api.upgradeDmCall).toHaveBeenCalledWith("call-1", { inviteeUserId: "third" });

    const g = group("grp-9");
    env.controller.applyServerEvent(
      serverEvent.callUpgraded({ callId: "call-1", group: g, voiceChannelId: "vc-1" }),
    );

    const state = env.controller.getState();
    expect(state.phase).toBe("active"); // still active — media never moved
    expect(state.surface).toEqual({
      kind: "group",
      groupId: "grp-9",
      voiceChannelId: "vc-1",
      group: g,
    });
    // Occupancy-only signal; NO engine leave/join beyond the original join.
    expect(env.signalVoiceJoin).toHaveBeenCalledWith("vc-1");
    expect(env.engine.join).toHaveBeenCalledTimes(1);
    expect(env.engine.leave).not.toHaveBeenCalled();
  });
});

// --- single-session eviction ------------------------------------------------

describe("createCallController — single-session eviction (§5)", () => {
  /**
   * ADR 0023 §3 changed what this event MEANS. It used to end the call
   * (`ended: session_replaced`), which is a lie the founder sees every time they
   * pick a call up on another device: answering on your phone is not the call
   * ending, it is the call MOVING. Only the seat is replaced; the row is live and
   * this device can take it back.
   */
  it("moves the SEAT (not the call) on voice.session_replaced for the call room", async () => {
    await callerActive(env);
    env.engine.leave.mockClear();

    env.controller.applyServerEvent(
      serverEvent.voiceSessionReplaced({
        roomId: "dmcall:call-1",
        reason: "joined_elsewhere",
      }),
    );

    const state = env.controller.getState();
    expect(state.phase).toBe("active");
    expect(state.seat).toBe("elsewhere");
    expect(state.endedReason).toBeNull();
    // The engine evicted itself — the controller must NOT call leave().
    expect(env.engine.leave).not.toHaveBeenCalled();
  });

  it("ignores a session_replaced for an unrelated room", async () => {
    await callerActive(env);

    env.controller.applyServerEvent(
      serverEvent.voiceSessionReplaced({
        roomId: "some-other-room",
        reason: "joined_elsewhere",
      }),
    );

    expect(env.controller.getState().phase).toBe("active");
  });
});

// --- store plumbing ---------------------------------------------------------

describe("createCallController — store", () => {
  it("notifies subscribers on state changes and ignores non-call events", async () => {
    const listener = vi.fn();
    env.controller.subscribe(listener);

    // A non-call event is a no-op (no notification).
    env.controller.applyServerEvent(
      serverEvent.presenceUpdated({ userId: "friend", status: "online" }),
    );
    expect(listener).not.toHaveBeenCalled();

    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.lastCall?.[0].phase).toBe("outgoing");
  });

  it("dismiss returns an ended call to idle", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    await env.controller.cancel();
    expect(env.controller.getState().phase).toBe("ended");

    env.controller.dismiss();
    expect(env.controller.getState().phase).toBe("idle");
  });
});
