import { CalendarCheck, EyeOff, ShieldAlert } from "lucide-react";
import { Button } from "@demli/ui";
import { nsfwGateStage } from "@demli/client-core";
import type { Channel } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useNsfwGateStore } from "../stores/nsfw-gate-store";
import { BirthdateVerification } from "./BirthdateVerification";

/**
 * The interstitial shown in place of an NSFW channel's content. Which of the
 * three stages renders is decided by the shared, framework-free
 * {@link nsfwGateStage} (client-core), so desktop/web and mobile gate identically:
 *
 * - `verifyAge`    — no date of birth on file. The user verifies RIGHT HERE
 *                    instead of being sent to settings: on success the `me`
 *                    cache updates, `isAdult` flips, and this component
 *                    re-renders straight to the acknowledgement — the channel
 *                    opens with no reload.
 * - `minorBlocked` — a date of birth IS on file and it is under 18. A final,
 *                    honest refusal with NO input and no "try again": the value
 *                    is set-once server-side, so an entry field here would be a
 *                    control that cannot work (§35).
 * - `confirmAdult` — adult, but has not acknowledged this channel yet: the
 *                    one-time "this may contain NSFW content, continue?".
 *
 * The caller (`ChatView`) only mounts this when the channel is NSFW and at least
 * one stage applies, so this component renders the copy + actions and nothing else.
 */
export function NsfwChannelGate({
  channel,
  isAdult,
  birthdateSet,
}: {
  channel: Channel;
  /** True only when `/users/me` reports `isAdult`. False for minors / no birthdate. */
  isAdult: boolean;
  /** Whether the account already has a (set-once) date of birth stored. */
  birthdateSet: boolean;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const confirm = useNsfwGateStore((s) => s.confirm);
  const acknowledged = useNsfwGateStore((s) => s.confirmedByChannel[channel.id] ?? false);

  const stage = nsfwGateStage({ isAdult, birthdateSet, acknowledged });
  if (stage === null) return null;

  const Icon =
    stage === "confirmAdult" ? EyeOff : stage === "verifyAge" ? CalendarCheck : ShieldAlert;
  const title =
    stage === "confirmAdult"
      ? t("desktop:nsfwGate.warnTitle")
      : stage === "verifyAge"
        ? t("desktop:nsfwGate.verifyTitle")
        : t("desktop:nsfwGate.blockTitle");
  const body =
    stage === "confirmAdult"
      ? t("desktop:nsfwGate.warnBody", { channel: channel.name })
      : stage === "verifyAge"
        ? t("desktop:nsfwGate.verifyBody", { channel: channel.name })
        : t("desktop:nsfwGate.blockBody");

  return (
    <div className="flex min-w-0 flex-1 items-center justify-center bg-app p-6">
      <div className="w-full max-w-sm rounded-xl border border-stroke bg-raised/60 p-6 text-center shadow-lg">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-dnd/15 text-dnd">
          <Icon className="size-6" aria-hidden />
        </div>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>

        {stage === "confirmAdult" && (
          <Button className="mt-5 w-full" onClick={() => confirm(channel.id)}>
            {t("desktop:nsfwGate.continue")}
          </Button>
        )}
        {stage === "verifyAge" && <BirthdateVerification className="mt-5" />}
        {/* `minorBlocked` renders no action at all — there is nothing the user
            can do here, and offering a button would promise otherwise. */}
      </div>
    </div>
  );
}
