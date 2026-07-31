/**
 * The YouTube postMessage wire (M20, ADR 0016).
 *
 * The parser is the part worth testing: it runs inside a `window.message`
 * listener on data from a third party we do not control, so "malformed input
 * throws" would mean one bad frame silently killing sync for the rest of the
 * session.
 */

import { describe, expect, it } from "vitest";
import {
  commandFrame,
  foldPlaying,
  isEngaged,
  listeningFrame,
  loadVideoCommand,
  parsePlayerMessage,
  pauseCommand,
  playCommand,
  playerErrorKind,
  seekCommand,
  PLAYER_STATE,
} from "../watch-player-protocol.js";

describe("outbound frames", () => {
  it("builds the handshake the embed needs before it says anything", () => {
    expect(JSON.parse(listeningFrame("p1"))).toEqual({
      event: "listening",
      id: "p1",
      channel: "widget",
    });
  });

  it("builds transport commands", () => {
    expect(JSON.parse(playCommand())).toEqual({ event: "command", func: "playVideo", args: [] });
    expect(JSON.parse(pauseCommand())).toEqual({
      event: "command",
      func: "pauseVideo",
      args: [],
    });
  });

  it("asks a seek to fetch the unbuffered range, so a correction actually lands", () => {
    expect(JSON.parse(seekCommand(42.5))).toEqual({
      event: "command",
      func: "seekTo",
      args: [42.5, true],
    });
  });

  it("never emits a negative position", () => {
    expect(JSON.parse(seekCommand(-10)).args[0]).toBe(0);
    expect(JSON.parse(loadVideoCommand("dQw4w9WgXcQ", -5)).args[0].startSeconds).toBe(0);
  });

  it("swaps the video in place instead of remounting the frame", () => {
    expect(JSON.parse(loadVideoCommand("dQw4w9WgXcQ", 90.9))).toEqual({
      event: "command",
      func: "loadVideoById",
      args: [{ videoId: "dQw4w9WgXcQ", startSeconds: 90 }],
    });
  });

  it("serializes an arbitrary command with its args", () => {
    expect(JSON.parse(commandFrame("setVolume", [50]))).toEqual({
      event: "command",
      func: "setVolume",
      args: [50],
    });
  });
});

describe("parsePlayerMessage", () => {
  it("reads a state delivery", () => {
    const frame = JSON.stringify({
      event: "infoDelivery",
      info: { currentTime: 12.5, playerState: 1, duration: 300 },
    });
    expect(parsePlayerMessage(frame)).toEqual({
      kind: "state",
      currentTime: 12.5,
      playerState: PLAYER_STATE.playing,
      duration: 300,
    });
  });

  it("reads a bare state change, leaving the fields it does not carry as null", () => {
    // The caller must keep its own last-known position; treating these nulls as
    // zero would seek everyone to the start on every state change.
    expect(parsePlayerMessage(JSON.stringify({ event: "onStateChange", info: 2 }))).toEqual({
      kind: "state",
      playerState: PLAYER_STATE.paused,
      currentTime: null,
      duration: null,
    });
  });

  it("reads ready and error frames", () => {
    expect(parsePlayerMessage(JSON.stringify({ event: "onReady" }))).toEqual({ kind: "ready" });
    expect(parsePlayerMessage(JSON.stringify({ event: "onError", info: 150 }))).toEqual({
      kind: "error",
      code: 150,
    });
  });

  it("survives everything a third party can throw at it", () => {
    for (const data of [
      "not json",
      "",
      "null",
      "[]",
      JSON.stringify({ noEvent: true }),
      JSON.stringify({ event: 42 }),
      JSON.stringify({ event: "infoDelivery" }),
      JSON.stringify({ event: "infoDelivery", info: null }),
      JSON.stringify({ event: "infoDelivery", info: { videoUrl: "x" } }),
      JSON.stringify({ event: "onStateChange", info: 99 }),
      JSON.stringify({ event: "onError", info: "boom" }),
      undefined,
      42,
    ]) {
      expect(parsePlayerMessage(data)).toEqual({ kind: "unknown" });
    }
  });

  it("rejects non-finite numbers rather than passing NaN into a seek", () => {
    expect(
      parsePlayerMessage({ event: "infoDelivery", info: { currentTime: Number.NaN } }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("player state interpretation", () => {
  it("treats buffering as engaged, so the autoplay gate does not accuse a loading player", () => {
    expect(isEngaged(PLAYER_STATE.playing)).toBe(true);
    expect(isEngaged(PLAYER_STATE.buffering)).toBe(true);
    expect(isEngaged(PLAYER_STATE.paused)).toBe(false);
    expect(isEngaged(null)).toBe(false);
  });

  it("does NOT read a buffering stall as the host pressing pause", () => {
    // The bug this prevents: the host's connection hiccups, their player reports
    // BUFFERING, and a naive read broadcasts a pause that stops the film for the
    // whole room.
    expect(foldPlaying(true, PLAYER_STATE.buffering)).toBe(true);
    expect(foldPlaying(true, PLAYER_STATE.unstarted)).toBe(true);
    expect(foldPlaying(true, PLAYER_STATE.cued)).toBe(true);
    expect(foldPlaying(true, null)).toBe(true);
    // The three states that ARE decisions.
    expect(foldPlaying(true, PLAYER_STATE.paused)).toBe(false);
    expect(foldPlaying(true, PLAYER_STATE.ended)).toBe(false);
    expect(foldPlaying(false, PLAYER_STATE.playing)).toBe(true);
  });
});

describe("playerErrorKind", () => {
  it("separates 'the owner forbade embedding' from everything else", () => {
    // Not a bug, not a network problem, not fixable by retrying — the host has
    // to pick a different link, and the copy has to say so.
    expect(playerErrorKind(101)).toBe("embedDisabled");
    expect(playerErrorKind(150)).toBe("embedDisabled");
    expect(playerErrorKind(100)).toBe("notFound");
    expect(playerErrorKind(2)).toBe("playbackFailed");
    expect(playerErrorKind(5)).toBe("playbackFailed");
    // An unknown future code must not be given a confidently wrong explanation.
    expect(playerErrorKind(999)).toBe("playbackFailed");
  });
});
