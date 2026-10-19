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
import { useBlockUser, useUnblockUser } from "../queries/social-queries";
import { useUiStore } from "../stores/ui-store";

/**
 * The block / unblock confirmation (M18, ADR 0017). One dialog for both
 * directions, driven by `ui-store.blockDialog`, so every entry point (profile
 * card, member menu, settings list) confirms with the same wording.
 *
 * Blocking is confirmed because it is consequential and partly irreversible: it
 * severs the friendship and any pending request, and unblocking does not bring
 * either back. The body spells out exactly what is cut so nobody discovers it
 * afterwards.
 *
 * What the copy must NEVER contain is a direction. The server answers one
 * `BLOCKED` code whether the caller blocked the target or the target blocked the
 * caller, precisely so a block cannot be detected — and no string in this dialog
 * (or in the errors catalog) may undo that by phrasing it as "they blocked you".
 */
export function BlockUserDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const target = useUiStore((s) => s.blockDialog);
  const setBlockDialog = useUiStore((s) => s.setBlockDialog);

  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const busy = blockUser.isPending || unblockUser.isPending;
  const error = blockUser.error ?? unblockUser.error ?? null;

  const close = (): void => {
    if (busy) return;
    blockUser.reset();
    unblockUser.reset();
    setBlockDialog(null);
  };

  const confirm = (): void => {
    if (!target || busy) return;
    const mutation = target.blocked ? unblockUser : blockUser;
    mutation.mutate(target.userId, {
      onSuccess: () => setBlockDialog(null),
    });
  };

  const unblocking = target?.blocked === true;
  const name = target?.displayName ?? "";

  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && close()}>
      {/* z-[58] for scrim AND card: this dialog is also opened from Settings →
          Blocked users, and the settings layer sits at z-[55] — at the default
          z-50 the unblock confirmation opened invisibly BEHIND it. */}
      <DialogContent className="z-[58]" overlayClassName="z-[58]">
        <DialogHeader>
          <DialogTitle>
            {unblocking
              ? t("desktop:block.unblockConfirmTitle", { name })
              : t("desktop:block.confirmTitle", { name })}
          </DialogTitle>
          <DialogDescription>
            {unblocking
              ? t("desktop:block.unblockConfirmBody")
              : t("desktop:block.confirmBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && <FormErrorAlert className="mb-3">{localizeError(error, t)}</FormErrorAlert>}
          {!unblocking && (
            <p className="text-xs leading-relaxed text-fg-faint">
              {t("desktop:block.confirmNote")}
            </p>
          )}
          <div className="mt-5 flex gap-2">
            <Button
              variant={unblocking ? "default" : "danger"}
              disabled={busy}
              onClick={confirm}
              className="flex-1"
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {unblocking
                ? t("desktop:block.unblockConfirmAction")
                : t("desktop:block.confirmAction")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={close} className="flex-1">
              {t("buttons.cancel")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
