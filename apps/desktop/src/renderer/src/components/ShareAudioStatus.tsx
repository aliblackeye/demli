/**
 * The local screen share's SOUND, told the same way on every call surface:
 * VoicePanel (server voice channels and group calls) and CallDock (DM calls).
 * One component so the three call types can never disagree about whether the
 * people watching hear anything (§35), plus the voice-error line the DM dock
 * used to lack entirely.
 */

import { AlertTriangle, Loader2, Volume2, VolumeX } from "lucide-react";
import { cn } from "@demli/ui";
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
      alert: { titleKey: null, bodyKey: "desktop:shareAudio.failedHint", tone: "warn" },
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
          }
        : { titleKey: null, bodyKey: `desktop:shareAudio.notice.${state.notice}`, tone: "muted" }
      : null,
  };
}

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-online",
  muted: "text-fg-muted",
  warn: "text-idle",
};

/** Presentational half — renders a {@link ShareAudioView}. */
export function ShareAudioStatusView({
  view,
  className,
}: {
  view: ShareAudioView;
  className?: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  const Icon = view.icon === "live" ? Volume2 : view.icon === "waiting" ? Loader2 : VolumeX;
  return (
    <div
      data-testid="share-audio-status"
      className={cn("rounded-md border border-online/25 bg-online/10 px-2 py-1.5", className)}
    >
      <p className={cn("flex items-center gap-1.5 text-2xs", TONE_TEXT[view.statusTone])}>
        <Icon className={cn("size-3.5 shrink-0", view.icon === "waiting" && "animate-spin")} />
        {t(view.statusKey)}
      </p>
      {view.sourceKey && <p className="mt-1 text-badge text-fg-faint">{t(view.sourceKey)}</p>}
      {view.alert && (
        <div
          role={view.alert.tone === "warn" ? "alert" : "status"}
          className={cn(
            "mt-1.5 rounded-md border px-2 py-1.5",
            view.alert.tone === "warn" ? "border-idle/40 bg-idle/10" : "border-stroke bg-surface",
          )}
        >
          {view.alert.titleKey && (
            <p className="flex items-start gap-1.5 text-2xs font-semibold text-idle">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              {t(view.alert.titleKey)}
            </p>
          )}
          <p className={cn("text-2xs leading-snug text-fg-muted", view.alert.titleKey && "mt-1")}>
            {t(view.alert.bodyKey)}
          </p>
        </div>
      )}
    </div>
  );
}

/** The live share's sound status. Renders nothing while not sharing. */
export function ShareAudioStatus({ className }: { className?: string }): JSX.Element | null {
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const shareAudio = useVoiceStore((s) => s.screenShareAudio);
  if (!screenShareEnabled) return null;
  return <ShareAudioStatusView view={shareAudioView(shareAudio)} className={className} />;
}

/** The current voice/media error, localized (§26). Renders nothing without one. */
export function VoiceErrorNotice({ className }: { className?: string }): JSX.Element | null {
  const { t } = useAppTranslation();
  const voiceError = useVoiceStore((s) => s.error);
  if (!voiceError) return null;
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-2xs leading-snug text-danger",
        className,
      )}
    >
      {localizeVoiceError(voiceError, t)}
    </p>
  );
}
