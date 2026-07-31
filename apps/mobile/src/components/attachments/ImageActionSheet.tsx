/**
 * "Save image" / "Copy image" for a picture in chat — the mobile UI half.
 *
 * Reached the way every other per-item action on this app is reached: a LONG
 * PRESS on the thing itself opens the shared bottom sheet (the same
 * `ActionSheet` the user menu, the message menu and the server menu use). No new
 * gesture, no new chrome — the founder's rule is that mobile feels like one app,
 * not a pile of one-off surfaces. The same two actions also sit as buttons in
 * the full-screen viewer, where a long press has nothing to aim at.
 *
 * All of the behaviour lives in `@/lib/image-actions`; this file decides only
 * what is OFFERED and what the user is TOLD:
 *
 *  - "Copy" is not rendered at all for a WebP/GIF. Android's clipboard takes a
 *    decoded bitmap and `expo-clipboard` only decodes PNG/JPEG, so the row would
 *    be a button that silently does nothing (CLAUDE.md §35). If the bytes turn
 *    out to disagree with the declared MIME, the honest "this format can't be
 *    copied — save it instead" line still fires from the action itself (§26).
 *  - A cancelled folder picker says NOTHING. Dismissing a picker is a choice.
 */

import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ToastAndroid, View } from "react-native";
import { Copy, Download } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import {
  canCopyImage,
  copyImage,
  imageActionNotice,
  saveImage,
  type ImageActionTarget,
} from "@/lib/image-actions";
import { ActionRow, ActionSheet } from "@/components/ui/ActionSheet";
import { colors, radius, space } from "@/theme/theme";

/** Minimum touch target for the viewer's icon buttons (iOS HIG / Android 48dp). */
export const IMAGE_ACTION_HIT_SIZE = 44;

/**
 * Announce an outcome without stealing the screen. Android gets its native
 * toast (the platform idiom for "done", and the one surface that does not cover
 * the picture the user just acted on); iOS, which has no equivalent, falls back
 * to the alert every other mobile error already uses.
 */
function announce(message: string): void {
  if (Platform.OS === "android") {
    ToastAndroid.show(message, ToastAndroid.SHORT);
    return;
  }
  Alert.alert(message);
}

/**
 * Run save/copy for one image and report the outcome. Shared by the long-press
 * sheet and the full-screen viewer so both surfaces behave identically — and so
 * neither can forget the "cancel says nothing" rule.
 */
export function useImageActions(target: ImageActionTarget | null): {
  /** Which action is in flight, or null. Drives the spinner + re-entry guard. */
  busy: "save" | "copy" | null;
  save: () => void;
  copy: () => void;
} {
  const { t } = useAppTranslation();
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);

  const run = useCallback(
    (action: "save" | "copy") => {
      if (!target || busy !== null) return;
      setBusy(action);
      haptics.light();
      const work = action === "save" ? saveImage(target) : copyImage(target);
      void work
        .then((result) => {
          const notice = imageActionNotice(action, result);
          if (!notice) return; // cancelled — stay silent
          if (notice.tone === "error") haptics.error();
          else haptics.success();
          announce(t(notice.key));
        })
        .finally(() => setBusy(null));
    },
    [target, busy, t],
  );

  return {
    busy,
    save: useCallback(() => run("save"), [run]),
    copy: useCallback(() => run("copy"), [run]),
  };
}

/**
 * The long-press sheet for a chat image. `target` being null keeps it closed and
 * unmounted, matching the `MemberActionSheet` idiom.
 */
export function ImageActionSheet({
  target,
  onClose,
}: {
  target: ImageActionTarget | null;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const actions = useImageActions(target);

  if (!target) return null;

  const copyable = canCopyImage(target.mime);

  return (
    <ActionSheet visible title={t("mobile:attachments.imageActionsTitle")} onClose={onClose}>
      <ActionRow
        icon={<Download size={20} color={colors.fgMuted} />}
        label={t("mobile:attachments.saveImage")}
        hint={
          Platform.OS === "android"
            ? t("mobile:attachments.saveImageHintAndroid")
            : t("mobile:attachments.saveImageHintIos")
        }
        disabled={actions.busy !== null}
        onPress={() => {
          onClose();
          actions.save();
        }}
      />
      {/* Not merely disabled: a format the clipboard cannot take is not offered. */}
      {copyable ? (
        <ActionRow
          icon={<Copy size={20} color={colors.fgMuted} />}
          label={t("mobile:attachments.copyImage")}
          disabled={actions.busy !== null}
          onPress={() => {
            onClose();
            actions.copy();
          }}
        />
      ) : null}
    </ActionSheet>
  );
}

/**
 * The save/copy pair as overlay buttons, for the full-screen viewer where there
 * is no row to long-press. Sized to {@link IMAGE_ACTION_HIT_SIZE} so they clear
 * the platform minimum on their own, without relying on `hitSlop` that a
 * neighbouring dismiss target would fight over.
 */
export function ImageActionButtons({
  target,
  t,
}: {
  target: ImageActionTarget;
  /** Passed in so the viewer keeps ONE translation subscription. */
  t: AppTFunction;
}) {
  const actions = useImageActions(target);
  const copyable = canCopyImage(target.mime);

  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      <OverlayButton
        label={t("mobile:attachments.saveImage")}
        busy={actions.busy === "save"}
        disabled={actions.busy !== null}
        onPress={actions.save}
      >
        <Download size={20} color={colors.fg} />
      </OverlayButton>
      {copyable ? (
        <OverlayButton
          label={t("mobile:attachments.copyImage")}
          busy={actions.busy === "copy"}
          disabled={actions.busy !== null}
          onPress={actions.copy}
        >
          <Copy size={20} color={colors.fg} />
        </OverlayButton>
      ) : null}
    </View>
  );
}

function OverlayButton({
  label,
  busy,
  disabled,
  onPress,
  children,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => ({
        width: IMAGE_ACTION_HIT_SIZE,
        height: IMAGE_ACTION_HIT_SIZE,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.12)",
        opacity: disabled && !busy ? 0.5 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={colors.fg} /> : children}
    </Pressable>
  );
}
