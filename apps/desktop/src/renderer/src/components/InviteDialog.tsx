import { useEffect } from "react";
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
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { buildInviteLink } from "../lib/invite-link";
import { useCreateInvite, useGroups } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import {
  CopyField,
  inviteLimits,
  INVITE_EXPIRES_HOURS,
  INVITE_MAX_USES,
} from "./invite-shared";

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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("desktop:invite.title", {
              group: group?.name ?? t("desktop:invite.yourGroup"),
            })}
          </DialogTitle>
          <DialogDescription>{t("desktop:invite.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {createInvite.isPending && (
            <div role="status" className="flex items-center gap-2 py-2 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" />
              {t("desktop:invite.creating")}
            </div>
          )}

          {createInvite.isError && (
            <div className="space-y-3">
              <FormErrorAlert>{localizeError(createInvite.error, t)}</FormErrorAlert>
              <Button
                variant="secondary"
                onClick={() =>
                  mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES })
                }
              >
                {t("buttons.retry")}
              </Button>
            </div>
          )}

          {invite && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">
                  {t("desktop:invite.linkLabel")}
                </p>
                <CopyField
                  label={t("desktop:invite.linkLabel")}
                  value={buildInviteLink(invite.code)}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-fg-muted">
                  {t("desktop:invite.codeLabel")}
                </p>
                <CopyField label={t("desktop:invite.codeLabel")} value={invite.code} />
              </div>
              <p className="text-xs text-fg-faint">{inviteLimits(invite, t)}.</p>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
