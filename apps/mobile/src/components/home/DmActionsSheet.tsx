/**
 * The DM row overflow menu — mobile's stand-in for the desktop DM list's
 * right-click menu.
 *
 * Desktop reveals a close button when the pointer enters the row and offers the
 * full user menu on right-click. A phone has no hover and no swipe (the app
 * ships neither react-native-gesture-handler nor reanimated, and adding one
 * would break OTA-safety, CLAUDE.md §32), so the affordance is a long press —
 * the pattern the app already uses for message actions (ADR 0011).
 *
 * The menu itself is the SHARED user menu ({@link MemberActionSheet}), so a DM
 * row offers exactly what a roster row or a message author offers: profile,
 * note, friend nickname, ignore, block, and the rest, gated by the same rules
 * module both platforms read. The only DM-specific entry — "hide this
 * conversation" — rides the sheet's `footer` slot rather than being smuggled in
 * beside the user actions.
 *
 * Hiding is server-side hide-for-self: history is preserved and the row returns
 * the next time either side sends a message. Because it is recoverable but not
 * obviously so, the copy says as much and the action is still confirmed.
 */

import { Alert } from "react-native";
import { X } from "lucide-react-native";
import type { Dm } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { localizeError } from "@/lib/errors";
import { useHideDm } from "@/queries/social-queries";
import { colors } from "@/theme/theme";
import { ActionRow } from "@/components/ui/ActionSheet";
import { MemberActionSheet } from "@/components/member/MemberActionSheet";

export function DmActionsSheet({
  dm,
  onClose,
}: {
  /** The DM this menu acts on; `null` keeps the sheet closed. */
  dm: Dm | null;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const hideDm = useHideDm();

  const name = dm?.participant.displayName ?? "";

  const confirmHide = () => {
    if (!dm) return;
    Alert.alert(t("mobile:direct.hideConfirmTitle", { name }), t("mobile:direct.hideConfirmBody"), [
      { text: t("common:buttons.cancel"), style: "cancel" },
      {
        text: t("mobile:direct.hide"),
        style: "destructive",
        onPress: () =>
          hideDm.mutate(dm.id, {
            // Close only after the row is actually gone, so a failure leaves the
            // menu open with the error rather than silently doing nothing.
            onSuccess: onClose,
            onError: (err) => Alert.alert(t("mobile:direct.hide"), localizeError(err, t)),
          }),
      },
    ]);
  };

  return (
    <MemberActionSheet
      target={
        dm
          ? {
              userId: dm.participant.id,
              displayName: dm.participant.displayName,
              username: dm.participant.username,
            }
          : null
      }
      // A DM is not inside a server: no roles, no invite, no moderation (§35).
      groupId={null}
      footer={
        <ActionRow
          icon={<X size={20} color={colors.danger} />}
          label={t("mobile:direct.hide")}
          labelColor={colors.danger}
          disabled={hideDm.isPending}
          onPress={confirmHide}
        />
      }
      onClose={onClose}
    />
  );
}
