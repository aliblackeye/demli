import { useEffect, useState } from "react";
import { Link2, Loader2, Trash2 } from "lucide-react";
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
import {
  useCreateGroupChatInvite,
  useGroupChat,
  useGroupChatInvites,
  useRevokeGroupChatInvite,
} from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";
import {
  CopyField,
  inviteLimits,
  INVITE_EXPIRES_HOURS,
  INVITE_MAX_USES,
} from "./invite-shared";

/**
 * Invite links for a flat group chat (M18, ADR 0005).
 *
 * Deliberately the SAME link format and the SAME redeem endpoint as a server
 * invite (`POST /invites/:code/redeem` branches on the group's kind), so there is
 * exactly one deep-link shape in the product and no second join flow to maintain.
 * The copy affordance is lifted from {@link InviteDialog} for the same reason.
 *
 * Where it differs from the server dialog, it differs because the API does:
 *  - it LISTS existing links instead of minting a fresh one on open, because a
 *    group chat's links are revocable and a user needs to see what is live;
 *  - creating is open to any member, but REVOKING is owner-only — so a non-owner
 *    simply gets no revoke button rather than one the server would reject (§35).
 */
export function GroupChatInviteDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const groupChatId = useUiStore((s) => s.groupChatInviteId);
  const setGroupChatInviteId = useUiStore((s) => s.setGroupChatInviteId);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const open = groupChatId !== null;
  const { data: details } = useGroupChat(groupChatId);
  const isOwner = details?.group.ownerId === currentUserId;

  const invitesQuery = useGroupChatInvites(groupChatId, open);
  const createInvite = useCreateGroupChatInvite(groupChatId);
  const revokeInvite = useRevokeGroupChatInvite(groupChatId);
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);

  const { reset: resetCreate } = createInvite;
  const { reset: resetRevoke } = revokeInvite;
  useEffect(() => {
    if (open) return;
    resetCreate();
    resetRevoke();
    setConfirmingRevoke(null);
  }, [open, resetCreate, resetRevoke]);

  const close = (): void => setGroupChatInviteId(null);
  const invites = invitesQuery.data ?? [];
  const busy = createInvite.isPending || revokeInvite.isPending;
  const error = invitesQuery.error ?? createInvite.error ?? revokeInvite.error ?? null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("desktop:groupChatInvite.title", {
              group: details?.group.name ?? t("desktop:invite.yourGroup"),
            })}
          </DialogTitle>
          <DialogDescription>{t("desktop:groupChatInvite.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error && <FormErrorAlert className="mb-3">{localizeError(error, t)}</FormErrorAlert>}

          {invitesQuery.isPending && (
            <div role="status" className="flex items-center gap-2 py-2 text-sm text-fg-muted">
              <Loader2 className="size-4 animate-spin" />
              {t("desktop:moderationLog.loading")}
            </div>
          )}

          {!invitesQuery.isPending && invites.length === 0 && (
            <p className="py-2 text-sm text-fg-muted">{t("desktop:groupChatInvite.empty")}</p>
          )}

          {invites.length > 0 && (
            <ul className="space-y-4">
              {invites.map((invite) => (
                <li key={invite.id} className="space-y-1.5">
                  <CopyField
                    label={t("desktop:groupChatInvite.linkLabel")}
                    value={buildInviteLink(invite.code)}
                  />
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 text-xs text-fg-faint">
                      {inviteLimits(invite, t)}
                    </p>
                    {isOwner &&
                      (confirmingRevoke === invite.id ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              revokeInvite.mutate(invite.id, {
                                onSuccess: () => setConfirmingRevoke(null),
                              })
                            }
                          >
                            {revokeInvite.isPending && (
                              <Loader2 className="size-4 animate-spin" />
                            )}
                            {t("desktop:groupChatInvite.revokeConfirm")}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfirmingRevoke(null)}
                          >
                            {t("buttons.cancel")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setConfirmingRevoke(invite.id)}
                        >
                          <Trash2 className="size-4" />
                          {t("desktop:groupChatInvite.revoke")}
                        </Button>
                      ))}
                  </div>
                  {confirmingRevoke === invite.id && (
                    <p className="text-2xs text-fg-faint">
                      {t("desktop:groupChatInvite.revokeBody")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <Button
            variant={invites.length > 0 ? "secondary" : "default"}
            disabled={busy}
            onClick={() =>
              createInvite.mutate({
                expiresInHours: INVITE_EXPIRES_HOURS,
                maxUses: INVITE_MAX_USES,
              })
            }
            className="mt-4 w-full"
          >
            {createInvite.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Link2 className="size-4" />
            )}
            {createInvite.isPending
              ? t("desktop:groupChatInvite.creating")
              : t("desktop:groupChatInvite.create")}
          </Button>

          {!isOwner && invites.length > 0 && (
            <p className="mt-2 text-2xs text-fg-faint">
              {t("desktop:groupChatInvite.ownerOnlyRevoke")}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
