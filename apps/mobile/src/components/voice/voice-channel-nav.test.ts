/**
 * The M20 voice gesture, on mobile.
 *
 * What these lock is behaviour a type error would never catch: a tap on a voice
 * channel CONNECTS you (the founder's most-used voice gesture),
 * the same tap on the room you are ALREADY in does not re-run a join, and the
 * separate read control connects to nothing ever. The rules themselves live in
 * `@demli/client-core` and are exercised there too; this file covers the
 * mobile translation into route intents, which is where a "simplification" would
 * actually cost the gesture.
 */

import { describe, expect, it } from "vitest";
import type { ChannelId } from "@demli/types";
import {
  initialVoiceView,
  parseVoiceScreenIntent,
  shouldAutoJoinOnMount,
  VOICE_READ_INTENT,
  voiceRowTapIntent,
} from "./voice-channel-nav";

const LOBBY = "lobby" as ChannelId;
const GAMES = "games" as ChannelId;

describe("tapping a voice channel row", () => {
  it("JOINS when we are in no room at all", () => {
    const intent = voiceRowTapIntent(LOBBY, { voiceRoomId: null, voiceStatus: "idle" });
    expect(intent).toBe("join");
    expect(shouldAutoJoinOnMount(intent)).toBe(true);
    expect(initialVoiceView(intent)).toBe("stage");
  });

  it("JOINS when we are connected to a DIFFERENT room", () => {
    const intent = voiceRowTapIntent(LOBBY, { voiceRoomId: GAMES, voiceStatus: "connected" });
    expect(intent).toBe("join");
    expect(shouldAutoJoinOnMount(intent)).toBe(true);
  });

  it("does NOT join the room we are already in — it only opens its chat", () => {
    for (const voiceStatus of ["connected", "joining", "reconnecting", "error"]) {
      const intent = voiceRowTapIntent(LOBBY, { voiceRoomId: LOBBY, voiceStatus });
      expect(intent).toBe("chat");
      // The whole point: mounting the screen must not put the live session
      // through a join for what the user meant as "show me the messages".
      expect(shouldAutoJoinOnMount(intent)).toBe(false);
      expect(initialVoiceView(intent)).toBe("chat");
    }
  });

  it("still joins a room whose id matches but whose session is idle", () => {
    // `roomId` can linger after a leave; only a non-idle status means we are in it.
    expect(voiceRowTapIntent(LOBBY, { voiceRoomId: LOBBY, voiceStatus: "idle" })).toBe("join");
  });
});

describe("the read control (chat icon / long-press entry)", () => {
  it("never joins — whatever the session is doing", () => {
    expect(VOICE_READ_INTENT).toBe("chat");
    expect(shouldAutoJoinOnMount(VOICE_READ_INTENT)).toBe(false);
    expect(initialVoiceView(VOICE_READ_INTENT)).toBe("chat");
  });
});

describe("route intent parsing", () => {
  it("defaults to join, so every pre-M20 caller keeps connecting", () => {
    // The mini bar, push deep links and the command palette pass no intent at
    // all; silently turning those into reads would break returning to a call.
    expect(parseVoiceScreenIntent(undefined)).toBe("join");
    expect(parseVoiceScreenIntent("")).toBe("join");
    expect(parseVoiceScreenIntent("nonsense")).toBe("join");
  });

  it("reads an explicit chat intent, including expo-router's array form", () => {
    expect(parseVoiceScreenIntent("chat")).toBe("chat");
    expect(parseVoiceScreenIntent(["chat"])).toBe("chat");
  });

  it("round-trips what the row produces", () => {
    const tap = voiceRowTapIntent(LOBBY, { voiceRoomId: LOBBY, voiceStatus: "connected" });
    expect(parseVoiceScreenIntent(tap)).toBe(tap);
    expect(parseVoiceScreenIntent(VOICE_READ_INTENT)).toBe(VOICE_READ_INTENT);
  });
});
