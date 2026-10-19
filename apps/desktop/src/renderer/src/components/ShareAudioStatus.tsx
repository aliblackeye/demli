/**
 * The local screen share's SOUND, told the same way on every call surface:
 * VoicePanel (server voice channels and group calls) and CallDock (DM calls).
 * One component so the three call types can never disagree about whether the
 * people watching hear anything (§35), plus the voice-error line the DM dock
 * used to lack entirely.
 */

import { AlertCircle, AlertTriangle, Loader2, Volume2, VolumeX } from "lucide-react";
import { Button, cn } from "@demli/ui";
import type { ShareAudioNotice, ShareAudioSource } from "../lib/screen-share";
import { localizeVoiceError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore, type ShareAudioState } from "../stores/voice-store";

type Tone = "ok" | "muted" | "warn";

/** Catalog keys + tone for one share-sound state. Pure, so it is unit-tested. */
export interface ShareAudioView {
  statusKey:
    | "desktop:shareAudio.statusLive"
    | "desktop:shareAudio.statusWaiting"
    | "desktop:shareAudio.statusNone"
    | "desktop:shareAudio.statusFailed";
  statusTone: Tone;
  icon: "live" | "waiting" | "none";
  sourceKey: `desktop:shareAudio.source.${SourceKey}` | null;
  /** A boxed notice: what happened and what the sharer can do. */
  alert: {
    titleKey: "desktop:shareAudio.noSoundTitle" | "desktop:shareAudio.echoRiskTitle" | null;
    bodyKey: `desktop:shareAudio.notice.${ShareAudioNotice}` | "desktop:shareAudio.failedHint";
    tone: Tone;
    /** A one-click way out the sharer can choose; never taken for them. */
    action: "sendSystemSound" | null;
  } | null;
}

type SourceKey = "app" | "system" | "browserTab" | "browserWindow" | "browserSystem";

const SOURCE_KEY: Record<ShareAudioSource, SourceKey> = {
  app: "app",
  system: "system",
  "browser-tab": "browserTab",
  "browser-window": "browserWindow",
  "browser-system": "browserSystem",
};

export function shareAudioView(state: ShareAudioState): ShareAudioView {
  const sourceKey = state.source ? (`desktop:shareAudio.source.${SOURCE_KEY[state.source]}` as const) : null;

  if (state.status === "failed") {
    return {
      statusKey: "desktop:shareAudio.statusFailed",
      statusTone: "warn",
      icon: "none",
      sourceKey,
      alert: { titleKey: null, bodyKey: "desktop:shareAudio.failedHint", tone: "warn", action: null },
    };
  }

  if (!state.source) {
    return {
      statusKey: "desktop:shareAudio.statusNone",
      statusTone: "muted",
      icon: "none",
      sourceKey: null,
      // Sound was asked for and none is going out: say so, and why.
      alert:
        state.requested && state.notice
          ? {
              titleKey: "desktop:shareAudio.noSoundTitle",
              bodyKey: `desktop:shareAudio.notice.${state.notice}`,
              tone: "warn",
              action: state.notice === "app_unavailable" ? "sendSystemSound" : null,
            }
          : null,
    };
  }

  const live = state.status === "live";
  return {
    statusKey: live ? "desktop:shareAudio.statusLive" : "desktop:shareAudio.statusWaiting",
    statusTone: live ? "ok" : "muted",
    icon: live ? "live" : "waiting",
    sourceKey,
    alert: state.notice
      ? state.notice === "web_echo_risk"
        ? {
            titleKey: "desktop:shareAudio.echoRiskTitle",
            bodyKey: "desktop:shareAudio.notice.web_echo_risk",
            tone: "warn",
            action: null,
          }
        : { titleKey: null, bodyKey: `desktop:shareAudio.notice.${state.notice}`, tone: "muted", action: null }
      : null,
  };
}

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-online",
  muted: "text-fg-muted",
  warn: "text-warning",
};

/**
 * The box follows the state it reports. It used to be green in every state —
 * including "viewers hear nothing" — so the colour contradicted the words. Now:
 * live sound sits on a quiet green wash, a waiting / deliberately silent share on
 * the neutral wash, and a share that FAILED or was asked for sound and has none
 * on the amber warning wash. Borderless, like every Koyu Masa notice.
 */
const TONE_BOX: Record<Tone, string> = {
  ok: "bg-success/10",
  muted: "bg-wash",
  warn: "bg-warning/12",
};

/** Presentational half — renders a {@link ShareAudioView}. */
export function ShareAudioStatusView({
  view,
  className,
  onSendSystemSound,
  switching = false,
}: {
  view: ShareAudioView;
  className?: string;
  onSendSystemSound?: () => void;
  switching?: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const Icon = view.icon === "live" ? Volume2 : view.icon === "waiting" ? Loader2 : VolumeX;
  // A warning ALERT below a muted status still paints the box amber: the
  // sharer's eye goes to the box, and the box has to say "something is wrong".
  const boxTone: Tone = view.alert?.tone === "warn" ? "warn" : view.statusTone;
  return (
    <div
      data-testid="share-audio-status"
      data-tone={boxTone}
      className={cn(
        "rounded-lg px-2.5 py-2 transition-colors motion-hover animate-fade-in",
        TONE_BOX[boxTone],
        className,
      )}
    >
      <p className={cn("flex items-center gap-1.5 text-2xs font-medium", TONE_TEXT[view.statusTone])}>
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            view.icon === "waiting" && "animate-spin motion-reduce:animate-none",
          )}
        />
        {t(view.statusKey)}
      </p>
      {view.sourceKey && (
        <p className="mt-1 pl-5 text-badge leading-snug text-fg-faint">{t(view.sourceKey)}</p>
      )}
      {view.alert && (
        <div
          role={view.alert.tone === "warn" ? "alert" : "status"}
          className={cn(
            "mt-2 rounded-md px-2 py-1.5",
            view.alert.tone === "warn" ? "bg-warning/12" : "bg-wash",
          )}
        >
          {view.alert.titleKey && (
            <p className="flex items-start gap-1.5 text-2xs font-semibold text-warning">
              <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" />
              {t(view.alert.titleKey)}
            </p>
          )}
          <p className={cn("text-2xs leading-snug text-fg-muted", view.alert.titleKey && "mt-1")}>
            {t(view.alert.bodyKey)}
          </p>
          {view.alert.action === "sendSystemSound" && onSendSystemSound && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="share-audio-send-system"
              className="mt-2 w-full"
              disabled={switching}
              loading={switching}
              onClick={onSendSystemSound}
            >
              {t("desktop:shareAudio.sendSystemSound")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The live share's sound status. Renders nothing while not sharing. */
export function ShareAudioStatus({ className }: { className?: string }): JSX.Element | null {
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const shareAudio = useVoiceStore((s) => s.screenShareAudio);
  const switching = useVoiceStore((s) => s.shareAudioSwitching);
  const sendSystemShareSound = useVoiceStore((s) => s.sendSystemShareSound);
  if (!screenShareEnabled) return null;
  return (
    <ShareAudioStatusView
      view={shareAudioView(shareAudio)}
      className={className}
      onSendSystemSound={sendSystemShareSound}
      switching={switching}
    />
  );
}

/** The current voice/media error, localized (§26). Renders nothing without one. */
export function VoiceErrorNotice({ className }: { className?: string }): JSX.Element | null {
  const { t } = useAppTranslation();
  const voiceError = useVoiceStore((s) => s.error);
  if (!voiceError) return null;
  return (
    <p
      role="alert"
      data-testid="voice-error"
      // Borderless pink wash (danger-surface) with the glyph, so the error is
      // recognised by shape as well as colour (design doc §1.4).
      className={cn(
        "flex items-start gap-2 rounded-lg bg-danger-surface px-2.5 py-2 text-2xs leading-snug text-danger animate-fade-in",
        className,
      )}
    >
      <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{localizeVoiceError(voiceError, t)}</span>
    </p>
  );
}
