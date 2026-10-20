/**
 * Shared product components (Phase 1+). These read their data ONLY through the
 * app-data context hooks (useShellData) and platform bridge — never a
 * store/query/window global directly — so one component tree renders unchanged
 * on desktop and web. Desktop-specific interactive pieces are passed as slots.
 */
export { AppShell, type AppShellProps } from "./AppShell";
export {
  ActionMenu,
  ActionMenuKebab,
  openActionMenuAt,
  useActionMenuAfterClose,
  useActionMenuTrigger,
  type ActionMenuProps,
  type ActionMenuKebabConfig,
} from "./ActionMenu";
export { UnreadCountBadge } from "./UnreadCountBadge";
export { SectionHeading } from "./SectionHeading";
export { EmptyState, RetryNotice } from "./EmptyState";
export { FormErrorAlert, type FormAlertTone } from "./FormErrorAlert";
export {
  floatingPillClass,
  floatingPillItemClass,
  shellRowClass,
  shellRowFocusClass,
  shellRowIconButtonClass,
  shellUnreadPipClass,
  type ShellRowState,
} from "./shellRow";
export { ShellListSkeleton, type ShellListSkeletonProps } from "./ShellListSkeleton";
export { RoleChip } from "./RoleChip";
export { GroupRail, type GroupRailProps, type RenderGroupMuteMenu } from "./GroupRail";
export {
  reconcile,
  normalizeLayout,
  createFolder,
  moveIntoFolder,
  moveToTopLevel,
  reorderTopLevel,
  toggleFolder,
  renameFolder,
  setFolderColor,
  removeFolder,
  parseLayout,
  serializeLayout,
  EMPTY_LAYOUT,
  type RailLayout,
  type LayoutEntry,
  type FolderEntry,
  type ServerEntry,
  type RailNode,
  type RailFolderNode,
  type RailServerNode,
} from "./serverFolders";
export { useServerFolders, type UseServerFolders } from "./useServerFolders";
export {
  ChannelSidebar,
  type ChannelSidebarProps,
  type ChannelDragProps,
  type ChannelMoveTarget,
  type ChannelOrderingActions,
  type RenderChannel,
  type RenderChannelOptions,
} from "./ChannelSidebar";
export {
  buildSidebarBuckets,
  canNudgeCategory,
  canNudgeChannel,
  moveCategory,
  moveChannel,
  nudgeCategory,
  nudgeChannel,
  toChannelOrderEntries,
  toReorderPayload,
  CATEGORY_NAME_MAX_LENGTH,
  type ChannelDropTarget,
  type SidebarBucket,
} from "./channelOrder";
export {
  useCollapsedSections,
  useHideMutedChannels,
  SIDEBAR_SECTION_KEYS,
  type SidebarSectionKey,
  type UseCollapsedSections,
  type UseHideMutedChannels,
} from "./sidebarPreferences";
export { HomeSidebar, type HomeSidebarProps } from "./HomeSidebar";
export {
  MemberSidebar,
  type MemberSidebarProps,
  type RenderMemberProfile,
  type RenderMemberMenu,
} from "./MemberSidebar";
export {
  MessageMarkdown,
  MarkdownSlotsProvider,
  type MarkdownSlots,
} from "./MessageMarkdown";
export { MessageList } from "./MessageList";
export { TypingDots } from "./TypingDots";
export {
  buildRows,
  firstUnreadMessageId,
  tailSentinel,
  toggleIgnoredRun,
  localDayStart,
  GROUP_WINDOW_MS,
  IGNORED_RUN_KEY_PREFIX,
  type BuildRowsOptions,
  type ListRow,
} from "./messageRows";
export { IgnoredRunRow, type IgnoredRunRowProps } from "./IgnoredRunRow";
export {
  activeTimeouts,
  useActiveTimeouts,
  formatTimeoutUntil,
  type TimeoutBearer,
  type TimeoutSnapshot,
} from "./memberTimeout";
export { TimeoutBadge, type TimeoutBadgeProps } from "./TimeoutBadge";
export { ChatView, type ChatViewProps } from "./ChatView";
export { MessageEditor } from "./MessageEditor";
export { MessageRow, type MessageRowProps } from "./MessageRow";
export { MessageComposer } from "./MessageComposer";
export {
  canMoveQueueItem,
  dropQueueItem,
  formatWatchDuration,
  moveQueueItem,
  watchSearchFailure,
  type WatchQueueMove,
  type WatchSearchFailure,
} from "./watchQueue";
export {
  WatchQueuePanel,
  type WatchQueueEntry,
  type WatchQueuePanelProps,
} from "./WatchQueuePanel";
export {
  WatchVideoPicker,
  IDLE_WATCH_SEARCH,
  type WatchPickerMode,
  type WatchPickerResult,
  type WatchPickerSearchState,
  type WatchPickerStatus,
  type WatchVideoPickerProps,
} from "./WatchVideoPicker";
