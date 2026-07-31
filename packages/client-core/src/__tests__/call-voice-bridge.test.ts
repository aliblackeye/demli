/**
 * The voice↔call bridge (call-UX plan K2.3/K2.4/K2.8).
 *
 * These are the decisions that used to live ONLY in the desktop renderer's glue,
 * which is why the phone kept the old behavior after the shared fixes landed: the
 * controller could repair a broken call, but nothing on mobile ever told it media
 * had died, and its join threw from a `leaving` engine. Both halves are now
 * platform-independent, so they are tested once, here.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createCallEngineAdapter,
  decideCallMediaOutcome,
  watchCallMedia,
  type CallController,
  type CallState,
  type VoiceSnapshot,
} from "../dm-calls/index.js";
import { initialCallState } from "../dm-calls/call-state.js";

// --- fakes ------------------------------------------------------------------

/** A minimal fake voice FSM: settable snapshot + subscribers. */
function fakeVoice(initial: Partial<VoiceSnapshot> = {}) {
  let state: VoiceSnapshot = {
    status: "idle",
    roomId: null,
    endedReason: null,
    ...initial,
  };
  const listeners = new Set<(s: VoiceSnapshot) => void>();
  return {
    getState: (): VoiceSnapshot => state,
    subscribe: (listener: (s: VoiceSnapshot) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: (): number => listeners.size,
    set(next: Partial<VoiceSnapshot>): void {
      state = { ...state, ...next };
      for (const listener of [...listeners]) listener(state);
    },
  };
}

function callState(overrides: Partial<CallState> = {}): CallState {
  return { ...initialCallState, ...overrides };
}

const dmSurface = { kind: "dm", dmId: "dm-1" } as CallState["surface"];
const groupSurface = {
  kind: "group",
  groupId: "g-1",
  voiceChannelId: "ch-1",
} as CallState["surface"];

/**
 * An active DM call whose media room is `dmcall:call-1` AND whose seat is on THIS
 * device — the only configuration in which an idle/erroring engine means this
 * call's media died (ADR 0023 §1). Tests that vary the seat pass it explicitly.
 */
function activeDmCall(overrides: Partial<CallState> = {}): CallState {
  return callState({
    phase: "active",
    seat: "here",
    callId: "call-1",
    roomName: "dmcall:call-1",
    surface: dmSurface,
    ...overrides,
  });
}

// --- createCallEngineAdapter (K2.3 / K2.8) ----------------------------------

describe("createCallEngineAdapter", () => {
  it("joins straight through from idle", async () => {
    const voice = fakeVoice();
    const join = vi.fn().mockResolvedValue(undefined);
    const leave = vi.fn().mockResolvedValue(undefined);
    const engine = createCallEngineAdapter({
      getVoiceState: voice.getState,
      subscribeVoice: voice.subscribe,
      join,
      leave,
    });

    await engine.join("dmcall:call-1", { url: "wss://lk", token: "t" });

    expect(leave).not.toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith("dmcall:call-1", { url: "wss://lk", token: "t" });
  });

  it("leaves the current room first when the engine is live (JOIN is idle/error-only)", async () => {
    const voice = fakeVoice({ status: "connected", roomId: "channel-9" });
    const order: string[] = [];
    const engine = createCallEngineAdapter({
      getVoiceState: voice.getState,
      subscribeVoice: voice.subscribe,
      join: async () => {
        order.push("join");
      },
      leave: async () => {
        order.push("leave");
      },
    });

    await engine.join("dmcall:call-1");

    expect(order).toEqual(["leave", "join"]);
  });

  it("WAITS OUT a `leaving` teardown instead of throwing (K2.8)", async () => {
    const voice = fakeVoice({ status: "leaving", roomId: "channel-9" });
    const join = vi.fn().mockResolvedValue(undefined);
    const leave = vi.fn().mockResolvedValue(undefined);
    const engine = createCallEngineAdapter({
      getVoiceState: voice.getState,
      subscribeVoice: voice.subscribe,
      join,
      leave,
    });

    let settled = false;
    const pending = engine.join("dmcall:call-1").then(() => {
      settled = true;
    });

    await Promise.resolve();
    // Still tearing down → the join must not have fired yet, and LEAVE must not be
    // called either (it is illegal from `leaving` too).
    expect(join).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    voice.set({ status: "idle", roomId: null });
    await pending;

    expect(join).toHaveBeenCalledWith("dmcall:call-1", undefined);
    expect(voice.listenerCount()).toBe(0); // the wait released its listener
  });

  it("gives up on a wedged `leaving` after the timeout and joins anyway", async () => {
    vi.useFakeTimers();
    try {
      const voice = fakeVoice({ status: "leaving", roomId: "channel-9" });
      const join = vi.fn().mockResolvedValue(undefined);
      const engine = createCallEngineAdapter({
        getVoiceState: voice.getState,
        subscribeVoice: voice.subscribe,
        join,
        leave: vi.fn().mockResolvedValue(undefined),
        leavingWaitMs: 4_000,
      });

      const pending = engine.join("dmcall:call-1");
      await vi.advanceTimersByTimeAsync(4_000);
      await pending;

      expect(join).toHaveBeenCalledTimes(1);
      expect(voice.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs beforeJoin after the engine is legal to join, before the join", async () => {
    const voice = fakeVoice({ status: "connected", roomId: "channel-9" });
    const order: string[] = [];
    const engine = createCallEngineAdapter({
      getVoiceState: voice.getState,
      subscribeVoice: voice.subscribe,
      join: async () => {
        order.push("join");
      },
      leave: async () => {
        order.push("leave");
      },
      beforeJoin: async () => {
        order.push("before");
      },
    });

    await engine.join("dmcall:call-1");

    expect(order).toEqual(["leave", "before", "join"]);
  });

  it("isConnectedTo answers from the voice FSM, not from an assumption (K2.3)", () => {
    const voice = fakeVoice({ status: "connected", roomId: "dmcall:call-1" });
    const engine = createCallEngineAdapter({
      getVoiceState: voice.getState,
      subscribeVoice: voice.subscribe,
      join: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
    });

    expect(engine.isConnectedTo?.("dmcall:call-1")).toBe(true);
    // Reconnecting still counts as live — the session is coming back, and
    // re-joining it would tear the working room down.
    voice.set({ status: "reconnecting" });
    expect(engine.isConnectedTo?.("dmcall:call-1")).toBe(true);
    // The founder's "odadayım, hiçbir şey duymuyorum": the call FSM says active,
    // the engine says nothing is up. This MUST read false so the resync repairs it.
    voice.set({ status: "idle", roomId: null });
    expect(engine.isConnectedTo?.("dmcall:call-1")).toBe(false);
    voice.set({ status: "connected", roomId: "some-other-room" });
    expect(engine.isConnectedTo?.("dmcall:call-1")).toBe(false);
  });
});

// --- decideCallMediaOutcome (K2.4) ------------------------------------------

describe("decideCallMediaOutcome", () => {
  const idleVoice: VoiceSnapshot = { status: "idle", roomId: null, endedReason: null };

  it("reports a failure when the engine ERRORS on the call's own room", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall(),
        voice: { status: "error", roomId: "dmcall:call-1", endedReason: null },
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("report_failure");
  });

  it("reports a failure when media we HAD goes idle with no attributed reason", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall(),
        voice: idleVoice,
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("report_failure");
  });

  it("ignores an idle engine during the pre-join window of an outgoing call", () => {
    expect(
      decideCallMediaOutcome({
        call: callState({
          phase: "outgoing",
          callId: "call-1",
          roomName: "dmcall:call-1",
          surface: dmSurface,
        }),
        voice: idleVoice,
        previousRoomId: null,
      }),
    ).toBe("none");
  });

  it("never reacts while a control action is pending (accept / accept-and-switch)", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall({ pending: true }),
        voice: idleVoice,
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("none");
  });

  it("never ends the call on session_replaced — it is LIVE on the other device", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall(),
        voice: { status: "idle", roomId: null, endedReason: "session_replaced" },
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("none");
  });

  it("never ends the call on `alone` — the server's own call.ended follows", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall(),
        voice: { status: "idle", roomId: null, endedReason: "alone" },
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("none");
  });

  it("only DISMISSES a post-upgrade group surface (its row already closed)", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall({ surface: groupSurface, roomName: "dmcall:call-1" }),
        voice: idleVoice,
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("dismiss");
    expect(
      decideCallMediaOutcome({
        call: activeDmCall({ surface: groupSurface }),
        voice: { status: "error", roomId: "dmcall:call-1", endedReason: null },
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("dismiss");
  });

  /**
   * ADR 0023 §2: "Leave" releases the seat and leaves the CALL alive. The engine
   * goes idle exactly as it does when a session dies, so without the seat guard
   * this watcher would report a media failure and hang up on the peer — turning
   * the new leave straight back into the old hang-up.
   */
  it("does not touch the call when the user deliberately LEFT the room", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall({ seat: "vacant" }),
        voice: idleVoice,
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("none");
  });

  /**
   * The other half: the account's seat moved to another device (single-session
   * eviction). Ending here would end the call the user is holding in their hand.
   */
  it("does not touch the call when the seat is on ANOTHER device", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall({ seat: "elsewhere" }),
        voice: idleVoice,
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("none");
    expect(
      decideCallMediaOutcome({
        call: activeDmCall({ seat: "elsewhere" }),
        voice: { status: "error", roomId: "dmcall:call-1", endedReason: null },
        previousRoomId: "dmcall:call-1",
      }),
    ).toBe("none");
  });

  it("ignores an error on a room that is not the call's", () => {
    expect(
      decideCallMediaOutcome({
        call: activeDmCall(),
        voice: { status: "error", roomId: "channel-9", endedReason: null },
        previousRoomId: "channel-9",
      }),
    ).toBe("none");
  });

  it("ignores everything when no call is live", () => {
    for (const call of [callState(), callState({ phase: "ended", callId: "call-1" })]) {
      expect(
        decideCallMediaOutcome({
          call,
          voice: { status: "error", roomId: "dmcall:call-1", endedReason: null },
          previousRoomId: "dmcall:call-1",
        }),
      ).toBe("none");
    }
  });
});

// --- watchCallMedia ---------------------------------------------------------

describe("watchCallMedia", () => {
  function fakeController(state: CallState) {
    return {
      getState: () => state,
      dismiss: vi.fn(),
      reportMediaFailure: vi.fn(),
    } as unknown as CallController & {
      dismiss: ReturnType<typeof vi.fn>;
      reportMediaFailure: ReturnType<typeof vi.fn>;
    };
  }

  it("tracks the previous roomId across notifications and retires a dead DM call", () => {
    const voice = fakeVoice();
    const controller = fakeController(activeDmCall());
    watchCallMedia({ subscribeVoice: voice.subscribe, getController: () => controller });

    // Media comes up on the call room, then dies with no attributed reason.
    voice.set({ status: "connected", roomId: "dmcall:call-1" });
    expect(controller.reportMediaFailure).not.toHaveBeenCalled();
    voice.set({ status: "idle", roomId: null });

    expect(controller.reportMediaFailure).toHaveBeenCalledTimes(1);
    expect(controller.dismiss).not.toHaveBeenCalled();
  });

  it("is a no-op with no controller (signed out)", () => {
    const voice = fakeVoice();
    const unsubscribe = watchCallMedia({
      subscribeVoice: voice.subscribe,
      getController: () => null,
    });
    expect(() => voice.set({ status: "error", roomId: "dmcall:call-1" })).not.toThrow();
    unsubscribe();
    expect(voice.listenerCount()).toBe(0);
  });
});
