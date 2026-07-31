/**
 * The command palette's DATA layer — the mobile mirror of the desktop
 * `CommandMenu` (apps/desktop/src/renderer/src/components/CommandMenu.tsx).
 *
 * Everything here is pure so it can be unit-tested in the repo's node-env vitest
 * setup (RN rendering is never simulated — see apps/mobile/vitest.config.ts).
 * The screen supplies live state (the rail selection, the cached channel list,
 * voice status) and renders whatever this module returns; the item ORDER, the
 * VISIBILITY rules and the SEARCH behaviour all live here.
 *
 * Parity rule (CLAUDE.md §36 — feature parity between platforms): the action set
 * is the desktop palette's, one for one. Nothing invented, nothing extra. The
 * two deliberate differences, both because the desktop concept has no mobile
 * counterpart rather than because we chose to diverge:
 *
 *  - "Toggle member list" is dropped. Mobile has no member SIDEBAR to toggle —
 *    the roster is rendered inline at the bottom of the server channel list, so
 *    the row would be a no-op, and a dead entry is forbidden (§35).
 *  - Mute / deafen appear only while a voice session is live. Desktop shows them
 *    unconditionally, but on mobile there is no always-present voice panel to
 *    reflect the change, so outside a session the row would do nothing visible.
 *    The capability is unchanged; only a guaranteed-dead state is hidden.
 *
 * "Search in channel" and "Invite people" are gated exactly as desktop gates
 * them — desktop hides them off the server surface (`activeView === "server"`),
 * mobile hides them when no server is selected in the rail.
 */

import type { Channel, FriendGroup } from "@demli/types";

/** Which heading an item is filed under. Rendered in this order. */
export type PaletteSection = "textChannels" | "voiceChannels" | "switchServer" | "actions";

/** Section render order — also the order {@link buildPaletteItems} emits. */
export const PALETTE_SECTION_ORDER: readonly PaletteSection[] = [
  "textChannels",
  "voiceChannels",
  "switchServer",
  "actions",
];

/**
 * What selecting an item does. A tagged union rather than a callback so the
 * items stay serialisable/pure and the navigation lives in exactly one place
 * (the screen), where the router and the stores are in scope.
 */
export type PaletteAction =
  | { kind: "openTextChannel"; channelId: string; groupId: string; name: string }
  | { kind: "joinVoiceChannel"; channelId: string; groupId: string; name: string }
  | { kind: "switchServer"; groupId: string }
  | { kind: "toggleMic" }
  | { kind: "toggleDeafen" }
  | { kind: "searchMessages"; channelId: string; name: string }
  | { kind: "invitePeople"; groupId: string; serverName: string }
  | { kind: "createServer" }
  | { kind: "joinServerWithCode" }
  | { kind: "voiceSettings" }
  | { kind: "openSettings" };

/** Icon slot, resolved to a lucide component by the screen (keeps this file RN-free). */
export type PaletteIcon =
  | "hash"
  | "volume"
  | "server"
  | "mic"
  | "micOff"
  | "headphones"
  | "headphoneOff"
  | "search"
  | "userPlus"
  | "plus"
  | "logIn"
  | "settings2"
  | "settings";

export interface PaletteItem {
  /** Stable list key. */
  id: string;
  section: PaletteSection;
  /** Localized, user-visible label. */
  label: string;
  /** Right-aligned context — the server a channel belongs to. */
  meta?: string;
  icon: PaletteIcon;
  /**
   * Extra, never-rendered search terms. Latin-ASCII on purpose: they exist so a
   * habit query typed in the OTHER language ("mute" on a Turkish phone, "ara" on
   * an English one) still finds the row. They are not copy, so they live here
   * rather than in the i18n catalog.
   */
  keywords: string;
  action: PaletteAction;
}

/** One rendered line: a section heading, or an item. */
export type PaletteRow =
  | { type: "header"; key: string; section: PaletteSection }
  | { type: "item"; key: string; item: PaletteItem };

/** Minimal `t` shape — the app's typed TFunction satisfies it structurally. */
export type PaletteTranslate = (key: string, params?: Record<string, string>) => string;

export interface PaletteInput {
  t: PaletteTranslate;
  /** Rail selection. `null` = the Home/DM surface (desktop's non-server view). */
  selectedServerId: string | null;
  /** Display name of the selected server, when one is selected. */
  selectedServerName: string | null;
  /** Every server the user belongs to (rail order). */
  servers: readonly FriendGroup[];
  /** Channels of the SELECTED server; empty when none is selected. */
  channels: readonly Channel[];
  /**
   * Last text channel opened in the selected server. Mobile's stand-in for
   * desktop's "active channel", which the palette's search action targets — on
   * mobile the palette opens from the Home shell, where no channel screen is
   * mounted, so the store's remembered channel is the honest equivalent.
   */
  lastChannelId: string | null;
  /** A voice session is live (joining / connected / reconnecting). */
  voiceActive: boolean;
  micEnabled: boolean;
  deafened: boolean;
}

/**
 * Build the full, unfiltered item list in render order.
 *
 * Mirrors the desktop groups: text channels → voice channels → other servers →
 * actions.
 */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const {
    t,
    selectedServerId,
    selectedServerName,
    servers,
    channels,
    lastChannelId,
    voiceActive,
    micEnabled,
    deafened,
  } = input;

  const onServerSurface = selectedServerId !== null;
  const serverName = selectedServerName ?? "";
  const items: PaletteItem[] = [];

  const ordered = onServerSurface ? [...channels].sort((a, b) => a.position - b.position) : [];
  const textChannels = ordered.filter((c) => c.kind === "text");
  const voiceChannels = ordered.filter((c) => c.kind === "voice");

  for (const channel of textChannels) {
    items.push({
      id: `text:${channel.id}`,
      section: "textChannels",
      label: channel.name,
      meta: serverName || undefined,
      icon: "hash",
      keywords: "channel kanal text metin",
      action: {
        kind: "openTextChannel",
        channelId: channel.id,
        groupId: channel.groupId,
        name: channel.name,
      },
    });
  }

  for (const channel of voiceChannels) {
    items.push({
      id: `voice:${channel.id}`,
      section: "voiceChannels",
      label: t("mobile:commandMenu.joinChannel", { channel: channel.name }),
      meta: serverName || undefined,
      icon: "volume",
      keywords: `${channel.name} join katil voice ses`,
      action: {
        kind: "joinVoiceChannel",
        channelId: channel.id,
        groupId: channel.groupId,
        name: channel.name,
      },
    });
  }

  // Every OTHER server — the selected one is already on screen (desktop drops
  // the active group from its "Switch server" group the same way).
  for (const server of servers) {
    if (server.id === selectedServerId) continue;
    items.push({
      id: `server:${server.id}`,
      section: "switchServer",
      label: server.name,
      icon: "server",
      keywords: "switch server sunucu gec degistir",
      action: { kind: "switchServer", groupId: server.id },
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  if (voiceActive) {
    items.push({
      id: "action:mic",
      section: "actions",
      label: micEnabled ? t("mobile:voice.controlMute") : t("mobile:voice.controlUnmute"),
      icon: micEnabled ? "micOff" : "mic",
      keywords: "mic mikrofon mute unmute sustur ac kapat",
      action: { kind: "toggleMic" },
    });
    items.push({
      id: "action:deafen",
      section: "actions",
      label: deafened ? t("mobile:voice.controlUndeafen") : t("mobile:voice.controlDeafen"),
      icon: deafened ? "headphones" : "headphoneOff",
      keywords: "deafen sagirlastir kulaklik headphones",
      action: { kind: "toggleDeafen" },
    });
  }

  // Desktop's "Search in channel" targets the channel you are looking at; the
  // mobile stand-in is the server's last-opened text channel, falling back to
  // its first one. With no text channel at all there is nothing to search, so
  // the row is dropped rather than offered dead.
  const searchTarget = onServerSurface
    ? (textChannels.find((c) => c.id === lastChannelId) ?? textChannels[0] ?? null)
    : null;
  if (searchTarget) {
    items.push({
      id: "action:search",
      section: "actions",
      label: t("mobile:commandMenu.searchMessages", { channel: searchTarget.name }),
      icon: "search",
      keywords: "search find ara bul mesaj message",
      action: { kind: "searchMessages", channelId: searchTarget.id, name: searchTarget.name },
    });
  }

  if (onServerSurface && selectedServerId) {
    items.push({
      id: "action:invite",
      section: "actions",
      label: t("mobile:group.inviteFriends"),
      icon: "userPlus",
      keywords: "invite davet friends arkadas people kisi",
      action: { kind: "invitePeople", groupId: selectedServerId, serverName },
    });
  }

  items.push({
    id: "action:create-server",
    section: "actions",
    label: t("mobile:newServer.createTitle"),
    icon: "plus",
    keywords: "create new server sunucu olustur yeni",
    action: { kind: "createServer" },
  });

  items.push({
    id: "action:join-server",
    section: "actions",
    label: t("mobile:commandMenu.joinWithCode"),
    icon: "logIn",
    keywords: "join code invite server sunucu kod katil davet link",
    action: { kind: "joinServerWithCode" },
  });

  items.push({
    id: "action:voice-settings",
    section: "actions",
    label: t("mobile:commandMenu.voiceSettings"),
    icon: "settings2",
    keywords: "voice audio mic device ses mikrofon cihaz ayar settings",
    action: { kind: "voiceSettings" },
  });

  items.push({
    id: "action:settings",
    section: "actions",
    label: t("mobile:commandMenu.openSettings"),
    icon: "settings",
    keywords: "settings ayarlar preferences tercih",
    action: { kind: "openSettings" },
  });

  return items;
}

/**
 * Turkish/English-insensitive search fold.
 *
 * `String.prototype.normalize` is deliberately avoided (Hermes ships without
 * full ICU on some builds) — an explicit map is deterministic on every engine.
 * `I` and `ı` both fold to `i`, so "acik"/"AÇIK"/"açık" all match each other and
 * an English keyboard finds a Turkish channel name.
 */
const FOLD_MAP: Readonly<Record<string, string>> = {
  ç: "c",
  Ç: "c",
  ğ: "g",
  Ğ: "g",
  ı: "i",
  I: "i",
  İ: "i",
  ö: "o",
  Ö: "o",
  ş: "s",
  Ş: "s",
  ü: "u",
  Ü: "u",
  â: "a",
  Â: "a",
  î: "i",
  Î: "i",
  û: "u",
  Û: "u",
};

export function foldForSearch(value: string): string {
  let out = "";
  for (const char of value) out += FOLD_MAP[char] ?? char.toLowerCase();
  return out;
}

/**
 * Filter by query. Every whitespace-separated token must appear somewhere in the
 * item's label + meta + keywords (AND across tokens, substring within one) — the
 * same "type a few letters of two words" behaviour cmdk gives on desktop.
 *
 * An empty/whitespace query returns everything, so opening the palette shows the
 * full browsable list (desktop does the same).
 */
export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
): PaletteItem[] {
  const tokens = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = foldForSearch(`${item.label} ${item.meta ?? ""} ${item.keywords}`);
    return tokens.every((token) => haystack.includes(token));
  });
}

/** Section heading copy. Reuses the channel-list headings already in the catalog. */
export function paletteSectionLabel(section: PaletteSection, t: PaletteTranslate): string {
  switch (section) {
    case "textChannels":
      return t("mobile:group.textChannels");
    case "voiceChannels":
      return t("mobile:group.voiceChannels");
    case "switchServer":
      return t("mobile:commandMenu.switchServer");
    case "actions":
      return t("mobile:commandMenu.actions");
  }
}

/**
 * Flatten items into the FlatList's rows, inserting one heading per non-empty
 * section. Emptied-by-filtering sections produce no heading — a lone "Voice
 * channels" label with nothing under it is a bug the user can see.
 */
export function toPaletteRows(items: readonly PaletteItem[]): PaletteRow[] {
  const rows: PaletteRow[] = [];
  let current: PaletteSection | null = null;
  for (const item of items) {
    if (item.section !== current) {
      current = item.section;
      rows.push({ type: "header", key: `header:${item.section}`, section: item.section });
    }
    rows.push({ type: "item", key: item.id, item });
  }
  return rows;
}
