/**
 * "A DM call is a ROOM" — the seat-model suite (ADR 0023,
 * `docs/product/call-as-room-plan.md`).
 *
 * Founder model statement: a private call should behave like a server voice
 * room, with one difference — whoever is left alone gets removed after a while.
 * Concretely: *"if I'm on a call on mobile, I should be able to press leave on
 * mobile and, within that window, join that same call from the desktop."*
 *
 * Three behaviors follow, and each of them USED to be wrong in a way a user
 * could feel:
 *
 *  1. LEAVE ≠ END. `hangup` ended the row and told the peer the call was over,
 *     so walking out hung up on someone who was still there and there was
 *     nothing left to walk back into.
 *  2. THE SEAT IS PER-DEVICE. A resync adopted a live call and joined its room
 *     with the account's identity — and LiveKit permits one connection per
 *     identity, so a desktop doing housekeeping DISCONNECTED the phone that was
 *     mid-conversation. That is the live regression this suite pins.
 *  3. `voice.session_replaced` IS NOT TERMINAL. Answering on another device is
 *     the call moving, not the call ending.
 *
 * The pure transition table lives in `call-state.test.ts`; this file drives the
 * CONTROLLER, because all three bugs were in the imperative seams (event →
 * reducer → api → engine) rather than in the reducer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverEvent } from "@demli/protocol";
import type { DmCallActiveResponse, DmCallTokenResponse } from "@demli/protocol";
import type { DmCall, User } from "@demli/types";
import {
  createCallController,
  type CallApi,
  type CallVoiceEngine,
} from "../dm-calls/index.js";

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
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

const GRANT = { url: "ws://livekit.test", token: "jwt-token" };

function tokenResponse(call: DmCall): DmCallTokenResponse {
  return {
    call,
    url: GRANT.url,
    token: GRANT.token,
    roomName: call.roomName,
    identity: "me",
    expiresAt: "2026-06-01T00:00:00.000Z",
  };
}

/** The resync body, with the media-plane seat reading spelled out explicitly. */
function activeResponse(call: DmCall, inRoom: boolean | null): DmCallActiveResponse {
  return {
    call,
    peer: user("friend"),
    side: call.callerId === "me" ? "caller" : "callee",
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
    startDmCall: vi.fn(async () => tokenResponse(dmCall())),
    acceptDmCall: vi.fn(async () => tokenResponse(dmCall({ status: "active" }))),
    rejectDmCall: vi.fn(async () => ({ call: dmCall({ status: "declined" }) })),
    cancelDmCall: vi.fn(async () => ({ call: dmCall({ status: "canceled" }) })),
    hangupDmCall: vi.fn(async () => ({ call: dmCall({ status: "ended" }) })),
    upgradeDmCall: vi.fn(),
    getMediaToken: vi.fn(),
    getActiveDmCall: vi.fn(
      async (): Promise<DmCallActiveResponse> => ({
        call: null,
        peer: null,
        side: null,
        media: null,
        inRoom: null,
      }),
    ),
  };

  /**
   * What the media engine reports about OTHER people in the room. `null` models a
   * platform that cannot answer — the case the last-one-out rule must treat as
   * "someone is still here".
   */
  let remoteCount: number | null = 1;

  const controller = createCallController({
    api: api as unknown as CallApi,
    engine,
    currentUserId: "me",
    getRemoteParticipantCount: () => remoteCount,
  });

  return {
    controller,
    api,
    engine,
    joinedRooms,
    setRemoteCount: (n: number | null) => {
      remoteCount = n;
    },
  };
}

type Env = ReturnType<typeof setup>;

let env: Env;
beforeEach(() => {
  env = setup();
});

/** Drive the controller to an ACTIVE call with the seat on this device. */
async function callerActive(e: Env): Promise<void> {
  const call = dmCall();
  e.api.startDmCall.mockResolvedValueOnce(tokenResponse(call));
  await e.controller.startCall({ dmId: "dm-1", media: "audio" });
  e.controller.applyServerEvent(
    serverEvent.callAccepted({
      callId: "call-1",
      target: { kind: "dm", dmId: "dm-1" },
      callee: user("friend"),
    }),
  );
  expect(e.controller.getState().phase).toBe("active");
  expect(e.controller.getState().seat).toBe("here");
}

// ---------------------------------------------------------------------------
// The live regression: a resync must not kick the device that is in the room
// ---------------------------------------------------------------------------

describe("the auto-join gate (ADR 0023 §3)", () => {
  it("does NOT join when the media plane says our identity is already in the room", async () => {
    // This device was rung and then told the call was answered — on the phone.
    env.controller.applyServerEvent(
      serverEvent.callInvite({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        caller: user("friend"),
        media: "audio",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    expect(env.controller.getState().phase).toBe("incoming");

    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, true));

    env.controller.applyServerEvent(
      serverEvent.callAccepted({
        callId: "call-1",
        target: { kind: "dm", dmId: "dm-1" },
        callee: user("me"),
      }),
    );
    await vi.waitFor(() => expect(env.controller.getState().seat).toBe("elsewhere"));

    const state = env.controller.getState();
    // The call is VISIBLE here (the founder's second half: "pcde aramada olduğum
    // gözükmüyor") …
    expect(state.phase).toBe("active");
    expect(state.callId).toBe("call-1");
    // …and this device joined NOTHING, so the phone keeps its LiveKit connection.
    expect(env.engine.join).not.toHaveBeenCalled();
  });

  it("stays out of the room when the media plane could not be read (inRoom: null)", async () => {
    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, null));

    await env.controller.resyncActiveCall("reconnect");

    // "I don't know" is not "the room is free". The cheap error is to wait for
    // the user; the expensive one is to disconnect a device mid-call.
    expect(env.controller.getState().seat).toBe("elsewhere");
    expect(env.engine.join).not.toHaveBeenCalled();
  });

  it("DOES repair media when the media plane says the seat is free (inRoom: false)", async () => {
    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, false));

    await env.controller.resyncActiveCall("reconnect");
    await vi.waitFor(() => expect(env.controller.getState().seat).toBe("here"));

    // The K2.3 repair path is untouched: nobody of ours is in the room, so
    // joining it can hurt no one.
    expect(env.engine.join).toHaveBeenCalledWith("dmcall:call-1", GRANT);
    expect(env.controller.getState().phase).toBe("active");
  });

  it("keeps the seat HERE when we are the device in the room", async () => {
    await callerActive(env);
    env.engine.join.mockClear();
    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    // `inRoom` is true because it is US — the identity cannot distinguish devices,
    // so the engine's own answer has to win.
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, true));

    await env.controller.resyncActiveCall("reconnect");

    expect(env.controller.getState().seat).toBe("here");
    expect(env.engine.join).not.toHaveBeenCalled();
    expect(env.engine.leave).not.toHaveBeenCalled();
  });

  it("takes the seat over on the user's deliberate joinHere()", async () => {
    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, true));
    await env.controller.resyncActiveCall("reconnect");
    expect(env.controller.getState().seat).toBe("elsewhere");

    await env.controller.joinHere();

    // The eviction of the other device is now a thing the USER did, which is the
    // whole difference between a handoff and a bug.
    expect(env.engine.join).toHaveBeenCalledWith("dmcall:call-1", GRANT);
    expect(env.controller.getState().seat).toBe("here");
    expect(env.controller.getState().pending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leave ≠ end (ADR 0023 §2)
// ---------------------------------------------------------------------------

describe("leaveRoom — walking out without ending the call", () => {
  it("releases only the media seat while the peer is still in the room", async () => {
    await callerActive(env);
    env.setRemoteCount(1); // the peer is there

    await env.controller.leaveRoom();

    const state = env.controller.getState();
    // The ROW is alive and this device can walk back in — the founder's
    // "leave on mobile, join from the desktop" window.
    expect(state.phase).toBe("active");
    expect(state.seat).toBe("vacant");
    expect(env.engine.leave).toHaveBeenCalledTimes(1);
    // Nothing tells the peer the call is over. This is the assertion that
    // separates the room model from the old hang-up.
    expect(env.api.hangupDmCall).not.toHaveBeenCalled();
    expect(env.api.cancelDmCall).not.toHaveBeenCalled();
  });

  it("closes the call when the LAST person walks out", async () => {
    await callerActive(env);
    env.setRemoteCount(0); // nobody left behind

    await env.controller.leaveRoom();

    // There is no room to come back to, so the row closes NOW and the
    // "Call ended · mm:ss" history line lands without waiting out the sweeper.
    expect(env.api.hangupDmCall).toHaveBeenCalledWith("call-1");
    expect(env.controller.getState().phase).toBe("ended");
    expect(env.controller.getState().endedReason).toBe("hung_up");
  });

  it("treats an UNKNOWN participant count as 'someone is still here'", async () => {
    await callerActive(env);
    env.setRemoteCount(null); // the platform cannot answer

    await env.controller.leaveRoom();

    // The two ways of being wrong are not symmetric: guessing "alone" cuts a live
    // conversation, guessing "occupied" costs a slightly late history line that
    // the server's alone-grace sweep writes anyway.
    expect(env.api.hangupDmCall).not.toHaveBeenCalled();
    expect(env.controller.getState().phase).toBe("active");
    expect(env.controller.getState().seat).toBe("vacant");
  });

  it("can walk back into the call it left", async () => {
    await callerActive(env);
    env.setRemoteCount(1);
    await env.controller.leaveRoom();
    expect(env.controller.getState().seat).toBe("vacant");

    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, false));
    env.engine.join.mockClear();

    await env.controller.joinHere();

    expect(env.engine.join).toHaveBeenCalledWith("dmcall:call-1", GRANT);
    expect(env.controller.getState().seat).toBe("here");
    expect(env.controller.getState().phase).toBe("active");
  });

  it("is a no-op when this device does not hold the seat", async () => {
    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, true));
    await env.controller.resyncActiveCall("reconnect");
    expect(env.controller.getState().seat).toBe("elsewhere");

    await env.controller.leaveRoom();

    // Leaving a room we are not in would tear down whatever session this device
    // IS in — a server voice channel, most likely.
    expect(env.engine.leave).not.toHaveBeenCalled();
    expect(env.api.hangupDmCall).not.toHaveBeenCalled();
    expect(env.controller.getState().phase).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// The handoff (ADR 0023 §3) and the terminal fan-out (§4)
// ---------------------------------------------------------------------------

describe("device handoff", () => {
  it("reports an eviction as a moved SEAT, never as an ended call", async () => {
    await callerActive(env);

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
    // The engine evicted itself; asking it to leave would be a second teardown.
    expect(env.engine.leave).not.toHaveBeenCalled();
  });

  it("clears the band when the call really does end on the other device", async () => {
    const live = dmCall({ status: "active", startedAt: "2026-01-01T00:00:05.000Z" });
    env.api.getActiveDmCall.mockResolvedValue(activeResponse(live, true));
    await env.controller.resyncActiveCall("reconnect");
    expect(env.controller.getState().seat).toBe("elsewhere");

    // The terminal now reaches BOTH participants' every session (ADR 0023 §4) —
    // without that, this band hangs here until the next resync.
    env.controller.applyServerEvent(
      serverEvent.callEnded({ callId: "call-1", reason: "hung_up" }),
    );

    expect(env.controller.getState().phase).toBe("ended");
    // …and it must not have torn down media it never held.
    expect(env.engine.leave).not.toHaveBeenCalled();
  });
});
