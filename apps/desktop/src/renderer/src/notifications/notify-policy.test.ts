/**
 * The notify rule, exercised THROUGH the renderer's import path.
 *
 * The rule itself moved to `@demli/client-core` and this module is now a
 * re-export, so these cases are deliberately kept rather than deleted: they are
 * the only thing that fails if the re-export is broken or drifts from what the
 * desktop callers actually import, and they cover more combinations than the
 * shared module's own suite. Behaviour changes belong in client-core; this file
 * asserts the desktop surface still resolves to them.
 */

import { describe, expect, it } from "vitest";
import {
  isAppInForeground,
  isTargetVisible,
  shouldNotify,
  shouldPlayMessageCue,
  type AlertTarget,
  type NotifyGateInput,
  type VisibleContext,
} from "./notify-policy";

/**
 * The founder-reported bug in one line: "biri mesaj atınca ve bende o kişinin
 * sohbetine o an bakmıyorsam bildirim gelmeli". The old rule was
 * `if (document.hasFocus()) return false`, which meant the app being open at all
 * suppressed everything. These tests pin the corrected rule so it cannot regress.
 */

const GENERAL = "chan_general";
const DM = "chan_dm";

/** Focused, visible, reading #general — the ONLY silent configuration. */
function reading(streamId: string): VisibleContext {
  return { focused: true, hidden: false, streamId, surface: null };
}

function gate(over: Partial<NotifyGateInput> = {}): NotifyGateInput {
  return {
    enabled: true,
    doNotDisturb: false,
    hasSink: true,
    hasTranslator: true,
    target: { kind: "stream", streamId: DM } as AlertTarget,
    visible: reading(GENERAL),
    ...over,
  };
}

describe("isAppInForeground", () => {
  it("requires focus AND visibility", () => {
    expect(isAppInForeground({ focused: true, hidden: false, streamId: null, surface: null })).toBe(true);
    expect(isAppInForeground({ focused: false, hidden: false, streamId: null, surface: null })).toBe(false);
    expect(isAppInForeground({ focused: true, hidden: true, streamId: null, surface: null })).toBe(false);
  });
});

describe("isTargetVisible", () => {
  it("is true only for the stream actually on screen", () => {
    expect(isTargetVisible({ kind: "stream", streamId: GENERAL }, reading(GENERAL))).toBe(true);
    expect(isTargetVisible({ kind: "stream", streamId: DM }, reading(GENERAL))).toBe(false);
  });

  it("is false for every stream when nothing conversational is painted", () => {
    const onFriends: VisibleContext = {
      focused: true,
      hidden: false,
      streamId: null,
      surface: "friends",
    };
    expect(isTargetVisible({ kind: "stream", streamId: GENERAL }, onFriends)).toBe(false);
    expect(isTargetVisible({ kind: "surface", surface: "friends" }, onFriends)).toBe(true);
    expect(isTargetVisible({ kind: "surface", surface: "recentCalls" }, onFriends)).toBe(false);
  });

  it("treats app-level alerts as visible whenever the app is in front", () => {
    expect(isTargetVisible({ kind: "app" }, reading(GENERAL))).toBe(true);
    expect(
      isTargetVisible({ kind: "app" }, { focused: false, hidden: false, streamId: null, surface: null }),
    ).toBe(false);
  });
});

describe("shouldNotify — the founder's rule", () => {
  it("does NOT notify while the user is looking at that very conversation", () => {
    expect(
      shouldNotify(gate({ target: { kind: "stream", streamId: GENERAL } })),
    ).toBe(false);
  });

  it("DOES notify when focused but reading a different conversation", () => {
    // The exact case that produced nothing before: app open on #general, DM lands.
    expect(shouldNotify(gate({ target: { kind: "stream", streamId: DM } }))).toBe(true);
  });

  it("DOES notify when the window is in the background", () => {
    expect(
      shouldNotify(
        gate({
          target: { kind: "stream", streamId: GENERAL },
          visible: { focused: false, hidden: false, streamId: GENERAL, surface: null },
        }),
      ),
    ).toBe(true);
  });

  it("DOES notify when the tab is hidden even though it reports focus", () => {
    expect(
      shouldNotify(
        gate({
          target: { kind: "stream", streamId: GENERAL },
          visible: { focused: true, hidden: true, streamId: GENERAL, surface: null },
        }),
      ),
    ).toBe(true);
  });

  it("DOES notify when a full-screen overlay hid the conversation (streamId cleared)", () => {
    // Settings open: visible-conversation.ts reports null for both fields.
    expect(
      shouldNotify(
        gate({
          target: { kind: "stream", streamId: GENERAL },
          visible: { focused: true, hidden: false, streamId: null, surface: null },
        }),
      ),
    ).toBe(true);
  });

  it("DOES notify while the video stage covers the chat (streamId cleared)", () => {
    expect(
      shouldNotify(
        gate({
          target: { kind: "stream", streamId: GENERAL },
          visible: { focused: true, hidden: false, streamId: null, surface: null },
        }),
      ),
    ).toBe(true);
  });

  it("never notifies in Do Not Disturb", () => {
    expect(shouldNotify(gate({ doNotDisturb: true }))).toBe(false);
    expect(
      shouldNotify(
        gate({
          doNotDisturb: true,
          visible: { focused: false, hidden: true, streamId: null, surface: null },
        }),
      ),
    ).toBe(false);
  });

  it("never notifies when the master switch is off", () => {
    expect(shouldNotify(gate({ enabled: false }))).toBe(false);
  });

  it("never notifies without a sink (no bridge at all)", () => {
    expect(shouldNotify(gate({ hasSink: false }))).toBe(false);
  });

  it("never notifies before the localizer is bound", () => {
    expect(shouldNotify(gate({ hasTranslator: false }))).toBe(false);
  });

  it("holds back a friend request only while the friends table is up", () => {
    const onFriends: VisibleContext = {
      focused: true,
      hidden: false,
      streamId: null,
      surface: "friends",
    };
    const target: AlertTarget = { kind: "surface", surface: "friends" };
    expect(shouldNotify(gate({ target, visible: onFriends }))).toBe(false);
    expect(shouldNotify(gate({ target, visible: reading(GENERAL) }))).toBe(true);
  });

  it("holds back an incoming call only while the app is in front (the ring overlay)", () => {
    const target: AlertTarget = { kind: "app" };
    expect(shouldNotify(gate({ target, visible: reading(GENERAL) }))).toBe(false);
    expect(
      shouldNotify(
        gate({ target, visible: { focused: false, hidden: false, streamId: null, surface: null } }),
      ),
    ).toBe(true);
  });
});

describe("shouldPlayMessageCue — same rule, so cue and toast cannot drift", () => {
  it("stays silent for the conversation on screen", () => {
    expect(
      shouldPlayMessageCue({ doNotDisturb: false, streamId: GENERAL, visible: reading(GENERAL) }),
    ).toBe(false);
  });

  it("plays for another conversation while focused", () => {
    expect(
      shouldPlayMessageCue({ doNotDisturb: false, streamId: DM, visible: reading(GENERAL) }),
    ).toBe(true);
  });

  it("plays in the background", () => {
    expect(
      shouldPlayMessageCue({
        doNotDisturb: false,
        streamId: GENERAL,
        visible: { focused: false, hidden: false, streamId: GENERAL, surface: null },
      }),
    ).toBe(true);
  });

  it("is silenced by Do Not Disturb", () => {
    expect(
      shouldPlayMessageCue({
        doNotDisturb: true,
        streamId: DM,
        visible: { focused: false, hidden: true, streamId: null, surface: null },
      }),
    ).toBe(false);
  });

  it("agrees with shouldNotify on every focus/stream combination", () => {
    const streams = [GENERAL, DM];
    for (const focused of [true, false]) {
      for (const hidden of [true, false]) {
        for (const onScreen of [...streams, null]) {
          for (const incoming of streams) {
            const visible: VisibleContext = { focused, hidden, streamId: onScreen, surface: null };
            const cue = shouldPlayMessageCue({ doNotDisturb: false, streamId: incoming, visible });
            const toast = shouldNotify(
              gate({ target: { kind: "stream", streamId: incoming }, visible }),
            );
            expect(cue).toBe(toast);
          }
        }
      }
    }
  });
});
