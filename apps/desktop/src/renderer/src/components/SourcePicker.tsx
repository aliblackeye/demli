/**
 * Screen-share source picker — our own in-app grid of capturable screens and
 * windows (Radix Dialog + @demli/ui). Enumerates via the desktop capture
 * bridge (`lib/screen-share.listScreenSources`) and, on pick, hands the source
 * id PLUS the share options (quality preset + system-audio toggle, M8) to the
 * caller which starts the share. The bridge id === the engine source id, so no
 * translation is needed (see .claude/reports/b-desktop-capture.md).
 *
 * Both choices persist in localStorage (lib/screen-share prefs) so the next
 * film night starts with the same settings. System audio defaults ON; on
 * platforms without loopback capture the toggle is disabled with an explainer.
 */

import { useEffect, useState } from "react";
import { AppWindow, Loader2, Monitor, Volume2, VolumeX } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import {
  SCREEN_SHARE_FRAME_RATES,
  SCREEN_SHARE_QUALITY_PROFILES,
  SCREEN_SHARE_RESOLUTIONS,
  screenShareFrameRateOf,
  screenShareQualityId,
  screenShareResolutionOf,
  type ScreenShareFrameRate,
  type ScreenShareResolution,
} from "@demli/media";
import {
  isLoopbackAudioSupported,
  isScreenCaptureAvailable,
  isWebDisplayAudioCapable,
  isWebPlatform,
  listScreenSources,
  loadScreenSharePrefs,
  saveScreenSharePrefs,
  type CaptureSource,
  type ScreenShareStartOptions,
} from "../lib/screen-share";
import { useAppTranslation } from "../lib/i18n";
import { useMediaSettings } from "../stores/media-settings";
import { Toggle } from "./Toggle";

export interface SourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen source id + share options when the user picks a source. */
  onSelect: (sourceId: string, options: ScreenShareStartOptions) => void;
}

type LoadState =
  | { kind: "loading" }
  /** `error` is a catalog key so an open picker follows live locale switches. */
  | { kind: "error"; error: "errorUnavailable" | "errorList" }
  | { kind: "ready"; sources: CaptureSource[] };

/** Display label per resolution tier (1440p is marketed as 2K). */
const RESOLUTION_LABEL = {
  "480p": "480p",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "2K",
} as const satisfies Record<ScreenShareResolution, string>;

/**
 * How often the open picker re-enumerates sources so a closed window drops out
 * (and a newly-opened one appears). Kept snappy — the founder still saw stale
 * entries at 3s, and the dialog is only open briefly, so the cost is bounded (§27).
 */
const SOURCE_REFRESH_MS = 1_500;

/** "1080p · 30 fps · ~4.5 Mbps" — derived from the shared profile table. */
function qualityDetail(
  resolution: ScreenShareResolution,
  frameRate: ScreenShareFrameRate,
): string {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[screenShareQualityId(resolution, frameRate)];
  const mbps = profile.maxBitrateBps / 1_000_000;
  return `${profile.height}p · ${profile.frameRate} fps · ~${mbps} Mbps`;
}

function SourceCard({
  source,
  onSelect,
}: {
  source: CaptureSource;
  onSelect: (sourceId: string) => void;
}): JSX.Element {
  const Icon = source.kind === "screen" ? Monitor : AppWindow;
  return (
    <button
      type="button"
      onClick={() => onSelect(source.id)}
      className={cn(
        "group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-stroke bg-raised text-left",
        "transition-colors motion-instant hover:border-accent/60 hover:bg-accent/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
      )}
    >
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden bg-surface">
        {source.thumbnailDataUrl ? (
          <img
            src={source.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-contain"
            draggable={false}
          />
        ) : (
          <Icon className="size-6 text-fg-faint" />
        )}
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Icon className="size-3.5 shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-muted group-hover:text-fg">
          {source.name}
        </span>
      </div>
    </button>
  );
}

export function SourcePicker({ open, onOpenChange, onSelect }: SourcePickerProps): JSX.Element {
  const { t } = useAppTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [prefs, setPrefs] = useState<ScreenShareStartOptions>(loadScreenSharePrefs);
  // Screen-share (yayın) quality is UNIFIED with the settings screen: it lives in
  // the persisted media-settings store, so a change here or there agrees. Only
  // the system-audio toggle stays in the picker's own localStorage prefs.
  const screenQuality = useMediaSettings((s) => s.video.screenShareQuality);
  const setScreenShareQuality = useMediaSettings((s) => s.setScreenShareQuality);
  // Platform capabilities — stable for the app's lifetime. Desktop captures film
  // audio natively (Windows loopback/process ladder); the WEB build instead rides
  // the browser's own display audio, which only Chromium offers (the "share
  // audio" checkbox in its picker) — Firefox/Safari never deliver stream sound.
  const loopbackSupported = isLoopbackAudioSupported();
  const webDisplayAudio = isWebDisplayAudioCapable();
  const audioSupported = loopbackSupported || webDisplayAudio;
  const audioOn = prefs.systemAudio && audioSupported;

  useEffect(() => {
    if (!open) return;
    let active = true;
    // Re-read prefs on open so a stale mounted picker can't shadow storage.
    setPrefs(loadScreenSharePrefs());

    if (!isScreenCaptureAvailable()) {
      setState({ kind: "error", error: "errorUnavailable" });
      return;
    }

    // desktopCapturer is never cached (main re-enumerates on every call), so each
    // refresh is a TRUE re-enumeration. `showLoading` only for the initial open so
    // a background refresh updates the grid in place without a loading flash — and
    // a failed background refresh keeps the last good list rather than erroring out.
    const refresh = (showLoading: boolean): void => {
      if (showLoading) setState({ kind: "loading" });
      listScreenSources()
        .then((sources) => {
          if (active) setState({ kind: "ready", sources });
        })
        .catch(() => {
          if (active && showLoading) setState({ kind: "error", error: "errorList" });
        });
    };

    refresh(true); // fresh, cache-free enumeration on every open

    // Keep the list LIVE while open so a window/app closed AFTER opening drops out
    // fast (and a newly-opened one appears): re-enumerate on a short interval, plus
    // immediately whenever Demli regains focus OR the document becomes visible
    // again — the user just closed/opened an app and tabbed back. Every one of these
    // is a TRUE re-enumeration with fresh thumbnails (main never caches). This
    // deepens the founder's "a closed app still shows in the picker" fix.
    const onRefresh = (): void => refresh(false);
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    const interval = window.setInterval(onRefresh, SOURCE_REFRESH_MS);

    return () => {
      active = false;
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
      window.clearInterval(interval);
    };
  }, [open]);

  // System-audio toggle persistence (keeps localStorage coherent with the unified
  // media-settings quality so an old startShare fallback still reads a sane pair).
  const updateSystemAudio = (next: boolean): void => {
    setPrefs((prev) => ({ ...prev, systemAudio: next }));
    saveScreenSharePrefs({ quality: screenQuality, systemAudio: next });
  };

  // The current selection decomposed onto the two axes (resolution + frame-rate).
  const resolution = screenShareResolutionOf(screenQuality);
  const frameRate = screenShareFrameRateOf(screenQuality);

  const applyQuality = (
    nextResolution: ScreenShareResolution,
    nextFrameRate: ScreenShareFrameRate,
  ): void => {
    const quality = screenShareQualityId(nextResolution, nextFrameRate);
    setScreenShareQuality(quality);
    saveScreenSharePrefs({ quality, systemAudio: prefs.systemAudio });
  };
  const onSelectResolution = (next: ScreenShareResolution): void =>
    applyQuality(next, frameRate);
  const onSelectFrameRate = (next: ScreenShareFrameRate): void =>
    applyQuality(resolution, next);

  const handleSelect = (sourceId: string): void => {
    onSelect(sourceId, {
      quality: screenQuality,
      // Never request audio on platforms with no film-audio route at all
      // (non-Windows desktop, non-Chromium web browsers).
      systemAudio: audioOn,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("desktop:voice.shareScreen")}</DialogTitle>
          <DialogDescription>{t("desktop:sourcePicker.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {/* System audio is the film-night make-or-break setting, so it leads and
              stands out: an accent-lit card when ON (the default), with a "Movie
              night" badge and copy spelling out that viewers hear nothing if it's
              off. (task #69 / #27) */}
          <div
            className={cn(
              "mb-2.5 rounded-lg border p-2.5 transition-colors motion-instant",
              audioOn ? "border-accent/50 bg-accent/10" : "border-stroke bg-surface",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                {audioOn ? (
                  <Volume2 className="size-5 shrink-0 text-accent" />
                ) : (
                  <VolumeX className="size-5 shrink-0 text-fg-faint" />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs font-semibold text-fg">
                      {t("desktop:sourcePicker.systemAudio")}
                    </p>
                    {audioSupported && (
                      <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-badge font-semibold uppercase tracking-wide text-accent">
                        {t("desktop:sourcePicker.systemAudioRecommended")}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-2xs leading-snug text-fg-muted">
                    {!audioSupported
                      ? isWebPlatform()
                        ? t("desktop:sourcePicker.systemAudioWebUnsupported")
                        : t("desktop:sourcePicker.systemAudioUnavailable")
                      : audioOn
                        ? webDisplayAudio
                          ? t("desktop:sourcePicker.systemAudioWebOn")
                          : t("desktop:sourcePicker.systemAudioOn")
                        : t("desktop:sourcePicker.systemAudioOff")}
                  </p>
                </div>
              </div>
              <Toggle
                checked={audioOn}
                disabled={!audioSupported}
                onChange={updateSystemAudio}
                label={t("desktop:sourcePicker.systemAudio")}
              />
            </div>
          </div>

          <div className="mb-3 rounded-lg border border-stroke bg-surface p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium text-fg">{t("desktop:sourcePicker.quality")}</p>
              {/* Live summary of the composed cell (resolution · fps · bitrate cap). */}
              <p className="truncate text-2xs text-fg-faint">
                {qualityDetail(resolution, frameRate)}
              </p>
            </div>

            {/* Resolution axis */}
            <p className="mt-2 px-0.5 text-badge font-semibold uppercase tracking-wide text-fg-faint">
              {t("desktop:sourcePicker.resolution")}
            </p>
            <div
              role="radiogroup"
              aria-label={t("desktop:sourcePicker.resolution")}
              className="mt-1 grid grid-cols-4 gap-1"
            >
              {SCREEN_SHARE_RESOLUTIONS.map((option) => {
                const selected = resolution === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onSelectResolution(option)}
                    className={cn(
                      "cursor-pointer rounded-md border px-2 py-1.5 text-center text-xs font-medium transition-colors motion-instant",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                      selected
                        ? "border-accent/60 bg-accent/10 text-fg"
                        : "border-stroke bg-raised text-fg-muted hover:bg-overlay",
                    )}
                  >
                    {RESOLUTION_LABEL[option]}
                  </button>
                );
              })}
            </div>

            {/* Frame-rate axis */}
            <p className="mt-2 px-0.5 text-badge font-semibold uppercase tracking-wide text-fg-faint">
              {t("desktop:sourcePicker.frameRate")}
            </p>
            <div
              role="radiogroup"
              aria-label={t("desktop:sourcePicker.frameRate")}
              className="mt-1 grid grid-cols-3 gap-1"
            >
              {SCREEN_SHARE_FRAME_RATES.map((option) => {
                const selected = frameRate === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onSelectFrameRate(option)}
                    className={cn(
                      "cursor-pointer rounded-md border px-2 py-1.5 text-center text-xs font-medium transition-colors motion-instant",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                      selected
                        ? "border-accent/60 bg-accent/10 text-fg"
                        : "border-stroke bg-raised text-fg-muted hover:bg-overlay",
                    )}
                  >
                    {option} fps
                  </button>
                );
              })}
            </div>
          </div>

          {state.kind === "loading" && (
            <div className="flex h-40 items-center justify-center text-fg-muted">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}

          {state.kind === "error" && (
            <FormErrorAlert className="text-sm">
              {t(`desktop:sourcePicker.${state.error}`)}
            </FormErrorAlert>
          )}

          {state.kind === "ready" && state.sources.length === 0 && (
            <p className="py-8 text-center text-sm text-fg-muted">
              {t("desktop:sourcePicker.empty")}
            </p>
          )}

          {state.kind === "ready" && state.sources.length > 0 && (
            <div className="space-y-3">
              {(() => {
                const screens = state.sources.filter((s) => s.kind === "screen");
                const windows = state.sources.filter((s) => s.kind !== "screen");
                return (
                  <>
                    {screens.length > 0 && (
                      <div>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <p className="text-2xs font-semibold uppercase tracking-wide text-fg-faint">
                            {t("desktop:sourcePicker.screensHeading")}
                          </p>
                          <p className="truncate text-2xs text-fg-faint">
                            {t("desktop:sourcePicker.screensHint")}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3">
                          {screens.map((source) => (
                            <SourceCard key={source.id} source={source} onSelect={handleSelect} />
                          ))}
                        </div>
                      </div>
                    )}
                    {windows.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-faint">
                          {t("desktop:sourcePicker.windowsHeading")}
                        </p>
                        <div className="grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3">
                          {windows.map((source) => (
                            <SourceCard key={source.id} source={source} onSelect={handleSelect} />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
