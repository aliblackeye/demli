import { useEffect } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@demli/ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { buildInviteLink } from "../lib/invite-link";
import { useCreateInvite, useGroups } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import {
  CopyField,
  InviteLimits,
  InviteSkeleton,
  INVITE_EXPIRES_HOURS,
  INVITE_MAX_USES,
} from "./invite-shared";
import { InlineError } from "./settings-kit";

export function InviteDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.inviteDialogOpen);
  const setOpen = useUiStore((s) => s.setInviteDialogOpen);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: groups } = useGroups();
  const group = groups?.find((g) => g.id === activeGroupId);

  const createInvite = useCreateInvite(activeGroupId);
  const { mutate, reset } = createInvite;

  // Mint a fresh invite each time the dialog opens.
  useEffect(() => {
    if (open && activeGroupId) {
      mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES });
    }
    if (!open) {
      reset();
    }
  }, [open, activeGroupId, mutate, reset]);

  const invite = createInvite.data?.invite;

  const retry = (): void => mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closeLabel={t("buttons.close")}>
        <DialogHeader>
          <DialogTitle>
            {t("desktop:invite.title", {
              group: group?.name ?? t("desktop:invite.yourGroup"),
            })}
          </DialogTitle>
          <DialogDescription>{t("desktop:invite.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {createInvite.isError ? (
            <InlineError
              message={localizeError(createInvite.error, t)}
              retryLabel={t("buttons.retry")}
              onRetry={retry}
              retrying={createInvite.isPending}
            />
          ) : invite ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-label font-medium text-fg-muted">{t("desktop:invite.linkLabel")}</p>
                <CopyField label={t("desktop:invite.linkLabel")} value={buildInviteLink(invite.code)} />
              </div>
              <div className="space-y-1.5">
                <p className="text-label font-medium text-fg-muted">{t("desktop:invite.codeLabel")}</p>
                <CopyField label={t("desktop:invite.codeLabel")} value={invite.code} />
              </div>
              <InviteLimits invite={invite} />
            </div>
          ) : (
            <InviteSkeleton rows={2} label={t("desktop:invite.creating")} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
