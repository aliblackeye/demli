import { useState } from "react";
import { Check, Loader2, Pencil, Tag, X } from "lucide-react";
import { Button, Input, UserAvatar } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { USER_NICKNAME_MAX_LENGTH } from "@demli/config";
import type { UserId } from "@demli/types";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { usePrivateNicknameEntries, useSetPrivateNickname } from "../queries/social-queries";

/**
 * One row of the private-nickname list: shows the label, the real name behind it,
 * and edits IN PLACE.
 *
 * In place rather than through the shared `friendNickname` dialog on purpose —
 * that dialog renders at z-50 and the settings surface sits at z-[55], so
 * reusing it here would open it BEHIND the panel that launched it. A list of
 * one-field renames is also better served by an inline field than by a modal per
 * row.
 */
function NicknameRow({
  userId,
  realName,
  username,
  avatarUrl,
  nickname,
}: {
  userId: UserId;
  realName: string;
  username: string;
  avatarUrl: string | null;
  nickname: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname);
  const setNickname = useSetPrivateNickname(userId);

  const close = (): void => {
    setEditing(false);
    setNickname.reset();
  };

  const save = (): void => {
    const value = draft.trim();
    // An emptied field means "remove it" — the same thing the trash button does,
    // so a user who clears the input does not get a silent no-op.
    setNickname.mutate(value.length > 0 ? value : null, { onSuccess: () => setEditing(false) });
  };

  return (
    <li className="flex flex-col px-3 py-2.5">
      <div className="flex items-center gap-3">
        <UserAvatar name={realName} colorSeed={userId} src={avatarUrl} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{nickname}</span>
          {/* The real name stays visible so a renamed person is still identifiable. */}
          <span className="min-w-0 truncate text-2xs text-fg-faint">
            {realName} · @{username}
          </span>
        </span>
        {!editing && (
          <>
            <Button
              variant="secondary"
              size="sm"
              aria-label={t("desktop:nicknames.edit")}
              onClick={() => {
                setDraft(nickname);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={setNickname.isPending}
              onClick={() => setNickname.mutate(null)}
            >
              {t("desktop:userMenu.nicknameReset")}
            </Button>
          </>
        )}
      </div>

      {editing && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            autoFocus
            value={draft}
            maxLength={USER_NICKNAME_MAX_LENGTH}
            placeholder={realName}
            aria-label={t("desktop:userMenu.friendNicknameTitle", { name: realName })}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <Button type="submit" size="sm" disabled={setNickname.isPending}>
            {setNickname.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="size-3.5" aria-hidden />
            )}
            <span className="sr-only">{t("buttons.save")}</span>
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={close}>
            <X className="size-3.5" aria-hidden />
            <span className="sr-only">{t("buttons.cancel")}</span>
          </Button>
        </form>
      )}

      {setNickname.error && (
        <div className="mt-2">
          <FormErrorAlert>{localizeError(setNickname.error, t)}</FormErrorAlert>
        </div>
      )}
    </li>
  );
}

/**
 * "Private nicknames" settings section (ADR 0019 §2) — every friend nickname the
 * signed-in user has given, with edit and remove.
 *
 * These are the VIEWER-ONLY labels: global across every surface, never shown to
 * the person they rename and never visible to a server. The per-server nickname
 * (which everyone in that server sees) is a different feature and is managed
 * from the member menu inside that server — the description says so, because two
 * things called "nickname" is exactly the confusion ADR 0019 exists to prevent.
 */
export function NicknamesSettings(): JSX.Element {
  const { t } = useAppTranslation();
  const { data: entries, isPending, error, refetch } = usePrivateNicknameEntries();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-fg">{t("desktop:nicknames.settingsTitle")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          {t("desktop:nicknames.settingsDescription")}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-fg-faint">
          {t("desktop:nicknames.settingsVsServer")}
        </p>
      </div>

      {isPending && (
        <div role="status" className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" />
          {t("desktop:moderationLog.loading")}
        </div>
      )}

      {error && (
        <div className="space-y-3">
          <FormErrorAlert>{localizeError(error, t)}</FormErrorAlert>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            {t("buttons.retry")}
          </Button>
        </div>
      )}

      {entries && entries.length === 0 && (
        <EmptyState icon={<Tag className="size-6" />} title={t("desktop:nicknames.settingsEmpty")} />
      )}

      {entries && entries.length > 0 && (
        <>
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
            {t("desktop:nicknames.settingsCount", { count: entries.length })}
          </p>
          <ul className="divide-y divide-stroke overflow-hidden rounded-lg border border-stroke bg-surface">
            {entries.map((entry) => (
              <NicknameRow
                key={entry.user.id}
                userId={entry.user.id}
                realName={entry.user.displayName}
                username={entry.user.username}
                avatarUrl={entry.user.avatarUrl}
                nickname={entry.nickname}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
