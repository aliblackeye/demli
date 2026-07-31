import { View } from "react-native";
import { ChevronDown, ChevronUp, FolderMinus, Pencil, Plus } from "lucide-react-native";
import { categoryMenuItems, type CategoryMenuItem } from "@demli/client-core";
import type { CategoryId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { ActionDivider, ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { colors } from "@/theme/theme";

/** The category header a long press / manage tap opened this sheet for. */
export interface CategorySheetTarget {
  categoryId: CategoryId;
  name: string;
  /** There is a category above this one — gates "move up". */
  canMoveUp: boolean;
  /** There is a category below this one — gates "move down". */
  canMoveDown: boolean;
}

/**
 * The category header's management menu — mobile's parity of the desktop
 * sidebar's per-category gear dropdown.
 *
 * WHICH entries appear is not decided here: `categoryMenuItems` in
 * @demli/client-core decides it for both clients, so "an unauthorized viewer
 * sees an EMPTY menu, not a set of disabled rows" (§35) is one rule instead of
 * two component trees that drift. This file only says what a row LOOKS like.
 *
 * A phone has no drag-and-drop sidebar, so the two move entries are not a
 * convenience here the way they are on a narrow desktop window — they are the
 * ONLY way to reorder categories on this surface. Each is omitted at the ends of
 * the list, where it would do nothing.
 */
export function CategoryActionSheet({
  target,
  canManageChannels,
  onCreateChannel,
  onRename,
  onMove,
  onDelete,
  onClose,
}: {
  /** The category, or null when the sheet is closed. */
  target: CategorySheetTarget | null;
  /** Viewer is the server owner OR holds MANAGE_CHANNELS. */
  canManageChannels: boolean;
  /** Create a channel already filed under this category. */
  onCreateChannel: (target: CategorySheetTarget) => void;
  onRename: (target: CategorySheetTarget) => void;
  onMove: (target: CategorySheetTarget, direction: "up" | "down") => void;
  onDelete: (target: CategorySheetTarget) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();

  const items: CategoryMenuItem[] = target
    ? categoryMenuItems({
        canManageChannels,
        canMoveUp: target.canMoveUp,
        canMoveDown: target.canMoveDown,
      })
    : [];

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  const rowFor = (item: CategoryMenuItem) => {
    if (!target) return null;
    switch (item) {
      case "createChannel":
        return (
          <ActionRow
            key={item}
            icon={<Plus size={20} color={colors.fgMuted} />}
            label={t("mobile:category.createChannelInCategory", { name: target.name })}
            onPress={() => run(() => onCreateChannel(target))}
          />
        );
      case "rename":
        return (
          <ActionRow
            key={item}
            icon={<Pencil size={20} color={colors.fgMuted} />}
            label={t("mobile:category.edit")}
            onPress={() => run(() => onRename(target))}
          />
        );
      case "moveUp":
        return (
          <ActionRow
            key={item}
            icon={<ChevronUp size={20} color={colors.fgMuted} />}
            label={t("mobile:category.moveUp")}
            onPress={() => run(() => onMove(target, "up"))}
          />
        );
      case "moveDown":
        return (
          <ActionRow
            key={item}
            icon={<ChevronDown size={20} color={colors.fgMuted} />}
            label={t("mobile:category.moveDown")}
            onPress={() => run(() => onMove(target, "down"))}
          />
        );
      case "delete":
        return (
          <ActionRow
            key={item}
            icon={<FolderMinus size={20} color={colors.danger} />}
            label={t("mobile:category.delete")}
            // The channels survive — say so where the action is taken rather
            // than only in the confirm that follows.
            hint={t("mobile:category.deleteBody")}
            labelColor={colors.danger}
            onPress={() => run(() => onDelete(target))}
          />
        );
      default:
        return null;
    }
  };

  return (
    <ActionSheet
      visible={target !== null && items.length > 0}
      title={target?.name}
      onClose={onClose}
    >
      {items.map((item, index) => (
        // The destructive entry is last and set apart, as everywhere else in the app.
        <View key={item}>
          {item === "delete" && index > 0 ? <ActionDivider /> : null}
          {rowFor(item)}
        </View>
      ))}
    </ActionSheet>
  );
}
