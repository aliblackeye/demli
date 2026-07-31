/**
 * Source-level invariants for voice-channel chat on MOBILE (M20).
 *
 * Four things can rot here and none of them shows up as a type error:
 *
 *  1. The row's tap stops connecting you. Tapping a voice channel joining it is
 *     the founder's muscle memory; a refactor back to
 *     "open a preview sheet first" would quietly cost the app its most-used
 *     voice gesture.
 *  2. Reading a voice channel WITHOUT joining loses its control. There is no
 *     hover on a phone, so the target must be permanently visible and at least a
 *     44pt tap target — otherwise a capability the server grants (visibility is
 *     the whole access rule, ADR 0007) has no way in at all (§35).
 *  3. A SECOND chat implementation grows for voice ("just a small message list
 *     on the stage"), and from then on pins, search, edit, reactions,
 *     attachments, drafts and the outbox have to be built twice.
 *  4. The two clients drift because mobile hand-writes its own copy of "does
 *     this tap join". The decision must come from @demli/client-core, which
 *     desktop and web read too.
 *
 * The mobile app has no RN render harness (node-environment vitest, see
 * vitest.config.ts), so the repo's established way to assert component wiring is
 * to read the source — the same technique the desktop renderer uses.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The mobile tsconfig pulls in DOM lib, whose `URL` is not node's — so resolve
// this file's directory from the string form and join, rather than `new URL()`.
const HERE = dirname(fileURLToPath(import.meta.url));

const read = (relative: string): string => readFileSync(join(HERE, relative), "utf8");

const list = read("./ServerChannelList.tsx");
const sheet = read("./ChannelActionSheet.tsx");
const room = read("../voice/VoiceRoomScreen.tsx");
const nav = read("../voice/voice-channel-nav.ts");
const settings = read("../../../app/(app)/channel-settings.tsx");

/**
 * Since M18 every channel row — uncategorized or filed under a category — is
 * rendered by the single `renderChannelRow` helper. Asserting against that one
 * slice is what keeps a voice channel inside a CATEGORY from quietly losing the
 * gestures a voice channel at the top of the list has.
 */
const rowRenderer = list.slice(
  list.indexOf("const renderChannelRow"),
  list.indexOf("const renderCategoryHeader"),
);

describe("tapping a voice channel connects you", () => {
  it("routes the VOICE row's tap through the join-bearing primary gesture", () => {
    expect(rowRenderer).toMatch(/isVoice \? \(\) => activateVoiceChannel\(channel\)/);
  });

  it("that gesture asks the SHARED rule instead of deciding for itself", () => {
    const gesture = list.slice(
      list.indexOf("const activateVoiceChannel"),
      list.indexOf("const openChannelChat"),
    );
    expect(gesture).toMatch(/voiceRowTapIntent\(/);
    // Reading the engine imperatively at tap time — a subscription here would
    // repaint the whole channel list on every voice tick (§27).
    expect(gesture).toMatch(/useVoiceStore\.getState\(\)/);
  });

  it("no intermediate confirm sheet stands between the tap and the room", () => {
    // The occupancy preview the old join sheet offered is already rendered
    // inline under every voice row (VoiceChannelOccupants), so a modal in front
    // of the join is a step with nothing left to show.
    expect(list).not.toMatch(/VoiceChannelJoinSheet/);
  });

  it("the tap never drives the voice engine from the list itself", () => {
    // Joining happens by navigating with a join intent; the room screen owns the
    // single media FSM (§11). A `join(` here would be a second lifecycle owner.
    expect(list).not.toMatch(/\bjoin\(/);
  });
});

describe("reading a voice channel without joining stays reachable", () => {
  it("gives the read path its own target on the row", () => {
    expect(rowRenderer).toMatch(
      /isVoice \? \(\) => openVoiceChannel\(channel, VOICE_READ_INTENT\)/,
    );
  });

  it("that target is permanently visible and a real tap target", () => {
    const control = list.slice(list.indexOf("{onOpenChat ? ("), list.indexOf("{onEdit ? ("));
    // No hover exists on a phone, so there is no conditional reveal to assert —
    // what must hold is that it is always rendered for a voice row and is big
    // enough to hit (≥44pt, the row's own height).
    expect(control).toMatch(/minWidth: 44/);
    expect(control).toMatch(/minHeight: ROW_HEIGHT/);
    expect(control).toMatch(/accessibilityLabel=\{t\("mobile:channel\.openChatWithoutJoining"\)\}/);
  });

  it("the read intent cannot be talked into joining", () => {
    expect(nav).toMatch(/export const VOICE_READ_INTENT: VoiceScreenIntent = "chat"/);
    expect(nav).toMatch(/return intent === "join";/);
  });

  it("also has a long-press path, whose room entry comes from the shared rule", () => {
    expect(sheet).toMatch(/voiceMenuRoomAction\(/);
    expect(sheet).toMatch(/mobile:channel\.openChatWithoutJoining/);
  });

  it("keeps disconnect OFF the row — only in the deliberate menu", () => {
    expect(list).not.toMatch(/leave\(\)/);
    expect(sheet).toMatch(/mobile:channel\.disconnect/);
  });
});

describe("a voice channel row carries a real unread signal", () => {
  it("passes the same unread/count/mute props a text row does", () => {
    // One renderer serves both kinds, so these props cannot be present for a
    // text row and missing for a voice one — which is what the two hand-written
    // sections used to make possible.
    expect(rowRenderer).toMatch(/unread=\{showUnread\}/);
    expect(rowRenderer).toMatch(/unreadCount=\{unreadCounts\[channel\.id\] \?\? 0\}/);
    expect(rowRenderer).toMatch(
      /effectiveChannelMuteMode\(notificationMutes, channel\.id, groupId\)/,
    );
    expect(rowRenderer).toMatch(/<VoiceChannelOccupants channelId=\{channel\.id\} \/>/);
  });

  it("offers 'mark as read', which needs a stream to be meaningful", () => {
    expect(sheet).toMatch(/markChannelRead\(target\.channelId\)/);
  });
});

describe("the list shows only what the server returned", () => {
  it("derives both sections from the group-details channels alone", () => {
    // Visibility is enforced server-side (ADR 0007): a restricted voice channel
    // is simply absent from `data.channels`, and it must stay absent — no
    // client-side merge, no "show hidden" branch that would leak its existence.
    // Categories change nothing here: they are pure organization, so the bucket
    // model is built FROM the same server-filtered list and adds no channels.
    expect(list).toMatch(/const channels: Channel\[\] = \[\.\.\.\(data\?\.channels \?\? \[\]\)\]/);
    expect(list).toMatch(/buildSidebarBuckets\(channels, categories \?\? \[\]\)/);
    expect(list).toMatch(
      /const voiceChannels = \(uncategorized\?\.channels \?\? \[\]\)\.filter\(\(c\) => c\.kind === "voice"\)/,
    );
    expect(rowRenderer).not.toMatch(/visib|hidden|restricted/i);
  });
});

describe("there is exactly one chat implementation", () => {
  it("the voice room renders the SAME ChatThread, not its own message list", () => {
    expect(room).toMatch(/<ChatThread/);
    expect(room).not.toMatch(/FlatList|Composer|useChannelMessages/);
  });

  it("and tells the store the channel's real kind, so its chat counts as active", () => {
    // Reporting "text" here would leave every message arriving in front of the
    // reader flagged unread (the store's active-channel gate is what suppresses
    // it), which is exactly the bug the kind gate used to cause.
    expect(room).toMatch(/channelKind="voice"/);
  });
});

describe("slow mode is offered on a voice channel's chat", () => {
  it("renders the field outside the voice/text branch", () => {
    const form = settings.slice(
      settings.indexOf("{isVoice ? ("),
      settings.indexOf("<NsfwToggle"),
    );
    const voiceArm = form.slice(0, form.indexOf("</>"));
    expect(voiceArm).not.toMatch(/channelSettings\.slowmode/);
    expect(form).toMatch(/channelSettings\.slowmode/);
  });

  it("sends slowmodeSeconds for both kinds", () => {
    const save = settings.slice(settings.indexOf("const onSave"), settings.indexOf("const onDelete"));
    const voiceBranch = save.slice(save.indexOf("if (isVoice)"), save.indexOf("} else {"));
    expect(voiceBranch).not.toMatch(/slowmodeSeconds/);
    expect(save).toMatch(/input\.slowmodeSeconds = slowmodeSeconds;/);
  });
});
