/**
 * Full-screen avatar viewer — "tap the avatar, see it big, and move around
 * inside it" (founder's reference; desktop's AvatarLightbox).
 *
 * Gesture-handler + Reanimated (declared dependencies since M16), so every
 * frame of a pinch runs on the UI thread:
 *
 *  - PINCH zooms 1–4× about the point between your fingers.
 *  - DOUBLE-TAP toggles fit ↔ 2.5× at the tapped point — the one-handed zoom.
 *  - PAN is clamped to the zoomed image's own overflow, so the picture can never
 *    be dragged off-screen and lost.
 *  - SWIPE DOWN at fit dismisses (the photo-viewer idiom): the backdrop thins as
 *    you drag, a short drag springs back, a flick or a long drag closes.
 *
 * It opens on the authored position spring out of a hair of scale (the
 * design system's `pop`) and fades out on the fast step; reduced motion makes
 * every one of those a jump. A stray tap on the backdrop closes only at fit
 * scale — once zoomed, a tap outside is far more likely a missed pan.
 */
import { useEffect, useState } from "react";
import { Modal, Pressable, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Text } from "@/components/ui/Text";
import { IconButton } from "@/components/ui/IconButton";
import { Avatar } from "@/components/Avatar";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { OVERLAY_MOTION } from "@/theme/motion-presets";
import { colors, radius, space } from "@/theme/theme";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** What a double-tap zooms to — enough to read a face, not so much it gets lost. */
const DOUBLE_TAP_SCALE = 2.5;
/** Drag distance / flick speed past which a swipe down at fit closes the viewer. */
const DISMISS_DISTANCE = 140;
const DISMISS_VELOCITY = 1200;

function clampValue(v: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, v));
}

export function AvatarLightbox({
  visible,
  url,
  name,
  onClose,
}: {
  visible: boolean;
  url?: string | null;
  /** Drives the initials tile when there is no photo (also tints it). */
  name: string;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  // Square viewport, inset from the edges so the close button never overlaps it.
  const size = Math.min(width, height) - space.xl * 2;

  const [mounted, setMounted] = useState(visible);
  const [zoomed, setZoomed] = useState(false);

  const open = useSharedValue(0);
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const drag = useSharedValue(0);
  const sizeSV = useSharedValue(size);
  useEffect(() => {
    sizeSV.value = size;
  }, [size, sizeSV]);

  const resetNow = () => {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    drag.value = 0;
    setZoomed(false);
  };

  useEffect(() => {
    if (visible) {
      setMounted(true);
      resetNow();
      open.value = 0;
      open.value = motionTo(1, "position", { reduced });
      return;
    }
    if (!mounted) return;
    open.value = motionTo(0, "fast", {
      reduced,
      onDone: (finished) => {
        "worklet";
        if (finished) scheduleOnRN(setMounted, false);
      },
    });
  }, [visible]);

  /** Keep the zoomed image's edges outside the viewport (no empty band). */
  const clampPan = (v: number, s: number) => {
    "worklet";
    const overflow = Math.max(0, (sizeSV.value * s - sizeSV.value) / 2);
    return clampValue(v, -overflow, overflow);
  };

  const zoomedJs = (z: boolean) => setZoomed(z);

  const pinchStart = useSharedValue({ s: 1, x: 0, y: 0, fx: 0, fy: 0 });
  const pinch = Gesture.Pinch()
    .onStart((e) => {
      "worklet";
      // Focal point relative to the viewport centre.
      pinchStart.value = {
        s: scale.value,
        x: tx.value,
        y: ty.value,
        fx: e.focalX - sizeSV.value / 2,
        fy: e.focalY - sizeSV.value / 2,
      };
    })
    .onUpdate((e) => {
      "worklet";
      const st = pinchStart.value;
      const next = clampValue(st.s * e.scale, MIN_SCALE, MAX_SCALE);
      const k = next / st.s;
      // The image point under the fingers stays under the fingers.
      scale.value = next;
      tx.value = clampPan(st.fx - (st.fx - st.x) * k, next);
      ty.value = clampPan(st.fy - (st.fy - st.y) * k, next);
    })
    .onEnd(() => {
      "worklet";
      if (scale.value <= MIN_SCALE + 0.01) {
        scale.value = motionTo(1, "position", { reduced });
        tx.value = motionTo(0, "position", { reduced });
        ty.value = motionTo(0, "position", { reduced });
      }
      scheduleOnRN(zoomedJs, scale.value > MIN_SCALE + 0.01);
    });

  const panStart = useSharedValue({ x: 0, y: 0 });
  const pan = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      "worklet";
      panStart.value = { x: tx.value, y: ty.value };
    })
    .onUpdate((e) => {
      "worklet";
      if (scale.value > MIN_SCALE + 0.01) {
        tx.value = clampPan(panStart.value.x + e.translationX, scale.value);
        ty.value = clampPan(panStart.value.y + e.translationY, scale.value);
      } else {
        // At fit: a vertical drag is the dismiss gesture.
        drag.value = e.translationY;
      }
    })
    .onEnd((e) => {
      "worklet";
      if (scale.value > MIN_SCALE + 0.01) return;
      if (Math.abs(drag.value) > DISMISS_DISTANCE || Math.abs(e.velocityY) > DISMISS_VELOCITY) {
        scheduleOnRN(onClose);
        return;
      }
      drag.value = motionTo(0, "position", { reduced, velocity: e.velocityY });
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(280)
    .onEnd((e, success) => {
      "worklet";
      if (!success) return;
      if (scale.value > MIN_SCALE + 0.01) {
        scale.value = motionTo(1, "position", { reduced });
        tx.value = motionTo(0, "position", { reduced });
        ty.value = motionTo(0, "position", { reduced });
        scheduleOnRN(zoomedJs, false);
        return;
      }
      const fx = e.x - sizeSV.value / 2;
      const fy = e.y - sizeSV.value / 2;
      const k = DOUBLE_TAP_SCALE;
      scale.value = motionTo(k, "position", { reduced });
      tx.value = motionTo(clampPan(fx - fx * k, k), "position", { reduced });
      ty.value = motionTo(clampPan(fy - fy * k, k), "position", { reduced });
      scheduleOnRN(zoomedJs, true);
    });

  const gesture = Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pinch, pan));

  const { from } = OVERLAY_MOTION.pop;
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: open.value * (1 - Math.min(1, Math.abs(drag.value) / 400) * 0.6),
  }));
  const frameStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [
      { translateY: drag.value },
      { scale: from.scale + (1 - from.scale) * open.value },
    ],
  }));
  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: open.value }));

  const trimmedUrl = url?.trim() ? url.trim() : null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      supportedOrientations={["portrait", "landscape"]}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.rail }, backdropStyle]}
        />
        {/* Tapping the backdrop closes — but only at fit scale (see header). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common:buttons.close")}
          onPress={zoomed ? undefined : onClose}
          disabled={zoomed}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <GestureDetector gesture={gesture}>
            <Animated.View
              accessible
              accessibilityRole="image"
              accessibilityLabel={t("mobile:userProfile.viewAvatar", { name })}
              accessibilityHint={t("mobile:userProfile.avatarZoomHint")}
              style={[{ width: size, height: size, overflow: "hidden", borderRadius: radius.card, borderCurve: "continuous" }, frameStyle]}
            >
              <Animated.View style={[{ width: size, height: size }, imageStyle]}>
                {trimmedUrl ? (
                  <Image
                    source={{ uri: trimmedUrl }}
                    style={{ width: size, height: size }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                    allowDownscaling={false}
                    transition={reduced ? 0 : 120}
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  // No photo: the same initials tile the rest of the app uses, so
                  // the gesture is consistent for every person in the roster.
                  <View style={{ alignItems: "center", justifyContent: "center", flex: 1 }}>
                    <Avatar name={name} size={size * 0.7} uri={null} />
                  </View>
                )}
              </Animated.View>
            </Animated.View>
          </GestureDetector>
        </Pressable>

        <Animated.View style={[{ position: "absolute", top: insets.top + space.sm, right: space.md }, chromeStyle]}>
          <IconButton icon={X} variant="veil" size="lg" label={t("common:buttons.close")} onPress={onClose} />
        </Animated.View>

        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + space.lg, alignItems: "center", gap: 2 }, chromeStyle]}
        >
          <Text type="subheading" tone="display" numberOfLines={1}>
            {name}
          </Text>
          <Text type="caption" tone="faint">
            {t("mobile:userProfile.avatarZoomHint")}
          </Text>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
