import { useState } from "react";
import { m } from "framer-motion";
import { Check, Info, Pencil, Tag, X } from "lucide-react";
import { Button, IconButton, Input, UserAvatar } from "@demli/ui";
import { EmptyState, FormErrorAlert, springs } from "@demli/app-ui";
import { USER_NICKNAME_MAX_LENGTH } from "@demli/config";
import type { UserId } from "@demli/types";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { usePrivateNicknameEntries, useSetPrivateNickname } from "../queries/social-queries";
import { CharCount, InlineError, ListSkeleton, SettingsLabel, SettingsNote } from "./settings-kit";

/**
 * One row of the private-nickname list: shows the label, the real name behind it,
 * and edits IN PLACE.
 *
 * In place rather than through the shared `friendNickname` dialog on purpose —
 * that dialog renders at z-50 and the settings surface sits at z-[55], so
 * reusing it here would open it BEHIND the panel that launched it. A list of
 * one-field renames is also better served by an inline field than by a modal per
 * row.
 *
 * The editor is marked `data-esc-local`: Esc there cancels the edit, and the
 * settings layer leaves it alone instead of closing over it.
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
    <li className="flex flex-col px-4 py-3 transition-colors motion-hover content-visibility-row hover:bg-raised/40">
      <div className="flex items-center gap-3">
        <UserAvatar name={realName} colorSeed={userId} src={avatarUrl} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-sm font-medium text-fg">{nickname}</span>
          {/* The real name stays visible so a renamed person is still identifiable. */}
          <span className="min-w-0 truncate text-label text-fg-faint">
            {realName} · @{username}
          </span>
        </span>
        {!editing && (
          <>
            <IconButton
              variant="ghost"
              size="sm"
              label={t("desktop:nicknames.edit")}
              onClick={() => {
                setDraft(nickname);
                setEditing(true);
              }}
            >
              <Pencil />
            </IconButton>
            <Button
              variant="secondary"
              size="sm"
              loading={setNickname.isPending}
              onClick={() => setNickname.mutate(null)}
            >
              {t("desktop:userMenu.nicknameReset")}
            </Button>
          </>
        )}
      </div>

      {editing && (
        <m.form
          data-esc-local
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: springs.position }}
          className="mt-3 flex items-center gap-2 pl-11"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="relative min-w-0 flex-1">
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
              // Inside the surface list the field is a darker well, not the
              // card's own tone (it would disappear).
              className="bg-app pr-14 hover:bg-app/70"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-2xs">
              <CharCount value={draft} max={USER_NICKNAME_MAX_LENGTH} />
            </span>
          </div>
          <IconButton
            type="submit"
            variant="solid"
            size="md"
            label={t("buttons.save")}
            disabled={setNickname.isPending}
            className="bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-pressed"
          >
            <Check />
          </IconButton>
          <IconButton type="button" variant="ghost" size="md" label={t("buttons.cancel")} onClick={close}>
            <X />
          </IconButton>
        </m.form>
      )}

      {setNickname.error && (
        <div className="mt-2 pl-11">
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
  const { data: entries, isPending, error, refetch, isFetching } = usePrivateNicknameEntries();

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm leading-relaxed text-fg-muted">{t("desktop:nicknames.settingsDescription")}</p>
        <SettingsNote icon={Info}>{t("desktop:nicknames.settingsVsServer")}</SettingsNote>
      </div>

      {isPending && <ListSkeleton rows={3} label={t("desktop:moderationLog.loading")} />}

      {error && (
        <InlineError
          message={localizeError(error, t)}
          retryLabel={t("buttons.retry")}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      )}

      {entries && entries.length === 0 && (
        <EmptyState
          icon={<Tag className="size-6" />}
          title={t("desktop:nicknames.settingsEmpty")}
          className="py-10"
        />
      )}

      {entries && entries.length > 0 && (
        <div className="space-y-2">
          <SettingsLabel>{t("desktop:nicknames.settingsCount", { count: entries.length })}</SettingsLabel>
          <ul className="overflow-hidden rounded-xl bg-surface [&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]">
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
        </div>
      )}
    </div>
  );
}
