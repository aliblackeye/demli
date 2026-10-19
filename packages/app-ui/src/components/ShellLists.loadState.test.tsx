// @vitest-environment jsdom
/**
 * Every shell list shows exactly ONE of skeleton / retry band / empty state /
 * rows, and the empty state only after a SUCCESSFUL empty fetch.
 *
 * The bug these pin (M16 audit): a failed or still-loading fetch rendered as the
 * designed empty state. A server whose details request failed said "No channels
 * yet" — and offered its owner "Create channel" inside a server that has
 * channels — while the roster read "Members — 0"; a DM list that had not
 * arrived said "No conversations yet". None of them offered a retry.
 */
import { createElement } from "react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

// lucide-react ships its own physical react copy under the hoisted layout (see
// ../test/dom) — a real icon render throws. Icons are decoration here.
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
import { TooltipProvider } from "@demli/ui";
import type { ChannelCategory, ChannelId, DmId, UserId } from "@demli/types";
import { AppDataProvider, type ShellData } from "../data/shell-data";
import { ChannelSidebar } from "./ChannelSidebar";
import { HomeSidebar } from "./HomeSidebar";
import { MemberSidebar } from "./MemberSidebar";
import { mount } from "../test/dom";

const NETWORK = "Can't reach the server. Check your connection and try again.";

function shellData(overrides: Partial<ShellData> = {}): ShellData {
  const noop = (): void => {};
  return {
    activeView: "server",
    homeView: "friends",
    activeGroupId: "grp-1",
    activeChannelId: null,
    activeGroupChatId: null,
    activeDmId: null,
    groups: [],
    homeUnread: { unread: false, mention: false, count: 0 },
    activeGroupName: "bizim masa",
    activeGroupBannerUrl: null,
    channels: [],
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

async function render(
  which: "channels" | "members" | "home",
  overrides: Partial<ShellData>,
): Promise<ReturnType<typeof mount>> {
  const i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
  const body =
    which === "channels" ? (
      <ChannelSidebar renderChannel={(channel) => <button type="button">{channel.name}</button>} />
    ) : which === "members" ? (
      <MemberSidebar />
    ) : (
      <HomeSidebar />
    );
  return mount(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <AppDataProvider value={shellData(overrides)}>{body}</AppDataProvider>
      </TooltipProvider>
    </I18nextProvider>,
  );
}

const text = (): string => document.body.textContent ?? "";

function clickRetry(): void {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Try again",
  );
  if (!button) throw new Error("no retry button rendered");
  act(() => button.click());
}

describe("channel column", () => {
  it("a failed first fetch shows the retry band — never 'No channels yet' or 'Create channel'", async () => {
    const retryServerDetails = vi.fn();
    const mounted = await render("channels", { serverDetailsError: NETWORK, retryServerDetails });
    try {
      expect(text()).toContain("Couldn't load the channels");
      expect(text()).toContain(NETWORK);
      expect(text()).not.toContain("No channels yet");
      expect(text()).not.toContain("Create channel");
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
      clickRetry();
      expect(retryServerDetails).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("a first fetch in flight shows the skeleton, not the empty state", async () => {
    const mounted = await render("channels", { serverDetailsLoading: true });
    try {
      expect(document.querySelector('[role="status"][aria-label="Loading channels"]')).not.toBeNull();
      expect(text()).not.toContain("No channels yet");
      expect(text()).not.toContain("Couldn't load the channels");
    } finally {
      mounted.unmount();
    }
  });

  it("a successful empty fetch is the only state that says 'No channels yet'", async () => {
    const mounted = await render("channels", {});
    try {
      expect(text()).toContain("No channels yet");
      expect(text()).not.toContain("Couldn't load the channels");
    } finally {
      mounted.unmount();
    }
  });
});

describe("roster", () => {
  it("a failed first fetch drops the count and shows the retry band", async () => {
    const retryServerDetails = vi.fn();
    const mounted = await render("members", { serverDetailsError: NETWORK, retryServerDetails });
    try {
      expect(document.querySelector("h2")?.textContent).toBe("Members");
      expect(text()).not.toContain("Members — 0");
      expect(text()).toContain("Couldn't load the members");
      clickRetry();
      expect(retryServerDetails).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("a loaded roster keeps its count", async () => {
    const mounted = await render("members", {
      members: [
        {
          id: "u-1" as UserId,
          displayName: "Ece",
          avatarUrl: null,
          status: "online",
          isOwner: false,
          color: null,
          roles: [],
          isGuest: false,
        },
      ],
    });
    try {
      expect(document.querySelector("h2")?.textContent).toBe("Members — 1");
      expect(text()).not.toContain("Couldn't load the members");
    } finally {
      mounted.unmount();
    }
  });
});

describe("home DM list", () => {
  it("pending shows the skeleton, not 'No conversations yet'", async () => {
    const mounted = await render("home", { activeView: "home", dmsStatus: "pending" });
    try {
      expect(
        document.querySelector('[role="status"][aria-label="Loading conversations"]'),
      ).not.toBeNull();
      expect(text()).not.toContain("No conversations yet");
    } finally {
      mounted.unmount();
    }
  });

  it("error shows the retry band, and retry re-runs the fetch", async () => {
    const retryDms = vi.fn();
    const mounted = await render("home", {
      activeView: "home",
      dmsStatus: "error",
      dmsErrorMessage: NETWORK,
      retryDms,
    });
    try {
      expect(text()).toContain("Couldn't load your conversations");
      expect(text()).not.toContain("No conversations yet");
      clickRetry();
      expect(retryDms).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });

  it("a successful empty fetch shows the empty card", async () => {
    const mounted = await render("home", { activeView: "home", dmsStatus: "ready" });
    try {
      expect(text()).toContain("No conversations yet");
    } finally {
      mounted.unmount();
    }
  });

  it("rows win over a failed background refetch", async () => {
    const mounted = await render("home", {
      activeView: "home",
      dmsStatus: "error",
      dmsErrorMessage: NETWORK,
      dms: [
        {
          id: "dm-1" as DmId,
          streamId: "s-1" as ChannelId,
          participantId: "u-1" as UserId,
          participantName: "Ece",
          participantAvatarUrl: null,
          status: "online",
          unread: { muted: false, showUnread: false, showMentionBadge: false, countBadge: null },
        },
      ],
    });
    try {
      expect(text()).toContain("Ece");
      expect(text()).not.toContain("Couldn't load your conversations");
    } finally {
      mounted.unmount();
    }
  });
});
