import { useMemo, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { AnimatePresence, m } from "framer-motion";
import { BellOff, Download, Folder, MessagesSquare, PencilLine, Plus, Trash2 } from "lucide-react";
import {
  Button,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  seedColor,
} from "@demli/ui";
import { unreadBadgeText } from "@demli/client-core";
import { useTranslation } from "@demli/i18n";
import type { GroupId } from "@demli/types";
import { useShellData, type ShellGroup } from "../data/shell-data";
import { ActionMenu } from "./ActionMenu";
import { UnreadCountBadge } from "./UnreadCountBadge";
import { useServerFolders } from "./useServerFolders";
import { END, type RailFolderNode } from "./serverFolders";

/**
 * Renders the group-scoped notification-mute submenu inside a server's context
 * menu. Desktop hands back its <NotificationMuteSubmenu> (coupled to the mute
 * mutation); web (Phase 4) can return null until it grows one.
 */
export type RenderGroupMuteMenu = (groupId: GroupId, isMuted: boolean) => ReactNode;

export interface GroupRailProps {
  /** Group mute submenu slot for the per-server context menu. */
  renderGroupMuteMenu?: RenderGroupMuteMenu;
  /**
   * Show the bottom "add a server" button. Default true (desktop). A surface
   * without a create-server flow yet passes false so the button is not a dead
   * control (§35) rather than wiring a no-op.
   */
  showCreateButton?: boolean;
  /**
   * Show the "download the app" button under the add-server button. Default
   * true. A surface with nothing to offer (or no dialog wired) passes false —
   * same dead-control rule as above.
   */
  showDownloadButton?: boolean;
  /**
   * Accessible name + tooltip for the download button. Omitted → the generic
   * "Download the app". A surface whose button does something NARROWER than that
   * — e.g. a phone where the click downloads the Android APK straight away
   * instead of opening a platform picker — passes the specific label, so the
   * button never promises more than it delivers.
   */
  downloadLabel?: string;
  /**
   * Offer "Leave server" in a non-owner's context menu. Default true (desktop).
   * A surface without a leave-confirm flow yet passes false to omit it (§35).
   */
  showLeaveServer?: boolean;
  /**
   * Brand logo for the top home/DM tile. Desktop passes the Demli mark
   * (a transparent-plate SVG) so the tile is box-less — the plate's own rounding
   * is the shape. Omitted (web, Phase 4) falls back to the neutral chat glyph.
   */
  homeLogoSrc?: string;
  /**
   * Account id the folder layout is persisted under (per-account localStorage).
   * Two accounts on one machine keep independent folders. Omitted → an "anon"
   * bucket (still works, just not account-scoped).
   */
  accountId?: string | null;
  /**
   * Enable server folders (drag one server onto another to group them).
   * Default true; a surface can opt out and keep the flat rail.
   */
  enableFolders?: boolean;
}

/**
 * Signature rail press: a spring scale-down on tap — physically nicer than a CSS
 * ease, and transform-only so it never disturbs the squircle border-radius morph
 * or the accent pill that animate on these same elements via CSS. Reduced-motion
 * is honored globally by <MotionConfig reducedMotion="user"> at the app root.
 */
const RAIL_TAP = {
  whileTap: { scale: 0.88 },
  transition: { type: "spring" as const, stiffness: 520, damping: 28, mass: 0.6 },
};

/** A small, curated set of folder accents offered in the folder context menu. */
const FOLDER_COLORS = [
  "hsl(231 58% 62%)", // blurple
  "hsl(145 45% 46%)", // green
  "hsl(15 72% 58%)", // coral
  "hsl(280 52% 62%)", // violet
  "hsl(45 80% 55%)", // amber
  "hsl(190 58% 50%)", // teal
] as const;

function groupInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}

/** Stable hue in [0,360) from an id — the seed for a folder's default accent. */
function hueFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** A folder's accent: its chosen color, else a brighter seeded default. */
function folderColor(id: string, color: string | null): string {
  return color ?? `hsl(${hueFromId(id)} 55% 58%)`;
}

/** Append an alpha channel to an `hsl(H S% L%)` string (space/slash syntax). */
function withAlpha(hsl: string, alpha: number): string {
  return hsl.replace(/\)\s*$/, ` / ${alpha})`);
}

interface FolderUnread {
  unread: boolean;
  mention: boolean;
  count: number;
}

/** Sum a folder's contained-server unread into one badge descriptor. */
function aggregateUnread(groups: readonly ShellGroup[]): FolderUnread {
  let unread = false;
  let mention = false;
  let count = 0;
  for (const g of groups) {
    if (g.unread.unread) unread = true;
    if (g.unread.mention) mention = true;
    count += g.unread.count;
  }
  return { unread, mention, count };
}

// ── drag/drop plumbing ──────────────────────────────────────────────────────

/** The item being dragged. `source` on a server is "top" or its folder id. */
type DragItem =
  | { kind: "server"; id: string; source: "top" | string }
  | { kind: "folder"; id: string };

interface RailDnd {
  drag: DragItem | null;
  overKey: string | null;
  setOver: (key: string | null) => void;
  begin: (item: DragItem) => void;
  end: () => void;
  createFolderFrom: (draggedId: string, targetServerId: string) => void;
  addToFolder: (draggedId: string, folderId: string, beforeServerId?: string) => void;
  extractToTop: (draggedServerId: string, beforeKey?: string) => void;
  reorderTop: (draggedKey: string, beforeKey?: string) => void;
}

// ── mini server icon (folder 2×2 preview) ───────────────────────────────────

function MiniServerIcon({ group }: { group: ShellGroup }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const showIcon = group.iconUrl != null && group.iconUrl.length > 0 && !failed;
  return (
    <span
      className="relative flex size-full items-center justify-center overflow-hidden rounded-[5px] text-[7px] font-bold leading-none text-white/90"
      style={{ backgroundColor: seedColor(group.id) }}
    >
      {groupInitials(group.name)}
      {showIcon && (
        <img
          src={group.iconUrl!}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}

// ── server tile (top level + inside a folder) ───────────────────────────────

interface ServerTileProps {
  group: ShellGroup;
  isActive: boolean;
  onOpen: () => void;
  onLeave: () => void;
  renderMuteMenu: RenderGroupMuteMenu;
  showLeaveServer: boolean;
  /** "top" for the rail root, or the folder id when nested. */
  source: "top" | string;
  dnd: RailDnd | null;
  /** What to do when a server is dropped onto this tile (combine / add). */
  onServerDrop?: (draggedId: string) => void;
}

function ServerTile({
  group,
  isActive,
  onOpen,
  onLeave,
  renderMuteMenu,
  showLeaveServer,
  source,
  dnd,
  onServerDrop,
}: ServerTileProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const { unread, muted, isOwner, iconUrl } = group;

  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const showIcon = iconUrl != null && iconUrl.length > 0 && failedIcon !== iconUrl;

  const badge = unread.unread ? unreadBadgeText(unread.count, true) : null;
  const showNumberBadge = badge !== null && badge !== "1+";

  const combineKey = `combine:${source}:${group.id}`;
  const canAcceptCombine =
    dnd?.drag?.kind === "server" && dnd.drag.id !== group.id && onServerDrop != null;
  const isCombineTarget = canAcceptCombine && dnd?.overKey === combineKey;
  const isTopLevel = source === "top";

  function onDragStart(e: DragEvent): void {
    if (!dnd) return;
    e.dataTransfer.effectAllowed = "move";
    // Firefox requires data to be set for a drag to initiate.
    e.dataTransfer.setData("text/plain", group.id);
    dnd.begin({ kind: "server", id: group.id, source });
  }
  function onDragOver(e: DragEvent): void {
    if (!canAcceptCombine) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    dnd!.setOver(combineKey);
  }
  function onDrop(e: DragEvent): void {
    if (!canAcceptCombine) return;
    e.preventDefault();
    e.stopPropagation();
    onServerDrop!(dnd!.drag!.id);
    dnd!.end();
  }

  return (
    <ActionMenu
      menu={
        <>
          <ContextMenuItem onSelect={onOpen}>{t("desktop:rail.openServer")}</ContextMenuItem>
          <ContextMenuSeparator />
          {renderMuteMenu(group.id, muted)}
          {showLeaveServer && !isOwner && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem danger onSelect={onLeave}>
                {t("desktop:rail.leaveServer")}
              </ContextMenuItem>
            </>
          )}
        </>
      }
    >
      <div
        className="group relative flex w-full justify-center"
        draggable={dnd != null}
        onDragStart={onDragStart}
        onDragEnd={() => dnd?.end()}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
          {/* Active/hover pill indicator at the rail edge — top level only. */}
          {isTopLevel && (
            <span
              aria-hidden
              className={cn(
                "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-accent transition-all motion-instant",
                isActive ? "h-7" : "h-0 group-hover:h-4",
              )}
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <m.button
                {...RAIL_TAP}
                type="button"
                onClick={onOpen}
                aria-label={group.name}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "relative flex size-10 cursor-pointer items-center justify-center overflow-hidden text-xs font-bold text-white/90",
                  "transition-[border-radius,filter,box-shadow] motion-instant hover:brightness-110",
                  isActive ? "rounded-[13px]" : "rounded-[20px] hover:rounded-[13px]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  isActive && "ring-2 ring-accent",
                  // A server being dragged onto → strong accent ring cue.
                  isCombineTarget && "rounded-[13px] ring-2 ring-accent brightness-110",
                  muted && !isActive && "opacity-45 hover:opacity-100",
                )}
                style={{ backgroundColor: seedColor(group.id) }}
              >
                {groupInitials(group.name)}
                {showIcon && (
                  <img
                    src={iconUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onError={() => setFailedIcon(iconUrl)}
                    className="absolute inset-0 size-full rounded-[inherit] object-cover"
                  />
                )}
              </m.button>
            </TooltipTrigger>
            <TooltipContent side="right">{group.name}</TooltipContent>
          </Tooltip>
          {muted && (
            <span
              aria-label={t("desktop:mute.mutedA11y")}
              className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-rail text-fg-faint"
            >
              <BellOff className="size-2.5" />
            </span>
          )}
          {unread.unread &&
            (showNumberBadge ? (
              <UnreadCountBadge
                text={badge!}
                tone={unread.mention ? "accent" : "neutral"}
                aria-label={t("desktop:channel.unread")}
                className="pointer-events-none absolute -right-1 -top-1 border-2 border-rail"
              />
            ) : (
              <span
                aria-label={t("desktop:channel.unread")}
                className={cn(
                  "pointer-events-none absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-rail",
                  unread.mention ? "bg-accent" : "bg-fg",
                )}
              />
            ))}
        </div>
    </ActionMenu>
  );
}

// ── folder ──────────────────────────────────────────────────────────────────

interface FolderViewProps {
  folder: RailFolderNode<ShellGroup>;
  dnd: RailDnd;
  activeGroupId: GroupId | null;
  isServerView: boolean;
  onOpenServer: (id: GroupId) => void;
  onLeaveServer: (id: GroupId) => void;
  renderMuteMenu: RenderGroupMuteMenu;
  showLeaveServer: boolean;
  onToggle: () => void;
  onRename: () => void;
  onRecolor: (color: string | null) => void;
  onDissolve: () => void;
}

function FolderView({
  folder,
  dnd,
  activeGroupId,
  isServerView,
  onOpenServer,
  onLeaveServer,
  renderMuteMenu,
  showLeaveServer,
  onToggle,
  onRename,
  onRecolor,
  onDissolve,
}: FolderViewProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const accent = folderColor(folder.id, folder.color);
  const label = folder.name.trim() || t("desktop:rail.folderDefaultName");
  const preview = folder.groups.slice(0, 4);
  const agg = aggregateUnread(folder.groups);
  const badge = agg.unread ? unreadBadgeText(agg.count, true) : null;
  const showNumberBadge = badge !== null && badge !== "1+";

  const addKey = `add:folder:${folder.id}`;
  const canAccept = dnd.drag?.kind === "server" && dnd.overKey === addKey;
  // A contained active server, while collapsed, keeps the folder feeling "live".
  const containsActive = isServerView && folder.groups.some((g) => g.id === activeGroupId);

  function onDragStart(e: DragEvent): void {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", folder.id);
    dnd.begin({ kind: "folder", id: folder.id });
  }
  function onDragOver(e: DragEvent): void {
    if (dnd.drag?.kind !== "server") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    dnd.setOver(addKey);
  }
  function onDrop(e: DragEvent): void {
    if (dnd.drag?.kind !== "server") return;
    e.preventDefault();
    e.stopPropagation();
    dnd.addToFolder(dnd.drag.id, folder.id);
    dnd.end();
  }

  const folderTile = (
    <ActionMenu
      menu={
        <>
          <ContextMenuItem onSelect={onToggle}>
            {folder.open ? t("desktop:rail.collapseFolder") : t("desktop:rail.expandFolder")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRename}>
            <PencilLine className="size-3.5" />
            {t("desktop:rail.renameFolder")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("desktop:rail.folderColor")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <div className="flex flex-wrap gap-1.5 p-1.5">
                {FOLDER_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => onRecolor(c)}
                    className="size-6 cursor-pointer rounded-full ring-1 ring-inset ring-white/20 transition-transform hover:scale-110"
                    style={{ backgroundColor: c }}
                  />
                ))}
                <button
                  type="button"
                  aria-label={t("desktop:rail.folderColorDefault")}
                  onClick={() => onRecolor(null)}
                  className="flex size-6 cursor-pointer items-center justify-center rounded-full bg-raised text-2xs font-semibold text-fg-muted ring-1 ring-inset ring-white/20 transition-transform hover:scale-110"
                >
                  A
                </button>
              </div>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem danger onSelect={onDissolve}>
            <Trash2 className="size-3.5" />
            {t("desktop:rail.removeFolder")}
          </ContextMenuItem>
        </>
      }
    >
      <div
        className="group relative flex w-full justify-center"
        draggable
        onDragStart={onDragStart}
        onDragEnd={() => dnd.end()}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
          {containsActive && !folder.open && (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-accent"
            />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <m.button
                {...RAIL_TAP}
                type="button"
                onClick={onToggle}
                aria-label={label}
                aria-expanded={folder.open}
                className={cn(
                  "relative flex size-10 cursor-pointer items-center justify-center p-[3px]",
                  "transition-[border-radius,filter] motion-instant hover:brightness-110",
                  folder.open ? "rounded-[13px]" : "rounded-[16px] hover:rounded-[13px]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  canAccept && "rounded-[13px] brightness-110",
                )}
                style={{
                  backgroundColor: withAlpha(accent, folder.open ? 0.32 : 0.24),
                  ...(canAccept ? { boxShadow: `0 0 0 2px ${accent}` } : null),
                }}
              >
                {folder.open ? (
                  <Folder className="size-5" style={{ color: accent }} />
                ) : (
                  <span className="grid size-full grid-cols-2 grid-rows-2 gap-[2px]">
                    {preview.map((g) => (
                      <MiniServerIcon key={g.id} group={g} />
                    ))}
                    {/* Pad to a full 2×2 so a 2- or 3-server folder stays square. */}
                    {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => (
                      <span key={`pad-${i}`} className="rounded-[5px] bg-white/5" />
                    ))}
                  </span>
                )}
              </m.button>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
          {/* Aggregate unread only while collapsed — open folders show per-server. */}
          {!folder.open &&
            agg.unread &&
            (showNumberBadge ? (
              <UnreadCountBadge
                text={badge!}
                tone={agg.mention ? "accent" : "neutral"}
                aria-label={t("desktop:channel.unread")}
                className="pointer-events-none absolute -right-1 -top-1 border-2 border-rail"
              />
            ) : (
              <span
                aria-label={t("desktop:channel.unread")}
                className={cn(
                  "pointer-events-none absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-rail",
                  agg.mention ? "bg-accent" : "bg-fg",
                )}
              />
            ))}
        </div>
    </ActionMenu>
  );

  if (!folder.open) return folderTile;

  // Open: the header tile over a tinted, rounded well that visually binds the
  // expanded servers together. The members' reveal is height-animated.
  return (
    <div
      className="flex w-full flex-col items-center gap-2 rounded-[18px] py-2"
      style={{ backgroundColor: withAlpha(accent, 0.14) }}
    >
      {folderTile}
      <AnimatePresence initial={false}>
        <m.div
          key="members"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
          className="flex w-full flex-col items-center gap-2 overflow-hidden"
        >
          {folder.groups.map((g) => (
            <ServerTile
              key={g.id}
              group={g}
              isActive={isServerView && activeGroupId === g.id}
              onOpen={() => onOpenServer(g.id)}
              onLeave={() => onLeaveServer(g.id)}
              renderMuteMenu={renderMuteMenu}
              showLeaveServer={showLeaveServer}
              source={folder.id}
              dnd={dnd}
              onServerDrop={(draggedId) => dnd.addToFolder(draggedId, folder.id, g.id)}
            />
          ))}
        </m.div>
      </AnimatePresence>
    </div>
  );
}

// ── insert / reorder drop zone ──────────────────────────────────────────────

/**
 * A thin drop line between two top-level entries (and one at the end). Only
 * interactive while a drag is in flight; dropping a SERVER here extracts it to
 * the top level at this position, dropping a FOLDER reorders it.
 */
function InsertZone({ dnd, beforeKey }: { dnd: RailDnd; beforeKey: string }): JSX.Element | null {
  if (!dnd.drag) return null;
  const key = `insert:${beforeKey}`;
  const active = dnd.overKey === key;

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    dnd.setOver(key);
  }
  function onDrop(e: DragEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const target = beforeKey === END ? undefined : beforeKey;
    if (dnd.drag?.kind === "server") dnd.extractToTop(dnd.drag.id, target);
    else if (dnd.drag?.kind === "folder") dnd.reorderTop(`folder:${dnd.drag.id}`, target);
    dnd.end();
  }

  return (
    <div
      className="flex w-full shrink-0 items-center justify-center"
      style={{ height: 10 }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span
        className={cn(
          "h-1 rounded-full bg-accent transition-all motion-instant",
          active ? "w-8 opacity-100" : "w-0 opacity-0",
        )}
      />
    </div>
  );
}

// ── main rail ───────────────────────────────────────────────────────────────

/**
 * Left-most vertical rail (CLAUDE.md §7): the Home button over the server avatar
 * stack, with the "add a server" and "download the app" buttons pinned to the
 * bottom under it. Servers can be grouped into folders (drag one server onto
 * another) that collapse to a 2×2 preview tile;
 * the grouping + order + open state persist per-account in localStorage.
 */
export function GroupRail({
  renderGroupMuteMenu,
  showCreateButton = true,
  showDownloadButton = true,
  downloadLabel,
  showLeaveServer = true,
  homeLogoSrc,
  accountId,
  enableFolders = true,
}: GroupRailProps): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const {
    groups,
    homeUnread,
    activeView,
    activeGroupId,
    openServer,
    openHome,
    openCreateGroup,
    openDownloadApp,
    openLeaveServer,
  } = useShellData();
  const renderMuteMenu: RenderGroupMuteMenu = renderGroupMuteMenu ?? (() => null);

  const {
    nodes,
    createFolderFrom,
    addToFolder,
    extractToTop,
    reorderTop,
    toggleOpen,
    rename,
    recolor,
    dissolve,
  } = useServerFolders(accountId ?? null, groups);

  const [drag, setDrag] = useState<DragItem | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);

  const dnd: RailDnd = useMemo(
    () => ({
      drag,
      overKey,
      setOver: setOverKey,
      begin: setDrag,
      end: () => {
        setDrag(null);
        setOverKey(null);
      },
      createFolderFrom,
      addToFolder,
      extractToTop,
      reorderTop,
    }),
    [drag, overKey, createFolderFrom, addToFolder, extractToTop, reorderTop],
  );

  const isHome = activeView === "home";
  const isServerView = activeView === "server";

  const showHomeUnread = homeUnread.unread && !isHome;
  const homeBadge = showHomeUnread ? unreadBadgeText(homeUnread.count, homeUnread.unread) : null;
  const showHomeNumberBadge = homeBadge !== null && homeBadge !== "1+";

  // With folders disabled, fall back to a flat server list (no dnd, no folders).
  const railNodes = enableFolders
    ? nodes
    : groups.map((g) => ({ kind: "server" as const, group: g }));
  const railDnd = enableFolders ? dnd : null;

  return (
    <nav
      aria-label={t("desktop:rail.groupsNav")}
      className="flex w-[68px] shrink-0 flex-col items-center space-y-2 bg-rail pb-3 pt-3"
    >
      <div className="group relative flex w-full justify-center">
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-fg transition-all motion-instant",
            isHome
              ? "h-8"
              : showHomeUnread && !showHomeNumberBadge
                ? "h-2 group-hover:h-4"
                : "h-0 group-hover:h-4",
          )}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <m.button
              {...RAIL_TAP}
              type="button"
              aria-label={t("desktop:rail.directGroups")}
              aria-current={isHome ? "true" : undefined}
              onClick={() => openHome()}
              className={cn(
                "flex size-10 cursor-pointer items-center justify-center text-white",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                homeLogoSrc
                  ? "rounded-[13px] transition-[filter] motion-instant hover:brightness-110"
                  : cn(
                      "transition-[border-radius,background-color] motion-instant",
                      isHome
                        ? "rounded-[13px] bg-accent"
                        : "rounded-[20px] bg-raised text-fg-muted hover:rounded-[13px] hover:bg-accent hover:text-on-accent",
                    ),
              )}
            >
              {homeLogoSrc ? (
                <img
                  src={homeLogoSrc}
                  alt=""
                  draggable={false}
                  // No scale transform here on purpose. The mark used to be scaled
                  // ~35% past the tile because the source asset carried ~12% of
                  // transparent plate on every side, so at size-full the tea read
                  // too small (founder, twice). That padding is now cropped AT THE
                  // SOURCE and a coverage test keeps it out, so the plain asset
                  // already fills the tile — re-adding a scale would overshoot.
                  className="size-full object-contain drop-shadow-sm"
                />
              ) : (
                <MessagesSquare className="size-5" />
              )}
              {showHomeUnread && <span className="sr-only">{t("desktop:channel.unread")}</span>}
            </m.button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("desktop:rail.directGroups")}</TooltipContent>
        </Tooltip>
        {showHomeNumberBadge && homeBadge && (
          <UnreadCountBadge
            text={homeBadge}
            tone={homeUnread.mention ? "accent" : "neutral"}
            aria-label={t("desktop:channel.unread")}
            className="pointer-events-none absolute -right-1 -top-1 border-2 border-rail"
          />
        )}
      </div>

      <div aria-hidden className="my-0.5 h-px w-8 bg-stroke-strong" />

      {/* py-1: the active-server accent ring draws OUTSIDE the avatar box, so
          the scroll container needs breathing room or the first/last item's
          ring clips at the container edge (founder bug report). */}
      <div className="flex w-full flex-col items-center space-y-2 overflow-y-auto py-1">
        {railNodes.map((node) => {
          const key = node.kind === "server" ? `server:${node.group.id}` : `folder:${node.id}`;
          return (
            <div key={key} className="flex w-full flex-col items-center">
              {railDnd && <InsertZone dnd={railDnd} beforeKey={key} />}
              {node.kind === "server" ? (
                <ServerTile
                  group={node.group}
                  isActive={isServerView && activeGroupId === node.group.id}
                  onOpen={() => openServer(node.group.id)}
                  onLeave={() => openLeaveServer(node.group.id)}
                  renderMuteMenu={renderMuteMenu}
                  showLeaveServer={showLeaveServer}
                  source="top"
                  dnd={railDnd}
                  onServerDrop={
                    railDnd
                      ? (draggedId) => railDnd.createFolderFrom(draggedId, node.group.id)
                      : undefined
                  }
                />
              ) : (
                railDnd && (
                  <FolderView
                    folder={node}
                    dnd={railDnd}
                    activeGroupId={activeGroupId}
                    isServerView={isServerView}
                    onOpenServer={openServer}
                    onLeaveServer={openLeaveServer}
                    renderMuteMenu={renderMuteMenu}
                    showLeaveServer={showLeaveServer}
                    onToggle={() => toggleOpen(node.id)}
                    onRename={() => setRenameTarget({ id: node.id, name: node.name })}
                    onRecolor={(color) => recolor(node.id, color)}
                    onDissolve={() => dissolve(node.id)}
                  />
                )
              )}
            </div>
          );
        })}
        {/* Trailing zone: drop here to move a server/folder to the very end. */}
        {railDnd && <InsertZone dnd={railDnd} beforeKey={END} />}
      </div>

      {/* Bottom cluster, pinned under the (scrolling) server stack: "add a
          server" over "download the app" — the founder's order, and it keeps the
          destructive-free utility actions together away from the server tiles. */}
      {(showCreateButton || showDownloadButton) && (
        <div className="!mt-auto flex w-full flex-col items-center gap-2 pt-2">
          {showCreateButton && (
            <Tooltip>
              <TooltipTrigger asChild>
                <m.button
                  {...RAIL_TAP}
                  type="button"
                  aria-label={t("desktop:rail.addServer")}
                  onClick={() => openCreateGroup()}
                  className={cn(
                    "flex size-10 cursor-pointer items-center justify-center rounded-[20px] bg-raised text-online",
                    "transition-[border-radius,background-color,color] motion-instant",
                    "hover:rounded-[13px] hover:bg-online hover:text-on-accent",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  )}
                >
                  <Plus className="size-5" />
                </m.button>
              </TooltipTrigger>
              <TooltipContent side="right">{t("desktop:rail.addServer")}</TooltipContent>
            </Tooltip>
          )}
          {showDownloadButton && (
            <Tooltip>
              <TooltipTrigger asChild>
                <m.button
                  {...RAIL_TAP}
                  type="button"
                  aria-label={downloadLabel ?? t("desktop:rail.downloadApp")}
                  onClick={() => openDownloadApp()}
                  className={cn(
                    "flex size-10 cursor-pointer items-center justify-center rounded-[20px] bg-raised text-fg-muted",
                    "transition-[border-radius,background-color,color] motion-instant",
                    "hover:rounded-[13px] hover:bg-accent hover:text-on-accent",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                  )}
                >
                  <Download className="size-5" />
                </m.button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {downloadLabel ?? t("desktop:rail.downloadApp")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

      <FolderRenameDialog
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSubmit={(name) => {
          if (renameTarget) rename(renameTarget.id, name);
          setRenameTarget(null);
        }}
      />
    </nav>
  );
}

// ── rename dialog ────────────────────────────────────────────────────────────

function FolderRenameDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: { id: string; name: string } | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  const [value, setValue] = useState("");

  // Seed the field each time a new folder's dialog opens (derived from `target`).
  const open = target !== null;
  const [seed, setSeed] = useState<string | null>(null);
  if (open && seed !== target.id) {
    setSeed(target.id);
    setValue(target.name);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("desktop:rail.renameFolder")}</DialogTitle>
        </DialogHeader>
        <div className="px-5 pb-2">
          <Input
            autoFocus
            value={value}
            maxLength={60}
            placeholder={t("desktop:rail.folderNamePlaceholder")}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:buttons.cancel")}
          </Button>
          <Button onClick={() => onSubmit(value)}>{t("common:buttons.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
