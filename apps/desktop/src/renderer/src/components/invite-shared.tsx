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
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Input } from "@demli/ui";
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
 * there is no state in which the user can see the link but not take it.
 */
export function CopyField({ label, value }: { label: string; value: string }): JSX.Element {
  const { t } = useAppTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPY_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    navigator.clipboard
      .writeText(value)
      .then(() => setCopied(true))
      .catch(() => {
        // Clipboard can be unavailable — the value stays selectable in the field.
      });
  };

  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(event) => event.target.select()}
        className="select-text font-mono text-[13px]"
      />
      <Button onClick={copy} variant="secondary" className="w-24 shrink-0" aria-live="polite">
        {copied ? (
          <>
            <Check className="size-4" /> {t("desktop:invite.copied")}
          </>
        ) : (
          <>
            <Copy className="size-4" /> {t("buttons.copy")}
          </>
        )}
      </Button>
    </div>
  );
}
