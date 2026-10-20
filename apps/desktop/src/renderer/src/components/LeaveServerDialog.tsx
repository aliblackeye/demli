import { useState } from "react";
import { FormErrorAlert } from "@demli/app-ui";
import { Trans } from "@demli/i18n";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useGroups, useLeaveGroup } from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";
import { ConfirmDialog } from "./settings-kit";

/**
 * Confirm leaving a server (self-removal). Opened from the GroupRail context
 * menu; never shown to the owner (owners delete the server instead). On success
 * AppShell's selection sync re-picks a valid server.
 */
export function LeaveServerDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const groupId = useUiStore((s) => s.leaveServerGroupId);
  const closeLeaveServer = useUiStore((s) => s.closeLeaveServer);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const { data: groups } = useGroups();
  const group = groups?.find((g) => g.id === groupId);

  const leaveGroup = useLeaveGroup();
  const [error, setError] = useState<CommonErrorKey | null>(null);

  const onLeave = (): void => {
    if (leaveGroup.isPending || !groupId || !currentUserId) return;
    setError(null);
    leaveGroup.mutate(
      { groupId, userId: currentUserId },
      {
        onSuccess: () => closeLeaveServer(),
        onError: (err) => setError(errorKey(err)),
      },
    );
  };

  return (
    <ConfirmDialog
      open={groupId !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          closeLeaveServer();
        }
      }}
      title={t("desktop:rail.leaveServer")}
      description={group?.name ?? t("desktop:leaveServer.thisServer")}
      confirmLabel={t("desktop:rail.leaveServer")}
      cancelLabel={t("buttons.cancel")}
      closeLabel={t("buttons.close")}
      onConfirm={onLeave}
      pending={leaveGroup.isPending}
      error={error ? <FormErrorAlert>{t(error)}</FormErrorAlert> : undefined}
    >
      <p className="text-sm leading-relaxed text-fg-muted">
        <Trans
          t={t}
          i18nKey="desktop:leaveServer.body"
          values={{ server: group?.name ?? "" }}
          components={{ strong: <span className="font-medium text-fg" /> }}
        />
      </p>
    </ConfirmDialog>
  );
}
