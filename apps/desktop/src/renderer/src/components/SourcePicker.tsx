/**
 * Screen-share source picker — our own in-app grid of capturable screens and
 * windows (Radix Dialog + @demli/ui). Pick a source, set its SOUND, start.
 *
 * Share sound is an explicit choice with three options on desktop:
 *   - Ses yok — picture only.
 *   - Yalnız bu uygulama — the shared window's app (process include-tree).
 *   - Sistem sesi (Demli hariç) — everything but Demli (process exclude-tree).
 * A window starts on "only this app", a screen on "system sound"; the sharer's
 * last choice is remembered per source kind. Neither option can carry the
 * call's own voices, so nobody in the call hears themselves (M16 H1).
 *
 * On the WEB build the browser owns the real picker and the sound, so the
 * cards are the three display surfaces (tab / entire screen / window) — each
 * opens the browser's picker on that pane — with honest per-surface guidance.
 * The bridge id === the engine source id, so no translation is needed.
 */

import { useEffect, useState } from "react";
import { AppWindow, Globe, Loader2, Monitor } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  getShareAudioCapability,
  isScreenCaptureAvailable,
  isWebDisplayAudioCapable,
  isWebPlatform,
  isWindowSource,
  listScreenSources,
  loadScreenSharePrefs,
  saveScreenSharePrefs,
  webPreferredSurface,
  type CaptureSource,
  type ScreenSharePrefs,
  type ScreenShareStartOptions,
  type ShareAudioCapability,
  type ShareAudioMode,
  type ShareSourceKind,
  type WebDisplaySurface,
} from "../lib/screen-share";
import { useAppTranslation } from "../lib/i18n";
import { useMediaSettings } from "../stores/media-settings";

export interface SourcePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen source id + share options when the user starts the share. */
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
 * (and a newly-opened one appears). The dialog is only open briefly, so the
 * cost is bounded (§27).
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

const WEB_SURFACE_COPY = {
  browser: { label: "desktop:sourcePicker.webTab", hint: "desktop:sourcePicker.webTabHint", icon: Globe },
  monitor: { label: "desktop:sourcePicker.webScreen", hint: "desktop:sourcePicker.webScreenHint", icon: Monitor },
  window: { label: "desktop:sourcePicker.webWindow", hint: "desktop:sourcePicker.webWindowHint", icon: AppWindow },
} as const satisfies Record<WebDisplaySurface, unknown>;

function kindOf(sourceId: string): ShareSourceKind {
  if (isWebPlatform()) return webPreferredSurface(sourceId) === "monitor" ? "screen" : "window";
  return isWindowSource(sourceId) ? "window" : "screen";
}

function SourceCard({
  source,
  selected,
  onSelect,
  onStart,
}: {
  source: CaptureSource;
  selected: boolean;
  onSelect: (sourceId: string) => void;
  onStart: (sourceId: string) => void;
}): JSX.Element {
  const Icon = source.kind === "screen" ? Monitor : AppWindow;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(source.id)}
      onDoubleClick={() => onStart(source.id)}
      className={cn(
        "group flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-raised text-left",
        "transition-colors motion-instant hover:border-accent/60 hover:bg-accent/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        selected ? "border-accent ring-1 ring-accent/60" : "border-stroke",
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

function WebSurfaceCard({
  source,
  selected,
  onSelect,
  onStart,
}: {
  source: CaptureSource;
  selected: boolean;
  onSelect: (sourceId: string) => void;
  onStart: (sourceId: string) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const copy = WEB_SURFACE_COPY[webPreferredSurface(source.id)];
  const Icon = copy.icon;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(source.id)}
      onDoubleClick={() => onStart(source.id)}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-lg border bg-raised p-2.5 text-left",
        "transition-colors motion-instant hover:border-accent/60 hover:bg-accent/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        selected ? "border-accent ring-1 ring-accent/60" : "border-stroke",
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
        <Icon className="size-4 shrink-0 text-accent" />
        {t(copy.label)}
      </span>
      <span className="text-2xs leading-snug text-fg-muted">{t(copy.hint)}</span>
    </button>
  );
}

interface AudioOption {
  mode: ShareAudioMode;
  label: string;
  hint: string;
  disabled: boolean;
}

function AudioModeSelector({
  options,
  value,
  onChange,
  label,
}: {
  options: AudioOption[];
  value: ShareAudioMode;
  onChange: (mode: ShareAudioMode) => void;
  label: string;
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="mt-1 grid gap-1 sm:grid-cols-3">
      {options.map((option) => {
        const selected = value === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.mode)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors motion-instant",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-accent/60 bg-accent/10 text-fg"
                : "border-stroke bg-raised text-fg-muted hover:bg-overlay",
            )}
          >
            <span className="text-xs font-medium">{option.label}</span>
            <span className="text-2xs leading-snug text-fg-muted">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SourcePicker({ open, onOpenChange, onSelect }: SourcePickerProps): JSX.Element {
  const { t } = useAppTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [prefs, setPrefs] = useState<ScreenSharePrefs>(loadScreenSharePrefs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capability, setCapability] = useState<ShareAudioCapability | null>(null);
  // Screen-share quality is UNIFIED with the settings screen: it lives in the
  // persisted media-settings store, so a change here or there agrees.
  const screenQuality = useMediaSettings((s) => s.video.screenShareQuality);
  const setScreenShareQuality = useMediaSettings((s) => s.setScreenShareQuality);
  const web = isWebPlatform();
  const webAudio = isWebDisplayAudioCapable();

  useEffect(() => {
    if (!open) return;
    let active = true;
    // Re-read prefs on open so a stale mounted picker can't shadow storage.
    setPrefs(loadScreenSharePrefs());
    setSelectedId(null);

    if (!isScreenCaptureAvailable()) {
      setState({ kind: "error", error: "errorUnavailable" });
      return;
    }
    if (!web) {
      void getShareAudioCapability().then((next) => {
        if (active) setCapability(next);
      });
    }

    // desktopCapturer is never cached (main re-enumerates on every call), so each
    // refresh is a TRUE re-enumeration. `showLoading` only for the initial open so
    // a background refresh updates the grid in place without a loading flash — and
    // a failed background refresh keeps the last good list rather than erroring out.
    const refresh = (showLoading: boolean): void => {
      if (showLoading) setState({ kind: "loading" });
      listScreenSources()
        .then((sources) => {
          if (!active) return;
          setState({ kind: "ready", sources });
          // A selected window that closed drops out of the selection too.
          setSelectedId((current) =>
            current && sources.some((s) => s.id === current) ? current : null,
          );
        })
        .catch(() => {
          if (active && showLoading) setState({ kind: "error", error: "errorList" });
        });
    };

    refresh(true);

    // Keep the list LIVE while open so a window closed AFTER opening drops out
    // fast (and a newly-opened one appears): re-enumerate on a short interval,
    // plus whenever Demli regains focus or the document becomes visible again.
    const onRefresh = (): void => refresh(false);
    window.addEventListener("focus", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    const interval = web ? null : window.setInterval(onRefresh, SOURCE_REFRESH_MS);

    return () => {
      active = false;
      window.removeEventListener("focus", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [open, web]);

  const resolution = screenShareResolutionOf(screenQuality);
  const frameRate = screenShareFrameRateOf(screenQuality);

  const applyQuality = (
    nextResolution: ScreenShareResolution,
    nextFrameRate: ScreenShareFrameRate,
  ): void => {
    const quality = screenShareQualityId(nextResolution, nextFrameRate);
    setScreenShareQuality(quality);
    const next = { ...prefs, quality };
    setPrefs(next);
    saveScreenSharePrefs(next);
  };

  const selectedKind: ShareSourceKind | null = selectedId ? kindOf(selectedId) : null;
  const selectedMode: ShareAudioMode = selectedKind ? prefs.audioMode[selectedKind] : "none";

  const setAudioMode = (mode: ShareAudioMode): void => {
    if (!selectedKind) return;
    const next: ScreenSharePrefs = {
      ...prefs,
      audioMode: { ...prefs.audioMode, [selectedKind]: mode },
    };
    setPrefs(next);
    saveScreenSharePrefs(next);
  };

  const start = (sourceId: string): void => {
    const kind = kindOf(sourceId);
    onSelect(sourceId, { quality: screenQuality, audioMode: prefs.audioMode[kind] });
    onOpenChange(false);
  };

  const desktopAudioOptions = (): AudioOption[] => [
    {
      mode: "none",
      label: t("desktop:sourcePicker.audioNone"),
      hint: t("desktop:sourcePicker.audioNoneHint"),
      disabled: false,
    },
    {
      mode: "app",
      label: t("desktop:sourcePicker.audioApp"),
      hint:
        selectedKind === "window"
          ? t("desktop:sourcePicker.audioAppHint")
          : t("desktop:sourcePicker.audioAppWindowOnly"),
      disabled: selectedKind !== "window",
    },
    {
      mode: "system",
      label: t("desktop:sourcePicker.audioSystem"),
      hint: t("desktop:sourcePicker.audioSystemHint"),
      disabled: false,
    },
  ];

  const webAudioOptions = (): AudioOption[] => [
    {
      mode: "none",
      label: t("desktop:sourcePicker.audioNone"),
      hint: t("desktop:sourcePicker.audioNoneHint"),
      disabled: false,
    },
    {
      mode: "system",
      label: t("desktop:sourcePicker.webAudioShare"),
      hint: t("desktop:sourcePicker.webAudioShareHint"),
      disabled: false,
    },
  ];

  const unsupportedCopy =
    capability && !capability.supported
      ? capability.notice === "unsupported_os"
        ? t("desktop:sourcePicker.audioUnsupportedOs")
        : capability.notice === "capture_failed"
          ? t("desktop:sourcePicker.audioHelperMissing")
          : t("desktop:sourcePicker.audioUnsupportedPlatform")
      : web && !webAudio
        ? t("desktop:sourcePicker.systemAudioWebUnsupported")
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("desktop:voice.shareScreen")}</DialogTitle>
          <DialogDescription>{t("desktop:sourcePicker.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
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

          {state.kind === "ready" && state.sources.length > 0 && web && (
            <div className="grid gap-2 p-0.5 sm:grid-cols-3">
              {state.sources.map((source) => (
                <WebSurfaceCard
                  key={source.id}
                  source={source}
                  selected={source.id === selectedId}
                  onSelect={setSelectedId}
                  onStart={start}
                />
              ))}
            </div>
          )}

          {state.kind === "ready" && state.sources.length > 0 && !web && (
            <div className="space-y-3">
              {(() => {
                const screens = state.sources.filter((s) => s.kind === "screen");
                const windows = state.sources.filter((s) => s.kind !== "screen");
                return (
                  <>
                    {windows.length > 0 && (
                      <div>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <p className="text-2xs font-semibold uppercase tracking-wide text-fg-faint">
                            {t("desktop:sourcePicker.windowsHeading")}
                          </p>
                          <p className="truncate text-2xs text-fg-faint">
                            {t("desktop:sourcePicker.screensHint")}
                          </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3">
                          {windows.map((source) => (
                            <SourceCard
                              key={source.id}
                              source={source}
                              selected={source.id === selectedId}
                              onSelect={setSelectedId}
                              onStart={start}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {screens.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-faint">
                          {t("desktop:sourcePicker.screensHeading")}
                        </p>
                        <div className="grid grid-cols-2 gap-2 p-0.5 sm:grid-cols-3">
                          {screens.map((source) => (
                            <SourceCard
                              key={source.id}
                              source={source}
                              selected={source.id === selectedId}
                              onSelect={setSelectedId}
                              onStart={start}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          <div className="mt-3 rounded-lg border border-stroke bg-surface p-2.5">
            <p className="text-xs font-medium text-fg">{t("desktop:sourcePicker.audioHeading")}</p>
            {unsupportedCopy ? (
              <p className="mt-1 text-2xs leading-snug text-fg-muted">{unsupportedCopy}</p>
            ) : selectedId ? (
              <AudioModeSelector
                label={t("desktop:sourcePicker.audioHeading")}
                options={web ? webAudioOptions() : desktopAudioOptions()}
                value={web && selectedMode === "app" ? "system" : selectedMode}
                onChange={setAudioMode}
              />
            ) : (
              <p className="mt-1 text-2xs leading-snug text-fg-muted">
                {t("desktop:sourcePicker.pickFirst")}
              </p>
            )}
          </div>

          <div className="mt-2.5 rounded-lg border border-stroke bg-surface p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium text-fg">{t("desktop:sourcePicker.quality")}</p>
              <p className="truncate text-2xs text-fg-faint">
                {qualityDetail(resolution, frameRate)}
              </p>
            </div>

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
                    onClick={() => applyQuality(option, frameRate)}
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
                    onClick={() => applyQuality(resolution, option)}
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
        </DialogBody>

        <DialogFooter>
          <Button disabled={!selectedId} onClick={() => selectedId && start(selectedId)}>
            {t("desktop:sourcePicker.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
