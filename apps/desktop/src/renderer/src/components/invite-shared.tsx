/**
 * The pieces every invite dialog needs, in one place.
 *
 * Three dialogs now hand out invite links — the server one, the flat group-chat
 * one (M18) and the channel one — and all three want the same read-only field
 * with a copy button and the same "expires in 7 days · 25 uses left" line. The
 * first two grew independent, byte-identical copies of both; a third copy is how
 * one of them starts saying "-3 hours" after a change lands in only two.
 *
 * The arithmetic itself is NOT here: it lives in `@demli/client-core`
 * (`inviteUsage`), because mobile needs the same numbers and cannot import a
 * react-dom module. This file is only the desktop/web presentation of it.
 */
import { useEffect, useRef, useState } from "react";
import { m } from "framer-motion";
import { Check, Clock, Copy } from "lucide-react";
import { Button, Input, Skeleton, cn } from "@demli/ui";
import { springs } from "@demli/app-ui";
import { inviteUsage, prefersDaysWording } from "@demli/client-core";
import type { Invite } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";

const COPY_RESET_MS = 1_600;

/** The default limits every dialog mints an invite with: one week, 25 uses. */
export const INVITE_EXPIRES_HOURS = 24 * 7;
export const INVITE_MAX_USES = 25;

/** Human summary of an invite's limits, from the real server-issued values. */
export function inviteLimits(invite: Invite, t: AppTFunction): string {
  const usage = inviteUsage(invite);
  const parts: string[] = [];

  if (usage.hoursLeft === null) {
    parts.push(t("desktop:invite.neverExpires"));
  } else if (prefersDaysWording(usage)) {
    parts.push(t("desktop:invite.expiresDays", { count: usage.daysLeft ?? 0 }));
  } else {
    parts.push(t("desktop:invite.expiresHours", { count: usage.hoursLeft }));
  }

  if (usage.maxUses === null) {
    parts.push(t("desktop:invite.unlimitedUses"));
  } else {
    parts.push(t("desktop:invite.usesLeft", { left: usage.usesLeft ?? 0, max: usage.maxUses }));
  }

  return parts.join(" · ");
}

/**
 * A read-only value with its own copy button (link or code).
 *
 * The value stays selectable and focus selects it whole, so a failed clipboard
 * write (unavailable in some browser contexts) still leaves a usable path —
 * there is no state in which the user can see the link but not take it. A
 * failure is SAID (and the value is pre-selected for a manual copy), a success
 * is shown on the button, washed over the field and announced to assistive tech.
 */
export function CopyField({
  label,
  value,
  inputClassName,
}: {
  label: string;
  value: string;
  /** Tone override when the field sits inside a surface card. */
  inputClassName?: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setState("idle"), COPY_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = (): void => {
    const write = navigator.clipboard?.writeText(value) ?? Promise.reject(new Error("no clipboard"));
    write
      .then(() => setState("copied"))
      .catch(() => {
        // Clipboard unavailable: say so, and hand the user the value selected.
        setState("failed");
        inputRef.current?.focus();
        inputRef.current?.select();
      });
  };

  const copied = state === "copied";

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.target.select()}
          className={cn(
            "select-text font-mono text-label transition-[background-color,box-shadow] motion-fast",
            inputClassName,
            copied && "bg-accent-surface shadow-[inset_0_0_0_1px_rgb(255_132_100/0.35)]",
          )}
        />
        <Button
          onClick={copy}
          variant={copied ? "accent" : "secondary"}
          className="w-28 shrink-0"
          aria-label={`${t("buttons.copy")}: ${label}`}
        >
          {copied ? (
            <m.span
              key="copied"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1, transition: springs.position }}
              className="inline-flex items-center gap-2"
            >
              <Check className="size-4" /> {t("desktop:invite.copied")}
            </m.span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <Copy className="size-4" /> {t("buttons.copy")}
            </span>
          )}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("desktop:settingsUi.copiedAnnounce") : ""}
      </span>
      {state === "failed" && (
        <p role="alert" className="text-label text-danger">
          {t("desktop:settingsUi.copyFailed")}
        </p>
      )}
    </div>
  );
}

/** The limits line under a link: expiry + uses, with a clock glyph. */
export function InviteLimits({ invite, className }: { invite: Invite; className?: string }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <p className={cn("flex items-center gap-1.5 text-label text-fg-faint", className)}>
      <Clock aria-hidden className="size-3.5 shrink-0" />
      {inviteLimits(invite, t)}
    </p>
  );
}

/** Placeholder while a fresh link is minted: field-shaped blocks, not a spinner. */
export function InviteSkeleton({ rows = 1, label }: { rows?: number; label: string }): JSX.Element {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2">
          <Skeleton shape="line" height={11} className="w-24" />
          <div className="flex gap-2">
            <Skeleton shape="rect" height={40} className="flex-1 rounded-lg" />
            <Skeleton shape="rect" width={112} height={38} className="rounded-lg" />
          </div>
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
