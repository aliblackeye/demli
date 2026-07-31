// @vitest-environment jsdom
/**
 * The sidebar's hide rules and its empty-area menu, driven through the real
 * component.
 *
 * A pure test of `visibleSidebarChannels` (which exists, in client-core) proves
 * the arithmetic and nothing about the sidebar: whether the chevron is wired to
 * the right section key, whether a collapsed section keeps its own header so it
 * can be reopened, whether the preference survives a remount, and — the one that
 * cannot be reasoned about at all — whether right-clicking a channel row opens
 * the ROW's menu rather than the empty-area menu. Radix's context menus do not
 * stop `contextmenu` propagating, so a menu placed one element too high opens
 * two menus on every right-click, and only a real mount can see it.
 *
 * The harness (../test/dom) mounts on `document.body` with a single React copy;
 * see its header for why neither is optional.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * lucide-react ships its own physical copy of react under the repo's hoisted
 * node_modules layout (see ../test/dom), so a real icon render throws. Icons are
 * decoration here — every one becomes an empty <svg>.
 */
import { vi } from "vitest";
vi.mock("lucide-react", () => {
  const Icon = (): JSX.Element => createElement("svg");
  const real = (name: string | symbol): boolean =>
    typeof name === "string" && name !== "then" && name !== "__esModule";
  return new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, name) => (real(name) ? Icon : target[name]),
    has: (target, name) => real(name) || name in target,
  });
});

import { I18nextProvider } from "react-i18next";
import { createI18n, createMemoryStorage } from "@demli/i18n";
import { ContextMenuItem } from "@demli/ui";
import type { Channel, ChannelCategory, ChannelId } from "@demli/types";
import { AppDataProvider, type ShellData } from "../data/shell-data";
import { ChannelSidebar } from "./ChannelSidebar";
import { ActionMenu } from "./ActionMenu";
import { findByText, findMenuItem, flush, mount, press } from "../test/dom";

const GROUP = "grp-1";
const ROW_MENU_ITEM = "ROW_MENU_ENTRY";

function ch(
  id: string,
  position: number,
  kind: Channel["kind"] = "text",
  categoryId: string | null = null,
): Channel {
  return {
    id,
    groupId: GROUP,
    kind,
    name: id,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    categoryId,
  } as Channel;
}

const CHANNELS = [
  ch("general", 0),
  ch("games", 1),
  ch("random", 2),
  ch("lobby", 0, "voice"),
  ch("afk", 1, "voice"),
];

/**
 * The row renderer, wrapped in a REAL ActionMenu with its own entry — this is
 * what makes the "row menu vs empty-area menu" assertion meaningful. The desktop
 * ChannelItem does exactly this; a bare <button> here would test nothing.
 */
const renderChannel = (channel: Channel): JSX.Element => (
  <ActionMenu menu={<ContextMenuItem onSelect={() => undefined}>{ROW_MENU_ITEM}</ContextMenuItem>}>
    <button type="button" data-channel={channel.id}>
      {channel.name}
    </button>
  </ActionMenu>
);

function shellData(overrides: Partial<ShellData> = {}): ShellData {
  const noop = (): void => {};
  return {
    activeView: "server",
    homeView: "friends",
    activeGroupId: GROUP,
    activeChannelId: "general",
    activeGroupChatId: null,
    activeDmId: null,
    groups: [],
    homeUnread: { unread: false, mention: false, count: 0 },
    activeGroupName: "Demli",
    activeGroupBannerUrl: null,
    channels: CHANNELS,
    categories: [] as ChannelCategory[],
    canManageChannels: true,
    canOpenServerSettings: true,
    connectedVoiceChannelId: null,
    mutedChannelIds: new Set<ChannelId>(),
    canCreateInvite: true,
    dms: [],
    groupChats: [],
    groupChatsStatus: "ready",
    groupChatsErrorMessage: null,
    members: [],
    openServer: noop,
    openHome: noop,
    openFriends: noop,
    openRecentCalls: noop,
    openDm: noop,
    openGroupChat: noop,
    hideDm: noop,
    openCreateGroup: noop,
    openDownloadApp: noop,
    openCreateGroupChat: noop,
    openLeaveServer: noop,
    openInvite: noop,
    openChannelInvite: noop,
    openCreateChannel: noop,
    openServerSettings: noop,
    retryGroupChats: noop,
    openCreateCategory: noop,
    openRenameCategory: noop,
    openDeleteCategory: noop,
    reorderSidebar: async () => {},
    ...overrides,
  };
}

async function mountSidebar(overrides: Partial<ShellData> = {}): Promise<ReturnType<typeof mount>> {
  const i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
  return mount(
    <I18nextProvider i18n={i18n}>
      <AppDataProvider value={shellData(overrides)}>
        <ChannelSidebar renderChannel={renderChannel} showServerMenu={false} />
      </AppDataProvider>
    </I18nextProvider>,
  );
}

/** Channel row labels currently on screen, in DOM order. */
function visibleChannels(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-channel]")].map(
    (node) => node.dataset.channel ?? "",
  );
}

function clickHeader(label: string): void {
  const button = [...document.querySelectorAll<HTMLElement>("button")].find((node) =>
    node.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
  );
  if (!button) throw new Error(`no section header matching "${label}"`);
  press(() => button.click());
}

/** Right-click the blank filler under the list (the empty-area menu's target). */
function openEmptyAreaMenu(): void {
  const filler = document.querySelector<HTMLElement>("[aria-label='Channel list actions']");
  if (!filler) throw new Error("the empty-area target did not render");
  press(() => {
    filler.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

function openRowMenu(channelId: string): void {
  const row = document.querySelector<HTMLElement>(`[data-channel='${channelId}']`);
  if (!row) throw new Error(`no row for ${channelId}`);
  press(() => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("collapsing a section", () => {
  it("starts with everything visible", async () => {
    const view = await mountSidebar();
    expect(visibleChannels()).toEqual(["general", "games", "random", "lobby", "afk"]);
    view.unmount();
  });

  it("keeps ONLY the selected channel in the collapsed section", async () => {
    const view = await mountSidebar({ activeChannelId: "games" });
    clickHeader("Text channels");
    await flush(5);
    // Text section collapsed to its selection; the voice section is untouched.
    expect(visibleChannels()).toEqual(["games", "lobby", "afk"]);
    view.unmount();
  });

  it("keeps the connected voice room when its section collapses", async () => {
    const view = await mountSidebar({
      activeChannelId: "general",
      connectedVoiceChannelId: "lobby",
    });
    clickHeader("Voice channels");
    await flush(5);
    expect(visibleChannels()).toEqual(["general", "games", "random", "lobby"]);
    view.unmount();
  });

  it("closes the section entirely when nothing in it is selected", async () => {
    const view = await mountSidebar({ activeChannelId: "general" });
    clickHeader("Voice channels");
    await flush(5);
    expect(visibleChannels()).toEqual(["general", "games", "random"]);
    view.unmount();
  });

  it("leaves the header behind so the section can be reopened", async () => {
    // A collapsed section that removed its own header would be a one-way door.
    const view = await mountSidebar({ activeChannelId: "general" });
    clickHeader("Voice channels");
    await flush(5);
    expect(findByText("Voice channels")).not.toBeNull();

    clickHeader("Voice channels");
    await flush(5);
    expect(visibleChannels()).toContain("lobby");
    view.unmount();
  });

  it("announces its state through aria-expanded, and toggles from the keyboard", async () => {
    const view = await mountSidebar();
    const header = [...document.querySelectorAll<HTMLElement>("button[aria-expanded]")].find(
      (node) => node.textContent?.includes("Text channels"),
    );
    expect(header, "the section header is not a real button").not.toBeUndefined();
    expect(header?.getAttribute("aria-expanded")).toBe("true");

    // A real <button> activates on Enter/Space via the browser's own click
    // synthesis, which is exactly what makes the keyboard path free.
    press(() => header?.click());
    await flush(5);
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    view.unmount();
  });

  it("survives a remount — the preference is persisted per server", async () => {
    const first = await mountSidebar({ activeChannelId: "general" });
    clickHeader("Voice channels");
    await flush(5);
    first.unmount();

    const second = await mountSidebar({ activeChannelId: "general" });
    expect(visibleChannels()).toEqual(["general", "games", "random"]);
    second.unmount();
  });

  it("does not leak one server's collapsed sections into another's", async () => {
    const first = await mountSidebar({ activeChannelId: "general" });
    clickHeader("Voice channels");
    await flush(5);
    first.unmount();

    const other = await mountSidebar({ activeGroupId: "grp-2", activeChannelId: "general" });
    expect(visibleChannels()).toContain("lobby");
    other.unmount();
  });
});

describe("the empty-area menu", () => {
  it("offers all four entries to a viewer who may manage and invite", async () => {
    const view = await mountSidebar();
    openEmptyAreaMenu();
    await flush(5);

    expect(findMenuItem("Hide muted channels")).not.toBeNull();
    expect(findMenuItem("Create channel")).not.toBeNull();
    expect(findMenuItem("Create category")).not.toBeNull();
    expect(findMenuItem("Invite to server")).not.toBeNull();
    view.unmount();
  });

  it("hides the three privileged entries from a viewer who has neither right", async () => {
    // The founder's second reference screenshot: absent, not disabled.
    const view = await mountSidebar({ canManageChannels: false, canCreateInvite: false });
    openEmptyAreaMenu();
    await flush(5);

    expect(findMenuItem("Create channel")).toBeNull();
    expect(findMenuItem("Create category")).toBeNull();
    expect(findMenuItem("Invite to server")).toBeNull();
    // The personal view preference is everyone's, so the menu is never empty.
    expect(findMenuItem("Hide muted channels")).not.toBeNull();
    view.unmount();
  });

  it("gates the two rights independently", async () => {
    const view = await mountSidebar({ canManageChannels: false, canCreateInvite: true });
    openEmptyAreaMenu();
    await flush(5);

    expect(findMenuItem("Create channel")).toBeNull();
    expect(findMenuItem("Invite to server")).not.toBeNull();
    view.unmount();
  });

  it("does NOT open when a channel row is right-clicked — the row's menu does", async () => {
    // Radix does not stop `contextmenu` propagating, so a menu attached one
    // element too high would open BOTH on every right-click.
    const view = await mountSidebar();
    openRowMenu("general");
    await flush(5);

    expect(findMenuItem(ROW_MENU_ITEM), "the row's own menu did not open").not.toBeNull();
    expect(
      findMenuItem("Hide muted channels"),
      "the empty-area menu opened on top of the row's menu",
    ).toBeNull();
    view.unmount();
  });
});

describe("hide muted channels", () => {
  async function mountWithMuted(
    overrides: Partial<ShellData> = {},
  ): Promise<ReturnType<typeof mount>> {
    return mountSidebar({ mutedChannelIds: new Set(["games", "afk"]), ...overrides });
  }

  it("hides muted rows once the toggle is on", async () => {
    const view = await mountWithMuted({ activeChannelId: "general" });
    expect(visibleChannels()).toContain("games");

    openEmptyAreaMenu();
    await flush(5);
    press(() => findMenuItem("Hide muted channels")?.click());
    await flush(20);

    expect(visibleChannels()).toEqual(["general", "random", "lobby"]);
    view.unmount();
  });

  it("keeps a muted channel the user is currently reading", async () => {
    const view = await mountWithMuted({ activeChannelId: "games" });
    openEmptyAreaMenu();
    await flush(5);
    press(() => findMenuItem("Hide muted channels")?.click());
    await flush(20);

    // "games" is muted AND selected — hiding it would move the user out from
    // under their own cursor.
    expect(visibleChannels()).toEqual(["general", "games", "random", "lobby"]);
    view.unmount();
  });

  it("keeps a muted voice room the user is connected to", async () => {
    const view = await mountWithMuted({
      activeChannelId: "general",
      connectedVoiceChannelId: "afk",
    });
    openEmptyAreaMenu();
    await flush(5);
    press(() => findMenuItem("Hide muted channels")?.click());
    await flush(20);

    expect(visibleChannels()).toEqual(["general", "random", "lobby", "afk"]);
    view.unmount();
  });

  it("persists across a remount", async () => {
    const first = await mountWithMuted({ activeChannelId: "general" });
    openEmptyAreaMenu();
    await flush(5);
    press(() => findMenuItem("Hide muted channels")?.click());
    await flush(20);
    first.unmount();

    const second = await mountWithMuted({ activeChannelId: "general" });
    expect(visibleChannels()).toEqual(["general", "random", "lobby"]);
    second.unmount();
  });
});
