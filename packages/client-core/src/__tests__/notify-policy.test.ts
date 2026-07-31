/**
 * The alert gate — the rule that decides whether the founder ever learns a
 * message arrived. Every case below is a real reported failure or the boundary
 * next to one, so a regression here is a message someone never sees.
 */

import { describe, expect, it } from "vitest";
import {
  isAppInForeground,
  isTargetVisible,
  shouldNotify,
  shouldPlayMessageCue,
  shouldShowForegroundPush,
  type VisibleContext,
} from "../notify-policy.js";

/** Foreground, looking at `streamId` (null = a non-conversation screen). */
function ctx(over: Partial<VisibleContext> = {}): VisibleContext {
  return { focused: true, hidden: false, streamId: null, surface: null, ...over };
}

const GATE = {
  enabled: true,
  doNotDisturb: false,
  hasSink: true,
  hasTranslator: true,
} as const;

describe("isAppInForeground", () => {
  it("needs focus AND not hidden", () => {
    expect(isAppInForeground(ctx())).toBe(true);
    expect(isAppInForeground(ctx({ focused: false }))).toBe(false);
    // A focused window that is minimized / a background tab is not being read.
    expect(isAppInForeground(ctx({ hidden: true }))).toBe(false);
  });
});

describe("isTargetVisible", () => {
  it("is true only for the stream actually on screen", () => {
    const visible = ctx({ streamId: "general" });
    expect(isTargetVisible({ kind: "stream", streamId: "general" }, visible)).toBe(true);
    // THE BUG: a DM arriving while #general is open must not count as visible.
    expect(isTargetVisible({ kind: "stream", streamId: "dm-42" }, visible)).toBe(false);
  });

  it("is false for any stream when the app is not in the foreground", () => {
    const bg = ctx({ streamId: "general", focused: false });
    expect(isTargetVisible({ kind: "stream", streamId: "general" }, bg)).toBe(false);
  });

  it("is false when no conversation is on screen at all", () => {
    // Friends / settings / a call / the video stage — nothing is being read.
    expect(isTargetVisible({ kind: "stream", streamId: "general" }, ctx())).toBe(false);
  });

  it("matches surfaces and treats app-level targets as always visible in front", () => {
    expect(isTargetVisible({ kind: "surface", surface: "friends" }, ctx({ surface: "friends" })))
      .toBe(true);
    expect(isTargetVisible({ kind: "surface", surface: "friends" }, ctx({ surface: "recentCalls" })))
      .toBe(false);
    expect(isTargetVisible({ kind: "app" }, ctx())).toBe(true);
    expect(isTargetVisible({ kind: "app" }, ctx({ focused: false }))).toBe(false);
  });
});

describe("shouldNotify", () => {
  const target = { kind: "stream", streamId: "dm-42" } as const;

  it("alerts for a different conversation while the app is open", () => {
    expect(shouldNotify({ ...GATE, target, visible: ctx({ streamId: "general" }) })).toBe(true);
  });

  it("stays silent only for the conversation on screen", () => {
    expect(shouldNotify({ ...GATE, target, visible: ctx({ streamId: "dm-42" }) })).toBe(false);
  });

  it("alerts when the app is backgrounded", () => {
    expect(
      shouldNotify({ ...GATE, target, visible: ctx({ streamId: "dm-42", focused: false }) }),
    ).toBe(true);
  });

  it("honors every independent suppressor", () => {
    const visible = ctx({ streamId: "general" });
    expect(shouldNotify({ ...GATE, doNotDisturb: true, target, visible })).toBe(false);
    expect(shouldNotify({ ...GATE, enabled: false, target, visible })).toBe(false);
    expect(shouldNotify({ ...GATE, hasSink: false, target, visible })).toBe(false);
    expect(shouldNotify({ ...GATE, hasTranslator: false, target, visible })).toBe(false);
  });
});

describe("shouldPlayMessageCue", () => {
  it("mirrors the toast gate so cue and toast cannot drift", () => {
    const base = { doNotDisturb: false, streamId: "dm-42" };
    expect(shouldPlayMessageCue({ ...base, visible: ctx({ streamId: "general" }) })).toBe(true);
    expect(shouldPlayMessageCue({ ...base, visible: ctx({ streamId: "dm-42" }) })).toBe(false);
    expect(shouldPlayMessageCue({ ...base, doNotDisturb: true, visible: ctx() })).toBe(false);
  });
});

describe("shouldShowForegroundPush", () => {
  it("suppresses only the conversation being read", () => {
    expect(
      shouldShowForegroundPush({ streamId: "dm-42", visible: ctx({ streamId: "dm-42" }) }),
    ).toBe(false);
    expect(
      shouldShowForegroundPush({ streamId: "dm-42", visible: ctx({ streamId: "general" }) }),
    ).toBe(true);
  });

  it("always shows a push that is not about a conversation", () => {
    // Friend requests, call notices — nothing on screen can BE them.
    expect(shouldShowForegroundPush({ streamId: null, visible: ctx() })).toBe(true);
  });

  it("shows a covered conversation's push", () => {
    // The mobile regression: the thread is mounted but a pushed screen (voice
    // room / settings) is on top, so the host reports no visible stream.
    expect(shouldShowForegroundPush({ streamId: "dm-42", visible: ctx({ streamId: null }) })).toBe(
      true,
    );
  });
});
