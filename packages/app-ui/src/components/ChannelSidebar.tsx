import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import {
  ChevronDown,
  FolderPlus,
  Hash,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserPlus,
} from "lucide-react";
import {
  Button,
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import {
  visibleSidebarChannels,
  type PinnedSidebarChannels,
  type SidebarVisibilityOptions,
} from "@demli/client-core";
import type { CategoryId, Channel, ChannelId } from "@demli/types";
import { useShellData } from "../data/shell-data";
import { ActionMenu } from "./ActionMenu";
import { EmptyState } from "./EmptyState";
import { FormErrorAlert } from "./FormErrorAlert";
import { SectionHeading } from "./SectionHeading";
import { ShellListSkeleton } from "./ShellListSkeleton";
import {
  buildSidebarBuckets,
  canNudgeCategory,
  canNudgeChannel,
  moveCategory,
  moveChannel,
  nudgeCategory,
  nudgeChannel,
  toReorderPayload,
  type SidebarBucket,
} from "./channelOrder";
import {
  SIDEBAR_SECTION_KEYS,
  useCollapsedSections,
  useHideMutedChannels,
  type SidebarSectionKey,
} from "./sidebarPreferences";

/** Where a channel may be moved, for the row menu's "move to category" list. */
export interface ChannelMoveTarget {
  /** `null` = the uncategorized top-level list. */
  id: CategoryId | null;
  name: string;
}

/**
 * Ordering affordances handed to the row renderer (M18). Present only for a
 * viewer who may manage channels — a member without the permission gets `null`
 * and therefore renders no reorder controls at all (§35).
 *
 * The nudge actions are the DRAG-FREE path: HTML5 drag-and-drop does not exist on
 * touch, and the web app is opened from phones, so every reorder reachable by
 * dragging is also reachable through these menu items.
 */
export interface ChannelOrderingActions {
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUp: () => void;
  moveDown: () => void;
  /** Buckets this channel is NOT already in (uncategorized included). */
  moveTargets: ChannelMoveTarget[];
  moveTo: (categoryId: CategoryId | null) => void;
}

/** Props the row renderer spreads onto its clickable row to make it draggable. */
export interface ChannelDragProps {
  draggable: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

export interface RenderChannelOptions {
  canManage: boolean;
  groupName: string | null;
  /** Reorder actions, or null when the viewer may not manage channels. */
  ordering: ChannelOrderingActions | null;
  /** Spread onto the row element; a no-op set when reordering is unavailable. */
  dragProps: ChannelDragProps;
  /**
   * The viewer may invite people into this channel (`invite_policy` + guest
   * gate). FALSE MEANS RENDER NOTHING — no icon on the row, no entry in its menu
   * (§35, founder's second reference screenshot). Never a disabled control.
   */
  canInvite: boolean;
  /** Open the channel-invite dialog for this row. Only call it when `canInvite`. */
  openInvite: () => void;
}

/**
 * Renders one channel row. Desktop hands back its voice/draft/mutation-coupled
 * ChannelItem (which stays desktop, Phase 2); web (Phase 4) supplies its own.
 */
export type RenderChannel = (channel: Channel, opts: RenderChannelOptions) => ReactNode;

export interface ChannelSidebarProps {
  /** Row renderer — desktop passes <ChannelItem>. Required (no meaningful default). */
  renderChannel: RenderChannel;
  /** Voice panel slot below the channel list (desktop VoicePanel, Phase 2). */
  voicePanel?: ReactNode;
  /** User footer slot at the column bottom (desktop UserFooter). */
  userFooter?: ReactNode;
  /**
   * Show the server-header dropdown (invite / create channel / server settings).
   * Default true (desktop). A surface without those dialogs yet (web, Phase 4)
   * passes false → the header becomes a plain, non-interactive title, so none of
   * those entries are dead controls (§35).
   */
  showServerMenu?: boolean;
}

/**
 * What is currently being dragged. A channel drag carries its `channelKind`
 * because the uncategorized bucket is DISPLAYED as a Text/Voice split while the
 * server stores it as ONE ordered list: offering a text channel a drop slot in
 * the Voice section would move it in the data and leave it looking unmoved.
 */
type SidebarDrag =
  | { kind: "channel"; id: ChannelId; channelKind: Channel["kind"] }
  | { kind: "category"; id: CategoryId };

const NO_DRAG: ChannelDragProps = {
  draggable: false,
  onDragStart: () => {},
  onDragEnd: () => {},
};

/**
 * A thin drop line between two rows. Rendered ONLY while a drag is in flight, so
 * an idle sidebar has exactly the same DOM children as before — `space-y-px`
 * spacing (and the voice-occupant rows that hang off a channel) stay untouched.
 */
function DropLine({
  active,
  onDragOver,
  onDrop,
  label,
}: {
  active: boolean;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  label: string;
}): JSX.Element {
  return (
    <div
      aria-label={label}
      className="flex w-full shrink-0 items-center"
      style={{ height: 8 }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span
        aria-hidden
        className={cn(
          "mx-2 h-0.5 flex-1 rounded-full bg-accent transition-opacity motion-instant",
          active ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/**
 * The collapse chevron shared by every sidebar section header — the category
 * headers (M18) and the uncategorized Text/Voice lists.
 *
 * One glyph that turns a quarter (fast step) rather than two swapped glyphs: the
 * turn is the feedback that the section answered. Reduced motion is NOT left to
 * chance here — the global `prefers-reduced-motion` guard in globals.css clamps
 * every transition (this one included) to 0.01ms, so the chevron simply lands in
 * its end state for those users. `data-collapsed` lets a test read the state
 * without measuring a transform.
 */
function CollapseChevron({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <ChevronDown
      aria-hidden
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "ml-1 size-3.5 shrink-0 text-fg-faint transition-transform motion-fast",
        "group-hover/sec:text-fg-muted",
        collapsed && "-rotate-90",
      )}
    />
  );
}

/** How long a just-expanded section's rows keep their arrival class. */
const REVEAL_MS = 400;

/**
 * Second column for the server surface (CLAUDE.md §7): the server header dropdown
 * (invite / create channel / create category / server settings, permission-gated)
 * over the channel list.
 *
 * Layout (M18): the UNCATEGORIZED channels keep their familiar Text/Voice split at
 * the top — so a server with no categories renders byte-for-byte as it did before
 * — followed by one collapsible section per category, each holding its channels in
 * the order the server states.
 *
 * Reordering is optimistic: the model moves locally, the PATCH goes out, and a
 * failure rolls the sidebar back and says so rather than leaving a lie on screen.
 */
export function ChannelSidebar({
  renderChannel,
  voicePanel,
  userFooter,
  showServerMenu = true,
}: ChannelSidebarProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const {
    activeGroupId,
    activeGroupName,
    activeGroupBannerUrl,
    activeChannelId,
    connectedVoiceChannelId,
    mutedChannelIds,
    channels,
    categories,
    canManageChannels,
    canCreateInvite,
    canOpenServerSettings,
    openInvite,
    openChannelInvite,
    openCreateChannel,
    openCreateCategory,
    openRenameCategory,
    openDeleteCategory,
    openServerSettings,
    reorderSidebar,
    serverDetailsLoading = false,
  } = useShellData();

  const { isCollapsed, toggle: toggleCollapsed } = useCollapsedSections(activeGroupId);

  // The section the user just EXPANDED: its rows fade in once, so opening a
  // section reads as the list arriving rather than as a jump. Only a user
  // toggle sets it — first paint and server switches never animate the list.
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const toggle = useCallback(
    (key: string) => {
      if (isCollapsed(key)) setRevealKey(key);
      toggleCollapsed(key);
    },
    [isCollapsed, toggleCollapsed],
  );
  useEffect(() => {
    if (revealKey === null) return;
    const timer = window.setTimeout(() => setRevealKey(null), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealKey]);
  const { hideMuted, toggleHideMuted } = useHideMutedChannels(activeGroupId);

  // The two rows that survive every hide rule: the conversation on screen and
  // the room this client's microphone is in (see client-core/sidebar-visibility).
  const pinned = useMemo<PinnedSidebarChannels>(
    () => ({ activeChannelId, connectedVoiceChannelId }),
    [activeChannelId, connectedVoiceChannelId],
  );

  // Server truth, derived fresh from props.
  const serverBuckets = useMemo(
    () => buildSidebarBuckets(channels, categories),
    [channels, categories],
  );
  const serverCategoryIds = useMemo(
    () => serverBuckets.flatMap((b) => (b.category ? [b.category.id] : [])),
    [serverBuckets],
  );

  // Optimistic override while a reorder is in flight / until the refetch lands.
  const [override, setOverride] = useState<{
    buckets: SidebarBucket[];
    categoryIds: CategoryId[];
  } | null>(null);
  const [reorderError, setReorderError] = useState(false);
  const inFlight = useRef(0);

  // Drop the override once fresh server data arrives (the mutation invalidates
  // the group details, and `category.reordered` refetches for everyone else).
  // Guarded on `inFlight` so the refetch that OUR mutation triggered is the one
  // that clears it, never a mid-flight tick that would flash the old order back.
  useEffect(() => {
    if (inFlight.current === 0) setOverride(null);
  }, [serverBuckets, serverCategoryIds]);

  // Switching servers always drops a stale override outright.
  useEffect(() => {
    setOverride(null);
    setReorderError(false);
  }, [activeGroupId]);

  const buckets = override?.buckets ?? serverBuckets;
  const categoryIds = override?.categoryIds ?? serverCategoryIds;

  /** Apply a local model change and persist it; roll back on failure (§26). */
  const commit = useCallback(
    (next: { buckets: SidebarBucket[]; categoryIds: CategoryId[] }) => {
      const payload = toReorderPayload({
        previousBuckets: buckets,
        nextBuckets: next.buckets,
        previousCategoryIds: categoryIds,
        nextCategoryIds: next.categoryIds,
      });
      if (!payload) return;

      const rollback = { buckets: [...buckets], categoryIds: [...categoryIds] };
      setOverride(next);
      setReorderError(false);
      inFlight.current += 1;
      void reorderSidebar(payload)
        .catch(() => {
          setOverride(rollback);
          setReorderError(true);
        })
        .finally(() => {
          inFlight.current = Math.max(0, inFlight.current - 1);
        });
    },
    [buckets, categoryIds, reorderSidebar],
  );

  // Re-sort the buckets whenever the category ORDER changed locally, so a
  // category drag repaints immediately instead of waiting for the refetch.
  const orderedBuckets = useMemo(() => {
    if (!override) return buckets;
    const rank = new Map(categoryIds.map((id, i) => [id, i]));
    const uncategorized = buckets.filter((b) => b.category === null);
    const rest = buckets
      .filter((b) => b.category !== null)
      .sort(
        (a, b) =>
          (rank.get(a.category?.id ?? "") ?? 0) - (rank.get(b.category?.id ?? "") ?? 0),
      );
    return [...uncategorized, ...rest];
  }, [buckets, categoryIds, override]);

  // ── drag state ────────────────────────────────────────────────────────────
  const [drag, setDrag] = useState<SidebarDrag | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const endDrag = useCallback(() => {
    setDrag(null);
    setOverKey(null);
  }, []);

  const dropChannel = useCallback(
    (categoryId: CategoryId | null, beforeChannelId: ChannelId | null) => {
      if (drag?.kind !== "channel") return;
      commit({
        buckets: moveChannel(buckets, drag.id, { categoryId, beforeChannelId }),
        categoryIds: [...categoryIds],
      });
      endDrag();
    },
    [drag, buckets, categoryIds, commit, endDrag],
  );

  const dropCategory = useCallback(
    (beforeCategoryId: CategoryId | null) => {
      if (drag?.kind !== "category") return;
      commit({
        buckets: [...buckets],
        categoryIds: moveCategory(categoryIds, drag.id, beforeCategoryId),
      });
      endDrag();
    },
    [drag, buckets, categoryIds, commit, endDrag],
  );

  /** All buckets a channel could be moved into, minus the one it already sits in. */
  const moveTargetsFor = useCallback(
    (currentCategoryId: CategoryId | null): ChannelMoveTarget[] => {
      const targets: ChannelMoveTarget[] = [];
      if (currentCategoryId !== null) {
        targets.push({ id: null, name: t("desktop:sidebar.uncategorized") });
      }
      for (const bucket of orderedBuckets) {
        const category = bucket.category;
        if (category && category.id !== currentCategoryId) {
          targets.push({ id: category.id, name: category.name });
        }
      }
      return targets;
    },
    [orderedBuckets, t],
  );

  /** Per-row ordering actions + drag props, or the inert set for a plain member. */
  const optionsFor = useCallback(
    (channel: Channel, bucketCategoryId: CategoryId | null): RenderChannelOptions => {
      if (!canManageChannels) {
        return {
          canManage: false,
          groupName: activeGroupName,
          ordering: null,
          dragProps: NO_DRAG,
          canInvite: canCreateInvite,
          openInvite: () => openChannelInvite(channel.id),
        };
      }
      return {
        canManage: true,
        groupName: activeGroupName,
        canInvite: canCreateInvite,
        openInvite: () => openChannelInvite(channel.id),
        ordering: {
          canMoveUp: canNudgeChannel(buckets, channel.id, "up"),
          canMoveDown: canNudgeChannel(buckets, channel.id, "down"),
          moveUp: () =>
            commit({
              buckets: nudgeChannel(buckets, channel.id, "up"),
              categoryIds: [...categoryIds],
            }),
          moveDown: () =>
            commit({
              buckets: nudgeChannel(buckets, channel.id, "down"),
              categoryIds: [...categoryIds],
            }),
          moveTargets: moveTargetsFor(bucketCategoryId),
          moveTo: (categoryId) =>
            commit({
              buckets: moveChannel(buckets, channel.id, {
                categoryId,
                beforeChannelId: null,
              }),
              categoryIds: [...categoryIds],
            }),
        },
        dragProps: {
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = "move";
            // Firefox refuses to start a drag without payload data.
            event.dataTransfer.setData("text/plain", channel.id);
            setDrag({ kind: "channel", id: channel.id, channelKind: channel.kind });
          },
          onDragEnd: endDrag,
        },
      };
    },
    [
      canManageChannels,
      canCreateInvite,
      openChannelInvite,
      activeGroupName,
      buckets,
      categoryIds,
      commit,
      moveTargetsFor,
      endDrag,
    ],
  );

  /**
   * One run of channel rows with the drop lines between them. `bucket` is the
   * bucket these rows belong to — the drop index is always expressed as "insert
   * before channel X", so a subsection (the uncategorized Text/Voice split) drops
   * into exactly the right slot of its bucket's single ordered list.
   *
   * `onlyKind` restricts the drop lines to one channel kind. The uncategorized
   * bucket passes it so a text channel is never offered a slot in the Voice
   * section: the move would be real in the data but invisible on screen, which is
   * exactly the kind of silently-wrong feedback §35 forbids. Category buckets
   * render one unfiltered list, so they pass nothing and accept either kind.
   *
   * `hidingRows` suppresses the drop lines entirely. A section that is collapsed
   * (or filtering muted channels out) is showing an INCOMPLETE list, and a drop
   * line between two visible rows would claim to place a channel "here" while
   * the neighbours it would really land between are off screen — a move whose
   * result the user cannot see is the silently-wrong feedback §35 forbids. Every
   * reorder stays reachable through the row menu's move entries.
   */
  const renderRows = (
    bucket: SidebarBucket,
    rows: readonly Channel[],
    onlyKind?: Channel["kind"],
    hidingRows = false,
    revealing = false,
  ): JSX.Element => {
    const bucketCategoryId = bucket.category?.id ?? null;
    const dragging =
      !hidingRows &&
      drag?.kind === "channel" &&
      (onlyKind === undefined || drag.channelKind === onlyKind);
    // The trailing drop line of a subsection inserts before whatever follows its
    // last row IN THE BUCKET (the first voice channel, for the Text subsection),
    // or appends when nothing follows.
    const last = rows[rows.length - 1];
    const tailIndex = last ? bucket.channels.findIndex((c) => c.id === last.id) + 1 : 0;
    const tailBefore = bucket.channels[tailIndex]?.id ?? null;

    const line = (beforeChannelId: ChannelId | null, key: string): JSX.Element => {
      const dropKey = `ch:${bucketCategoryId ?? "-"}:${beforeChannelId ?? "end"}`;
      return (
        <DropLine
          key={key}
          active={overKey === dropKey}
          label={t("desktop:sidebar.dropHere")}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            setOverKey(dropKey);
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dropChannel(bucketCategoryId, beforeChannelId);
          }}
        />
      );
    };

    return (
      <div className={cn("space-y-px", revealing && "animate-fade-in")}>
        {rows.map((channel) => (
          <Fragment key={channel.id}>
            {dragging && line(channel.id, `before-${channel.id}`)}
            {renderChannel(channel, optionsFor(channel, bucketCategoryId))}
          </Fragment>
        ))}
        {dragging && line(tailBefore, "tail")}
      </div>
    );
  };

  /** A category header: collapse toggle, name, add-channel and the manage menu. */
  const renderCategoryHeader = (bucket: SidebarBucket): JSX.Element | null => {
    const category = bucket.category;
    if (!category) return null;
    const collapsed = isCollapsed(category.id);
    const dropKey = `cat:${category.id}`;
    const canDropCategory = drag?.kind === "category" && drag.id !== category.id;

    return (
      <div
        className={cn(
          // The section's vertical rhythm lives on the ROW, not on the heading
          // inside it: SectionHeading's own `pt-4 pb-1` is asymmetric, so a
          // chevron centred against the padded box lands visibly above the text.
          // Padding here + `py-0` on the heading centres it on the words.
          "group/cat group/sec flex items-center gap-0.5 rounded-md pb-1 pr-1 pt-4",
          "transition-colors motion-hover",
          canDropCategory && overKey === dropKey && "bg-accent-surface",
        )}
        draggable={canManageChannels}
        onDragStart={(event) => {
          if (!canManageChannels) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", category.id);
          setDrag({ kind: "category", id: category.id });
        }}
        onDragEnd={endDrag}
        onDragOver={(event) => {
          if (!canDropCategory) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setOverKey(dropKey);
        }}
        onDrop={(event) => {
          if (!canDropCategory) return;
          event.preventDefault();
          event.stopPropagation();
          dropCategory(category.id);
        }}
      >
        <button
          type="button"
          onClick={() => toggle(category.id)}
          aria-expanded={!collapsed}
          aria-label={
            collapsed
              ? t("desktop:sidebar.expandCategory", { name: category.name })
              : t("desktop:sidebar.collapseCategory", { name: category.name })
          }
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-0.5 rounded-sm text-left",
            "[&_h3]:transition-colors [&_h3]:motion-hover hover:[&_h3]:text-fg-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          )}
        >
          <CollapseChevron collapsed={collapsed} />
          <SectionHeading className="min-w-0 flex-1 truncate px-1 py-0">
            {category.name}
          </SectionHeading>
        </button>

        {canManageChannels && (
          <>
            <button
              type="button"
              onClick={() => openCreateChannel(category.id)}
              aria-label={t("desktop:sidebar.createChannelInCategory", { name: category.name })}
              title={t("desktop:sidebar.createChannelInCategory", { name: category.name })}
              className={cn(
                "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-faint",
                "opacity-0 transition-[opacity,color,background-color] motion-hover hover:bg-wash hover:text-fg",
                "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                "group-hover/cat:opacity-100 pointer-coarse:opacity-100",
              )}
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("a11y.moreActions")}
                  className={cn(
                    "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-faint",
                    "opacity-0 transition-[opacity,color,background-color] motion-hover hover:bg-wash hover:text-fg",
                    "data-[state=open]:bg-wash data-[state=open]:text-fg data-[state=open]:opacity-100",
                    "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                    "group-hover/cat:opacity-100 pointer-coarse:opacity-100",
                  )}
                >
                  <Settings className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuItem onSelect={() => openCreateChannel(category.id)}>
                  <Plus className="size-4" />
                  {t("desktop:sidebar.createChannel")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => openRenameCategory(category.id, category.name)}
                >
                  <Pencil className="size-4" />
                  {t("desktop:category.edit")}
                </DropdownMenuItem>
                {/* Drag-free reordering (touch / narrow web). Each entry is hidden
                    when it would do nothing, so there is no disabled placeholder
                    pretending to be actionable (§35). */}
                {canNudgeCategory(categoryIds, category.id, "up") && (
                  <DropdownMenuItem
                    onSelect={() =>
                      commit({
                        buckets: [...buckets],
                        categoryIds: nudgeCategory(categoryIds, category.id, "up"),
                      })
                    }
                  >
                    {t("desktop:sidebar.moveUp")}
                  </DropdownMenuItem>
                )}
                {canNudgeCategory(categoryIds, category.id, "down") && (
                  <DropdownMenuItem
                    onSelect={() =>
                      commit({
                        buckets: [...buckets],
                        categoryIds: nudgeCategory(categoryIds, category.id, "down"),
                      })
                    }
                  >
                    {t("desktop:sidebar.moveDown")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  danger
                  onSelect={() => openDeleteCategory(category.id, category.name)}
                >
                  <Trash2 className="size-4" />
                  {t("desktop:category.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    );
  };

  /**
   * A collapsible header for the two fixed lists ("Metin Kanalları" / "Ses
   * Kanalları"). A real `<button>` with `aria-expanded`, so the section opens and
   * closes from the keyboard exactly as the category headers do.
   */
  const renderSectionHeader = (
    sectionKey: SidebarSectionKey,
    label: string,
    collapsed: boolean,
  ): JSX.Element => (
    <button
      type="button"
      onClick={() => toggle(sectionKey)}
      aria-expanded={!collapsed}
      aria-label={
        collapsed
          ? t("desktop:sidebar.expandSection", { name: label })
          : t("desktop:sidebar.collapseSection", { name: label })
      }
      className={cn(
        // Same rhythm-on-the-row rule as the category header above, so the two
        // kinds of section header are indistinguishable in the list.
        "group/sec flex w-full min-w-0 cursor-pointer items-center gap-0.5 rounded-sm pb-1 pt-4 text-left",
        "[&_h3]:transition-colors [&_h3]:motion-hover hover:[&_h3]:text-fg-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
      )}
    >
      <CollapseChevron collapsed={collapsed} />
      <SectionHeading className="min-w-0 flex-1 truncate px-1 py-0">{label}</SectionHeading>
    </button>
  );

  /** The hide rules in force for one section (see client-core/sidebar-visibility). */
  const visibilityFor = (sectionKey: SidebarSectionKey): SidebarVisibilityOptions => ({
    collapsed: isCollapsed(sectionKey),
    hideMuted,
    mutedChannelIds,
    pinned,
  });

  const uncategorized = orderedBuckets.find((b) => b.category === null);
  const textChannels = (uncategorized?.channels ?? []).filter((c) => c.kind === "text");
  const voiceChannels = (uncategorized?.channels ?? []).filter((c) => c.kind === "voice");
  const textVisibility = visibilityFor(SIDEBAR_SECTION_KEYS.text);
  const voiceVisibility = visibilityFor(SIDEBAR_SECTION_KEYS.voice);
  const visibleTextChannels = visibleSidebarChannels(textChannels, textVisibility);
  const visibleVoiceChannels = visibleSidebarChannels(voiceChannels, voiceVisibility);

  /**
   * The empty-area menu (founder's fourth reference): right-click — or long-press
   * on touch, via {@link ActionMenu} — the blank space under the channel list.
   *
   * Every entry but the toggle already exists elsewhere and is CALLED here, never
   * reimplemented. The three management entries are permission-gated and omitted
   * outright when refused (§35); "hide muted channels" is a personal view
   * preference, so it is offered to everyone and the menu is therefore never
   * empty — there is no "opened a menu with nothing in it" case to handle.
   */
  const emptyAreaMenu = (
    <>
      <ContextMenuCheckboxItem
        checked={hideMuted}
        onSelect={(event) => {
          // Keep the menu open: this is a toggle the user may want to see take
          // effect, and Radix's default is to close on select.
          event.preventDefault();
          toggleHideMuted();
        }}
      >
        {t("desktop:sidebar.hideMutedChannels")}
      </ContextMenuCheckboxItem>
      {(canManageChannels || canCreateInvite) && <ContextMenuSeparator />}
      {canManageChannels && (
        <>
          <ContextMenuItem onSelect={() => openCreateChannel()}>
            <Plus className="size-4" />
            {t("desktop:sidebar.createChannel")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openCreateCategory()}>
            <FolderPlus className="size-4" />
            {t("desktop:sidebar.createCategory")}
          </ContextMenuItem>
        </>
      )}
      {canCreateInvite && (
        <ContextMenuItem onSelect={() => openInvite()}>
          <UserPlus className="size-4" />
          {t("desktop:sidebar.inviteToServer")}
        </ContextMenuItem>
      )}
    </>
  );

  /**
   * The server banner, painted BEHIND the header's text (M20).
   *
   * Deliberately a background layer rather than a taller band of its own: the
   * header keeps its exact `h-16` geometry, so a server with a banner and a
   * server without one have identical layout and nothing below shifts. With no
   * banner this renders nothing at all — no empty box, no broken <img> (§35).
   *
   * The scrim is not decoration, and it is TWO layers because one is provably
   * not enough. The image is chosen by the server owner, so it can be anything —
   * including near-white. A left-weighted gradient alone protects the name and
   * leaves the chevron on the right sitting on bare image; a near-white banner
   * then renders it invisible. So:
   *
   *   1. a UNIFORM veil, the contrast FLOOR every pixel of the header gets,
   *      including the chevron;
   *   2. a left-weighted gradient on top, extra darkness exactly where the
   *      server name is.
   *
   * Verified against a near-white banner, which is the case that fails first.
   *
   * `onError` drops the layer back to the plain header if the URL ever fails to
   * load, so a dead image degrades to today's appearance rather than a
   * broken-image glyph.
   */
  const bannerLayer = activeGroupBannerUrl ? (
    <>
      <img
        src={activeGroupBannerUrl}
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none absolute inset-0 size-full object-cover"
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-sidebar/60" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-sidebar/85 via-sidebar/45 to-transparent"
      />
    </>
  ) : null;

  return (
    <div className="flex w-60 shrink-0 flex-col bg-sidebar">
      {showServerMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "group/hdr relative flex h-16 shrink-0 cursor-pointer items-center justify-between gap-2 overflow-hidden px-4",
                "text-fg transition-colors motion-hover hover:bg-wash data-[state=open]:bg-wash",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70",
              )}
            >
              {bannerLayer}
              <span className="relative truncate font-display text-base font-semibold text-fg-display">
                {activeGroupName ?? t("desktop:sidebar.serverFallback")}
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "relative size-4 shrink-0 text-fg-faint transition-[transform,color] motion-fast",
                  "group-hover/hdr:text-fg-muted group-data-[state=open]/hdr:rotate-180 group-data-[state=open]/hdr:text-fg",
                )}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {/* Same gate as every other invite affordance: a member the server
                would refuse is offered nothing, not a control that 403s. */}
            {canCreateInvite && (
              <DropdownMenuItem onSelect={() => openInvite()}>
                <UserPlus className="size-4" />
                {t("desktop:chat.invitePeople")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={!canManageChannels} onSelect={() => openCreateChannel()}>
              <Plus className="size-4" />
              {canManageChannels
                ? t("desktop:sidebar.createChannel")
                : t("desktop:sidebar.createChannelNoPermission")}
            </DropdownMenuItem>
            {/* Categories are pure organization; only someone who may manage
                channels can make one, so the entry is hidden outright rather than
                shown disabled next to an already-disabled sibling. */}
            {canManageChannels && (
              <DropdownMenuItem onSelect={() => openCreateCategory()}>
                <FolderPlus className="size-4" />
                {t("desktop:sidebar.createCategory")}
              </DropdownMenuItem>
            )}
            {canOpenServerSettings && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openServerSettings()}>
                  <Settings className="size-4" />
                  {t("desktop:sidebar.serverSettings")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="relative flex h-16 shrink-0 items-center overflow-hidden px-4 text-fg">
          {bannerLayer}
          <span className="relative truncate font-display text-base font-semibold text-fg-display">
            {activeGroupName ?? t("desktop:sidebar.serverFallback")}
          </span>
        </div>
      )}

      {reorderError && (
        <FormErrorAlert className="mx-2 mt-1 shrink-0">
          {t("desktop:category.reorderFailed")}
        </FormErrorAlert>
      )}

      <nav
        aria-label={t("desktop:sidebar.channelsNav")}
        // edge-fade-y: channels dissolve under the server header / above the
        // voice panel instead of being sliced off mid-row while scrolling.
        className="edge-fade-y flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3"
      >
        {/* First fetch of this server: rows in their final geometry, so the
            list does not jump when it lands. */}
        {serverDetailsLoading && channels.length === 0 && (
          <ShellListSkeleton
            label={t("desktop:sidebar.loadingChannels")}
            variant="channel"
            className="pt-4"
          />
        )}
        {/* Loaded, and genuinely no channel the viewer can see. Said plainly,
            with the one action that fixes it for someone who may take it. */}
        {!serverDetailsLoading && channels.length === 0 && (
          <EmptyState
            icon={<Hash />}
            title={t("desktop:sidebar.emptyTitle")}
            body={
              canManageChannels
                ? t("desktop:sidebar.emptyBodyManage")
                : t("desktop:sidebar.emptyBodyMember")
            }
            action={
              canManageChannels ? (
                <Button size="sm" variant="secondary" onClick={() => openCreateChannel()}>
                  <Plus className="size-4" aria-hidden />
                  {t("desktop:sidebar.createChannel")}
                </Button>
              ) : undefined
            }
            className="py-10"
          />
        )}
        {uncategorized && textChannels.length > 0 && (
          <section>
            {renderSectionHeader(
              SIDEBAR_SECTION_KEYS.text,
              t("desktop:sidebar.textChannels"),
              textVisibility.collapsed,
            )}
            {visibleTextChannels.length > 0 &&
              renderRows(
                uncategorized,
                visibleTextChannels,
                "text",
                visibleTextChannels.length !== textChannels.length,
                revealKey === SIDEBAR_SECTION_KEYS.text,
              )}
          </section>
        )}
        {uncategorized && voiceChannels.length > 0 && (
          <section>
            {renderSectionHeader(
              SIDEBAR_SECTION_KEYS.voice,
              t("desktop:sidebar.voiceChannels"),
              voiceVisibility.collapsed,
            )}
            {visibleVoiceChannels.length > 0 &&
              renderRows(
                uncategorized,
                visibleVoiceChannels,
                "voice",
                visibleVoiceChannels.length !== voiceChannels.length,
                revealKey === SIDEBAR_SECTION_KEYS.voice,
              )}
          </section>
        )}

        {orderedBuckets
          .filter((bucket) => bucket.category !== null)
          .map((bucket) => {
            const category = bucket.category;
            if (!category) return null;
            const visibility = visibilityFor(category.id);
            const visible = visibleSidebarChannels(bucket.channels, visibility);
            const hidingRows = visible.length !== bucket.channels.length;
            return (
              <section key={category.id} aria-label={category.name}>
                {renderCategoryHeader(bucket)}
                {/* A collapsed category is no longer emptied outright: it keeps
                    the channel you are reading and the room you are in, exactly
                    like the Text/Voice sections above, so the two collapse
                    affordances cannot mean different things. */}
                {visible.length > 0 &&
                  renderRows(bucket, visible, undefined, hidingRows, revealKey === category.id)}
                {visible.length === 0 &&
                  !visibility.collapsed &&
                  bucket.channels.length === 0 && (
                    // An empty category still needs a drop target, otherwise the
                    // only way to fill it would be the row menu.
                    <div
                      className={cn(
                        "mx-1 mb-1 rounded-md px-2.5 py-2 text-label transition-colors motion-hover",
                        drag?.kind === "channel" && overKey === `ch:${category.id}:end`
                          ? "bg-accent-surface text-accent-hover"
                          : "bg-wash text-fg-faint",
                      )}
                      onDragOver={(event) => {
                        if (drag?.kind !== "channel") return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        setOverKey(`ch:${category.id}:end`);
                      }}
                      onDrop={(event) => {
                        if (drag?.kind !== "channel") return;
                        event.preventDefault();
                        event.stopPropagation();
                        dropChannel(category.id, null);
                      }}
                    >
                      {t("desktop:category.empty")}
                    </div>
                  )}
              </section>
            );
          })}

        {/* Tail zone so a category can be dropped last in the list. */}
        {drag?.kind === "category" && (
          <DropLine
            active={overKey === "cat:end"}
            label={t("desktop:sidebar.dropHere")}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setOverKey("cat:end");
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              dropCategory(null);
            }}
          />
        )}

        {/*
          The blank space under the list, and the ONLY surface the empty-area
          menu is attached to.

          Deliberately a sibling filler rather than the <nav> itself: Radix's
          ContextMenuTrigger prevents the browser default on `contextmenu` but
          does NOT stop the event propagating, so a menu on an ancestor of the
          rows would open ALONGSIDE the row's own menu on every right-click. One
          element, one menu — a row press reaches the row's trigger and stops
          being anyone else's business.

          `flex-1` so it claims whatever height the sections leave; the min-height
          guarantees a real target even when the list fills the column and
          scrolls.
        */}
        <ActionMenu menu={emptyAreaMenu} contentClassName="w-56">
          <div
            aria-label={t("desktop:sidebar.listActions")}
            className="min-h-16 w-full flex-1"
          />
        </ActionMenu>
      </nav>

      {voicePanel}
      {userFooter}
    </div>
  );
}
