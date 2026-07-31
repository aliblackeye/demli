import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { Trans } from "@demli/i18n";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useGroups, useLeaveGroup } from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";

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
    <Dialog
      open={groupId !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          closeLeaveServer();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:rail.leaveServer")}</DialogTitle>
          <DialogDescription>
            {group?.name ?? t("desktop:leaveServer.thisServer")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error && (
            <FormErrorAlert className="mb-3">{t(error)}</FormErrorAlert>
          )}

          <p className="text-sm leading-relaxed text-fg-muted">
            <Trans
              t={t}
              i18nKey="desktop:leaveServer.body"
              values={{ server: group?.name ?? "" }}
              components={{ strong: <span className="font-medium text-fg" /> }}
            />
          </p>

          <div className="mt-5 flex gap-2">
            <Button
              variant="danger"
              disabled={leaveGroup.isPending}
              onClick={onLeave}
              className="flex-1"
            >
              {leaveGroup.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:rail.leaveServer")}
            </Button>
            <Button
              variant="secondary"
              disabled={leaveGroup.isPending}
              onClick={() => closeLeaveServer()}
              className="flex-1"
            >
              {t("buttons.cancel")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
