/**
 * Source-level invariants for voice-channel chat (M20).
 *
 * Three things can silently rot here and none shows up in a type error:
 *
 *  1. The row's click stops connecting you. Clicking a voice channel joining it
 *     is the founder's muscle memory; a refactor that
 *     "simplifies" the row down to a plain select would quietly cost the app its
 *     most-used voice gesture.
 *  2. Reading a voice channel WITHOUT joining loses its control. The capability
 *     exists server-side (visibility is the whole access rule, ADR 0007), so
 *     dropping the icon or the menu entry leaves a capability with no way to
 *     reach it (§35) — and on touch, where the icon is the only pointer path,
 *     making it hover-only would do the same thing invisibly.
 *  3. A SECOND chat implementation grows for voice ("just a small message list
 *     inside the stage"), and from then on pins, search, edit, reactions,
 *     attachments, the outbox and the unread divider have to be built twice.
 *     The scope note is explicit: reuse ChatView/ChatDataProvider verbatim.
 *
 * The renderer has no DOM harness (node-environment vitest), so the repo's
 * established way to assert component wiring is to read the source — the same
 * technique as ./destructive-actions-single-flow.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const COMPONENTS = fileURLToPath(new URL("../components/", import.meta.url));
const LIB = fileURLToPath(new URL("./", import.meta.url));

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

describe("clicking a voice channel connects you", () => {
  const row = read(COMPONENTS, "ChannelItem.tsx");
  const actions = read(LIB, "channel-actions.ts");

  it("routes a VOICE row's click through the join-bearing primary gesture", () => {
    expect(row).toMatch(
      /const handleClick = \(\): void =>\s*isVoice \? activateVoiceChannel\(channel, groupName\) : openChannelChat\(channel\)/,
    );
  });

  it("the primary gesture actually joins", () => {
    expect(actions).toMatch(
      /export function activateVoiceChannel[\s\S]{0,500}joinVoiceChannel\(channel, groupName\)/,
    );
  });

  it("but does NOT rejoin the room we are already in", () => {
    // Decided by the pure rule (covered exhaustively in ./voice-channel-chat.test.ts);
    // this asserts the action consults it rather than joining unconditionally.
    expect(actions).toMatch(/voiceRowClickAction\(channel\.id/);
    expect(actions).toMatch(/if \(action === "open-chat"\) openChannelChat\(channel\)/);
  });

  it("has no double-click fast path — the primary click already joins", () => {
    expect(row).not.toMatch(/onDoubleClick/);
  });

  it("never calls the join guard directly, behind the abstraction's back", () => {
    expect(row).not.toMatch(/requestVoiceJoin/);
  });
});

describe("reading a voice channel without joining stays reachable", () => {
  const row = read(COMPONENTS, "ChannelItem.tsx");
  /** The trailing-control strip: everything between its two neighbours. */
  const strip = row.slice(
    row.indexOf("function RowIconButton"),
    row.indexOf("const PLAIN_OPTIONS"),
  );

  it("gives the read path its own control on the row", () => {
    // The strip is now shared with the invite control, so the assertion is that
    // a VOICE row still gets a chat control — decided by planChannelRowControls,
    // whose `showChatControl` is exhaustively covered in
    // ../components/channelRowControls.test.ts.
    expect(row).toMatch(/<ChannelRowActions[\s\S]{0,200}plan=\{rowControls\}/);
    expect(strip).toMatch(/plan\.showChatControl && \(/);
  });

  it("that control opens the chat and cannot leak a click into the row's join", () => {
    const control = strip.slice(strip.indexOf("plan.showChatControl"));
    expect(control).toMatch(/openChannelChat\(channel\)/);
    expect(control).not.toMatch(/joinVoiceChannel|activateVoiceChannel/);
    // Without both of these the press/click reaches the row underneath, which
    // would connect the user to voice — the exact opposite of this control.
    expect(strip).toMatch(/onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
    expect(strip).toMatch(/event\.stopPropagation\(\)/);
  });

  it("is permanently visible on touch and on a narrow viewport", () => {
    // Hover does not exist there, so a hover-only reveal would delete the
    // capability on every phone that opens the web app. The classes moved into
    // channelRowControls.ts (one testable copy, shared with the invite icon), so
    // this asserts (a) the row spreads them and (b) they still say it.
    expect(strip).toMatch(/revealClasses=\{plan\.chatRevealClasses\}/);
    const rules = read(COMPONENTS, "channelRowControls.ts");
    const reveal = rules.slice(
      rules.indexOf("export const HOVER_REVEAL_CLASSES"),
      rules.indexOf("export interface ChannelRowControlsInput"),
    );
    expect(reveal).toMatch(/pointer-coarse:opacity-100/);
    expect(reveal).not.toMatch(/max-\[899px\]/);
    expect(reveal).toMatch(/group-hover\/actionmenu:opacity-100/);
    expect(strip).toMatch(/focus-visible:opacity-100/);
    // The chat control never gains the invite icon's selected exemption: two
    // permanent icons on the row you are reading is not what was asked for.
    expect(rules).toMatch(/chatRevealClasses: HOVER_REVEAL_CLASSES/);
  });

  it("also has a keyboard / right-click path in the context menu", () => {
    expect(row).toMatch(/onSelect=\{\(\) => openChannelChat\(channel\)\}/);
    expect(row).toMatch(/desktop:channel\.openChat/);
  });
});

describe("there is exactly one chat implementation", () => {
  it("the voice-channel header adds controls only — no list, no composer", () => {
    const header = read(COMPONENTS, "VoiceChannelHeaderControls.tsx");
    expect(header).not.toMatch(/MessageList|ChatDataProvider|MessageComposer/);
  });

  it("the stage hands the user the SAME chat surface instead of embedding one", () => {
    const stage = read(COMPONENTS, "VideoStage.tsx");
    expect(stage).toMatch(/openChannelChat\(roomChannel\)/);
    expect(stage).not.toMatch(/MessageList|ChatDataProvider|MessageComposer/);
  });

  it("ChatView is kind-agnostic — it never branches a voice channel elsewhere", () => {
    const chat = read(COMPONENTS, "ChatView.tsx");
    expect(chat).toMatch(/<AppChatView/);
    expect(chat).not.toMatch(/kind === "voice"[\s\S]{0,80}return/);
  });
});

describe("both gestures have a single implementation", () => {
  const actions = read(LIB, "channel-actions.ts");

  it("opening a channel always sets the chat intent alongside the selection", () => {
    // Selecting without `showChannelChat()` leaves a user mid-call staring at
    // the video stage, convinced their click did nothing.
    expect(actions).toMatch(
      /showChannelChat\(\);[\s\S]{0,120}setActiveChannel\(channel\)/,
    );
  });

  it("joining also opens the room's chat, so leaving the stage lands somewhere", () => {
    expect(actions).toMatch(
      /setActiveChannel\(channel\);[\s\S]{0,200}requestVoiceJoin\(/,
    );
  });
});

describe("slowmode is offered on a voice channel's chat", () => {
  const dialog = read(COMPONENTS, "ChannelSettingsDialog.tsx");

  it("renders the slowmode field outside the voice/text branch", () => {
    // Inside the `isVoice ? … : …` arms it would either be hidden on voice or
    // duplicated into both — this asserts it is neither.
    const voiceArm = dialog.slice(
      dialog.indexOf("{isVoice ? ("),
      dialog.indexOf("<Button type=\"submit\""),
    );
    const branchEnd = voiceArm.indexOf(")}");
    expect(voiceArm.slice(0, branchEnd)).not.toMatch(/channel-slowmode/);
    expect(voiceArm).toMatch(/channel-slowmode/);
  });

  it("sends slowmodeSeconds for both kinds", () => {
    const save = dialog.slice(dialog.indexOf("const onSave"), dialog.indexOf("const onDelete"));
    const voiceBranch = save.slice(save.indexOf("if (isVoice)"), save.indexOf("} else {"));
    expect(voiceBranch).not.toMatch(/slowmodeSeconds/);
    expect(save).toMatch(/patch\.slowmodeSeconds = /);
  });
});
