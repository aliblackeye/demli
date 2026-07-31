/**
 * Shell data contract — the single, typed seam the shared shell-edge components
 * (GroupRail, ChannelSidebar, HomeSidebar, MemberSidebar) read their data from,
 * instead of touching any Zustand store, TanStack Query hook, or `window` global
 * directly. One component tree then renders unchanged on desktop and web; only
 * the surface that BUILDS this value differs.
 *
 * Design (Phase 1, tek-kaynak UI):
 *   - The value is CONSUMER-DRIVEN and mostly PRE-DERIVED. Anything whose
 *     computation is platform-coupled — per-server unread (needs the desktop
 *     query cache), mute mode (chat-store internals), member role colors
 *     (permission helpers), presence status — is resolved by the surface and
 *     handed over as plain, ready-to-render data. The shared components stay
 *     purely presentational, so their output is byte-identical to the
 *     hand-written desktop components they replace.
 *   - The desktop maps its ui-store / chat-store / queries into this shape once,
 *     near the shell root, via <AppDataProvider>. The web (Phase 4) will provide
 *     the same shape from its own state.
 *   - Only fields the four moved components actually consume live here — no
 *     speculative surface. Desktop-specific INTERACTIVE pieces (ChannelItem,
 *     VoicePanel, UserFooter, CallDock, ProfileCard, the notification-mute
 *     submenu) are NOT data — they are passed as composition slots (props) to
 *     the individual components, keeping voice/mutation coupling out of here.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ChannelOrderInput } from "@demli/client-core";
import type {
  CategoryId,
  Channel,
  ChannelCategory,
  ChannelId,
  DmId,
  GroupId,
  PresencePlatform,
  PresenceStatus,
  UserId,
} from "@demli/types";

/** Which surface the middle three columns show. */
export type ActiveView = "server" | "home";

/** Home sub-surface routing (ADR 0010): friends table / call history / DM / group chat. */
export type HomeView = "friends" | "recentCalls" | "groupChat" | "dm";

/**
 * Aggregate unread for a set of streams (a server's channels, or the whole home
 * surface), already mute-aware. Mirrors the desktop `StreamsUnread` but is
 * self-contained so app-ui never imports the desktop derivation.
 */
export interface UnreadState {
  /** Any unread the badge should surface. */
  unread: boolean;
  /** At least one of those unreads is a direct @mention (accent badge). */
  mention: boolean;
  /** Sum of per-stream counts from unmuted contributing streams. */
  count: number;
}

/**
 * Per-home-row unread DISPLAY descriptor (a DM row or a flat-group-chat row),
 * pre-resolved against the row's mute mode so the shared HomeSidebar only paints.
 */
export interface HomeRowUnread {
  /** The row's effective mute mode is non-null (shows the muted bell, dims the row). */
  muted: boolean;
  /** Show the unread affordance at all (respects "all"/"mentions" muting). */
  showUnread: boolean;
  /** The unread is a mention under a "mentions" mute (accent pip, no number). */
  showMentionBadge: boolean;
  /** A real count string when countable, else null (pip / "1+" fallback). */
  countBadge: string | null;
}

/** A server/group entry in the left rail, with its pre-derived unread + mute state. */
export interface ShellGroup {
  id: GroupId;
  name: string;
  /**
   * Server icon URL (`FriendGroup.iconUrl`). When present and it loads, the photo
   * covers the seed-color initials tile; a load error / null falls back to the
   * initials so a dead URL never leaves an empty square. Render only — upload is
   * a separate concern.
   */
  iconUrl: string | null;
  /** The signed-in user owns this server (owners delete rather than leave it). */
  isOwner: boolean;
  /** Group-scope mute active (quieter avatar + bell chip). */
  muted: boolean;
  /** Mute-aware per-server unread aggregate (#110). */
  unread: UnreadState;
}

/** A DM row in the home sidebar, with the peer's presence + pre-derived unread. */
export interface ShellDmRow {
  id: DmId;
  streamId: ChannelId;
  /** Peer user id — the avatar color seed. */
  participantId: UserId;
  participantName: string;
  /** Peer `user.avatarUrl` — the real photo for the row's avatar; null when unset. */
  participantAvatarUrl: string | null;
  status: PresenceStatus;
  platform?: PresencePlatform;
  unread: HomeRowUnread;
}

/** A flat group-chat row (ADR 0005) in the home sidebar. */
export interface ShellGroupChatRow {
  id: GroupId;
  streamId: ChannelId;
  name: string;
  unread: HomeRowUnread;
}

/**
 * A server role a member holds, pre-resolved to plain display data (id + name +
 * chip color) so the shared roster paints it without touching the permission
 * helpers or the roles query. Ordered highest-position first by the surface.
 */
export interface ShellMemberRole {
  id: string;
  name: string;
  /** Chip dot color as `"#rrggbb"`, or null → a neutral fallback dot. */
  color: string | null;
}

/** A roster member row, with presence + pre-resolved role color + owner flag. */
export interface ShellMember {
  id: UserId;
  displayName: string;
  /**
   * Profile photo URL, or null for the initials fallback. Optional so a surface
   * that has not wired it yet still type-checks — but every real provider MUST
   * set it: without it the roster renders initials for everyone forever, which
   * is exactly the "my new avatar never shows up for other people" bug.
   */
  avatarUrl?: string | null;
  status: PresenceStatus;
  platform?: PresencePlatform;
  isOwner: boolean;
  /**
   * The member's live custom status line (M18), or null when they have none / it
   * expired. PLAIN TEXT: rendered escaped as a second line under the name, never
   * as HTML or markdown (§28).
   */
  customStatus?: string | null;
  /** Highest colored-role color, or null (default text color). */
  color: string | null;
  /**
   * Every custom role this member holds, pre-resolved for display (highest-first).
   * Empty when the member holds none (or on a surface with no role system). Drives
   * the inline role chips in the roster (M18) and the assignment menu's checked set.
   */
  roles: ShellMemberRole[];
  /** Guests can hold no roles (ADR 0007) — the assignment menu explains, not offers. */
  isGuest: boolean;
  /**
   * ISO instant this member's timeout (mute) lapses, or null when they are not
   * timed out (ADR 0019 §3). Carried RAW — expiry is a clock comparison the
   * roster makes itself, so a mute that lapses while the app is open clears
   * without a refetch instead of leaving a stale badge behind.
   */
  timedOutUntil?: string | null;
}

/** Loading state for the home sidebar's flat group-chat list. */
export type GroupChatsStatus = "pending" | "error" | "ready";

/**
 * The full ambient data the four shell-edge components read. Everything here is
 * plain data or a stable action callback — no React elements (those are slots).
 */
export interface ShellData {
  // ── surface routing ───────────────────────────────────────────────────────
  activeView: ActiveView;
  homeView: HomeView;
  activeGroupId: GroupId | null;
  activeChannelId: ChannelId | null;
  activeGroupChatId: GroupId | null;
  activeDmId: DmId | null;

  // ── group rail ────────────────────────────────────────────────────────────
  groups: ShellGroup[];
  /** Aggregate unread over the home surface (DMs + group chats), mute-aware. */
  homeUnread: UnreadState;

  // ── channel sidebar (active server) ───────────────────────────────────────
  activeGroupName: string | null;
  /**
   * The active server's banner image (M20), or null when it has none — which is
   * the default and stays a first-class state: the header renders exactly as it
   * did before banners existed rather than showing an empty box (§35).
   */
  activeGroupBannerUrl: string | null;
  /** The active server's channels, UNSORTED — the component sorts by position. */
  channels: Channel[];
  /**
   * The active server's categories (M18), UNSORTED — the component sorts by
   * position. Empty for a server with none, which renders exactly as before:
   * every channel stays in the uncategorized top-level list.
   */
  categories: ChannelCategory[];
  canManageChannels: boolean;
  canOpenServerSettings: boolean;
  /**
   * The voice room this client is CONNECTED to (any non-idle status), or null.
   *
   * Independent of `activeChannelId`: reading #general while talking in 🔊lobby
   * is the normal case, and both are places the user occupies. The sidebar's hide
   * rules (collapse, hide-muted) exempt both — see
   * `@demli/client-core` sidebar-visibility — so neither can be hidden out
   * from under them. Surfaced as plain data (not a voice-store read) so the
   * shared sidebar keeps its hands off the media FSM (§11).
   */
  connectedVoiceChannelId: ChannelId | null;
  /**
   * Channels the viewer muted INDIVIDUALLY, pre-derived by the surface (the mute
   * mirror is store-internal). Channel-scope mutes ONLY — a server-scope mute
   * makes every channel "muted", and feeding that in would empty the sidebar the
   * moment someone mutes a server.
   */
  mutedChannelIds: ReadonlySet<ChannelId>;
  /**
   * The viewer may mint invites for this server (`invite_policy` + guest gate,
   * resolved through `canCreateServerInvite`). False hides the invite icon on
   * every channel row and every invite entry in every menu — not disabled,
   * ABSENT (§35, founder's reference screenshots).
   */
  canCreateInvite: boolean;

  // ── home sidebar ──────────────────────────────────────────────────────────
  dms: ShellDmRow[];
  groupChats: ShellGroupChatRow[];
  groupChatsStatus: GroupChatsStatus;
  /** Localized error message when `groupChatsStatus === "error"`, else null. */
  groupChatsErrorMessage: string | null;

  // ── member sidebar (active server roster) ─────────────────────────────────
  members: ShellMember[];

  // ── actions: surface routing ──────────────────────────────────────────────
  openServer: (groupId: GroupId) => void;
  openHome: () => void;
  openFriends: () => void;
  openRecentCalls: () => void;
  openDm: (input: { id: DmId; streamId: ChannelId }) => void;
  openGroupChat: (input: { id: GroupId; streamId: ChannelId }) => void;
  /**
   * Close (hide-for-self) a DM from the home list. Reversible: the DM and its
   * full history are preserved server-side and reappear when the peer's DM is
   * reopened — this only drops the row from the caller's list (ADR 0010).
   */
  hideDm: (dmId: DmId) => void;

  // ── actions: dialogs / server ops ─────────────────────────────────────────
  /** Rail "+" — opens the add-a-server entry point (create or join with an invite). */
  openCreateGroup: () => void;
  /**
   * Rail download button — opens the "get Demli on your devices" dialog. The
   * surface owns which platforms it can honestly offer (see the desktop
   * lib/download-links.ts availability matrix); the rail only triggers it.
   */
  openDownloadApp: () => void;
  openCreateGroupChat: () => void;
  openLeaveServer: (groupId: GroupId) => void;
  openInvite: () => void;
  /**
   * Open the "invite a friend into THIS channel" dialog (founder's third
   * reference screenshot). The dialog mints an invite carrying the channel as
   * its target, so a redeemer lands there instead of the server's front door.
   * Only ever called from a control that `canCreateInvite` allowed.
   */
  openChannelInvite: (channelId: ChannelId) => void;
  /**
   * Open the create-channel dialog. `categoryId` pre-files the new channel under
   * a category (the "+" on a category header); omitted/null creates it in the
   * uncategorized top-level list, which is the pre-M18 behaviour.
   */
  openCreateChannel: (categoryId?: CategoryId | null) => void;
  openServerSettings: () => void;
  retryGroupChats: () => void;

  // ── actions: channel categories (M18) ─────────────────────────────────────
  /** Open the "create category" dialog (owner ∨ MANAGE_CHANNELS). */
  openCreateCategory: () => void;
  /** Open the rename dialog for one category. */
  openRenameCategory: (categoryId: CategoryId, currentName: string) => void;
  /**
   * Open the delete confirmation for one category. The copy MUST say the channels
   * survive and become uncategorized — the API's FK is ON DELETE SET NULL, and a
   * confirmation that implies otherwise would be a lie about a destructive action.
   */
  openDeleteCategory: (categoryId: CategoryId, name: string) => void;
  /**
   * Persist a new sidebar order. The caller has already built a payload whose
   * every touched bucket is listed in FULL (see `channelOrder.toReorderPayload`);
   * the surface only posts it. Rejects on failure so the sidebar can roll its
   * optimistic order back and say so (§26).
   */
  reorderSidebar: (input: ChannelOrderInput) => Promise<void>;
}

const ShellDataContext = createContext<ShellData | null>(null);

export interface AppDataProviderProps {
  /** The surface's assembled shell data (desktop maps stores/queries into it). */
  value: ShellData;
  children: ReactNode;
}

/** Makes the {@link ShellData} available to the shell-edge components below it. */
export function AppDataProvider({ value, children }: AppDataProviderProps): ReactNode {
  return <ShellDataContext.Provider value={value}>{children}</ShellDataContext.Provider>;
}

/**
 * Read the ambient {@link ShellData}. Throws when no {@link AppDataProvider} is
 * above it — a wiring bug surfaced loudly rather than a silent half-render.
 */
export function useShellData(): ShellData {
  const value = useContext(ShellDataContext);
  if (value === null) {
    throw new Error(
      "useShellData() must be used within an <AppDataProvider>. Wire one near the shell root " +
        "and feed it your surface's routing/roster/unread state.",
    );
  }
  return value;
}
