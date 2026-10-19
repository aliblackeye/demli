import { useEffect, useMemo, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  UserAvatar,
  cn,
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
        data-testid="add-call-candidate"
        aria-busy={busy || undefined}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
          // Tone-only hover on a dialog card (white wash shows on any tone).
          "transition-colors motion-hover hover:bg-wash active:bg-wash-strong",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
          "disabled:pointer-events-none disabled:opacity-40",
          busy && "bg-accent-surface disabled:opacity-100",
        )}
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
          <Loader2 aria-hidden className="size-4 animate-spin text-accent motion-reduce:animate-none" />
        ) : (
          <span className="flex size-7 items-center justify-center rounded-full text-fg-faint transition-colors motion-hover group-hover:bg-accent-surface group-hover:text-accent-hover">
            <UserPlus aria-hidden className="size-4" />
          </span>
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
  const { data: friends, isPending: friendsLoading, isError: friendsFailed, refetch } = useFriends();
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
      <DialogContent closeLabel={t("buttons.close")}>
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
            {friendsLoading ? (
              // Loading: the rows' own shape, so the list does not claim "no
              // friends to add" while the friend list is still on its way.
              <li role="status" aria-label={t("desktop:call.addPersonLoading")} data-testid="add-call-loading">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                    <Skeleton shape="circle" width={32} />
                    <Skeleton shape="line" className="w-1/2" height={10} />
                  </div>
                ))}
              </li>
            ) : friendsFailed ? (
              <li data-testid="add-call-error" className="flex flex-col items-center gap-3 px-1 py-6 text-center">
                <span className="text-label text-fg-muted">{t("desktop:call.addPersonLoadFailed")}</span>
                <Button variant="secondary" size="sm" onClick={() => void refetch()}>
                  {t("buttons.retry")}
                </Button>
              </li>
            ) : candidates.length === 0 ? (
              <li
                data-testid="add-call-empty"
                className="flex flex-col items-center gap-2.5 px-1 py-8 text-center"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-surface text-fg-faint">
                  <UserPlus aria-hidden className="size-5" />
                </span>
                <span className="text-label text-fg-muted">
                  {query.trim().length > 0
                    ? t("desktop:call.addPersonNoMatch", { query: query.trim() })
                    : t("desktop:call.addPersonEmpty")}
                </span>
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
