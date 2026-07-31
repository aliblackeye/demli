import { Folder, FolderOpen } from "lucide-react-native";
import { channelMoveDestinations, type SidebarBucket } from "@demli/client-core";
import type { CategoryId, ChannelId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { colors } from "@/theme/theme";

/** The channel whose destination is being picked, or null when closed. */
export interface ChannelMoveTarget {
  channelId: ChannelId;
  name: string;
}

/**
 * "Move to category" — the destination picker a phone needs in place of the
 * desktop's drag-and-drop.
 *
 * The list of destinations comes from `channelMoveDestinations` in
 * @demli/client-core, which already excludes the bucket the channel is
 * currently in. That exclusion is the whole reason it is a shared rule rather
 * than a `filter` written here: offering a channel its own category is a move
 * that appears to work and changes nothing, and it is precisely the check a
 * hand-written picker forgets.
 *
 * The uncategorized list is a real destination (`categoryId: null`) — a channel
 * filed under a category must be able to come back out without deleting the
 * category.
 */
export function ChannelMoveSheet({
  target,
  buckets,
  onPick,
  onClose,
}: {
  target: ChannelMoveTarget | null;
  /** The current sidebar model, so destinations are derived from what is on screen. */
  buckets: readonly SidebarBucket[];
  onPick: (target: ChannelMoveTarget, categoryId: CategoryId | null) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();

  const destinations = target ? channelMoveDestinations(buckets, target.channelId) : [];

  return (
    <ActionSheet
      visible={target !== null && destinations.length > 0}
      title={target ? t("mobile:category.moveChannelTitle", { name: target.name }) : undefined}
      onClose={onClose}
    >
      {destinations.map((destination) => (
        <ActionRow
          key={destination.categoryId ?? "uncategorized"}
          icon={
            destination.categoryId === null ? (
              <FolderOpen size={20} color={colors.fgMuted} />
            ) : (
              <Folder size={20} color={colors.fgMuted} />
            )
          }
          label={destination.name ?? t("mobile:category.moveToUncategorized")}
          onPress={() => {
            if (!target) return;
            onPick(target, destination.categoryId);
            onClose();
          }}
        />
      ))}
    </ActionSheet>
  );
}
