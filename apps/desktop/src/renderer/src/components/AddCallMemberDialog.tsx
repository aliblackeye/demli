import { useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  UserAvatar,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import type { User, UserId } from "@demli/types";
import { localizeBlockedError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { getCallController } from "../lib/call-controller";
import { useFriends } from "../queries/social-queries";
import { useChatStore } from "../stores/chat-store";

/**
 * One friend candidate row. Subscribes to only THIS user's presence, not the
 * whole presence map, so a presence tick for an unrelated user never rerenders
 * the entire candidate list (§27).
 */
function FriendCandidateRow({
  user,
  busy,
  disabled,
  onAdd,
}: {
  user: User;
  busy: boolean;
  disabled: boolean;
  onAdd: (userId: UserId) => void;
}): JSX.Element {
  const presence = useChatStore((s) => s.presence[user.id] ?? "offline");
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAdd(user.id)}
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-60"
      >
        <UserAvatar
          name={user.displayName}
          colorSeed={user.id}
          src={user.avatarUrl}
          size="sm"
          presence={presence}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {user.displayName}
        </span>
        {busy ? (
          <Loader2 className="size-4 animate-spin text-fg-muted" />
        ) : (
          <UserPlus className="size-4 text-fg-muted" />
        )}
      </button>
    </li>
  );
}

/**
 * Friend picker for the seamless group upgrade (ADR 0012 §6 / Wave 6). Picking a
 * friend calls `upgrade({ inviteeUserId })`; the server creates the group, moves
 * the two originals in without a media gap, and rings the third person. The UI
 * transition happens when our own `call.upgraded` arrives (CallLayer navigates).
 *
 * The current peer is excluded from the list (they are already in the call).
 */
export function AddCallMemberDialog({
  open,
  onOpenChange,
  excludeUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeUserId: UserId | null;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { data: friends } = useFriends();
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<UserId | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setPendingId(null);
      setError(null);
    }
  }, [open]);

  const candidates = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (friends ?? [])
      .filter((f) => f.user.id !== excludeUserId)
      .filter((f) => term.length === 0 || f.user.displayName.toLowerCase().includes(term));
  }, [friends, excludeUserId, query]);

  const add = (userId: UserId): void => {
    if (pendingId) return;
    setPendingId(userId);
    setError(null);
    void getCallController()
      ?.upgrade({ inviteeUserId: userId })
      .then(() => onOpenChange(false))
      .catch((err: unknown) => {
        // The upgrade is refused when a block exists between the invitee and
        // EITHER original party (ADR 0017). It used to fail silently — the row
        // just stopped spinning — so the user now gets a neutral reason (§26).
        setPendingId(null);
        setError(err);
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:call.addPersonTitle")}</DialogTitle>
          <DialogDescription>{t("desktop:call.addPersonBody")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {error !== null && (
            <FormErrorAlert className="mb-3">
              {localizeBlockedError(error, t, "addMember")}
            </FormErrorAlert>
          )}

          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
            spellCheck={false}
            placeholder={t("desktop:call.addPersonSearch")}
            aria-label={t("desktop:call.addPersonSearch")}
          />

          <ul className="mt-3 max-h-72 space-y-0.5 overflow-y-auto" aria-label={t("desktop:call.addPersonTitle")}>
            {candidates.length === 0 ? (
              <li className="px-1 py-6 text-center text-sm text-fg-muted">
                {t("desktop:call.addPersonEmpty")}
              </li>
            ) : (
              candidates.map((friend) => (
                <FriendCandidateRow
                  key={friend.user.id}
                  user={friend.user}
                  busy={pendingId === friend.user.id}
                  disabled={pendingId !== null}
                  onAdd={add}
                />
              ))
            )}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
