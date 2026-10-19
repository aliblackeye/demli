import { useEffect, useState } from "react";
import { m } from "framer-motion";
import { Link2, Trash2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@demli/ui";
import { FormErrorAlert, springs } from "@demli/app-ui";
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
  InviteLimits,
  InviteSkeleton,
  INVITE_EXPIRES_HOURS,
  INVITE_MAX_USES,
} from "./invite-shared";
import { InlineError } from "./settings-kit";

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
  const error = createInvite.error ?? revokeInvite.error ?? null;

  const create = (): void =>
    createInvite.mutate({ expiresInHours: INVITE_EXPIRES_HOURS, maxUses: INVITE_MAX_USES });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent closeLabel={t("buttons.close")}>
        <DialogHeader>
          <DialogTitle>
            {t("desktop:groupChatInvite.title", {
              group: details?.group.name ?? t("desktop:invite.yourGroup"),
            })}
          </DialogTitle>
          <DialogDescription>{t("desktop:groupChatInvite.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {invitesQuery.isError ? (
            <InlineError
              message={localizeError(invitesQuery.error, t)}
              retryLabel={t("buttons.retry")}
              onRetry={() => void invitesQuery.refetch()}
              retrying={invitesQuery.isFetching}
            />
          ) : (
            error && <FormErrorAlert>{localizeError(error, t)}</FormErrorAlert>
          )}

          {invitesQuery.isPending && <InviteSkeleton label={t("desktop:moderationLog.loading")} />}

          {!invitesQuery.isPending && !invitesQuery.isError && invites.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-surface px-4 py-6 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-raised text-fg-muted">
                <Link2 aria-hidden className="size-5" />
              </span>
              <p className="text-sm text-fg-muted">{t("desktop:groupChatInvite.empty")}</p>
            </div>
          )}

          {invites.length > 0 && (
            <ul className="space-y-3">
              {invites.map((invite) => (
                <li key={invite.id} className="space-y-2 rounded-xl bg-surface p-3.5">
                  <CopyField
                    label={t("desktop:groupChatInvite.linkLabel")}
                    value={buildInviteLink(invite.code)}
                    inputClassName="bg-app hover:bg-app/70"
                  />
                  <div className="flex min-h-[29px] items-center gap-2">
                    <InviteLimits invite={invite} className="min-w-0 flex-1" />
                    {isOwner && confirmingRevoke !== invite.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          revokeInvite.reset();
                          setConfirmingRevoke(invite.id);
                        }}
                        className="hover:bg-danger-surface hover:text-danger"
                      >
                        <Trash2 className="size-3.5" />
                        {t("desktop:groupChatInvite.revoke")}
                      </Button>
                    )}
                  </div>
                  {isOwner && confirmingRevoke === invite.id && (
                    <m.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0, transition: springs.position }}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-danger-surface px-3 py-2"
                    >
                      <p className="min-w-0 flex-1 text-label text-fg">{t("desktop:groupChatInvite.revokeBody")}</p>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingRevoke(null)}>
                        {t("buttons.cancel")}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={revokeInvite.isPending}
                        onClick={() =>
                          revokeInvite.mutate(invite.id, {
                            onSuccess: () => setConfirmingRevoke(null),
                          })
                        }
                      >
                        {t("desktop:groupChatInvite.revokeConfirm")}
                      </Button>
                    </m.div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!isOwner && invites.length > 0 && (
            <p className="text-label text-fg-faint">{t("desktop:groupChatInvite.ownerOnlyRevoke")}</p>
          )}
        </DialogBody>

        <DialogFooter className="pt-4">
          <Button
            variant={invites.length > 0 ? "secondary" : "accent"}
            loading={createInvite.isPending}
            disabled={revokeInvite.isPending || invitesQuery.isPending}
            onClick={create}
            className="w-full"
          >
            <Link2 className="size-4" />
            {t("desktop:groupChatInvite.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
