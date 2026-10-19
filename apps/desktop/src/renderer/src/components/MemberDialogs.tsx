import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, Clock, LogOut, UserMinus } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  RadioGroup,
  RadioItem,
  Textarea,
  cn,
} from "@demli/ui";
import { FormErrorAlert, formatTimeoutUntil } from "@demli/app-ui";
import { TIMEOUT_PRESET_MINUTES } from "@demli/client-core";
import {
  BAN_REASON_MAX_LENGTH,
  MEMBER_NICKNAME_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
  USER_NOTE_MAX_LENGTH,
} from "@demli/config";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import {
  useBanMember,
  useKickMember,
  useSetMemberNickname,
  useTimeoutMember,
} from "../queries/chat-queries";
import {
  useSetPrivateNickname,
  useSetUserNote,
  useUnfriend,
  useUserNote,
} from "../queries/social-queries";
import { useUiStore, type MemberDialog } from "../stores/ui-store";

type T = ReturnType<typeof useAppTranslation>["t"];

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
  // The LAST dialog stays rendered (closed) after the slot clears, so Radix can
  // play the card's pop-out and the scrim's fade instead of the dialog
  // vanishing mid-frame. A new target remounts through the key below.
  const [shown, setShown] = useState<MemberDialog | null>(dialog);
  useEffect(() => {
    if (dialog) setShown(dialog);
  }, [dialog]);
  const current = dialog ?? shown;
  // Keyed remount per target+kind so a dialog never opens seeded with the
  // PREVIOUS user's note or nickname still in its input.
  const key = current ? `${current.kind}:${current.userId}` : "none";
  return (
    <DialogOpenContext.Provider value={dialog !== null}>
      <MemberDialogBody key={key} dialog={current} />
    </DialogOpenContext.Provider>
  );
}

/** Whether the member dialog slot is open (false while the last one animates out). */
const DialogOpenContext = createContext(true);

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
    case "timeout":
      return <TimeoutDialog dialog={dialog} />;
    default:
      return <></>;
  }
}

/**
 * The shared chrome of every user / moderation confirmation (also used by
 * {@link BlockUserDialog}): title, description, an optional list of exactly
 * what will happen, the form body, and the action row bottom-right — Cancel
 * first, the action last.
 *
 * DANGER is legible before a word is read, and never by colour alone (the
 * design system's danger pink is chosen to stay apart from coral and from the
 * online green, so it is placed and marked rather than shouted): a pink-washed
 * icon disc beside the title, a pink bullet per consequence, and the danger
 * button. Focus opens on the FIRST control of the body — Cancel, in a pure
 * confirmation — so a stray Enter can never fire a kick or a ban.
 */
export function ConfirmDialogShell({
  open = true,
  title,
  description,
  error,
  busy,
  submitLabel,
  submitVariant = "primary",
  tone = "default",
  icon,
  consequences,
  onSubmit,
  onClose,
  children,
  footer,
}: {
  /** False while the dialog animates out (the caller keeps it mounted). */
  open?: boolean;
  title: string;
  description: string;
  error: unknown;
  busy: boolean;
  submitLabel: string;
  submitVariant?: "primary" | "danger" | "accent";
  /** `danger` adds the pink icon disc and bullets. */
  tone?: "default" | "danger";
  icon?: ReactNode;
  /** One line per concrete effect of the action, in plain words. */
  consequences?: string[];
  onSubmit: () => void;
  onClose: () => void;
  children?: ReactNode;
  /** Extra control below the action row (e.g. "Remove nickname"). */
  footer?: ReactNode;
}): JSX.Element {
  const { t } = useAppTranslation();
  const danger = tone === "danger";
  const close = (): void => {
    if (!busy) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent closeLabel={t("buttons.close")}>
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
          <DialogHeader className={cn(icon && "flex-row items-start gap-3")}>
            {icon && (
              <span
                aria-hidden
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-full [&_svg]:size-5",
                  danger ? "bg-danger-surface text-danger" : "bg-raised text-fg-muted",
                )}
              >
                {icon}
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle className="break-words">{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {error != null && <FormErrorAlert>{localizeError(error, t)}</FormErrorAlert>}
            {consequences && consequences.length > 0 && (
              <ul className="space-y-2 rounded-xl bg-surface p-3.5">
                {consequences.map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-label text-fg">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-[7px] size-1.5 shrink-0 rounded-full",
                        danger ? "bg-danger" : "bg-fg-subtle",
                      )}
                    />
                    {line}
                  </li>
                ))}
              </ul>
            )}
            {children}
          </DialogBody>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            {footer && <div className="mr-auto">{footer}</div>}
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              {t("buttons.cancel")}
            </Button>
            <Button type="submit" variant={submitVariant} loading={busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The member-dialog flavour of the shell: closing clears the ui-store slot. */
function MemberDialogShell(
  props: Omit<Parameters<typeof ConfirmDialogShell>[0], "onClose">,
): JSX.Element {
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const open = useContext(DialogOpenContext);
  return <ConfirmDialogShell {...props} open={open} onClose={() => setMemberDialog(null)} />;
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
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={onRemove}
      className="text-danger hover:bg-danger/12 hover:text-danger"
    >
      {label}
    </Button>
  );
}

/** Live "n / max" help line under a field, turning danger once the cap is hit. */
function charCount(value: string, max: number): ReactNode {
  return (
    <span className={cn("tabular-nums", value.length >= max && "text-danger")}>
      {value.length} / {max}
    </span>
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
      <Field
        hideLabel
        label={t("desktop:userMenu.noteTitle", { name: dialog.displayName })}
        help={charCount(body, USER_NOTE_MAX_LENGTH)}
      >
        <Textarea
          autoFocus
          rows={4}
          value={body}
          maxLength={USER_NOTE_MAX_LENGTH}
          placeholder={t("desktop:userMenu.notePlaceholder")}
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>
      <p className="text-label text-fg-faint">{t("desktop:userMenu.notePrivacy")}</p>
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
      <Field
        hideLabel
        label={t("desktop:userMenu.friendNicknameTitle", { name: dialog.realName })}
        help={charCount(value, USER_NICKNAME_MAX_LENGTH)}
      >
        <Input
          autoFocus
          value={value}
          maxLength={USER_NICKNAME_MAX_LENGTH}
          placeholder={dialog.realName}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <p className="text-label text-fg-faint">{t("desktop:userMenu.friendNicknamePrivacy")}</p>
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
      <Field
        hideLabel
        label={t("desktop:userMenu.serverNicknameTitle", { name: dialog.realName })}
        help={charCount(value, MEMBER_NICKNAME_MAX_LENGTH)}
      >
        <Input
          autoFocus
          value={value}
          maxLength={MEMBER_NICKNAME_MAX_LENGTH}
          placeholder={dialog.realName}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <p className="text-label text-fg-faint">{t("desktop:userMenu.serverNicknamePrivacy")}</p>
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
      tone="danger"
      icon={<UserMinus />}
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
      tone="danger"
      icon={<LogOut />}
      title={t("desktop:userMenu.kickTitle", { name: dialog.displayName })}
      description={t("desktop:userMenu.kickDescription", { name: dialog.displayName })}
      consequences={[
        t("desktop:userMenu.kickConsequence1"),
        t("desktop:userMenu.kickConsequence2"),
        t("desktop:userMenu.kickConsequence3"),
      ]}
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
      tone="danger"
      icon={<Ban />}
      title={t("desktop:userMenu.banTitle", { name: dialog.displayName })}
      description={t("desktop:userMenu.banDescription", { name: dialog.displayName })}
      consequences={[
        t("desktop:userMenu.banConsequence1"),
        t("desktop:userMenu.banConsequence2"),
        t("desktop:userMenu.banConsequence3"),
      ]}
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
      <Field
        label={t("desktop:userMenu.banReasonLabel")}
        help={charCount(reason, BAN_REASON_MAX_LENGTH)}
      >
        <Input
          value={reason}
          maxLength={BAN_REASON_MAX_LENGTH}
          placeholder={t("desktop:userMenu.banReasonPlaceholder")}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </MemberDialogShell>
  );
}

/** "60 seconds" / "5 minutes" / "1 hour" / "1 day" / "1 week", localized. */
export function formatTimeoutDuration(minutes: number, t: T): string {
  if (minutes < 60) return t("desktop:userMenu.durationMinutes", { count: minutes });
  if (minutes < 1440) return t("desktop:userMenu.durationHours", { count: minutes / 60 });
  if (minutes < 10080) return t("desktop:userMenu.durationDays", { count: minutes / 1440 });
  return t("desktop:userMenu.durationWeeks", { count: minutes / 10080 });
}

/**
 * Timeout (ADR 0019 §3): silence someone for a chosen duration. The duration
 * is picked HERE, with what a timeout cuts spelled out and the exact end time
 * shown for the choice — not fired from a submenu row with no confirmation,
 * which is how a "1 week" lands when "1 minute" was meant. The reason is
 * optional and, like a ban's, only ever read in the moderation log.
 */
function TimeoutDialog({
  dialog,
}: {
  dialog: Extract<MemberDialog, { kind: "timeout" }>;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const setMemberDialog = useUiStore((s) => s.setMemberDialog);
  const timeout = useTimeoutMember(dialog.groupId);
  const [minutes, setMinutes] = useState<number>(TIMEOUT_PRESET_MINUTES[1] ?? 5);
  const [reason, setReason] = useState("");
  // Recomputed on each choice (not on a timer): the line answers "if I press
  // now, when does it end?", and the press is what starts the clock.
  const endsAt = useMemo(
    () => formatTimeoutUntil(new Date(Date.now() + minutes * 60_000).toISOString(), i18n.language),
    [minutes, i18n.language],
  );

  return (
    <MemberDialogShell
      tone="danger"
      icon={<Clock />}
      title={t("desktop:userMenu.timeoutTitle", { name: dialog.displayName })}
      description={t("desktop:userMenu.timeoutDescription", { name: dialog.displayName })}
      error={timeout.error}
      busy={timeout.isPending}
      submitLabel={t("desktop:userMenu.timeoutConfirm")}
      submitVariant="danger"
      onSubmit={() =>
        void timeout.mutate(
          { userId: dialog.userId, minutes, reason: reason.trim() || undefined },
          { onSuccess: () => setMemberDialog(null) },
        )
      }
    >
      <fieldset className="space-y-2">
        <legend className="pb-2 text-label font-medium text-fg-muted">
          {t("desktop:userMenu.timeoutDuration")}
        </legend>
        <RadioGroup
          value={String(minutes)}
          onValueChange={(value) => setMinutes(Number(value))}
          aria-label={t("desktop:userMenu.timeoutDuration")}
          className="grid grid-cols-2 gap-1"
        >
          {TIMEOUT_PRESET_MINUTES.map((preset) => (
            <RadioItem key={preset} value={String(preset)} label={formatTimeoutDuration(preset, t)} />
          ))}
        </RadioGroup>
        <p className="text-label text-fg-faint" aria-live="polite">
          {t("desktop:userMenu.timeoutEnds", { date: endsAt })}
        </p>
      </fieldset>
      <Field
        label={t("desktop:userMenu.banReasonLabel")}
        help={charCount(reason, BAN_REASON_MAX_LENGTH)}
      >
        <Textarea
          rows={2}
          value={reason}
          maxLength={BAN_REASON_MAX_LENGTH}
          placeholder={t("desktop:userMenu.banReasonPlaceholder")}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
    </MemberDialogShell>
  );
}
