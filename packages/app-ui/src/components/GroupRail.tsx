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
import { pressable, transitions } from "../motion/presets";

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
 * Rail press: the shared `pressable` give (scale .92 on press, spring back) —
 * transform-only, so it never fights the pill indicator that animates beside the
 * tile. There is NO hover motion: a rail tile answers hover with a tone change
 * (brightness on a seeded tile, the raised tone on a utility tile), exactly like
 * every row in the shell. Reduced motion is honoured by <MotionConfig
 * reducedMotion="user"> at the app root.
 */
const RAIL_TAP = pressable;

/** Rail tile geometry: a 44px box with the 16px radius, on the black rail. */
const TILE = "relative flex size-11 cursor-pointer items-center justify-center overflow-hidden rounded-xl";

/** Focus ring for every rail control — offset onto the black rail so it reads on any tile colour. */
const TILE_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-rail";

/** Utility tile (add server, download): surface box, tone change on hover. */
const UTILITY_TILE = cn(
  TILE,
  "bg-surface text-fg-muted transition-colors motion-hover",
  "hover:bg-raised hover:text-accent-hover active:bg-raised-pressed",
  TILE_FOCUS,
);

/**
 * The rail's edge indicator — one language for the whole rail:
 *   selected  tall coral pill (36px) — the same coral as a selected sidebar row
 *   unread    short white pill (8px) — the same white as a row's unread pip
 *   hover     medium white pill (20px), only while the pointer is on the tile
 * It GROWS between those heights on the authored position spring (CSS
 * `motion-spring`, the sampled {stiffness 500, damping 60} curve — no
 * overshoot), so a selection change reads as the pill arriving at its tile.
 * Height on one absolutely-positioned 4px element repaints nothing else.
 */
function RailPill({ selected, unread }: { selected: boolean; unread: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      data-rail-pill={selected ? "selected" : unread ? "unread" : "idle"}
      className={cn(
        "pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full",
        "transition-[height,background-color,opacity] motion-spring",
        selected
          ? "h-9 bg-accent opacity-100"
          : unread
            ? "h-2 bg-fg opacity-100 group-hover:h-5"
            : "h-0 bg-fg opacity-0 group-hover:h-5 group-hover:opacity-100",
      )}
    />
  );
}

/** Corner dot on a tile when there is no number to show (a mention, or a nested server). */
function TileDot({ mention, label }: { mention: boolean; label: string }): JSX.Element {
  return (
    <span
      aria-label={label}
      className={cn(
        "pointer-events-none absolute -right-0.5 -top-0.5 size-3 animate-pop-in-fast rounded-full ring-[3px] ring-rail",
        mention ? "bg-accent" : "bg-fg",
      )}
    />
  );
}

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
          {/* Selected / unread / hover pill at the rail edge — top level only
              (a server inside an open folder sits in the folder's well; it keeps
              its corner dot instead). */}
          {isTopLevel && <RailPill selected={isActive} unread={unread.unread && !isActive} />}
          {/* Tile-sized anchor: corner markers (count, dot, muted bell) sit on
              the TILE's corner, not the 72px row's — anchored to the row they
              overhung the rail by 4px and were clipped by its scroller. */}
          <div className="relative size-11">
            <Tooltip>
              <TooltipTrigger asChild>
                <m.button
                  {...RAIL_TAP}
                  type="button"
                  onClick={onOpen}
                  aria-label={group.name}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    TILE,
                    "text-xs font-semibold text-fg-display",
                    // Hover = a tone change on the seeded colour (and on a photo).
                    "transition-[filter,opacity,box-shadow] motion-hover hover:brightness-115 active:brightness-95",
                    TILE_FOCUS,
                    // A server being dragged onto → the coral drop cue.
                    isCombineTarget && "ring-2 ring-accent ring-offset-2 ring-offset-rail brightness-115",
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
                      className="absolute inset-0 size-full object-cover"
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
            {/* Corner marker: a count when there is a real number (coral when it
                is about YOU), else a dot for a mention or a nested server. A plain
                uncounted unread at the top level is carried by the short edge pill
                alone — the rail's quiet signal. */}
            {unread.unread &&
              (showNumberBadge ? (
                <UnreadCountBadge
                  key={badge!}
                  text={badge!}
                  tone={unread.mention ? "accent" : "neutral"}
                  aria-label={t("desktop:channel.unread")}
                  className="pointer-events-none absolute -bottom-1 -right-1 ring-[3px] ring-rail"
                />
              ) : unread.mention || !isTopLevel ? (
                <TileDot mention={unread.mention} label={t("desktop:channel.unread")} />
              ) : (
                <span className="sr-only">{t("desktop:channel.unread")}</span>
              ))}
          </div>
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
                    className={cn(
                      "size-6 cursor-pointer rounded-full ring-1 ring-inset ring-white/20 transition-shadow motion-hover",
                      "hover:ring-2 hover:ring-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <button
                  type="button"
                  aria-label={t("desktop:rail.folderColorDefault")}
                  onClick={() => onRecolor(null)}
                  className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded-full bg-raised text-2xs font-semibold text-fg-muted ring-1 ring-inset ring-white/20",
                    "transition-shadow motion-hover hover:ring-2 hover:ring-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  )}
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
          <RailPill selected={containsActive && !folder.open} unread={agg.unread && !folder.open} />
          {/* Tile-sized anchor for the aggregate badge (see ServerTile). */}
          <div className="relative size-11">
            <Tooltip>
              <TooltipTrigger asChild>
                <m.button
                  {...RAIL_TAP}
                  type="button"
                  onClick={onToggle}
                  aria-label={label}
                  aria-expanded={folder.open}
                  className={cn(
                    TILE,
                    "p-1",
                    "transition-[filter,box-shadow] motion-hover hover:brightness-115 active:brightness-95",
                    TILE_FOCUS,
                    canAccept && "brightness-115",
                  )}
                  style={{
                    backgroundColor: withAlpha(accent, folder.open ? 0.32 : 0.24),
                    ...(canAccept ? { boxShadow: `0 0 0 2px ${accent}` } : null),
                  }}
                >
                  {folder.open ? (
                    <Folder className="size-5" style={{ color: accent }} />
                  ) : (
                    <span className="grid size-full grid-cols-2 grid-rows-2 gap-0.5">
                      {preview.map((g) => (
                        <MiniServerIcon key={g.id} group={g} />
                      ))}
                      {/* Pad to a full 2×2 so a 2- or 3-server folder stays square. */}
                      {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => (
                        <span key={`pad-${i}`} className="rounded-[5px] bg-wash" />
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
                  key={badge!}
                  text={badge!}
                  tone={agg.mention ? "accent" : "neutral"}
                  aria-label={t("desktop:channel.unread")}
                  className="pointer-events-none absolute -bottom-1 -right-1 ring-[3px] ring-rail"
                />
              ) : agg.mention ? (
                <TileDot mention label={t("desktop:channel.unread")} />
              ) : (
                <span className="sr-only">{t("desktop:channel.unread")}</span>
              ))}
          </div>
        </div>
    </ActionMenu>
  );

  if (!folder.open) return folderTile;

  // Open: the header tile over a tinted, rounded well that visually binds the
  // expanded servers together. The members' reveal is height-animated.
  return (
    <div
      className="flex w-14 flex-col items-center gap-2 rounded-cta py-1.5"
      style={{ backgroundColor: withAlpha(accent, 0.14) }}
    >
      {folderTile}
      <AnimatePresence initial={false}>
        <m.div
          key="members"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={transitions.standard}
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
          "h-1 rounded-full bg-accent transition-[width,opacity] motion-fast",
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
      className="flex w-[72px] shrink-0 flex-col items-center space-y-2 bg-rail py-1"
    >
      <div className="group relative flex w-full justify-center">
        <RailPill selected={isHome} unread={showHomeUnread} />
        <Tooltip>
          <TooltipTrigger asChild>
            <m.button
              {...RAIL_TAP}
              type="button"
              aria-label={t("desktop:rail.directGroups")}
              aria-current={isHome ? "true" : undefined}
              onClick={() => openHome()}
              className={cn(
                TILE,
                TILE_FOCUS,
                homeLogoSrc
                  ? "overflow-visible transition-[filter] motion-hover hover:brightness-115 active:brightness-95"
                  : cn(
                      "transition-colors motion-hover",
                      isHome
                        ? "bg-selected text-accent-hover"
                        : "bg-surface text-fg-muted hover:bg-raised hover:text-fg",
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
                  className="size-full object-contain"
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
            key={homeBadge}
            text={homeBadge}
            tone={homeUnread.mention ? "accent" : "neutral"}
            aria-label={t("desktop:channel.unread")}
            // right-2.5: the same 4px past the tile corner as every server/folder
            // badge (tile right edge = 58px of the 72px rail).
            className="pointer-events-none absolute -bottom-1 right-2.5 ring-[3px] ring-rail"
          />
        )}
      </div>

      <div aria-hidden className="my-0.5 h-0.5 w-8 shrink-0 rounded-full bg-surface" />

      {/* py-1: the active-server accent ring draws OUTSIDE the avatar box, so
          the scroll container needs breathing room or the first/last item's
          ring clips at the container edge (founder bug report). */}
      <div className="flex w-full flex-col items-center space-y-2 overflow-y-auto overflow-x-hidden py-1.5">
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
        <div className="!mt-auto flex w-full flex-col items-center gap-2 pb-1 pt-2">
          {showCreateButton && (
            <Tooltip>
              <TooltipTrigger asChild>
                <m.button
                  {...RAIL_TAP}
                  type="button"
                  aria-label={t("desktop:rail.addServer")}
                  onClick={() => openCreateGroup()}
                  className={UTILITY_TILE}
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
                  className={UTILITY_TILE}
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
        <div className="px-6 pb-2">
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
