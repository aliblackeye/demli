// @vitest-environment jsdom
/**
 * The server banner behind the sidebar header (M20).
 *
 * The one thing that MUST hold is the negative case: a server without a banner —
 * which is every server that existed before migration 0022, and the default for
 * every new one — has to render exactly as it always did. No stray <img>, no
 * empty box, no layout shift. That is not something a pure test of a URL field
 * can see; it needs the real component to actually render.
 *
 * The positive case pins the two decisions the banner makes: the image is
 * decorative (empty alt, aria-hidden, not announced) and the header keeps its
 * `h-16` geometry so a banner never moves the channel list.
 */
import { createElement } from "react";
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
import type { Channel, ChannelCategory, ChannelId } from "@demli/types";
import { AppDataProvider, type ShellData } from "../data/shell-data";
import { ChannelSidebar } from "./ChannelSidebar";
import { mount } from "../test/dom";

const GROUP = "grp-1";
const BANNER = "https://cdn.example/avatars-bucket/group-banners/grp-1/abc.png";

const CHANNELS: Channel[] = [
  {
    id: "general",
    groupId: GROUP,
    kind: "text",
    name: "general",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    categoryId: null,
  } as Channel,
];

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

async function mountSidebar(
  overrides: Partial<ShellData> = {},
  showServerMenu = false,
): Promise<ReturnType<typeof mount>> {
  const i18n = await createI18n({ lng: "en", storage: createMemoryStorage() });
  return mount(
    <I18nextProvider i18n={i18n}>
      <AppDataProvider value={shellData(overrides)}>
        <ChannelSidebar
          renderChannel={(channel) => (
            <button type="button" data-channel={channel.id}>
              {channel.name}
            </button>
          )}
          showServerMenu={showServerMenu}
        />
      </AppDataProvider>
    </I18nextProvider>,
  );
}

/** The server-name header element, whichever of the two branches rendered it. */
function header(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".h-16");
  if (!node) throw new Error("the sidebar header did not render");
  return node;
}

describe("server banner — absent (every pre-0022 server, and the default)", () => {
  it("renders NO image at all", async () => {
    const mounted = await mountSidebar({ activeGroupBannerUrl: null });
    try {
      expect(document.querySelectorAll("img")).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });

  it("still shows the server name, in a header of the unchanged height", async () => {
    const mounted = await mountSidebar({ activeGroupBannerUrl: null });
    try {
      expect(header().textContent).toContain("Demli");
      expect(header().className).toContain("h-16");
    } finally {
      mounted.unmount();
    }
  });

  it("falls back to the generic label when the server has no name either", async () => {
    const mounted = await mountSidebar({
      activeGroupBannerUrl: null,
      activeGroupName: null,
    });
    try {
      expect(header().textContent).toContain("Server");
    } finally {
      mounted.unmount();
    }
  });
});

describe("server banner — present", () => {
  it("paints the banner inside the header, and keeps the name readable", async () => {
    const mounted = await mountSidebar({ activeGroupBannerUrl: BANNER });
    try {
      const img = document.querySelector<HTMLImageElement>("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe(BANNER);
      expect(header().contains(img)).toBe(true);
      expect(header().textContent).toContain("Demli");
    } finally {
      mounted.unmount();
    }
  });

  it("is DECORATIVE — empty alt and aria-hidden, so it is never announced", async () => {
    const mounted = await mountSidebar({ activeGroupBannerUrl: BANNER });
    try {
      const img = document.querySelector<HTMLImageElement>("img");
      expect(img?.getAttribute("alt")).toBe("");
      expect(img?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      mounted.unmount();
    }
  });

  it("does NOT change the header's height — the channel list never shifts", async () => {
    const withBanner = await mountSidebar({ activeGroupBannerUrl: BANNER });
    const bannerClass = header().className;
    withBanner.unmount();

    const without = await mountSidebar({ activeGroupBannerUrl: null });
    try {
      expect(bannerClass).toContain("h-16");
      expect(header().className).toContain("h-16");
    } finally {
      without.unmount();
    }
  });

  it("renders in the interactive (server-menu) header too, not just the plain one", async () => {
    const mounted = await mountSidebar({ activeGroupBannerUrl: BANNER }, true);
    try {
      const img = document.querySelector<HTMLImageElement>("img");
      expect(img?.getAttribute("src")).toBe(BANNER);
      expect(header().textContent).toContain("Demli");
    } finally {
      mounted.unmount();
    }
  });

  it("hides the image if the URL fails to load, leaving today's header behind", async () => {
    const mounted = await mountSidebar({ activeGroupBannerUrl: BANNER });
    try {
      const img = document.querySelector<HTMLImageElement>("img");
      expect(img).not.toBeNull();
      img?.dispatchEvent(new Event("error", { bubbles: false }));
      expect(img?.style.display).toBe("none");
      // The name is still there — a dead image degrades, it does not blank out.
      expect(header().textContent).toContain("Demli");
    } finally {
      mounted.unmount();
    }
  });
});
