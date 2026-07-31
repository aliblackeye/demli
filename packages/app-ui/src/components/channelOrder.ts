/**
 * channelOrder — re-export of the category placement model, which now lives in
 * `@demli/client-core/channel-order`.
 *
 * The model was born here and is still framework-free, but this package depends
 * on react-dom, so React Native could not import it — and the mobile channel list
 * would have had to hand-write a second copy of the dense-position arithmetic and
 * the "which bucket is this channel in" rules. Two copies of that drift on the
 * first change and corrupt the sidebar order on one platform only.
 *
 * So the implementation moved to client-core (which both clients already depend
 * on) and this file stays as its address: every desktop/web import path and the
 * `channelOrder.test.ts` suite beside it are unchanged, and that suite now proves
 * the shared module through the same door the sidebar uses.
 */
export {
  buildSidebarBuckets,
  canNudgeCategory,
  canNudgeChannel,
  categoryMenuItems,
  channelMoveDestinations,
  channelPlacementMenuItems,
  isDestructiveCategoryMenuItem,
  moveCategory,
  moveChannel,
  nudgeCategory,
  nudgeChannel,
  toChannelOrderEntries,
  toReorderPayload,
  CATEGORY_NAME_MAX_LENGTH,
  type CategoryMenuContext,
  type CategoryMenuItem,
  type ChannelDropTarget,
  type ChannelMoveDestination,
  type ChannelPlacementMenuContext,
  type ChannelPlacementMenuItem,
  type SidebarBucket,
} from "@demli/client-core";
