import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { RefreshCw, Video, VideoOff } from "lucide-react-native";
import {
  mediaDevices,
  RTCView,
  type MediaStream,
} from "@livekit/react-native-webrtc";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { ensureCameraPermission, normalizeMediaError } from "@/media/permissions";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, motion, radius, space } from "@/theme/theme";
import { EmptyState } from "../EmptyState";
import { Segmented } from "../Segmented";
import { Skeleton } from "../Skeleton";
import { Button } from "../ui/Button";
import { Sheet } from "../ui/Sheet";
import {
  classifyCameras,
  facingModeFor,
  type EnumeratedCamera,
  type FacingCameras,
} from "./camera-preview";

type PreviewError = "permission" | "notfound" | "generic";

const NO_CAMERAS: FacingCameras = { count: 0, front: null, back: null };

/** Classify a normalized getUserMedia failure into the §26 buckets we message on. */
function classifyPreviewError(err: unknown): PreviewError {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "permission";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "notfound";
  return "generic";
}

/**
 * Camera PREVIEW sheet (#101) — the mobile twin of the desktop
 * CameraPreviewDialog. Tapping the camera control while OFF opens this instead of
 * publishing immediately: a LOCAL getUserMedia self-view (rendered with RTCView,
 * NEVER published), a front/back toggle when the phone has two cameras, then
 * "Turn on camera" to actually publish. Cancel/close stops the preview track so
 * the camera is released (no leak, camera light off) — critical on RN where the
 * camera is a single exclusive resource: we stop the preview BEFORE the engine
 * re-acquires it on publish.
 *
 * Engine boundary (CLAUDE.md §11): the preview stream lives entirely here and
 * never reaches the voice engine, so the engine's `VoiceState` (single source of
 * truth for what is published) is untouched while previewing. On confirm we call
 * the SAME engine commands the flow would use anyway — `setVideoDevice` (the
 * camera the preview resolved to) then the parent's camera toggle to publish.
 *
 * No effects on mobile MVP (native background blur is a later, 1.7.0-native item);
 * front/back + preview is the shipping value here.
 *
 * Every state is drawn: the camera starting (a pulsing frame, never a black box),
 * the live preview (fading in when the first frame is ready), and a refusal —
 * permission, no camera, anything else — as the kit's error block with its own
 * retry. Front/back is the kit's sliding Segmented. Drawn on the draggable Sheet;
 * every way out (drag, scrim, back, Cancel) goes through `close`, so the preview
 * track is always stopped.
 */
export function CameraPreviewSheet({
  visible,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  onClose: () => void;
  /** Enable the camera (the parent's camera toggle — the sheet only opens while OFF). */
  onConfirm: () => void;
}) {
  const { t } = useAppTranslation();
  const setVideoDevice = useVoiceStore((s) => s.setVideoDevice);

  const [front, setFront] = useState(true);
  const [cameras, setCameras] = useState<FacingCameras>(NO_CAMERAS);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  // The deviceId the preview actually resolved to — handed to the engine on
  // confirm so what was previewed is exactly what publishes.
  const resolvedDeviceId = useRef<string | null>(null);

  const stopStream = useCallback((): void => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const refreshCameras = useCallback(async (): Promise<void> => {
    try {
      const infos = (await mediaDevices.enumerateDevices()) as EnumeratedCamera[];
      setCameras(classifyCameras(infos));
    } catch {
      // Keep whatever we had — the toggle just won't appear.
    }
  }, []);

  // Reset to the front camera and enumerate whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setFront(true);
    setError(null);
    void refreshCameras();
  }, [visible, refreshCameras]);

  // Acquire the LOCAL preview stream (never published). Re-runs on open, side
  // switch, and retry; always stops the track on cleanup so the camera is freed.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setError(null);
    setStreamUrl(null);

    void (async () => {
      try {
        await ensureCameraPermission();
        const preferredId = front ? cameras.front : cameras.back;
        const video = preferredId
          ? { deviceId: preferredId }
          : { facingMode: facingModeFor(front) };
        const acquired = (await mediaDevices.getUserMedia({
          audio: false,
          video,
        })) as MediaStream;
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stopStream();
        streamRef.current = acquired;
        const track = acquired.getVideoTracks()[0];
        resolvedDeviceId.current = preferredId ?? track?.getSettings?.().deviceId ?? null;
        setStreamUrl(acquired.toURL());
        // Permission is now granted → labels/facing populate; refresh so the
        // front/back toggle can appear when a second camera exists.
        void refreshCameras();
      } catch (err) {
        if (!cancelled) {
          setError(classifyPreviewError(normalizeMediaError(err)));
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [visible, front, attempt, cameras.front, cameras.back, stopStream, refreshCameras]);

  const close = useCallback((): void => {
    stopStream();
    onClose();
  }, [stopStream, onClose]);

  const confirm = useCallback((): void => {
    haptics.medium();
    // Release the preview camera BEFORE the engine re-acquires it (RN camera is
    // exclusive), persist the resolved camera, then publish via the parent toggle.
    stopStream();
    if (resolvedDeviceId.current) setVideoDevice(resolvedDeviceId.current);
    onConfirm();
    onClose();
  }, [stopStream, setVideoDevice, onConfirm, onClose]);

  const showToggle = cameras.count >= 2;
  const errorMessage =
    error === "permission"
      ? t("mobile:voice.cameraPreview.permissionDenied")
      : error === "notfound"
        ? t("mobile:voice.cameraPreview.noCamera")
        : error === "generic"
          ? t("mobile:voice.cameraPreview.genericError")
          : null;

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={t("mobile:voice.cameraPreview.title")}
      description={t("mobile:voice.cameraPreview.subtitle")}
      footer={
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button
            variant="secondary"
            size="lg"
            label={t("mobile:voice.cameraPreview.cancel")}
            onPress={close}
            style={{ flex: 1 }}
          />
          <Button
            variant="accent"
            size="lg"
            icon={Video}
            label={t("mobile:voice.cameraPreview.confirm")}
            disabled={!!error}
            onPress={confirm}
            style={{ flex: 2 }}
          />
        </View>
      }
    >
      <View style={{ paddingHorizontal: space.xs, gap: space.md }}>
        {/* Preview surface (never published). Mirror the front camera — the
            natural selfie look, consistent with the live self-view tile. */}
        <View
          style={{
            width: "100%",
            aspectRatio: 3 / 4,
            maxHeight: 320,
            borderRadius: radius.xl,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: colors.rail,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {errorMessage ? (
            <EmptyState
              compact
              tone="error"
              icon={<VideoOff size={22} color={colors.danger} strokeWidth={2} />}
              title={errorMessage}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={RefreshCw}
                  label={t("mobile:voice.cameraPreview.retry")}
                  onPress={() => setAttempt((n) => n + 1)}
                />
              }
            />
          ) : streamUrl ? (
            <Animated.View
              key={streamUrl}
              entering={FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
              style={{ width: "100%", height: "100%" }}
            >
              <RTCView
                streamURL={streamUrl}
                objectFit="cover"
                mirror={front}
                zOrder={1}
                style={{ width: "100%", height: "100%" }}
              />
            </Animated.View>
          ) : (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityState={{ busy: true }}
              accessibilityLabel={t("mobile:voice.cameraPreview.starting")}
              style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
            >
              <Skeleton width="100%" height="100%" radius={radius.xl} />
            </View>
          )}
        </View>

        {/* Front/back segmented toggle — only when the phone has two cameras. */}
        {showToggle && !errorMessage ? (
          <Segmented
            value={front ? "front" : "back"}
            onChange={(next) => {
              const isFront = next === "front";
              if (front === isFront) return;
              // Segmented already gives the selection tick.
              setFront(isFront);
            }}
            options={[
              { value: "front", label: t("mobile:voice.cameraPreview.front") },
              { value: "back", label: t("mobile:voice.cameraPreview.back") },
            ]}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
