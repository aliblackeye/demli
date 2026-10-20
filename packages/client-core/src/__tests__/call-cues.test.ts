import { describe, expect, it } from "vitest";
import type { CallId } from "@demli/types";
import { callTransitionCue, isCallRoomId } from "../dm-calls/call-cues.js";
import { initialCallState, type CallState } from "../dm-calls/call-state.js";

function state(overrides: Partial<CallState>): CallState {
  return { ...initialCallState, callId: "call-1" as CallId, ...overrides };
}

const outgoing = state({ phase: "outgoing", role: "caller", seat: "here" });
const incoming = state({ phase: "incoming", role: "callee", seat: "vacant" });
const active = state({ phase: "active", role: "caller", seat: "here" });
const ended = (reason: CallState["endedReason"], seat: CallState["seat"] = "vacant") =>
  state({ phase: "ended", endedReason: reason, seat });

describe("isCallRoomId", () => {
  it("recognises dmcall rooms only", () => {
    expect(isCallRoomId("dmcall:abc")).toBe(true);
    expect(isCallRoomId("8b1f-channel-id")).toBe(false);
    expect(isCallRoomId(null)).toBe(false);
    expect(isCallRoomId(undefined)).toBe(false);
  });
});

describe("callTransitionCue", () => {
  it("cues call-connected when a ringing call goes active (both roles)", () => {
    expect(callTransitionCue(outgoing, active)).toBe("call-connected");
    expect(callTransitionCue(incoming, { ...active, role: "callee" })).toBe("call-connected");
  });

  it("stays quiet when the call went live on another device of this account", () => {
    expect(callTransitionCue(incoming, { ...active, seat: "elsewhere" })).toBeNull();
  });

  it("cues call-connected on accept-and-switch (active → a different active call)", () => {
    const next = { ...active, callId: "call-2" as CallId };
    expect(callTransitionCue(active, next)).toBe("call-connected");
  });

  it("never re-cues an unchanged active call (seat moves, pending flips, upgrade re-point)", () => {
    expect(callTransitionCue(active, { ...active, seat: "vacant" })).toBeNull();
    expect(callTransitionCue(active, { ...active, pending: true })).toBeNull();
  });

  it("cues call-ended when an active call ends, error when it failed", () => {
    expect(callTransitionCue(active, ended("hung_up"))).toBe("call-ended");
    expect(callTransitionCue(active, ended("session_replaced"))).toBe("call-ended");
    expect(callTransitionCue(active, ended("failed"))).toBe("error");
  });

  it("stays quiet on a seamless group upgrade — the conversation continues", () => {
    expect(callTransitionCue(active, ended("upgraded"))).toBeNull();
  });

  it("stays quiet when the ended call was seated on another device", () => {
    expect(callTransitionCue({ ...active, seat: "elsewhere" }, ended("hung_up"))).toBeNull();
  });

  it("tells the caller an unanswered call is over", () => {
    for (const r of ["declined", "busy", "timeout", "canceled"] as const) {
      expect(callTransitionCue(outgoing, ended(r))).toBe("call-ended");
    }
    expect(callTransitionCue(outgoing, ended("failed"))).toBe("error");
  });

  it("cues the callee only when THEY declined — a missed call is the ring stopping", () => {
    expect(callTransitionCue(incoming, ended("declined"))).toBe("call-ended");
    expect(callTransitionCue(incoming, ended("canceled"))).toBeNull();
    expect(callTransitionCue(incoming, ended("timeout"))).toBeNull();
  });

  it("ignores ended → ended and ended/idle → idle", () => {
    expect(callTransitionCue(ended("hung_up"), ended("hung_up"))).toBeNull();
    expect(callTransitionCue(ended("hung_up"), initialCallState)).toBeNull();
    expect(callTransitionCue(initialCallState, initialCallState)).toBeNull();
  });
});
