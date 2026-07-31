import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  cn,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import {
  MEMBER_NICKNAME_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
  USER_NOTE_MAX_LENGTH,
} from "@demli/config";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useBanMember, useKickMember, useSetMemberNickname } from "../queries/chat-queries";
import {
  useSetPrivateNickname,
  useSetUserNote,
  useUnfriend,
  useUserNote,
} from "../queries/social-queries";
import { useUiStore, type MemberDialog } from "../stores/ui-store";

/**
 * Every dialog the user context menu can open, in one host mounted once at the
 * app shell (like {@link BlockUserDialog}).
 *
 * They CANNOT be owned by the menu itself: Radix unmounts a context menu's
 * content the instant an entry is selected, which would destroy the dialog
 * before it painted. Driving them from `ui-store.memberDialog` also means the
 * roster row, a message avatar and the profile card's ⋯ button all open the
 * exact same dialog — one confirmation wording per action, never three.
 */
export function MemberDialogs(): JSX.Element {
  const dialog = useUiStore((s) => s.memberDialog);
  // Keyed remount per target+kind so a dialog never opens seeded with the
  // PREVIOUS user's note or nickname still in its input.
  const key = dialog ? `${dialog.kind}:${dialog.userId}` : "none";
  return <MemberDialogBody key={key} dialog={dialog} />;
}

function MemberDialogBody({ dialog }: { dialog: MemberDialog | null }): JSX.Element {
  switch (dialog?.kind) {
    case "note":
      return <NoteDialog dialog={dialog} />;
    case "friendNickname":
      return <FriendNicknameDialog dialog={dialog} />;
    case "serverNickname":
      return <ServerNicknameDialog dialog={dialog} />;
    case "unfriend":
      return <UnfriendDialog dialog={dialog} />;
    case "kick":
      return <KickDialog dialog={dialog} />;
    case "ban":
      return <BanDialog dialog={dialog} />;
    default:
      return <></>;
  }
}

/** Shared chrome so all five dialogs share one layout, one close path, one busy rule. */
function MemberDialogShell({
  title,
  description,
  error,
  busy,
  submitLabel,
  submitVariant = "default",
  onSubmit,
  children,
  footer,
}: {
  title: string;
  description: string;
  error: unknown;
  busy: boolean;
  submitLabel: string;
  submitVariant?: "default" | "danger";
  onSubmit: () => void;
  children?: ReactNode;
  /** Extra control below the primary row (e.g. "Remove nickname"). */
  footer?: ReactNode;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const close = (): void => {
    if (busy) return;
    setMemberDialog(null);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent>
        {/* The form — not DialogContent — is the flex parent of the header/body
            here, so it has to carry the column contract itself. Without
            `min-h-0 flex-1 flex-col` the DialogBody inside it never becomes the
            scroll region and tall content (a long ban reason on a phone-height
            sheet) is silently clipped by the card's overflow-hidden. */}
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!busy) onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {error != null && (
              <FormErrorAlert className="mb-3">{localizeError(error, t)}</FormErrorAlert>
            )}
            {children}
            <div className="mt-5 flex gap-2">
              <Button type="submit" variant={submitVariant} disabled={busy} className="flex-1">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {submitLabel}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={close}
                className="flex-1"
              >
                {t("buttons.cancel")}
              </Button>
            </div>
            {footer}
          </DialogBody>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The explicit "Remove" control for a dialog that edits an OPTIONAL value — a
 * note, a private nickname, a server nickname.
 *
 * Clearing the field and pressing Save already deletes (the mutation sends
 * `null` for empty input), but nobody discovers that: the founder's report was
 * literally "takma adı ekleyince silme yok … notda da aynı şekilde". A named
 * button is the discoverable path, and it is rendered only when there is
 * something to remove — never as a dead control (§35).
 *
 * Deliberately quiet rather than a red danger button: removing your own private
 * label about someone is trivially redoable, and giving it the same weight as
 * "Ban" would be theatre.
 */
function RemoveValueButton({
  label,
  disabled,
  onRemove,
}: {
  label: string;
  disabled: boolean;
  onRemove: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onRemove}
      className={cn(
        "mt-3 w-full cursor-pointer rounded-md py-1.5 text-xs font-medium",
        "text-danger/85 transition-colors motion-instant hover:bg-danger/10 hover:text-danger",
        "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
      )}
    >
      {label}
    </button>
  );
}

/** Live "n / max" counter under a field, turning danger once the cap is hit. */
function CharCount({ value, max }: { value: string; max: number }): JSX.Element {
  return (
    <p
      className={
        value.length >= max
          ? "mt-1 text-right text-2xs text-danger"
          : "mt-1 text-right text-2xs text-fg-faint"
      }
    >
      {value.length} / {max}
    </p>
  );
}

/**
 * The private note (ADR 0019 §1). SINGLE-READER: it is fetched only while this
 * dialog is open, written to its own cache key, and rendered on no other
 * surface. The copy states that plainly, because a user who believes a note
 * might be visible will not use the feature.
 */
function NoteDialog({
  dialog,
}: {
  dialog: Extract<MemberDialog, { kind: "note" }>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const { data: note, isPending } = useUserNote(dialog.userId, true);
  const setNote = useSetUserNote(dialog.userId);
  const [body, setBody] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Seed once, when the fetch lands — never on every render, or a slow network
  // would overwrite what the user has already started typing.
  useEffect(() => {
    if (seeded || isPending) return;
    setBody(note?.body ?? "");
    setSeeded(true);
  }, [seeded, isPending, note?.body]);

  const save = (next: string | null): void =>
    void setNote.mutate(next, { onSuccess: () => setMemberDialog(null) });

  const submit = (): void => {
    const trimmed = body.trim();
    save(trimmed.length > 0 ? trimmed : null);
  };

  // Gated on the SAVED note, not on the textarea: a user who has cleared the box
  // to delete must still see the button that does it.
  const hasSavedNote = Boolean(note?.body);

  return (
    <MemberDialogShell
      title={
        hasSavedNote
          ? t("desktop:userMenu.noteEditTitle", { name: dialog.displayName })
          : t("desktop:userMenu.noteTitle", { name: dialog.displayName })
      }
      description={t("desktop:userMenu.noteDescription")}
      error={setNote.error}
      busy={setNote.isPending}
      submitLabel={t("buttons.save")}
      onSubmit={submit}
      footer={
        hasSavedNote ? (
          <RemoveValueButton
            label={t("desktop:userMenu.noteRemove")}
            disabled={setNote.isPending}
            onRemove={() => save(null)}
          />
        ) : null
      }
    >
      <Textarea
        autoFocus
        rows={4}
        value={body}
        maxLength={USER_NOTE_MAX_LENGTH}
        placeholder={t("desktop:userMenu.notePlaceholder")}
        onChange={(event) => setBody(event.target.value)}
        aria-label={t("desktop:userMenu.noteTitle", { name: dialog.displayName })}
      />
      <CharCount value={body} max={USER_NOTE_MAX_LENGTH} />
      <p className="mt-2 text-xs leading-relaxed text-fg-faint">
        {t("desktop:userMenu.notePrivacy")}
      </p>
    </MemberDialogShell>
  );
}

/**
 * The PRIVATE "friend nickname" — global across every surface and visible only
 * to the viewer (ADR 0019 §2). Its copy has to be unmistakably different from
 * the server-nickname dialog's, because the two actions look identical and one
 * of them publishes a name to a whole server.
 */
function FriendNicknameDialog({
  dialog,
}: {
  dialog: Extract<MemberDialog, { kind: "friendNickname" }>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const setNickname = useSetPrivateNickname(dialog.userId);
  // Seeded from the nickname the menu read out of the private-nickname map — the
  // authoritative answer to "is one set". Inferring it from
  // `displayName !== realName` used to be wrong whenever a SERVER nickname was
  // the thing overriding the name.
  const [value, setValue] = useState(dialog.current ?? "");

  const save = (next: string | null): void =>
    void setNickname.mutate(next, { onSuccess: () => setMemberDialog(null) });

  return (
    <MemberDialogShell
      title={
        dialog.current === null
          ? t("desktop:userMenu.friendNicknameTitle", { name: dialog.realName })
          : t("desktop:userMenu.friendNicknameEditTitle", { name: dialog.realName })
      }
      description={t("desktop:userMenu.friendNicknameDescription")}
      error={setNickname.error}
      busy={setNickname.isPending}
      submitLabel={t("buttons.save")}
      onSubmit={() => save(value.trim().length > 0 ? value.trim() : null)}
      footer={
        // Gated on the SAVED nickname, not on the input: emptying the field to
        // delete must not make the delete button vanish.
        dialog.current !== null ? (
          <RemoveValueButton
            label={t("desktop:userMenu.nicknameReset")}
            disabled={setNickname.isPending}
            onRemove={() => save(null)}
          />
        ) : null
      }
    >
      <Input
        autoFocus
        value={value}
        maxLength={USER_NICKNAME_MAX_LENGTH}
        placeholder={dialog.realName}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t("desktop:userMenu.friendNicknameTitle", { name: dialog.realName })}
      />
      <CharCount value={value} max={USER_NICKNAME_MAX_LENGTH} />
      <p className="mt-2 text-xs leading-relaxed text-fg-faint">
        {t("desktop:userMenu.friendNicknamePrivacy")}
      </p>
    </MemberDialogShell>
  );
}

/**
 * The per-SERVER nickname — visible to everyone in that server. Two wordings:
 * renaming yourself ("Edit your server profile", no permission needed) and
 * renaming someone else (owner ∨ MANAGE_NICKNAMES).
 */
function ServerNicknameDialog({
  dialog,
}: {
  dialog: Extract<MemberDialog, { kind: "serverNickname" }>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const setNickname = useSetMemberNickname(dialog.groupId);
  const [value, setValue] = useState(dialog.current ?? "");

  const save = (next: string | null): void =>
    void setNickname.mutate(
      { userId: dialog.userId, nickname: next },
      { onSuccess: () => setMemberDialog(null) },
    );

  return (
    <MemberDialogShell
      title={
        dialog.isSelf
          ? t("desktop:userMenu.serverProfileTitle")
          : dialog.current === null
            ? t("desktop:userMenu.serverNicknameTitle", { name: dialog.realName })
            : t("desktop:userMenu.serverNicknameEditTitle", { name: dialog.realName })
      }
      description={
        dialog.isSelf
          ? t("desktop:userMenu.serverProfileDescription")
          : t("desktop:userMenu.serverNicknameDescription")
      }
      error={setNickname.error}
      busy={setNickname.isPending}
      submitLabel={t("buttons.save")}
      onSubmit={() => save(value.trim().length > 0 ? value.trim() : null)}
      footer={
        (dialog.current ?? "").length > 0 ? (
          <RemoveValueButton
            label={t("desktop:userMenu.nicknameReset")}
            disabled={setNickname.isPending}
            onRemove={() => save(null)}
          />
        ) : null
      }
    >
      <Input
        autoFocus
        value={value}
        maxLength={MEMBER_NICKNAME_MAX_LENGTH}
        placeholder={dialog.realName}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t("desktop:userMenu.serverNicknameTitle", { name: dialog.realName })}
      />
      <CharCount value={value} max={MEMBER_NICKNAME_MAX_LENGTH} />
      <p className="mt-2 text-xs leading-relaxed text-fg-faint">
        {t("desktop:userMenu.serverNicknamePrivacy")}
      </p>
    </MemberDialogShell>
  );
}

/**
 * End a friendship. The ONE confirmation behind both entry points — the context
 * menu's "Remove friend" and the profile card's banner icon — so a small icon
 * and a menu row can never behave differently.
 *
 * Confirmed rather than instant because it is not undoable alone: getting the
 * friendship back needs the other person to accept a fresh request.
 */
function UnfriendDialog({
  dialog,
}: {
  dialog: Extract<MemberDialog, { kind: "unfriend" }>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const unfriend = useUnfriend();
  const queryClient = useQueryClient();

  return (
    <MemberDialogShell
      title={t("desktop:userMenu.unfriendTitle", { name: dialog.displayName })}
      description={t("desktop:userMenu.unfriendDescription", { name: dialog.displayName })}
      error={unfriend.error}
      busy={unfriend.isPending}
      submitLabel={t("desktop:userMenu.unfriendConfirm")}
      submitVariant="danger"
      onSubmit={() =>
        void unfriend.mutate(dialog.userId, {
          onSuccess: () => {
            // The open profile card reads `friendship` from this cache — refresh
            // it so the banner icon flips to "Add friend" behind the dialog.
            void queryClient.invalidateQueries({ queryKey: ["profile", dialog.userId] });
            setMemberDialog(null);
          },
        })
      }
    />
  );
}

/** Kick: removes them from the server. Reversible — any invite brings them back. */
function KickDialog({
  dialog,
}: {
  dialog: Extract<MemberDialog, { kind: "kick" }>;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const kick = useKickMember(dialog.groupId);

  return (
    <MemberDialogShell
      title={t("desktop:userMenu.kickTitle", { name: dialog.displayName })}
      description={t("desktop:userMenu.kickDescription", { name: dialog.displayName })}
      error={kick.error}
      busy={kick.isPending}
      submitLabel={t("desktop:userMenu.kickConfirm")}
      submitVariant="danger"
      onSubmit={() =>
        void kick.mutate(dialog.userId, { onSuccess: () => setMemberDialog(null) })
      }
    />
  );
}

/**
 * Ban: a kick PLUS a permanent bar, so no invite brings them back. The optional
 * reason lands in the moderation audit log, which is the only place it is read.
 */
function BanDialog({ dialog }: { dialog: Extract<MemberDialog, { kind: "ban" }> }): JSX.Element {
  const { t } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const ban = useBanMember(dialog.groupId);
  const [reason, setReason] = useState("");

  return (
    <MemberDialogShell
      title={t("desktop:userMenu.banTitle", { name: dialog.displayName })}
      description={t("desktop:userMenu.banDescription", { name: dialog.displayName })}
      error={ban.error}
      busy={ban.isPending}
      submitLabel={t("desktop:userMenu.banConfirm")}
      submitVariant="danger"
      onSubmit={() =>
        void ban.mutate(
          { userId: dialog.userId, reason: reason.trim() || undefined },
          { onSuccess: () => setMemberDialog(null) },
        )
      }
    >
      <label className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-fg-faint">
        {t("desktop:userMenu.banReasonLabel")}
      </label>
      <Input
        autoFocus
        value={reason}
        maxLength={200}
        placeholder={t("desktop:userMenu.banReasonPlaceholder")}
        onChange={(event) => setReason(event.target.value)}
      />
    </MemberDialogShell>
  );
}
