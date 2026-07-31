/**
 * The M20 rules these lock: a click on a voice channel CONNECTS you, reading
 * without connecting stays available on its own control, and
 * the room you are already in is never rejoined by a click that only meant
 * "show me the messages".
 */

import { describe, expect, it } from "vitest";
import type { ChannelId } from "@demli/types";
import {
  isVoiceSessionFor,
  voiceChatHeaderActions,
  voiceMenuRoomAction,
  voiceRowClickAction,
} from "./voice-channel-chat";

const LOBBY = "lobby" as ChannelId;
const GAMES = "games" as ChannelId;

describe("isVoiceSessionFor", () => {
  it("is true only for the room the engine is actually in", () => {
    expect(
      isVoiceSessionFor(LOBBY, { voiceRoomId: LOBBY, voiceStatus: "connected" }),
    ).toBe(true);
    expect(
      isVoiceSessionFor(LOBBY, { voiceRoomId: GAMES, voiceStatus: "connected" }),
    ).toBe(false);
  });

  it("counts a session that is still settling — joining and reconnecting", () => {
    // Otherwise an impatient second click mid-handshake would fire a SECOND join
    // at the room we are already entering.
    for (const status of ["joining", "reconnecting"]) {
      expect(isVoiceSessionFor(LOBBY, { voiceRoomId: LOBBY, voiceStatus: status })).toBe(
        true,
      );
    }
  });

  it("is false while idle, even if a stale room id lingers", () => {
    expect(isVoiceSessionFor(LOBBY, { voiceRoomId: LOBBY, voiceStatus: "idle" })).toBe(
      false,
    );
  });
});

describe("voiceRowClickAction — the primary gesture", () => {
  it("JOINS from idle: one click connects you", () => {
    expect(voiceRowClickAction(LOBBY, { voiceRoomId: null, voiceStatus: "idle" })).toBe(
      "join",
    );
  });

  it("joins when we are sitting in a DIFFERENT room — a click moves you", () => {
    expect(
      voiceRowClickAction(LOBBY, { voiceRoomId: GAMES, voiceStatus: "connected" }),
    ).toBe("join");
  });

  it("does NOT rejoin the room we are already in — it opens the chat", () => {
    // The point of the exception: clicking your current room means "show me what
    // was said", and running that through the join path would move the voice FSM
    // for a request that was purely about the view.
    expect(
      voiceRowClickAction(LOBBY, { voiceRoomId: LOBBY, voiceStatus: "connected" }),
    ).toBe("open-chat");
  });

  it("does not rejoin mid-handshake either", () => {
    for (const status of ["joining", "reconnecting"]) {
      expect(voiceRowClickAction(LOBBY, { voiceRoomId: LOBBY, voiceStatus: status })).toBe(
        "open-chat",
      );
    }
  });

  it("never disconnects — a misclick must not end a call", () => {
    const cases = [
      { voiceRoomId: null, voiceStatus: "idle" },
      { voiceRoomId: GAMES, voiceStatus: "connected" },
      { voiceRoomId: LOBBY, voiceStatus: "connected" },
    ];
    for (const facts of cases) {
      expect(voiceRowClickAction(LOBBY, facts)).not.toBe("leave");
    }
  });
});

describe("voiceMenuRoomAction — the context menu's room entry", () => {
  it("offers join for a room we are not in", () => {
    expect(voiceMenuRoomAction(LOBBY, { voiceRoomId: null, voiceStatus: "idle" })).toBe(
      "join",
    );
    expect(
      voiceMenuRoomAction(LOBBY, { voiceRoomId: GAMES, voiceStatus: "connected" }),
    ).toBe("join");
  });

  it("offers leave for the room we are in — the deliberate surface for it", () => {
    expect(
      voiceMenuRoomAction(LOBBY, { voiceRoomId: LOBBY, voiceStatus: "connected" }),
    ).toBe("leave");
  });
});

describe("voiceChatHeaderActions", () => {
  const base = { hasStageVideo: false, stageFocused: false };

  it("offers only join while reading a channel we are not connected to", () => {
    expect(
      voiceChatHeaderActions(LOBBY, { ...base, voiceRoomId: null, voiceStatus: "idle" }),
    ).toEqual(["join"]);
  });

  it("still offers join — not leave — while sitting in a DIFFERENT room", () => {
    // Reading #lobby's chat from inside #games must never put a disconnect
    // button in front of the user: the button they want is "move me here".
    expect(
      voiceChatHeaderActions(LOBBY, {
        ...base,
        voiceRoomId: GAMES,
        voiceStatus: "connected",
      }),
    ).toEqual(["join"]);
  });

  it("offers the stage back when there is video we are not looking at", () => {
    expect(
      voiceChatHeaderActions(LOBBY, {
        voiceRoomId: LOBBY,
        voiceStatus: "connected",
        hasStageVideo: true,
        stageFocused: false,
      }),
    ).toEqual(["return-to-stage", "leave"]);
  });

  it("hides the stage control when there is no video to return to", () => {
    // With no camera or share the center stays chat whatever the stage intent
    // says, so the button would do nothing visible (§35).
    expect(
      voiceChatHeaderActions(LOBBY, {
        voiceRoomId: LOBBY,
        voiceStatus: "connected",
        hasStageVideo: false,
        stageFocused: false,
      }),
    ).toEqual(["leave"]);
  });

  it("hides it again once the stage IS the center", () => {
    expect(
      voiceChatHeaderActions(LOBBY, {
        voiceRoomId: LOBBY,
        voiceStatus: "connected",
        hasStageVideo: true,
        stageFocused: true,
      }),
    ).toEqual(["leave"]);
  });
});
