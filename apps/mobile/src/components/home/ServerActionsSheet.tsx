import { Alert } from "react-native";
import { router } from "expo-router";
import { LogOut, Settings, UserPlus } from "lucide-react-native";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { localizeError } from "@/lib/errors";
import { useServerPermissions } from "@/queries/chat-queries";
import { useLeaveGroup } from "@/queries/management-queries";
import { colors } from "@/theme/theme";
import { ActionDivider, ActionRow, ActionSheet } from "@/components/ui/ActionSheet";

/**
 * The server overflow menu — opened from the panel header's
 * server name / "…" button, or by long-pressing the server in the rail.
 *
 * Destructive membership actions live HERE, never in the panel body: a leave
 * button sitting inline under the channel list is one mis-tap away from dropping
 * a server and reads as an invitation to leave (founder finding, 2026-07-21).
 * Inside the menu it is bottom-most, danger-styled and still confirmed by an
 * alert before anything is sent.
 *
 * Built on the shared {@link ActionSheet} shell (OTA-safe RN Modal, no native
 * sheet module).
 */
export function ServerActionsSheet({
  visible,
  groupId,
  serverName,
  onClose,
  onLeft,
}: {
  visible: boolean;
  groupId: string | null;
  serverName: string;
  onClose: () => void;
  /** Called after the user leaves this server (pop the route / deselect the rail). */
  onLeft: () => void;
}) {
  const { t } = useAppTranslation();

  // Cosmetic permission gates (ADR 0007) — the API re-checks every mutation.
  const { isOwner, can } = useServerPermissions(groupId);
  const canOpenSettings =
    isOwner ||
    can(PERMISSIONS.MANAGE_ROLES) ||
    can(PERMISSIONS.MANAGE_CHANNELS) ||
    can(PERMISSIONS.KICK_MEMBERS);

  const leaveGroup = useLeaveGroup(groupId);

  const confirmLeave = () => {
    Alert.alert(
      t("mobile:group.leaveConfirmTitle"),
      t("mobile:group.leaveConfirmBody", { name: serverName }),
      [
        { text: t("common:buttons.cancel"), style: "cancel" },
        {
          text: t("common:buttons.leave"),
          style: "destructive",
          onPress: () =>
            leaveGroup.mutate(undefined, {
              onSuccess: () => {
                onClose();
                onLeft();
              },
              onError: (err) => Alert.alert(t("mobile:group.leaveError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  return (
    <ActionSheet visible={visible && groupId !== null} title={serverName} onClose={onClose}>
      <ActionRow
        icon={<UserPlus size={20} color={colors.fgMuted} />}
        label={t("mobile:group.inviteFriends")}
        onPress={() => {
          onClose();
          if (groupId) router.push({ pathname: "/invite", params: { groupId, name: serverName } });
        }}
      />
      {canOpenSettings ? (
        <ActionRow
          icon={<Settings size={20} color={colors.fgMuted} />}
          label={t("mobile:group.serverSettings")}
          onPress={() => {
            onClose();
            if (groupId)
              router.push({ pathname: "/server-settings", params: { groupId, name: serverName } });
          }}
        />
      ) : null}

      {/* The owner cannot leave their own server (server-side rule too). */}
      {!isOwner ? (
        <>
          <ActionDivider />
          <ActionRow
            icon={<LogOut size={20} color={colors.danger} />}
            label={t("mobile:group.leaveServer")}
            labelColor={colors.danger}
            disabled={leaveGroup.isPending}
            onPress={confirmLeave}
          />
        </>
      ) : null}
    </ActionSheet>
  );
}
