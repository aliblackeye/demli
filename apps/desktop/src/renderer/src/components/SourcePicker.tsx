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

import { useEffect, useRef, useState } from "react";
import { AppWindow, Check, Globe, Monitor, MonitorX, Volume2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RadioGroup,
  RadioItem,
  Skeleton,
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
  pickerStartAudioMode,
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
function qualityDetail(resolution: ScreenShareResolution, frameRate: ScreenShareFrameRate): string {
  const profile = SCREEN_SHARE_QUALITY_PROFILES[screenShareQualityId(resolution, frameRate)];
  const mbps = profile.maxBitrateBps / 1_000_000;
  return `${profile.height}p · ${profile.frameRate} fps · ~${mbps} Mbps`;
}

const WEB_SURFACE_COPY = {
  browser: {
    label: "desktop:sourcePicker.webTab",
    hint: "desktop:sourcePicker.webTabHint",
    icon: Globe,
  },
  monitor: {
    label: "desktop:sourcePicker.webScreen",
    hint: "desktop:sourcePicker.webScreenHint",
    icon: Monitor,
  },
  window: {
    label: "desktop:sourcePicker.webWindow",
    hint: "desktop:sourcePicker.webWindowHint",
    icon: AppWindow,
  },
} as const satisfies Record<WebDisplaySurface, unknown>;

function kindOf(sourceId: string): ShareSourceKind {
  if (isWebPlatform()) return webPreferredSurface(sourceId) === "monitor" ? "screen" : "window";
  return isWindowSource(sourceId) ? "window" : "screen";
}

/** Selected-card marker: a coral check disc in the corner, scaled in on select. */
function SelectedMark({ selected }: { selected: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute right-2 top-2 z-10 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent",
        "transition-[opacity,scale] motion-fast",
        selected ? "scale-100 opacity-100" : "scale-75 opacity-0",
      )}
    >
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

/**
 * Card tones (Koyu Masa): resting on the surface step, raised on hover (200ms
 * tone change, nothing lifts), the coral wash + a 1.5px INSET coral line when
 * selected — inset so the scrolling dialog body cannot clip it.
 */
const CARD = cn(
  "group relative flex cursor-pointer flex-col overflow-hidden rounded-xl text-left",
  "transition-colors motion-hover active:bg-raised-pressed",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
);
const CARD_IDLE = "bg-surface hover:bg-raised";
const CARD_SELECTED = "bg-accent-surface shadow-[inset_0_0_0_1.5px_var(--color-accent)]";

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
      data-testid="source-card"
      onClick={() => onSelect(source.id)}
      onDoubleClick={() => onStart(source.id)}
      className={cn(CARD, "p-1.5", selected ? CARD_SELECTED : CARD_IDLE)}
    >
      <SelectedMark selected={selected} />
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-rail">
        {source.thumbnailDataUrl ? (
          <img
            src={source.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-contain"
            draggable={false}
          />
        ) : (
          <Icon aria-hidden className="size-6 text-fg-subtle" />
        )}
      </div>
      <div className="flex items-center gap-1.5 px-1 pb-0.5 pt-2">
        <Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", selected ? "text-accent" : "text-fg-faint")}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-2xs font-medium transition-colors motion-hover",
            selected ? "text-accent-hover" : "text-fg-muted group-hover:text-fg",
          )}
        >
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
      data-testid="source-card"
      onClick={() => onSelect(source.id)}
      onDoubleClick={() => onStart(source.id)}
      className={cn(CARD, "gap-1.5 p-3", selected ? CARD_SELECTED : CARD_IDLE)}
    >
      <SelectedMark selected={selected} />
      <span className="flex size-8 items-center justify-center rounded-lg bg-raised text-accent">
        <Icon aria-hidden className="size-4" />
      </span>
      <span
        className={cn("pr-6 text-label font-semibold", selected ? "text-accent-hover" : "text-fg")}
      >
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

/**
 * The share-sound choice as the design system's radio rows: one tab stop, arrow
 * keys move AND select, the selected row takes the coral wash. Stacked, because
 * each option's hint is a real sentence about what viewers will hear — three
 * squeezed columns made the most important copy in the dialog the hardest to read.
 */
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
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as ShareAudioMode)}
      className="mt-2 gap-0.5"
    >
      {options.map((option) => (
        <RadioItem
          key={option.mode}
          value={option.mode}
          label={option.label}
          // The long explanation is shown for the CHOSEN option (and for a
          // disabled one, whose hint says why it is off); the others show their
          // label only. All three hints were ~400px of copy in the settings pane
          // and pushed the choice itself out of view. Hidden hints stay in the
          // accessibility tree (sr-only), so every radio still announces its
          // description.
          description={
            <span
              data-hint-visible={option.mode === value || option.disabled || undefined}
              className={option.mode === value || option.disabled ? undefined : "sr-only"}
            >
              {option.hint}
            </span>
          }
          disabled={option.disabled}
          data-testid={`share-audio-option-${option.mode}`}
        />
      ))}
    </RadioGroup>
  );
}

/**
 * A segmented single choice (resolution, frame rate): a WAI-ARIA radio group in
 * a recessed track — one tab stop, arrows move and select, Home/End jump. The
 * selected segment lifts to the raised tone; the others only tone on hover.
 */
function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  renderLabel,
  testId,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  renderLabel: (option: T) => string;
  testId: string;
}): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number | "first" | "last"): void => {
    const last = options.length - 1;
    const to =
      delta === "first"
        ? 0
        : delta === "last"
          ? last
          : (from + delta + options.length) % options.length;
    const next = options[to];
    if (next === undefined) return;
    onChange(next);
    refs.current[to]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="mt-1.5 grid gap-1 rounded-lg bg-app p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const selected = option === value;
        return (
          <button
            key={String(option)}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option)}
            onKeyDown={(event) => {
              const delta =
                event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : event.key === "Home"
                      ? "first"
                      : event.key === "End"
                        ? "last"
                        : null;
              if (delta === null) return;
              event.preventDefault();
              move(index, delta);
            }}
            className={cn(
              "h-8 cursor-pointer rounded-md px-2 text-center text-label font-medium tabular-nums",
              "transition-colors motion-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              selected
                ? "bg-raised text-fg-display"
                : "text-fg-muted hover:bg-wash hover:text-fg active:bg-wash-strong",
            )}
          >
            {renderLabel(option)}
          </button>
        );
      })}
    </div>
  );
}

/** Loading: the grid's own shape in skeleton blocks, never a lone spinner. */
function SourceGridSkeleton({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" aria-label={label} data-testid="source-skeleton" className="space-y-2">
      <Skeleton shape="line" width={96} height={10} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-xl bg-surface p-1.5">
            <Skeleton className="aspect-video w-full rounded-lg" />
            <Skeleton shape="line" className="mx-1 mb-0.5 mt-2.5 w-2/3" height={8} />
          </div>
        ))}
      </div>
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
    onSelect(sourceId, {
      quality: screenQuality,
      audioMode: pickerStartAudioMode(capability, prefs.audioMode[kind]),
    });
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
      {/* Two panes on a desktop-sized window: what to share on the left (its own
          scroll — there can be dozens of windows), how to share it on the right,
          always in view. Stacked in one column it was taller than the default
          1280×800 window, so the sound choice sat below an invisible-until-hover
          scrollbar and people started a silent share without ever seeing it. */}
      <DialogContent
        className="max-h-[calc(100vh-2rem)] max-w-4xl"
        closeLabel={t("buttons.close")}
        data-testid="source-picker"
      >
        <DialogHeader>
          <DialogTitle>{t("desktop:voice.shareScreen")}</DialogTitle>
          <DialogDescription>{t("desktop:sourcePicker.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody className="md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:grid-rows-[minmax(0,1fr)] md:gap-5 md:overflow-hidden md:pb-2">
          <div
            data-testid="source-pane"
            className="md:min-h-0 md:overflow-y-auto md:overscroll-contain md:pb-4 md:pr-1"
          >
            {state.kind === "loading" && (
              <SourceGridSkeleton label={t("desktop:sourcePicker.loading")} />
            )}

            {state.kind === "error" && (
              <FormErrorAlert className="text-sm">
                {t(`desktop:sourcePicker.${state.error}`)}
              </FormErrorAlert>
            )}

            {state.kind === "ready" && state.sources.length === 0 && (
              <div
                data-testid="source-empty"
                className="flex flex-col items-center gap-3 rounded-xl bg-surface px-4 py-10 text-center"
              >
                <span className="flex size-11 items-center justify-center rounded-full bg-raised text-fg-faint">
                  <MonitorX aria-hidden className="size-5" />
                </span>
                <p className="text-label text-fg-muted">{t("desktop:sourcePicker.empty")}</p>
              </div>
            )}

            {state.kind === "ready" && state.sources.length > 0 && web && (
              <div className="grid gap-2 sm:grid-cols-3">
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
              <div className="space-y-4">
                {(() => {
                  const screens = state.sources.filter((s) => s.kind === "screen");
                  const windows = state.sources.filter((s) => s.kind !== "screen");
                  return (
                    <>
                      {windows.length > 0 && (
                        <div>
                          <div className="mb-2 flex items-baseline justify-between gap-2 px-0.5">
                            <p className="text-2xs font-semibold uppercase tracking-wide text-fg-faint">
                              {t("desktop:sourcePicker.windowsHeading")}
                            </p>
                            <p className="truncate text-2xs text-fg-faint">
                              {t("desktop:sourcePicker.screensHint")}
                            </p>
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
                          <p className="mb-2 px-0.5 text-2xs font-semibold uppercase tracking-wide text-fg-faint">
                            {t("desktop:sourcePicker.screensHeading")}
                          </p>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
          </div>

          <div
            data-testid="share-settings-pane"
            className="mt-4 space-y-2 md:mt-0 md:min-h-0 md:overflow-y-auto md:overscroll-contain md:pb-4"
          >
            <section
              aria-label={t("desktop:sourcePicker.audioHeading")}
              data-testid="share-audio-section"
              className="rounded-xl bg-surface p-3"
            >
              <p className="flex items-center gap-1.5 text-label font-semibold text-fg">
                <Volume2 aria-hidden className="size-3.5 text-fg-muted" />
                {t("desktop:sourcePicker.audioHeading")}
              </p>
              {unsupportedCopy ? (
                <p className="mt-1.5 text-2xs leading-snug text-fg-muted">{unsupportedCopy}</p>
              ) : selectedId ? (
                <AudioModeSelector
                  label={t("desktop:sourcePicker.audioHeading")}
                  options={web ? webAudioOptions() : desktopAudioOptions()}
                  value={web && selectedMode === "app" ? "system" : selectedMode}
                  onChange={setAudioMode}
                />
              ) : (
                <p className="mt-1.5 text-2xs leading-snug text-fg-faint">
                  {t("desktop:sourcePicker.pickFirst")}
                </p>
              )}
            </section>

            <section
              aria-label={t("desktop:sourcePicker.quality")}
              data-testid="share-quality-section"
              className="rounded-xl bg-surface p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-label font-semibold text-fg">
                  {t("desktop:sourcePicker.quality")}
                </p>
                <p className="truncate text-2xs tabular-nums text-fg-faint">
                  {qualityDetail(resolution, frameRate)}
                </p>
              </div>

              {/* Side by side on a phone-width sheet; stacked in the narrow settings
                pane, where four resolution segments would not fit half of it. */}
              <div className="mt-2.5 grid gap-3 sm:grid-cols-[4fr_3fr] md:grid-cols-1">
                <div>
                  <p className="px-0.5 text-badge font-semibold uppercase tracking-wide text-fg-faint">
                    {t("desktop:sourcePicker.resolution")}
                  </p>
                  <Segmented
                    label={t("desktop:sourcePicker.resolution")}
                    options={SCREEN_SHARE_RESOLUTIONS}
                    value={resolution}
                    onChange={(option) => applyQuality(option, frameRate)}
                    renderLabel={(option) => RESOLUTION_LABEL[option]}
                    testId="share-resolution"
                  />
                </div>
                <div>
                  <p className="px-0.5 text-badge font-semibold uppercase tracking-wide text-fg-faint">
                    {t("desktop:sourcePicker.frameRate")}
                  </p>
                  <Segmented
                    label={t("desktop:sourcePicker.frameRate")}
                    options={SCREEN_SHARE_FRAME_RATES}
                    value={frameRate}
                    onChange={(option) => applyQuality(resolution, option)}
                    renderLabel={(option) => `${option} fps`}
                    testId="share-framerate"
                  />
                </div>
              </div>
            </section>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("buttons.cancel")}
          </Button>
          <Button
            variant="accent"
            data-testid="source-start"
            disabled={!selectedId}
            onClick={() => selectedId && start(selectedId)}
          >
            <Monitor aria-hidden className="size-4" />
            {t("desktop:sourcePicker.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
