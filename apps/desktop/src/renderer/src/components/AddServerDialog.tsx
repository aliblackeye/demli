import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ArrowLeft, Check, ChevronRight, Sparkles, Ticket } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  cn,
} from "@demli/ui";
import { FormErrorAlert, springs, transitions } from "@demli/app-ui";
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { ApiClientError } from "../lib/api-client";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { INVITE_LINK_PREFIX, parseInviteCode } from "../lib/invite-link";
import { useCreateGroup, useRedeemInvite } from "../queries/chat-queries";
import { useUiStore } from "../stores/ui-store";
import { HelpWithCount } from "./settings-kit";

/**
 * "Add a server" — the rail's `+` entry point, as one dialog with three steps
 * (chooser → create → join, with a real Back).
 *
 *   choose  What do you want to do — make one, or use an invite you were sent.
 *   create  Name it. (Replaces the old CreateGroupDialog "Create" tab.)
 *   join    Paste an invite link/code. (Replaces its "Join" tab.)
 *
 * ── WHY NO SERVER TEMPLATES ─────────────────────────────────────────────────
 * Deliberately omitted. A template would have to provision a CHANNEL SET (and
 * the category layout) for the theme you pick; our create-server API takes `{ name }`
 * and nothing else, so anything we shipped under the word "template" would be,
 * at best, a name pre-fill — a control that looks like it does the work and then
 * doesn't. That is exactly the dead-affordance CLAUDE.md §35 forbids, and it
 * teaches the wrong expectation before the real feature exists. When the backend
 * grows template provisioning, the chooser's row list is where the options slot
 * in with no restructuring.
 *
 * The step lives in the ui-store (not local state) so any entry point can land
 * on the right one — the command menu opens `create`/`join` directly.
 */

/** Error KEY in state, localized at render (follows live locale switches). */
type FormError =
  | CommonErrorKey
  | "desktop:addServer.nameRequired"
  | "desktop:addServer.codeRequired"
  | "desktop:addServer.invalidCode"
  | "desktop:addServer.alreadyMember";

/**
 * Join-specific error mapping. The shared `errorKey` is right for most codes
 * (INVITE_EXPIRED / INVITE_EXHAUSTED / GROUP_BANNED already have friendly copy),
 * but two land on unhelpfully generic strings in this context:
 *   NOT_FOUND → "not found"  → the code was mistyped/revoked, say so.
 *   CONFLICT  → "generic"    → you are already in this server, say THAT.
 */
function joinErrorKey(err: unknown): FormError {
  if (err instanceof ApiClientError) {
    if (err.code === "NOT_FOUND") return "desktop:addServer.invalidCode";
    if (err.code === "CONFLICT") return "desktop:addServer.alreadyMember";
  }
  return errorKey(err);
}

/** A full-width, tappable row action in the chooser step. */
function ChooserRow({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: JSX.Element;
  title: string;
  hint: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-3.5 rounded-xl bg-surface p-3.5 text-left",
        "transition-colors motion-hover hover:bg-raised active:bg-raised-pressed",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-app",
      )}
    >
      <span
        aria-hidden
        className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-surface text-accent"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-fg">{title}</span>
        <span className="mt-0.5 block truncate text-label text-fg-muted">{hint}</span>
      </span>
      <ChevronRight
        aria-hidden
        className="size-4 shrink-0 text-fg-subtle transition-colors motion-hover group-hover:text-fg"
      />
    </button>
  );
}

/** Step content travels in from the side of its step (forward right, back left). */
const stepMotion = (direction: 1 | -1) => ({
  initial: { opacity: 0, x: 20 * direction },
  animate: { opacity: 1, x: 0, transition: springs.position },
  exit: { opacity: 0, x: -12 * direction, transition: transitions.instant },
});

/** Create/join a server — see the file header for the step model. */
export function AddServerDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.addServerDialogOpen);
  const setOpen = useUiStore((s) => s.setAddServerDialogOpen);
  const step = useUiStore((s) => s.addServerStep);
  const setStep = useUiStore((s) => s.setAddServerStep);

  const prefillCode = useUiStore((s) => s.addServerPrefillCode);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [touched, setTouched] = useState(false);

  const createGroup = useCreateGroup();
  const redeemInvite = useRedeemInvite();
  const busy = createGroup.isPending || redeemInvite.isPending;

  // Clear the form once the dialog is fully closed, so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setName("");
      setCode("");
      setError(null);
      setTouched(false);
    }
  }, [open]);

  // Web `/invite/<kod>` route (openJoinWithCode): copy the one-shot prefill into
  // the input, then clear it so a later manual "join" starts empty.
  useEffect(() => {
    if (open && step === "join" && prefillCode !== null) {
      setCode(prefillCode);
      useUiStore.getState().clearAddServerPrefill();
    }
  }, [open, step, prefillCode]);

  const goTo = (next: "choose" | "create" | "join"): void => {
    setError(null);
    setTouched(false);
    setStep(next);
  };

  const onCreate = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setTouched(true);
      setError("desktop:addServer.nameRequired");
      return;
    }
    setError(null);
    createGroup.mutate(
      { name: trimmed },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => setError(errorKey(err)),
      },
    );
  };

  const onJoin = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const normalized = parseInviteCode(code);
    if (normalized.length < 4) {
      setTouched(true);
      setError("desktop:addServer.codeRequired");
      return;
    }
    setError(null);
    redeemInvite.mutate(normalized, {
      onSuccess: () => setOpen(false),
      onError: (err) => setError(joinErrorKey(err)),
    });
  };

  const title =
    step === "create"
      ? t("desktop:addServer.createTitle")
      : step === "join"
        ? t("desktop:addServer.joinTitle")
        : t("desktop:addServer.chooseTitle");
  const description =
    step === "create"
      ? t("desktop:addServer.createDescription")
      : step === "join"
        ? t("desktop:addServer.joinDescription")
        : t("desktop:addServer.chooseDescription");

  // Field-level errors sit under their field; anything else (network, server)
  // is a form-level band above it.
  const nameError =
    step === "create" && (error === "desktop:addServer.nameRequired" || (touched && name.trim().length === 0))
      ? t("desktop:addServer.nameRequired")
      : undefined;
  const parsedCode = parseInviteCode(code);
  const codeError =
    step === "join" &&
    (error === "desktop:addServer.codeRequired" ||
      error === "desktop:addServer.invalidCode" ||
      (touched && parsedCode.length < 4))
      ? t(error === "desktop:addServer.invalidCode" ? error : "desktop:addServer.codeRequired")
      : undefined;
  const formError =
    error !== null &&
    error !== "desktop:addServer.nameRequired" &&
    error !== "desktop:addServer.codeRequired" &&
    error !== "desktop:addServer.invalidCode"
      ? t(error)
      : null;
  // A pasted LINK resolves to a code: show which one, so the user sees the
  // paste was understood before pressing Join.
  const detectedCode = parsedCode.length >= 4 && parsedCode !== code.trim() ? parsedCode : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent closeLabel={t("buttons.close")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="overflow-x-hidden">
          {formError && <FormErrorAlert className="mb-3">{formError}</FormErrorAlert>}

          <AnimatePresence mode="wait" initial={false}>
            {step === "choose" && (
              <m.div key="choose" {...stepMotion(-1)} className="space-y-3">
                <ChooserRow
                  icon={<Sparkles className="size-5" />}
                  title={t("desktop:addServer.createOwn")}
                  hint={t("desktop:addServer.createOwnHint")}
                  onClick={() => goTo("create")}
                />
                <div className="rounded-xl bg-surface/60 p-4 text-center">
                  <p className="font-display text-base font-medium text-fg-display">
                    {t("desktop:addServer.haveInvite")}
                  </p>
                  <Button variant="secondary" className="mt-3 w-full" onClick={() => goTo("join")}>
                    <Ticket className="size-4" />
                    {t("desktop:addServer.joinCta")}
                  </Button>
                </div>
              </m.div>
            )}

            {step === "create" && (
              <m.form key="create" {...stepMotion(1)} onSubmit={onCreate} noValidate className="space-y-5">
                <Field
                  label={t("desktop:addServer.nameLabel")}
                  error={nameError}
                  help={<HelpWithCount value={name} max={GROUP_NAME_MAX_LENGTH} />}
                >
                  <Input
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      if (error === "desktop:addServer.nameRequired") setError(null);
                    }}
                    onBlur={() => setTouched(true)}
                    maxLength={GROUP_NAME_MAX_LENGTH}
                    autoFocus
                    placeholder={t("desktop:addServer.namePlaceholder")}
                  />
                </Field>
                <div className="flex justify-between gap-2">
                  <Button type="button" variant="ghost" onClick={() => goTo("choose")}>
                    <ArrowLeft className="size-4" />
                    {t("desktop:addServer.back")}
                  </Button>
                  <Button type="submit" variant="accent" loading={busy}>
                    {t("desktop:addServer.submitCreate")}
                  </Button>
                </div>
              </m.form>
            )}

            {step === "join" && (
              <m.form key="join" {...stepMotion(1)} onSubmit={onJoin} noValidate className="space-y-4">
                <Field
                  label={t("desktop:addServer.codeLabel")}
                  error={codeError}
                  help={
                    detectedCode ? (
                      <span className="inline-flex items-center gap-1.5 text-success">
                        <Check aria-hidden className="size-3.5" />
                        {t("desktop:settingsUi.codeDetected", { code: detectedCode })}
                      </span>
                    ) : undefined
                  }
                >
                  <Input
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                      if (error !== null) setError(null);
                    }}
                    autoFocus
                    spellCheck={false}
                    placeholder={t("desktop:addServer.codePlaceholder")}
                    className="font-mono"
                  />
                </Field>

                {/* The formats we ADVERTISE: the branded https link + the bare
                    code. The other accepted shapes (demli://join/…, /kat/…) still
                    parse (lib/invite-link.ts) but are never shown. */}
                <div className="rounded-xl bg-surface p-3.5">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                    {t("desktop:addServer.formatsTitle")}
                  </p>
                  <ul className="mt-2 space-y-1 font-mono text-label text-fg-muted">
                    <li className="truncate">{`${INVITE_LINK_PREFIX}hJ3kPq7t`}</li>
                    <li className="truncate">hJ3kPq7t</li>
                  </ul>
                </div>

                <div className="flex justify-between gap-2 pt-1">
                  <Button type="button" variant="ghost" onClick={() => goTo("choose")}>
                    <ArrowLeft className="size-4" />
                    {t("desktop:addServer.back")}
                  </Button>
                  <Button type="submit" variant="accent" loading={busy}>
                    {t("desktop:addServer.submitJoin")}
                  </Button>
                </div>
              </m.form>
            )}
          </AnimatePresence>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
