/**
 * Camera PREVIEW dialog (#101) — the "see yourself before you go
 * live" step. Pressing the camera control while the camera is OFF opens this
 * instead of publishing immediately: the user gets a LOCAL self-preview (from
 * `getUserMedia`, never published), picks the camera device, then confirms with
 * "Turn on camera" to actually publish. Cancel/close releases the preview track
 * so nothing leaks and the OS camera light goes out.
 *
 * Engine boundary (CLAUDE.md §11): this dialog is renderer-only. The preview
 * stream is acquired here and stays here — it NEVER touches the voice engine, so
 * the engine's `VoiceState` (the single source of truth for what is published)
 * is untouched while previewing. On confirm we call the SAME engine commands the
 * device settings use: `setVideoDevice` (stores the preferred camera) then
 * `toggleCamera` (livekit acquires + publishes with that preference). Turning the
 * camera OFF stays a direct toggle in the control (this dialog is open-only).
 *
 * Effects (background blur, etc.) are intentionally NOT offered here yet: a real
 * blur needs a MediaPipe/`@livekit/track-processors` pipeline (net-new multi-MB
 * dependency + same-origin asset bundling under the strict renderer CSP). Rather
 * than ship a dead "None"-only dropdown (§35), the effect selector is omitted
 * until that pipeline lands; the preview/device flow is the shipping value.
 *
 * Errors (§26): permission denied / no camera / device busy surface as a
 * friendly localized message INSIDE the dialog with a "Try again" retry — never a
 * raw stack trace, and never a silent black frame.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Video, VideoOff } from "lucide-react";
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
  Select,
  Skeleton,
  cn,
} from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import { fallbackLabel, useMediaDevices } from "../lib/media-devices";
import { startLocalPreviewPlayback } from "../lib/video-playback";

type PreviewError = "permission" | "notfound" | "generic";

/** Classify a getUserMedia failure into the §26 buckets we message on. */
function classifyPreviewError(err: unknown): PreviewError {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "permission";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "notfound";
  return "generic";
}

export function CameraPreviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { cameras } = useMediaDevices();
  const storedDeviceId = useVoiceStore((s) => s.selectedVideoDeviceId);
  const setVideoDevice = useVoiceStore((s) => s.setVideoDevice);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);

  // "" = platform default (no explicit videoinput chosen yet).
  const [deviceId, setDeviceId] = useState<string>(storedDeviceId ?? "");
  const [error, setError] = useState<PreviewError | null>(null);
  const [ready, setReady] = useState(false);
  // Bumping this re-runs the acquire effect — the "Try again" affordance.
  const [attempt, setAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * The live preview stream, mirrored out of the effect closure so {@link confirm}
   * can release the camera SYNCHRONOUSLY before the engine re-acquires it. See the
   * comment on `confirm` — this ref is the whole fix for the mobile-web P0.
   */
  const streamRef = useRef<MediaStream | null>(null);

  /**
   * Stop the preview capture and unbind the element. Idempotent, so the effect
   * cleanup and an explicit `confirm()` release can both call it.
   */
  const stopPreview = useCallback((): void => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Best-effort — the device may already be gone.
        }
      }
    }
    const el = videoRef.current;
    if (el) el.srcObject = null;
  }, []);

  // When the dialog (re)opens, seed the device from the stored preference so the
  // preview and the eventual publish agree on the camera.
  useEffect(() => {
    if (open) {
      setDeviceId(storedDeviceId ?? "");
      setError(null);
      setReady(false);
    }
  }, [open, storedDeviceId]);

  // Acquire the LOCAL preview stream (never published). Re-runs on open, device
  // change, and retry; always stops every track on cleanup so there is no leak
  // and the OS camera light follows the real state.
  useEffect(() => {
    if (!open) return;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setError("generic");
      return;
    }

    let cancelled = false;
    setError(null);
    setReady(false);

    media
      .getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
        audio: false,
      })
      .then((acquired) => {
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = acquired;
        const el = videoRef.current;
        if (el) {
          el.srcObject = acquired;
          // Start playback explicitly — a browser (esp. Safari 12) does not reliably
          // autostart a srcObject assigned in this async callback, so the preview
          // stayed black on web while desktop worked. See lib/video-playback.
          startLocalPreviewPlayback(el);
        }
        setReady(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(classifyPreviewError(err));
      });

    return () => {
      cancelled = true;
      stopPreview();
    };
  }, [open, deviceId, attempt, stopPreview]);

  /**
   * Confirm → publish. RELEASING THE PREVIEW FIRST IS LOAD-BEARING.
   *
   * The old order was `toggleCamera(); onOpenChange(false);` — i.e. the engine
   * called `setCameraEnabled(true)` (a SECOND `getUserMedia` on the same camera)
   * while this dialog's preview stream was still holding the device. React only
   * runs the effect cleanup that stops the preview after it commits the
   * `open=false` render, which is strictly LATER.
   *
   * On desktop Chromium a second reader of the same camera is allowed, so nobody
   * noticed. On mobile browsers the camera is effectively EXCLUSIVE: the second
   * acquire fails with `NotReadableError`/`AbortError`, which used to land in the
   * engine's catch-all and surface as "Seçili ses aygıtı kullanılamıyor" — the
   * founder's exact report ("preview opens, but Aç says the audio device is
   * unavailable and the camera never turns on").
   *
   * So: stop the preview tracks synchronously, close the dialog, yield one
   * macrotask so the browser/OS actually hands the device back, and only then
   * publish. The engine additionally retries unconstrained on a constraint-shaped
   * failure, so a slow release degrades to a retry rather than a dead button.
   */
  const confirm = useCallback((): void => {
    stopPreview();
    onOpenChange(false);
    // Persist the chosen camera as the engine preference (off-camera it is just
    // stored; the engine applies it when the camera publishes), then publish.
    setTimeout(() => {
      if (deviceId) setVideoDevice(deviceId);
      toggleCamera();
    }, 0);
  }, [deviceId, setVideoDevice, toggleCamera, onOpenChange, stopPreview]);

  const errorMessage =
    error === "permission"
      ? t("desktop:voice.cameraPreview.permissionDenied")
      : error === "notfound"
        ? t("desktop:voice.cameraPreview.noDevice")
        : error === "generic"
          ? t("desktop:voice.cameraPreview.genericError")
          : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={t("buttons.close")}>
        <DialogHeader>
          <DialogTitle>{t("desktop:voice.cameraPreview.title")}</DialogTitle>
          <DialogDescription>{t("desktop:voice.cameraPreview.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {/* Preview surface. Upright, whole frame, NOT mirrored — consistent with
              the live self-view (LocalCameraTile): the local user sees exactly
              what peers see. Borderless on the page black, radius 16. */}
          <div
            data-testid="camera-preview"
            data-state={errorMessage ? "error" : ready ? "ready" : "starting"}
            className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-rail"
          >
            {errorMessage ? (
              <div role="alert" className="flex flex-col items-center gap-3 px-6 py-8 text-center animate-fade-in">
                <span className="flex size-11 items-center justify-center rounded-full bg-danger-surface text-danger">
                  <VideoOff aria-hidden className="size-5" />
                </span>
                <p className="text-label leading-snug text-fg-muted">{errorMessage}</p>
                <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  {t("desktop:voice.cameraPreview.retry")}
                </Button>
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={cn(
                    "h-full w-full object-contain transition-opacity motion-standard",
                    ready ? "opacity-100" : "opacity-0",
                  )}
                />
                {!ready && (
                  // Starting: the frame's own shape pulses while the camera wakes
                  // up — a skeleton, not a spinner (founder rule).
                  <div role="status" className="absolute inset-0 flex items-center justify-center">
                    <Skeleton className="absolute inset-0 rounded-none" />
                    <p className="relative flex items-center gap-1.5 text-2xs font-medium text-fg-muted">
                      <Video aria-hidden className="size-3.5" />
                      {t("desktop:voice.cameraPreview.starting")}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Camera picker — reuses the shared enumeration (labels appear once
              camera access is granted). Hidden until there is a real choice. */}
          {cameras.length > 0 && (
            <Field label={t("desktop:voice.cameraPreview.device")}>
              <Select
                value={deviceId === "" ? undefined : deviceId}
                onValueChange={setDeviceId}
                placeholder={t("desktop:devices.systemDefault")}
                options={cameras.map((device, index) => ({
                  value: device.deviceId,
                  label: device.label || fallbackLabel("videoinput", device.deviceId, index, t),
                }))}
              />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("desktop:voice.cameraPreview.cancel")}
          </Button>
          <Button variant="accent" onClick={confirm} disabled={!!error}>
            <Video aria-hidden className="size-4" />
            {t("desktop:voice.cameraPreview.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
