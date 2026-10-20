import { useEffect, useState } from "react";
import { ShieldBan, ShieldOff } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { useBlockUser, useUnblockUser } from "../queries/social-queries";
import { useUiStore, type BlockDialogTarget } from "../stores/ui-store";
import { ConfirmDialogShell } from "./MemberDialogs";

/**
 * The block / unblock confirmation (M18, ADR 0017). One dialog for both
 * directions, driven by `ui-store.blockDialog`, so every entry point (profile
 * card, member menu, settings list) confirms with the same wording — and the
 * same chrome as the moderation confirmations ({@link ConfirmDialogShell}).
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
export function BlockUserDialog(): JSX.Element | null {
  const { t } = useAppTranslation();
  const target = useUiStore((s) => s.blockDialog);
  const setBlockDialog = useUiStore((s) => s.setBlockDialog);

  // Keep the last target rendered while the dialog animates out.
  const [shown, setShown] = useState<BlockDialogTarget | null>(target);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);
  const current = target ?? shown;

  const blockUser = useBlockUser();
  const unblockUser = useUnblockUser();
  const busy = blockUser.isPending || unblockUser.isPending;
  const error = blockUser.error ?? unblockUser.error ?? null;

  if (!current) return null;

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

  const unblocking = current.blocked === true;
  const name = current.displayName;

  return (
    <ConfirmDialogShell
      key={current.userId}
      open={target !== null}
      tone={unblocking ? "default" : "danger"}
      icon={unblocking ? <ShieldOff /> : <ShieldBan />}
      title={
        unblocking
          ? t("desktop:block.unblockConfirmTitle", { name })
          : t("desktop:block.confirmTitle", { name })
      }
      description={unblocking ? t("desktop:block.unblockConfirmBody") : t("desktop:block.confirmBody")}
      error={error}
      busy={busy}
      submitLabel={
        unblocking ? t("desktop:block.unblockConfirmAction") : t("desktop:block.confirmAction")
      }
      submitVariant={unblocking ? "primary" : "danger"}
      onSubmit={confirm}
      onClose={close}
      // Also opened from Settings → Blocked users: the settings layer sits at
      // z-[55], so at the default z-50 the confirmation opened invisibly BEHIND it.
      layer="overSettings"
    >
      {!unblocking && (
        <p className="text-label text-fg-faint">{t("desktop:block.confirmNote")}</p>
      )}
    </ConfirmDialogShell>
  );
}
