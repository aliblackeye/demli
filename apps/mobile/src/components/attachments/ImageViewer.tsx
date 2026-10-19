/**
 * Full-screen image viewer for chat pictures — the mobile twin of the desktop
 * gallery lightbox, driven by touch:
 *
 *  - PINCH to zoom about your fingers (1× – 4×, a soft rubber band past either
 *    end), DRAG to move a zoomed picture (it keeps its momentum; past an edge it
 *    resists, and a release there springs it back), DOUBLE TAP to zoom in at that point / back to fit.
 *  - SWIPE sideways to step through the message's pictures ("2 / 3"); SWIPE
 *    up or down to close, the black backdrop thinning with the drag.
 *  - TAP once to hide / show the controls.
 *
 * Every position change rides the authored position spring (theme/motion), and
 * reduced motion turns each settle into a jump. Screen readers get the same
 * reach without gestures: labelled close, save, copy and previous / next
 * buttons, and the counter.
 *
 * Built on a RN `Modal` (a window above tabs and the call bar). Gestures inside
 * a Modal need their own GestureHandlerRootView on Android, and toasts need
 * their own host here (a root toast could never draw above this window), so
 * the viewer brings both — save / copy outcomes land on top of the picture.
 */
import { useCallback, useEffect, useState } from "react";
import { Modal, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react-native";
import type { ImageActionTarget } from "../../lib/image-actions";
import { useAppTranslation } from "../../lib/i18n";
import { motionTo, useReducedMotion } from "../../theme/motion";
import { colors, motion, radius, space } from "../../theme/theme";
import { IconButton } from "../ui/IconButton";
import { Text } from "../ui/Text";
import { Toaster } from "../ui/Toast";
import { MODAL_RESPONDER_BARRIER } from "../ui/Touchable";
import { ImageActionButtons } from "./ImageActionSheet";
import {
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampAbs,
  containSize,
  panLimit,
  panRelease,
  releasePage,
  rubberPan,
  rubberScale,
  shouldDismiss,
  zoomAbout,
} from "./viewer-math";

export interface ViewerImage {
  /** Stable id (the attachment id). */
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  target: ImageActionTarget;
}

type PanMode = 0 | 1 | 2 | 3; // undecided · move zoomed · page · dismiss

function Page({
  image,
  width,
  height,
  offset,
}: {
  image: ViewerImage;
  width: number;
  height: number;
  /** Page position relative to the current one (−1, 0, +1). */
  offset: number;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const [broken, setBroken] = useState(false);
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: offset * width,
        width,
        height,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {broken ? (
        <View accessibilityRole="alert" style={{ alignItems: "center", gap: space.sm }}>
          <ImageOff size={28} color={colors.fgMuted} />
          <Text type="ui" tone="muted">
            {t("mobile:attachments.openFailed")}
          </Text>
        </View>
      ) : (
        <Image
          source={{ uri: image.url }}
          contentFit="contain"
          transition={reduced ? 0 : motion.duration.fast}
          onError={() => setBroken(true)}
          accessibilityIgnoresInvertColors
          style={{ width, height }}
        />
      )}
    </View>
  );
}

export function ImageViewer({
  images,
  initialIndex,
  onClose,
}: {
  images: readonly ViewerImage[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const count = images.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialIndex), Math.max(0, count - 1)));
  const [chrome, setChrome] = useState(true);

  // Zoom/translate of the CURRENT page, the pager drag, the dismiss drag.
  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const pageX = useSharedValue(-index * W);
  const dismissY = useSharedValue(0);
  // Gesture anchors.
  const s0 = useSharedValue(1);
  const tx0 = useSharedValue(0);
  const ty0 = useSharedValue(0);
  const mode = useSharedValue<PanMode>(0);
  const indexSV = useSharedValue(index);
  const pinching = useSharedValue(false);

  const current = images[index];
  const fitted = containSize(current?.width ?? null, current?.height ?? null, W, H);
  const fitW = useSharedValue(fitted.width);
  const fitH = useSharedValue(fitted.height);
  useEffect(() => {
    fitW.value = fitted.width;
    fitH.value = fitted.height;
  }, [fitted.width, fitted.height, fitW, fitH]);

  // A new page starts at fit; the pager settles on it (also after a rotation).
  useEffect(() => {
    indexSV.value = index;
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
    pageX.value = motionTo(-index * W, "position", { reduced });
  }, [index, W, reduced, indexSV, scale, tx, ty, pageX]);

  const goTo = useCallback(
    (next: number) => setIndex(Math.min(count - 1, Math.max(0, next))),
    [count],
  );
  const toggleChrome = useCallback(() => setChrome((c) => !c), []);

  const settleInside = () => {
    "worklet";
    const lx = panLimit(fitW.value, scale.value, W);
    const ly = panLimit(fitH.value, scale.value, H);
    tx.value = motionTo(clampAbs(tx.value, lx), "position", { reduced });
    ty.value = motionTo(clampAbs(ty.value, ly), "position", { reduced });
  };

  const pinch = Gesture.Pinch()
    .onStart(() => {
      "worklet";
      pinching.value = true;
      s0.value = scale.value;
      tx0.value = tx.value;
      ty0.value = ty.value;
    })
    .onUpdate((e) => {
      "worklet";
      const next = rubberScale(s0.value * e.scale);
      const fx = e.focalX - W / 2;
      const fy = e.focalY - H / 2;
      tx.value = zoomAbout(tx0.value, fx, s0.value, next);
      ty.value = zoomAbout(ty0.value, fy, s0.value, next);
      scale.value = next;
    })
    .onEnd(() => {
      "worklet";
      pinching.value = false;
      if (scale.value <= MIN_ZOOM) {
        scale.value = motionTo(MIN_ZOOM, "position", { reduced });
        tx.value = motionTo(0, "position", { reduced });
        ty.value = motionTo(0, "position", { reduced });
        return;
      }
      if (scale.value > MAX_ZOOM) scale.value = motionTo(MAX_ZOOM, "position", { reduced });
      const s = Math.min(MAX_ZOOM, scale.value);
      const lx = panLimit(fitW.value, s, W);
      const ly = panLimit(fitH.value, s, H);
      tx.value = motionTo(clampAbs(tx.value, lx), "position", { reduced });
      ty.value = motionTo(clampAbs(ty.value, ly), "position", { reduced });
    });

  const pan = Gesture.Pan()
    .maxPointers(1)
    .onStart(() => {
      "worklet";
      mode.value = scale.value > 1.01 ? 1 : 0;
      tx0.value = tx.value;
      ty0.value = ty.value;
    })
    .onUpdate((e) => {
      "worklet";
      if (pinching.value) return;
      if (mode.value === 0) {
        if (Math.abs(e.translationX) < 10 && Math.abs(e.translationY) < 10) return;
        mode.value = Math.abs(e.translationX) > Math.abs(e.translationY) && count > 1 ? 2 : 3;
      }
      if (mode.value === 1) {
        tx.value = rubberPan(tx0.value + e.translationX, panLimit(fitW.value, scale.value, W), W);
        ty.value = rubberPan(ty0.value + e.translationY, panLimit(fitH.value, scale.value, H), H);
      } else if (mode.value === 2) {
        const atStart = indexSV.value === 0 && e.translationX > 0;
        const atEnd = indexSV.value === count - 1 && e.translationX < 0;
        const dx = atStart || atEnd ? e.translationX * 0.3 : e.translationX;
        pageX.value = -indexSV.value * W + dx;
      } else {
        dismissY.value = e.translationY;
      }
    })
    .onEnd((e) => {
      "worklet";
      if (mode.value === 1) {
        const lx = panLimit(fitW.value, scale.value, W);
        const ly = panLimit(fitH.value, scale.value, H);
        if (reduced) {
          settleInside();
          return;
        }
        // Let go past an edge: spring back to it. Inside: momentum that bounces
        // off an edge. (A rigid clamped decay finishes at once when the finger
        // stopped, leaving the picture off its edge — so it is never used.)
        tx.value =
          panRelease(tx.value, lx) === "spring"
            ? motionTo(clampAbs(tx.value, lx), "position", { velocity: e.velocityX })
            : withDecay({ velocity: e.velocityX, clamp: [-lx, lx], rubberBandEffect: true, reduceMotion: ReduceMotion.System });
        ty.value =
          panRelease(ty.value, ly) === "spring"
            ? motionTo(clampAbs(ty.value, ly), "position", { velocity: e.velocityY })
            : withDecay({ velocity: e.velocityY, clamp: [-ly, ly], rubberBandEffect: true, reduceMotion: ReduceMotion.System });
      } else if (mode.value === 2) {
        const next = releasePage(indexSV.value, e.translationX, e.velocityX, W, count);
        pageX.value = motionTo(-next * W, "position", { reduced, velocity: e.velocityX });
        if (next !== indexSV.value) scheduleOnRN(goTo, next);
      } else if (mode.value === 3) {
        if (shouldDismiss(e.translationY, e.velocityY)) {
          const to = (e.translationY >= 0 ? 1 : -1) * H;
          dismissY.value = withTiming(
            to,
            { duration: motion.duration.fast, reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System },
            (finished) => {
              "worklet";
              if (finished) scheduleOnRN(onClose);
            },
          );
        } else {
          dismissY.value = motionTo(0, "position", { reduced, velocity: e.velocityY });
        }
      }
      mode.value = 0;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(260)
    .onEnd((e) => {
      "worklet";
      if (scale.value > 1.01) {
        scale.value = motionTo(1, "position", { reduced });
        tx.value = motionTo(0, "position", { reduced });
        ty.value = motionTo(0, "position", { reduced });
        return;
      }
      const s = DOUBLE_TAP_ZOOM;
      const fx = e.x - W / 2;
      const fy = e.y - H / 2;
      scale.value = motionTo(s, "position", { reduced });
      tx.value = motionTo(clampAbs(zoomAbout(0, fx, 1, s), panLimit(fitW.value, s, W)), "position", { reduced });
      ty.value = motionTo(clampAbs(zoomAbout(0, fy, 1, s), panLimit(fitH.value, s, H)), "position", { reduced });
    });

  const singleTap = Gesture.Tap()
    .maxDuration(260)
    .onEnd(() => {
      "worklet";
      scheduleOnRN(toggleChrome);
    });

  const gesture = Gesture.Simultaneous(
    Gesture.Simultaneous(pinch, pan),
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(0.85, Math.abs(dismissY.value) / (H * 0.7)),
  }));
  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: pageX.value }, { translateY: dismissY.value }],
  }));
  const zoomStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  if (count === 0 || !current) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }} {...MODAL_RESPONDER_BARRIER}>
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.rail }, backdropStyle]}
        />
        <GestureDetector gesture={gesture}>
          <Animated.View
            accessible
            accessibilityRole="image"
            accessibilityLabel={t("mobile:attachments.position", { index: index + 1, total: count })}
            style={{ flex: 1, overflow: "hidden" }}
          >
            <Animated.View style={[{ width: W, height: H }, pagerStyle]}>
              {images.map((image, i) => {
                const offset = i - index;
                // Only the current picture and its neighbours are mounted.
                if (Math.abs(offset) > 1) return null;
                return (
                  <Animated.View
                    key={image.id}
                    style={[
                      { position: "absolute", top: 0, left: i * W, width: W, height: H },
                      i === index ? zoomStyle : null,
                    ]}
                  >
                    <Page image={image} width={W} height={H} offset={0} />
                  </Animated.View>
                );
              })}
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        {chrome ? (
          <Animated.View
            entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            pointerEvents="box-none"
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          >
            <View
              style={{
                position: "absolute",
                top: insets.top + space.sm,
                left: space.md,
                right: space.md,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
              }}
            >
              <IconButton icon={X} label={t("common:buttons.close")} variant="veil" size="lg" onPress={onClose} />
              {count > 1 ? (
                <View
                  style={{
                    paddingHorizontal: space.md,
                    height: 32,
                    justifyContent: "center",
                    borderRadius: radius.pill,
                    backgroundColor: colors.veil,
                  }}
                >
                  <Text type="meta" tone="display" style={{ fontVariant: ["tabular-nums"] }}>
                    {t("mobile:attachments.position", { index: index + 1, total: count })}
                  </Text>
                </View>
              ) : null}
              <ImageActionButtons target={current.target} t={t} />
            </View>
            {count > 1 ? (
              <View
                pointerEvents="box-none"
                style={{
                  position: "absolute",
                  bottom: insets.bottom + space.lg,
                  left: space.md,
                  right: space.md,
                  flexDirection: "row",
                  justifyContent: "space-between",
                }}
              >
                <IconButton
                  icon={ChevronLeft}
                  label={t("mobile:attachments.previousImage")}
                  variant="veil"
                  size="lg"
                  disabled={index === 0}
                  onPress={() => goTo(index - 1)}
                />
                <IconButton
                  icon={ChevronRight}
                  label={t("mobile:attachments.nextImage")}
                  variant="veil"
                  size="lg"
                  disabled={index === count - 1}
                  onPress={() => goTo(index + 1)}
                />
              </View>
            ) : null}
          </Animated.View>
        ) : null}
        {/* This window's toast host (save / copy outcomes). */}
        <Toaster placement="top" />
      </GestureHandlerRootView>
    </Modal>
  );
}
