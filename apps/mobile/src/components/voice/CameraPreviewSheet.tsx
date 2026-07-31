import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { colors, radius, space } from "@/theme/theme";
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
  const insets = useSafeAreaInsets();
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
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable
        onPress={close}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
      >
        {/* Card. Its own Pressable swallows taps so they don't dismiss the sheet. */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.md,
            paddingBottom: space.md + insets.bottom,
            paddingHorizontal: space.lg,
            gap: space.md,
          }}
        >
          {/* Grab handle. */}
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: colors.strokeStrong,
            }}
          />

          <View style={{ gap: 2 }}>
            <Text variant="display" style={{ color: colors.fg, fontSize: 17, fontWeight: "800" }}>
              {t("mobile:voice.cameraPreview.title")}
            </Text>
            <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
              {t("mobile:voice.cameraPreview.subtitle")}
            </Text>
          </View>

          {/* Preview surface (never published). Mirror the front camera — the
              natural selfie look, consistent with the live self-view tile. */}
          <View
            style={{
              width: "100%",
              aspectRatio: 3 / 4,
              maxHeight: 320,
              borderRadius: radius.md,
              borderCurve: "continuous",
              overflow: "hidden",
              backgroundColor: "#000",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {errorMessage ? (
              <View style={{ alignItems: "center", gap: space.md, paddingHorizontal: space.lg }}>
                <VideoOff size={30} color={colors.fgFaint} />
                <Text style={{ color: colors.fgMuted, fontSize: 13, textAlign: "center" }}>
                  {errorMessage}
                </Text>
                <Pressable
                  onPress={() => setAttempt((n) => n + 1)}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                    borderRadius: radius.md,
                    backgroundColor: colors.surfaceRaised,
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <RefreshCw size={15} color={colors.fg} />
                  <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
                    {t("mobile:voice.cameraPreview.retry")}
                  </Text>
                </Pressable>
              </View>
            ) : streamUrl ? (
              <RTCView
                streamURL={streamUrl}
                objectFit="cover"
                mirror={front}
                zOrder={1}
                style={{ width: "100%", height: "100%" }}
              />
            ) : (
              <Text style={{ color: colors.fgFaint, fontSize: 13 }}>
                {t("mobile:voice.cameraPreview.starting")}
              </Text>
            )}
          </View>

          {/* Front/back segmented toggle — only when the phone has two cameras. */}
          {showToggle && !errorMessage ? (
            <View
              style={{
                flexDirection: "row",
                backgroundColor: colors.surfaceRaised,
                borderRadius: radius.md,
                borderCurve: "continuous",
                padding: 3,
                gap: 3,
              }}
            >
              {[true, false].map((isFront) => {
                const selected = front === isFront;
                return (
                  <Pressable
                    key={isFront ? "front" : "back"}
                    onPress={() => {
                      if (front === isFront) return;
                      haptics.light();
                      setFront(isFront);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      paddingVertical: space.sm,
                      borderRadius: radius.sm,
                      borderCurve: "continuous",
                      backgroundColor: selected ? colors.accent : "transparent",
                    }}
                  >
                    <Text
                      style={{
                        color: selected ? colors.onAccent : colors.fgMuted,
                        fontSize: 14,
                        fontWeight: "700",
                      }}
                    >
                      {isFront
                        ? t("mobile:voice.cameraPreview.front")
                        : t("mobile:voice.cameraPreview.back")}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 48,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: colors.surfaceRaised,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
                {t("mobile:voice.cameraPreview.cancel")}
              </Text>
            </Pressable>
            <Pressable
              onPress={confirm}
              disabled={!!error}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flex: 2,
                minHeight: 48,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: space.sm,
                borderRadius: radius.md,
                borderCurve: "continuous",
                backgroundColor: colors.online,
                opacity: error ? 0.4 : pressed ? 0.85 : 1,
              })}
            >
              <Video size={18} color={colors.onAccent} />
              <Text style={{ color: colors.onAccent, fontSize: 15, fontWeight: "700" }}>
                {t("mobile:voice.cameraPreview.confirm")}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
