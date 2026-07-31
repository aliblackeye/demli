/**
 * "Accepted but never connected" — the connectivity-reliability suite
 * (call-UX plan K2, `docs/product/call-ux-plan-2026-07-30.md`).
 *
 * Founder report: "bazen karşıdaki kabul etse bile bağlantı sağlanamıyor. odadan
 * çıkıp o kişiyi tekrar aramak zorunda kalıyorum."
 *
 * Every test here reproduces one CONCRETE way the client could end up with
 * `dm_calls.status = 'active'` on the server and no working media on this device —
 * the state that then locked out every retry (`isCallLive`) until the 3-6 minute
 * server sweeper. The reducer half lives in `call-state.test.ts`; this file drives
 * the CONTROLLER, because every one of these bugs was in the imperative seams
 * (event → reducer → api → engine), not in the pure transition table.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverEvent } from "@demli/protocol";
import type { DmCallTokenResponse } from "@demli/protocol";
import type { DmCall, User } from "@demli/types";
import { ApiClientError } from "../api-client.js";
import {
  createCallController,
  type CallApi,
  type CallPhase,
  type CallTransition,
  type CallVoiceEngine,
} from "../dm-calls/index.js";

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

const GRANT = { url: "ws://livekit.test", token: "jwt-token" };

/**
 * The `GET /dm-calls/active` answer for a live call, with a rejoin grant.
 *
 * Shaped like the SERVER's DmCallActiveResponse: credentials nested under
 * `media`, plus `peer`/`side`. An earlier draft put url/token at the top level
 * and typechecked fine against a hand-written client interface — so this suite
 * passed while the real endpoint would have handed the client `undefined` and
 * made it hang up the call it was healing. The fixture follows the contract now,
 * and the client is typed from it, so the two cannot drift again.
 */
/**
 * The resync answer for a call whose room this account is NOT in — the media
 * REPAIR case these tests are about (`inRoom: false` is what licenses the client
 * to join, ADR 0023 §3). The seat-gate cases pass `inRoom` explicitly.
 */
function activeResponse(call: DmCall, inRoom: boolean | null = false) {
  return {
    call,
    peer: null,
    side: null,
    media: {
      url: GRANT.url,
      token: GRANT.token,
      roomName: call.roomName,
      identity: "me",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    inRoom,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    isArmed: () => scheduled !== null,
    fire: () => {
      const s = scheduled;
      scheduled = null;
      s?.cb();
    },
  };
}

function setup() {
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

  const api = {
    startDmCall: vi.fn(),
    acceptDmCall: vi.fn(),
    rejectDmCall: vi.fn(async () => ({ call: dmCall({ status: "declined" }) })),
    cancelDmCall: vi.fn(async () => ({ call: dmCall({ status: "canceled" }) })),
    hangupDmCall: vi.fn(async () => ({ call: dmCall({ status: "ended" }) })),
    upgradeDmCall: vi.fn(),
    getMediaToken: vi.fn(),
    getActiveDmCall: vi.fn(async () => ({ call: null }) as { call: DmCall | null }),
  };

  const timers = fakeTimers();
  const transitions: CallTransition[] = [];
  let voiceStatus = "idle";

  const controller = createCallController({
    api: api as unknown as CallApi,
    engine,
    currentUserId: "me",
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    getVoiceStatus: () => voiceStatus,
    onTransition: (t) => transitions.push(t),
  });

  return {
    controller,
    api,
    engine,
    timers,
    transitions,
    joinedRooms,
    setVoiceStatus: (s: string) => {
      voiceStatus = s;
    },
  };
}

type Env = ReturnType<typeof setup>;

let env: Env;
beforeEach(() => {
  env = setup();
});

// ---------------------------------------------------------------------------
// K2.2 — the accept that arrives before the FSM can place it
// ---------------------------------------------------------------------------

describe("out-of-phase call.accepted (the founder's race)", () => {
  it("resyncs and connects when the accept lands BEFORE the start response", async () => {
    // The server publishes `call.invite` and only THEN awaits the push round-trip
    // before answering 201, so this window is wide open in production.
    let resolveStart!: (value: DmCallTokenResponse) => void;
    env.api.startDmCall.mockReturnValueOnce(
      new Promise<DmCallTokenResponse>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const startPromise = env.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(env.controller.getState().phase).toBe("idle"); // 201 not back yet
    expect(env.controller.getState().pending).toBe(true);

    // The callee answers in that window.
    const accepted = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValueOnce(activeResponse(accepted));
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );
    await flush();

    // Before this fix: the reducer dropped the frame, nothing followed up, the
    // caller rang into a timeout while the callee sat in a live room.
    expect(env.api.getActiveDmCall).toHaveBeenCalledTimes(1);
    expect(env.controller.getState().phase).toBe("active");
    expect(env.controller.getState().callId).toBe("call-1");
    expect(env.engine.join).toHaveBeenCalledWith("dmcall:call-1", GRANT);

    // …and the late 201 must NOT drag the live call back to `outgoing` (which would
    // arm a ring timer that later "times out" a call both sides are talking on).
    resolveStart(tokenResponse(dmCall()));
    await startPromise;
    await flush();
    expect(env.controller.getState().phase).toBe("active");
    expect(env.engine.join).toHaveBeenCalledTimes(1);
    expect(env.timers.isArmed()).toBe(false);
  });

  it("keeps the peer profile the accept carried when the resync row has only ids", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    // A duplicate/late accept for the SAME call: applied normally, peer recorded.
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );
    await flush();
    expect(env.controller.getState().peer?.id).toBe("friend");

    // A reconnect resync of the same call must not blank the peer (the row has no
    // profile) — the in-call UI renders off `peer`.
    env.api.getActiveDmCall.mockResolvedValueOnce(
      activeResponse(dmCall({ status: "active" })),
    );
    await env.controller.resyncActiveCall("reconnect");
    expect(env.controller.getState().peer?.id).toBe("friend");
  });

  it("never silently drops an unplaceable accept, in ANY phase", async () => {
    // A SOURCE-INVARIANT style guard: the map is keyed by the full `CallPhase`
    // union, so adding a phase fails to compile until this table covers it. The
    // assertion is behavioral — for every phase, an accept the FSM cannot place
    // must either transition or trigger a server resync. "Nothing happened" (the
    // old behavior) is the one outcome that is never acceptable.
    const arrange = {
      idle: async (e: Env) => {
        // Nothing live at all — a start whose 201 never landed.
        void e.controller;
      },
      outgoing: async (e: Env) => {
        e.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall({ id: "call-9" })));
        await e.controller.startCall({ dmId: "dm-1", media: "audio" });
      },
      incoming: async (e: Env) => {
        e.controller.applyServerEvent(
          serverEvent.callInvite({
            callId: "call-9",
            target: { kind: "dm", dmId: "dm-1" },
            media: "audio",
            caller: user("friend"),
            expiresAt: "2026-01-01T00:00:30.000Z",
          }),
        );
      },
      active: async (e: Env) => {
        e.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall({ id: "call-9" })));
        await e.controller.startCall({ dmId: "dm-1", media: "audio" });
        e.controller.applyServerEvent(
          serverEvent.callAccepted({
            callId: "call-9",
            target: { kind: "dm", dmId: "dm-1" },
            callee: user("friend"),
          }),
        );
      },
      ended: async (e: Env) => {
        e.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall({ id: "call-9" })));
        await e.controller.startCall({ dmId: "dm-1", media: "audio" });
        await e.controller.cancel();
      },
    } satisfies Record<CallPhase, (e: Env) => Promise<void>>;

    for (const [phase, prepare] of Object.entries(arrange)) {
      const local = setup();
      await prepare(local);
      await flush();
      expect(local.controller.getState().phase, `arranged ${phase}`).toBe(phase);

      const before = local.controller.getState();
      local.api.getActiveDmCall.mockClear();
      // An accept for a call this slot does NOT hold.
      local.controller.applyServerEvent(
        serverEvent.callAccepted({
          callId: "call-unknown",
          target: { kind: "dm", dmId: "dm-1" },
          callee: user("friend"),
        }),
      );
      await flush();

      const after = local.controller.getState();
      const changed = after !== before;
      const resynced = local.api.getActiveDmCall.mock.calls.length > 0;
      expect(changed || resynced, `phase ${phase}: accept was silently dropped`).toBe(true);
    }
  });

  it("logs the voice.status + call.phase pair for a DROPPED action (K2.7)", async () => {
    env.setVoiceStatus("connected");
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-unknown",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );
    await flush();

    const dropped = env.transitions.find((t) => !t.applied);
    expect(dropped).toMatchObject({
      action: "accepted_by_peer",
      from: "idle",
      to: "idle",
      applied: false,
      voiceStatus: "connected",
    });
  });
});

// ---------------------------------------------------------------------------
// K2.2 — reconnect resync
// ---------------------------------------------------------------------------

describe("resync on realtime reconnect", () => {
  it("adopts the call that was accepted while the socket was down, and joins media", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    // Simulate the socket dying and the media session dying with it.
    await env.engine.leave();
    expect(env.controller.getState().phase).toBe("outgoing");

    env.api.getActiveDmCall.mockResolvedValueOnce(
      activeResponse(dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" })),
    );
    await env.controller.resyncActiveCall("reconnect");
    await flush();

    expect(env.controller.getState().phase).toBe("active");
    expect(env.engine.join).toHaveBeenLastCalledWith("dmcall:call-1", GRANT);
    expect(env.timers.isArmed()).toBe(false); // no longer ringing
  });

  it("does not re-join media that is already live on the call room", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    env.engine.join.mockClear();

    env.api.getActiveDmCall.mockResolvedValueOnce(
      activeResponse(dmCall({ status: "active" })),
    );
    await env.controller.resyncActiveCall("reconnect");
    await flush();

    expect(env.controller.getState().phase).toBe("active");
    expect(env.engine.join).not.toHaveBeenCalled();
  });

  it("ends a call the server no longer knows about", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });

    env.api.getActiveDmCall.mockResolvedValueOnce({ call: null });
    await env.controller.resyncActiveCall("reconnect");

    expect(env.controller.getState().phase).toBe("ended");
    // "It is over", not "it broke" — the resync cannot see a failure, so it must not
    // invent one (§26).
    expect(env.controller.getState().endedReason).toBe("hung_up");
  });

  it("leaves a call ALONE while one of its control actions is in flight", async () => {
    // A resync racing a start whose row is not committed yet must never end the
    // call being created.
    let resolveStart!: (value: DmCallTokenResponse) => void;
    env.api.startDmCall.mockReturnValueOnce(
      new Promise<DmCallTokenResponse>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const startPromise = env.controller.startCall({ dmId: "dm-1", media: "audio" });

    env.api.getActiveDmCall.mockResolvedValueOnce({ call: null });
    await env.controller.resyncActiveCall("reconnect");
    expect(env.controller.getState().phase).toBe("idle");
    expect(env.controller.getState().pending).toBe(true);

    resolveStart(tokenResponse(dmCall()));
    await startPromise;
    expect(env.controller.getState().phase).toBe("outgoing");
  });

  it("never touches a post-upgrade group call (its row closes as `upgraded`)", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );
    env.controller.applyServerEvent(
      serverEvent.callUpgraded({
        callId: "call-1",
        group: {
          id: "grp-1",
          name: "Group",
          iconUrl: null,
          ownerId: "me",
          streamId: "stream-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        voiceChannelId: "vc-1",
      }),
    );
    expect(env.controller.getState().surface?.kind).toBe("group");

    await env.controller.resyncActiveCall("reconnect");

    // The DM-call endpoint has no authority over a group voice session — reading it
    // would "end" a perfectly live 3-person call.
    expect(env.api.getActiveDmCall).not.toHaveBeenCalled();
    expect(env.controller.getState().phase).toBe("active");
  });

  it("keeps the current state when the resync request itself fails", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    env.api.getActiveDmCall.mockRejectedValueOnce(
      new ApiClientError("NETWORK", "Can't reach the server."),
    );

    await env.controller.resyncActiveCall("reconnect");

    expect(env.controller.getState().phase).toBe("outgoing");
  });
});

// ---------------------------------------------------------------------------
// K2.3 — media failure after the call was accepted
// ---------------------------------------------------------------------------

describe("media failure after an accept", () => {
  it("HANGS UP (not cancels) when the caller's join fails after the peer accepted", async () => {
    // The accept lands while the caller's join is still running: `cancel` is
    // caller-only AND ringing-only, so it 409s and — swallowed — left the row
    // `active` forever.
    let rejectJoin!: (error: Error) => void;
    env.engine.join.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectJoin = reject;
        }),
    );
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    const startPromise = env.controller.startCall({ dmId: "dm-1", media: "audio" });
    await flush();

    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );
    expect(env.controller.getState().phase).toBe("active");

    rejectJoin(new Error("livekit unreachable"));
    await startPromise;

    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    expect(env.api.cancelDmCall).not.toHaveBeenCalled();
    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("failed");
  });

  it("falls back from cancel to hangup on a 409 (the accept we never saw)", async () => {
    env.engine.join.mockRejectedValueOnce(new Error("livekit unreachable"));
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    env.api.cancelDmCall.mockRejectedValueOnce(
      new ApiClientError("CONFLICT", "This call is not ringing.", 409),
    );

    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    await flush();

    // Still `outgoing` locally (no accept frame ever arrived) so cancel is tried
    // first — but its 409 is the server saying "it was accepted".
    expect(env.api.cancelDmCall).toHaveBeenCalledWith("call-1", "canceled");
    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    expect(env.controller.getState().phase).toBe("ended");
  });

  it("closes the call on BOTH planes when the callee's media fails after accepting", async () => {
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        media: "audio",
        caller: user("friend"),
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
    );
    env.api.acceptDmCall.mockResolvedValueOnce(
      tokenResponse(dmCall({ status: "active", callerId: "friend", calleeId: "me" })),
    );
    env.engine.join.mockRejectedValueOnce(new Error("mic exploded"));

    await expect(env.controller.accept()).rejects.toThrow();
    await flush();

    // The row is `active` server-side and the caller believes we joined — leaving
    // it open is exactly the founder's stuck call, from the answering side.
    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("failed");
  });

  it("uses reject (not cancel) as the callee's 409 fallback", async () => {
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        media: "audio",
        caller: user("friend"),
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
    );
    env.api.acceptDmCall.mockResolvedValueOnce(
      tokenResponse(dmCall({ status: "active", callerId: "friend", calleeId: "me" })),
    );
    env.engine.join.mockRejectedValueOnce(new Error("mic exploded"));
    env.api.hangupDmCall.mockRejectedValueOnce(
      new ApiClientError("CONFLICT", "This call is not active.", 409),
    );

    await expect(env.controller.accept()).rejects.toThrow();
    await flush();

    // `cancel` is caller-only: guessing it here would 403 and leave the row open.
    expect(env.api.rejectDmCall).toHaveBeenCalledWith("call-1");
    expect(env.api.cancelDmCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// K2.4 — the media session dies under a live call
// ---------------------------------------------------------------------------

describe("reportMediaFailure (engine error / unexpected disconnect)", () => {
  it("retires the call and tells the server, so the next call is not locked out", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );

    env.controller.reportMediaFailure();
    await flush();

    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("failed");
    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    // The slot is free again — this is the whole point (founder: "çıkıp tekrar
    // aramak zorunda kalıyorum").
    env.controller.dismiss();
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall({ id: "call-2" })));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(env.controller.getState().callId).toBe("call-2");
  });

  it("is a no-op when no call is live", () => {
    env.controller.reportMediaFailure();
    expect(env.controller.getState().phase).toBe("idle");
    expect(env.api.hangupDmCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// K2.5 / K2.6 — re-entrancy and the ring timer
// ---------------------------------------------------------------------------

describe("accept re-entrancy", () => {
  it("joins ONCE and accepts ONCE when the user double-taps", async () => {
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        media: "audio",
        caller: user("friend"),
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
    );
    let resolveAccept!: (value: DmCallTokenResponse) => void;
    env.api.acceptDmCall.mockReturnValueOnce(
      new Promise<DmCallTokenResponse>((resolve) => {
        resolveAccept = resolve;
      }),
    );

    const first = env.controller.accept();
    await flush(); // the first accept is now waiting on the endpoint
    expect(env.api.acceptDmCall).toHaveBeenCalledTimes(1);
    // The second tap arrives while the first accept is still in flight. Before the
    // guard this bumped the engine's command epoch, so the FIRST join connected
    // nothing and the SECOND accept 409'd — accepted call, no media.
    await env.controller.accept();
    expect(env.api.acceptDmCall).toHaveBeenCalledTimes(1);

    resolveAccept(tokenResponse(dmCall({ status: "active", callerId: "friend", calleeId: "me" })));
    await first;

    expect(env.api.acceptDmCall).toHaveBeenCalledTimes(1);
    expect(env.engine.join).toHaveBeenCalledTimes(1);
    expect(env.controller.getState().phase).toBe("active");
  });

  it("starts ONE call when the call button is double-tapped", async () => {
    let resolveStart!: (value: DmCallTokenResponse) => void;
    env.api.startDmCall.mockReturnValueOnce(
      new Promise<DmCallTokenResponse>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const first = env.controller.startCall({ dmId: "dm-1", media: "audio" });
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(env.api.startDmCall).toHaveBeenCalledTimes(1);

    resolveStart(tokenResponse(dmCall()));
    await first;
    expect(env.api.startDmCall).toHaveBeenCalledTimes(1);
  });
});

describe("ring timer (K2.6)", () => {
  it("keeps ringing when a stale accepted arrives for a DIFFERENT call", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    expect(env.timers.isArmed()).toBe(true);

    // Before the fix `clearRingTimeout()` ran unconditionally, ahead of the reducer:
    // a stale frame silently disarmed a live ring that was never re-armed → the
    // "zil durmuyor" class of bug.
    env.api.getActiveDmCall.mockResolvedValueOnce({ call: null });
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-other",
        target: { kind: "dm", dmId: "dm-2" },
        callee: user("someone"),
      }),
    );

    expect(env.timers.isArmed()).toBe(true);
  });

  it("disarms the ring only when the accept actually applied", async () => {
    env.api.startDmCall.mockResolvedValueOnce(tokenResponse(dmCall()));
    await env.controller.startCall({ dmId: "dm-1", media: "audio" });
    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("friend"),
      }),
    );
    expect(env.controller.getState().phase).toBe("active");
    expect(env.timers.isArmed()).toBe(false);
  });
});
