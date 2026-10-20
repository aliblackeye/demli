/**
 * ImageCropEditor — frame a new avatar (circle) or banner (8:3, the profile
 * card's shape) before it becomes a draft. The mobile twin of the desktop
 * ImageCropDialog, on the same geometry (lib/image-crop.ts) and export sizes.
 *
 *  - Pinch to zoom about the point between your fingers, drag to move, double
 *    tap to jump to 2× there (and back). Everything runs on the UI thread
 *    (gesture-handler → Reanimated shared values); React only hears about the
 *    zoom when a gesture settles, for the slider and Reset.
 *  - The mask is ALWAYS filled (clampCropState on every frame): you cannot zoom
 *    out past cover or drag an empty edge into the frame, so the circle shows
 *    exactly what gets exported.
 *  - Live preview: the profile-card identity block and a message row redraw
 *    from the same shared values, at frame rate, while you pinch.
 *  - A GIF banner asks first: keep it moving (byte-for-byte) or crop a still.
 *    A GIF avatar is cropped as its first frame, and says so.
 *  - TalkBack: the stage is an adjustable control (swipe up/down zooms) with
 *    move actions in its actions menu; reduced motion makes the double-tap jump.
 *
 * A full-screen window (RN Modal) over everything, with its own
 * GestureHandlerRootView — gesture handlers in a Modal need one on Android.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { ImagePlus, Minus, Plus, RotateCcw, Sparkles, Crop, X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import {
  CROP_ASPECT,
  DOUBLE_TAP_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampCropState,
  coverScale,
  cropRect,
  imageTransform,
  initialCropState,
  isInitialCrop,
  maskSizeFor,
  panCrop,
  zoomCrop,
  type Size,
} from "@/lib/image-crop";
import {
  ProfileImageError,
  exportProfileCrop,
  gifFitsBannerCap,
  keepAnimatedBanner,
  type PickedProfileImage,
  type ProfileImageSource,
} from "@/lib/profile-image";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, motion, radius, space } from "@/theme/theme";
import { Avatar } from "@/components/Avatar";
import { ProfileBannerImage } from "@/components/ProfileBannerImage";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Slider } from "@/components/ui/Slider";
import { Text } from "@/components/ui/Text";
import { Touchable } from "@/components/ui/Touchable";

/** Breathing room between the mask and the stage edge (the dimmed image shows there). */
const STAGE_INSET = { avatar: space.xl, banner: space.lg } as const;
/** Banner frame corner — the card's own radius step. */
const FRAME_RADIUS = radius.lg;
/** Zoom per tap on the −/+ buttons and per TalkBack swipe. */
const ZOOM_STEP = 0.25;

type Mode = "choice" | "crop";

export type ImageCropEditorProps = {
  /** The picked image. `null` = closed. */
  source: ProfileImageSource | null;
  onCancel: () => void;
  /** The framed image, ready to hold as a draft, for the kind it was framed as. */
  onApply: (image: PickedProfileImage, kind: ProfileImageSource["kind"]) => void;
  /** Re-open the picker (the parent swaps `source`). */
  onChooseAnother: () => void;
  /** Preview context: whose card this is. */
  displayName: string;
  seedId: string;
  /** The avatar the banner preview shows (current draft or saved). */
  avatarUri: string | null;
  /** The banner the avatar preview shows (current draft or saved). */
  bannerUri: string | null;
};

export function ImageCropEditor(props: ImageCropEditorProps) {
  const { source, onCancel } = props;
  return (
    <Modal
      visible={source !== null}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onCancel}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* Keyed by the source, so "choose another image" starts a fresh crop. */}
        {source ? <EditorBody key={source.uri} {...props} source={source} /> : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

function EditorBody({
  source,
  onCancel,
  onApply,
  onChooseAnother,
  displayName,
  seedId,
  avatarUri,
  bannerUri,
}: ImageCropEditorProps & { source: ProfileImageSource }) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const kind = source.kind;
  const image = source.size;

  // A GIF banner that fits the cap may stay animated — ask before cropping.
  const [mode, setMode] = useState<Mode>(() =>
    kind === "banner" && source.gif && gifFitsBannerCap(source) ? "choice" : "crop",
  );
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Geometry ───────────────────────────────────────────────────────────────
  const [stage, setStage] = useState<Size | null>(null);
  const mask = useMemo(
    () => (stage ? maskSizeFor(kind, stage, STAGE_INSET[kind]) : null),
    [stage, kind],
  );
  const cover = mask ? coverScale(image, mask) : 1;
  const base = { width: image.width * cover, height: image.height * cover };

  // Shared state the worklets read and write: the crop + the mask it lives in.
  const zoom = useSharedValue(MIN_ZOOM);
  const cx = useSharedValue(image.width / 2);
  const cy = useSharedValue(image.height / 2);
  const maskW = useSharedValue(1);
  const maskH = useSharedValue(1);
  const active = useSharedValue(0);
  const lastReported = useSharedValue(MIN_ZOOM);
  /** Half the stage size: the mask is centred in it, so focal − this = mask-relative anchor. */
  const stageHalf = useSharedValue({ x: 0, y: 0 });

  useEffect(() => {
    if (!mask) return;
    maskW.value = mask.width;
    maskH.value = mask.height;
    // Re-fit the current crop to the new mask (rotation / first layout).
    const next = clampCropState({ zoom: zoom.value, center: { x: cx.value, y: cy.value } }, image, mask);
    zoom.value = next.zoom;
    cx.value = next.center.x;
    cy.value = next.center.y;
    settled.current = { zoom: next.zoom, x: next.center.x, y: next.center.y };
  }, [mask?.width, mask?.height]);

  // React's copy of the crop — only what the controls need, set when a gesture
  // settles (and, throttled, while pinching so the slider follows the fingers).
  const [zoomJs, setZoomJs] = useState(MIN_ZOOM);
  const [pristine, setPristine] = useState(true);
  /**
   * The crop as of the last settled gesture / control — the TARGET of any
   * spring still running. Apply exports this, never a mid-animation frame read
   * off the shared values.
   */
  const settled = useRef({ zoom: MIN_ZOOM, x: image.width / 2, y: image.height / 2 });
  /** False once the editor unmounts (cancelled): a late export must not land. */
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const sync = useCallback(
    (z: number, x: number, y: number) => {
      settled.current = { zoom: z, x, y };
      setZoomJs(z);
      if (mask) setPristine(isInitialCrop({ zoom: z, center: { x, y } }, image, mask));
    },
    [mask, image.width, image.height],
  );

  const write = (next: { zoom: number; center: { x: number; y: number } }) => {
    "worklet";
    zoom.value = next.zoom;
    cx.value = next.center.x;
    cy.value = next.center.y;
  };

  const img = { width: image.width, height: image.height };

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onBegin(() => {
      "worklet";
      active.value = withTiming(1, { duration: motion.duration.fast, reduceMotion: ReduceMotion.System });
    })
    .onChange((e) => {
      "worklet";
      const m = { width: maskW.value, height: maskH.value };
      write(panCrop({ zoom: zoom.value, center: { x: cx.value, y: cy.value } }, { x: e.changeX, y: e.changeY }, img, m));
    })
    .onFinalize(() => {
      "worklet";
      active.value = withTiming(0, { duration: motion.duration.hover, reduceMotion: ReduceMotion.System });
      scheduleOnRN(sync, zoom.value, cx.value, cy.value);
    });

  const pinch = Gesture.Pinch()
    .onChange((e) => {
      "worklet";
      const m = { width: maskW.value, height: maskH.value };
      // The stage centres the mask, so the focal point relative to the mask
      // centre is the focal point relative to the stage centre.
      const anchor = { x: e.focalX - stageHalf.value.x, y: e.focalY - stageHalf.value.y };
      write(
        zoomCrop(
          { zoom: zoom.value, center: { x: cx.value, y: cy.value } },
          zoom.value * e.scaleChange,
          img,
          m,
          anchor,
        ),
      );
      if (Math.abs(zoom.value - lastReported.value) > 0.04) {
        lastReported.value = zoom.value;
        scheduleOnRN(setZoomJs, zoom.value);
      }
    })
    .onFinalize(() => {
      "worklet";
      lastReported.value = zoom.value;
      scheduleOnRN(sync, zoom.value, cx.value, cy.value);
    });

  /** JS-side haptic for the double tap (a worklet hands a plain function back to RN). */
  const tapFeedback = useCallback(() => haptics.selection(), []);

  /** Animate to a target crop on the position spring (or jump, reduced motion). */
  const animateTo = (next: { zoom: number; center: { x: number; y: number } }) => {
    "worklet";
    zoom.value = motionTo(next.zoom, "position", { reduced });
    cx.value = motionTo(next.center.x, "position", { reduced });
    cy.value = motionTo(next.center.y, "position", { reduced });
  };

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(260)
    .onEnd((e, success) => {
      "worklet";
      if (!success) return;
      const m = { width: maskW.value, height: maskH.value };
      const current = { zoom: zoom.value, center: { x: cx.value, y: cy.value } };
      const target =
        zoom.value > MIN_ZOOM + 0.01
          ? clampCropState({ zoom: MIN_ZOOM, center: current.center }, img, m)
          : zoomCrop(current, DOUBLE_TAP_ZOOM, img, m, {
              x: e.x - stageHalf.value.x,
              y: e.y - stageHalf.value.y,
            });
      animateTo(target);
      scheduleOnRN(tapFeedback);
      scheduleOnRN(sync, target.zoom, target.center.x, target.center.y);
    });

  const gesture = Gesture.Exclusive(doubleTap, Gesture.Simultaneous(pan, pinch));

  // ── Controls (JS thread) ──────────────────────────────────────────────────
  const zoomTo = (next: number, animated: boolean) => {
    if (!mask) return;
    const target = zoomCrop({ zoom: zoom.value, center: { x: cx.value, y: cy.value } }, next, image, mask);
    if (animated) animateTo(target);
    else write(target);
    sync(target.zoom, target.center.x, target.center.y);
  };

  const nudge = (dx: number, dy: number) => {
    if (!mask) return;
    const target = panCrop(
      { zoom: zoom.value, center: { x: cx.value, y: cy.value } },
      { x: dx * mask.width, y: dy * mask.height },
      image,
      mask,
    );
    animateTo(target);
    sync(target.zoom, target.center.x, target.center.y);
  };

  const reset = () => {
    if (!mask) return;
    const target = clampCropState(initialCropState(image), image, mask);
    animateTo(target);
    haptics.selection();
    sync(target.zoom, target.center.x, target.center.y);
  };

  const apply = async () => {
    if (!mask || applying) return;
    setError(null);
    setApplying(true);
    try {
      const { zoom: z, x, y } = settled.current;
      const rect = cropRect({ zoom: z, center: { x, y } }, image, mask);
      const result = await exportProfileCrop(source, rect);
      if (!alive.current) return;
      haptics.light();
      onApply(result, kind);
    } catch (err) {
      if (!alive.current) return;
      setError(
        err instanceof ProfileImageError ? t(err.key) : t("mobile:profile.imageUnreadable"),
      );
      setApplying(false);
    }
  };

  const keepMoving = async () => {
    if (applying) return;
    setError(null);
    setApplying(true);
    try {
      const result = await keepAnimatedBanner(source);
      if (!alive.current) return;
      haptics.light();
      onApply(result, kind);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof ProfileImageError ? t(err.key) : t("mobile:profile.imageUnreadable"));
      setApplying(false);
    }
  };

  // ── Animated styles ───────────────────────────────────────────────────────
  const imageStyle = useAnimatedStyle(() => {
    const m = { width: maskW.value, height: maskH.value };
    const tr = imageTransform({ zoom: zoom.value, center: { x: cx.value, y: cy.value } }, img, m);
    return { transform: [{ translateX: tr.x }, { translateY: tr.y }, { scale: tr.scale }] };
  });
  const guideStyle = useAnimatedStyle(() => ({ opacity: active.value }));

  const onStageLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (!stage || Math.abs(stage.width - width) > 0.5 || Math.abs(stage.height - height) > 0.5) {
      setStage({ width, height });
      stageHalf.value = { x: width / 2, y: height / 2 };
    }
  };

  const title = kind === "avatar" ? t("mobile:imageEditor.avatarTitle") : t("mobile:imageEditor.bannerTitle");
  const percent = Math.round(zoomJs * 100);
  const maskLeft = stage && mask ? (stage.width - mask.width) / 2 : 0;
  const maskTop = stage && mask ? (stage.height - mask.height) / 2 : 0;
  const previewWidth = Math.min(windowWidth - space.lg * 2, 420);

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      accessibilityViewIsModal
      style={{ flex: 1, backgroundColor: colors.rail, paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      {/* Top bar: close · title · reset */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, minHeight: 56 }}>
        <IconButton icon={X} label={t("common:buttons.cancel")} onPress={onCancel} disabled={applying} />
        <Text type="heading" tone="display" accessibilityRole="header" numberOfLines={1} style={{ flex: 1 }}>
          {title}
        </Text>
        {mode === "crop" ? (
          <Button
            label={t("mobile:imageEditor.reset")}
            icon={RotateCcw}
            variant="ghost"
            size="sm"
            onPress={reset}
            disabled={pristine || applying}
          />
        ) : null}
      </View>

      {mode === "choice" ? (
        <AnimatedChoice
          source={source}
          applying={applying}
          error={error}
          onKeep={() => void keepMoving()}
          onCrop={() => setMode("crop")}
        />
      ) : (
        <>
          <Text type="meta" tone="muted" style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
            {kind === "avatar" ? t("mobile:imageEditor.avatarHint") : t("mobile:imageEditor.bannerHint")}
          </Text>

          {/* Stage: the whole area takes the gestures, not just the mask. */}
          <GestureDetector gesture={gesture}>
            <View
              onLayout={onStageLayout}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={t("mobile:imageEditor.stageLabel")}
              accessibilityHint={t("mobile:imageEditor.stageHint")}
              accessibilityValue={{ min: MIN_ZOOM * 100, max: MAX_ZOOM * 100, now: percent, text: t("mobile:imageEditor.zoomValue", { percent }) }}
              accessibilityActions={[
                { name: "increment" },
                { name: "decrement" },
                { name: "moveLeft", label: t("mobile:imageEditor.moveLeft") },
                { name: "moveRight", label: t("mobile:imageEditor.moveRight") },
                { name: "moveUp", label: t("mobile:imageEditor.moveUp") },
                { name: "moveDown", label: t("mobile:imageEditor.moveDown") },
                { name: "reset", label: t("mobile:imageEditor.reset") },
              ]}
              onAccessibilityAction={(e) => {
                switch (e.nativeEvent.actionName) {
                  case "increment":
                    zoomTo(zoom.value + ZOOM_STEP, true);
                    break;
                  case "decrement":
                    zoomTo(zoom.value - ZOOM_STEP, true);
                    break;
                  // "Move left" shows more of the left: the image travels right.
                  case "moveLeft":
                    nudge(0.1, 0);
                    break;
                  case "moveRight":
                    nudge(-0.1, 0);
                    break;
                  case "moveUp":
                    nudge(0, 0.1);
                    break;
                  case "moveDown":
                    nudge(0, -0.1);
                    break;
                  case "reset":
                    reset();
                    break;
                }
              }}
              style={{ flex: 1, overflow: "hidden" }}
            >
              {stage && mask ? (
                <>
                  <View
                    pointerEvents="none"
                    style={{ position: "absolute", left: maskLeft, top: maskTop, width: mask.width, height: mask.height }}
                  >
                    <Animated.View
                      style={[
                        { position: "absolute", left: 0, top: 0, width: base.width, height: base.height, transformOrigin: "left top" },
                        imageStyle,
                      ]}
                    >
                      <Image
                        source={{ uri: source.uri }}
                        style={{ width: base.width, height: base.height }}
                        contentFit="fill"
                        allowDownscaling={false}
                        accessibilityIgnoresInvertColors
                      />
                    </Animated.View>
                  </View>
                  <MaskOverlay stage={stage} mask={mask} kind={kind} />
                  <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, guideStyle]}>
                    <ThirdsGuide stage={stage} mask={mask} kind={kind} />
                  </Animated.View>
                </>
              ) : null}
            </View>
          </GestureDetector>

          {/* Zoom: − slider + */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, paddingTop: space.sm }}>
            <IconButton
              icon={Minus}
              label={t("mobile:imageEditor.zoomOut")}
              onPress={() => zoomTo(zoom.value - ZOOM_STEP, true)}
              disabled={zoomJs <= MIN_ZOOM + 0.001 || applying}
              size="md"
            />
            <Slider
              value={zoomJs}
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              onValueChange={(v) => zoomTo(v, false)}
              accessibilityLabel={t("mobile:imageEditor.zoom")}
              formatValue={(v) => t("mobile:imageEditor.zoomValue", { percent: Math.round(v * 100) })}
              disabled={applying}
              style={{ flex: 1 }}
            />
            <IconButton
              icon={Plus}
              label={t("mobile:imageEditor.zoomIn")}
              onPress={() => zoomTo(zoom.value + ZOOM_STEP, true)}
              disabled={zoomJs >= MAX_ZOOM - 0.001 || applying}
              size="md"
            />
          </View>

          {/* Live preview — redrawn from the same shared values at frame rate. */}
          {mask ? (
            <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm, alignItems: "center" }}>
              <View style={{ width: previewWidth, gap: space.xs }}>
                <Text type="caption" tone="faint" style={{ textTransform: "uppercase", letterSpacing: 0.6 }}>
                  {t("mobile:imageEditor.previewHeading")}
                </Text>
                {kind === "avatar" ? (
                  <AvatarPreview
                    width={previewWidth}
                    uri={source.uri}
                    base={base}
                    mask={mask}
                    imageStyleSource={{ zoom, cx, cy, maskW, maskH, img }}
                    displayName={displayName}
                    seedId={seedId}
                    bannerUri={bannerUri}
                  />
                ) : (
                  <BannerPreview
                    width={previewWidth}
                    uri={source.uri}
                    base={base}
                    mask={mask}
                    imageStyleSource={{ zoom, cx, cy, maskW, maskH, img }}
                    displayName={displayName}
                    avatarUri={avatarUri}
                  />
                )}
              </View>
            </View>
          ) : null}

          <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
            {kind === "avatar" && source.gif ? (
              <Banner variant="info" title={t("mobile:imageEditor.gifAvatarNotice")} />
            ) : null}
            {error ? <Banner variant="danger" title={t("mobile:imageEditor.errorTitle")} description={error} /> : null}
            <View style={{ flexDirection: "row", gap: space.sm, paddingBottom: space.md }}>
              <Button
                label={t("mobile:imageEditor.chooseAnother")}
                icon={ImagePlus}
                variant="secondary"
                onPress={onChooseAnother}
                disabled={applying}
                style={{ flex: 1 }}
              />
              <Button
                label={applying ? t("mobile:imageEditor.applying") : t("mobile:imageEditor.apply")}
                variant="accent"
                onPress={() => void apply()}
                loading={applying}
                disabled={!mask}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </>
      )}
    </Animated.View>
  );
}

// ── Mask + guides ────────────────────────────────────────────────────────────

/**
 * The dimmed surround with the mask cut out (even-odd fill), plus a hairline
 * at the mask's edge. One SVG, no per-frame work: the mask never moves, the
 * image moves under it.
 */
function MaskOverlay({ stage, mask, kind }: { stage: Size; mask: Size; kind: "avatar" | "banner" }) {
  const left = (stage.width - mask.width) / 2;
  const top = (stage.height - mask.height) / 2;
  const outer = `M0 0H${stage.width}V${stage.height}H0Z`;
  let hole: string;
  if (kind === "avatar") {
    const r = mask.width / 2;
    const cxp = left + r;
    const cyp = top + r;
    hole = `M${cxp - r} ${cyp}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  } else {
    const r = FRAME_RADIUS;
    const w = mask.width;
    const h = mask.height;
    hole =
      `M${left + r} ${top}H${left + w - r}a${r} ${r} 0 0 1 ${r} ${r}V${top + h - r}` +
      `a${r} ${r} 0 0 1 ${-r} ${r}H${left + r}a${r} ${r} 0 0 1 ${-r} ${-r}V${top + r}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
  }
  return (
    <Svg pointerEvents="none" width={stage.width} height={stage.height} style={StyleSheet.absoluteFill}>
      <Path d={`${outer}${hole}`} fill={colors.scrim} fillRule="evenodd" />
      {kind === "avatar" ? (
        <Circle
          cx={left + mask.width / 2}
          cy={top + mask.height / 2}
          r={mask.width / 2 - 0.75}
          stroke={colors.strokeStrong}
          strokeWidth={1.5}
          fill="none"
        />
      ) : (
        <Rect
          x={left + 0.75}
          y={top + 0.75}
          width={mask.width - 1.5}
          height={mask.height - 1.5}
          rx={FRAME_RADIUS}
          stroke={colors.strokeStrong}
          strokeWidth={1.5}
          fill="none"
        />
      )}
    </Svg>
  );
}

/**
 * Rule-of-thirds lines inside the mask, shown only while a finger is down. In
 * the circle each line is the chord at that offset, so nothing pokes out into
 * the dimmed surround.
 */
function ThirdsGuide({ stage, mask, kind }: { stage: Size; mask: Size; kind: "avatar" | "banner" }) {
  const left = (stage.width - mask.width) / 2;
  const top = (stage.height - mask.height) / 2;
  const r = mask.width / 2;
  const lines = [1, 2].flatMap((i) => {
    const vx = (mask.width * i) / 3;
    const hy = (mask.height * i) / 3;
    if (kind === "banner") {
      return [
        { x1: left + vx, y1: top, x2: left + vx, y2: top + mask.height },
        { x1: left, y1: top + hy, x2: left + mask.width, y2: top + hy },
      ];
    }
    const half = Math.sqrt(Math.max(0, r * r - (vx - r) * (vx - r)));
    return [
      { x1: left + vx, y1: top + r - half, x2: left + vx, y2: top + r + half },
      { x1: left + r - half, y1: top + hy, x2: left + r + half, y2: top + hy },
    ];
  });
  return (
    <Svg pointerEvents="none" width={stage.width} height={stage.height}>
      {lines.map((l, i) => (
        <Line key={i} {...l} stroke={colors.strokeStrong} strokeWidth={1} />
      ))}
    </Svg>
  );
}

// ── Live previews ────────────────────────────────────────────────────────────

type CropSource = {
  zoom: { value: number };
  cx: { value: number };
  cy: { value: number };
  maskW: { value: number };
  maskH: { value: number };
  img: Size;
};

/**
 * A viewport of `frame` size showing the current crop: the image is laid out
 * at the editor's base size scaled by frame/mask, and moved by the SAME
 * transform the stage uses (scaled likewise) — so a preview can never show a
 * different crop than the stage.
 */
function CropViewport({
  uri,
  base,
  mask,
  frame,
  round,
  source,
}: {
  uri: string;
  base: Size;
  mask: Size;
  frame: Size;
  round: boolean;
  source: CropSource;
}) {
  const k = frame.width / mask.width;
  const { zoom, cx, cy, maskW, maskH, img } = source;
  const style = useAnimatedStyle(() => {
    const tr = imageTransform(
      { zoom: zoom.value, center: { x: cx.value, y: cy.value } },
      img,
      { width: maskW.value, height: maskH.value },
    );
    return { transform: [{ translateX: tr.x * k }, { translateY: tr.y * k }, { scale: tr.scale }] };
  });
  return (
    <View
      style={{
        width: frame.width,
        height: frame.height,
        borderRadius: round ? radius.pill : 0,
        overflow: "hidden",
        backgroundColor: colors.surface,
      }}
    >
      <Animated.View
        style={[
          { position: "absolute", left: 0, top: 0, width: base.width * k, height: base.height * k, transformOrigin: "left top" },
          style,
        ]}
      >
        <Image source={{ uri }} style={{ width: base.width * k, height: base.height * k }} contentFit="fill" />
      </Animated.View>
    </View>
  );
}

const PREVIEW_AVATAR = 56;
const PREVIEW_ROW_AVATAR = 32;

function AvatarPreview({
  width,
  uri,
  base,
  mask,
  imageStyleSource,
  displayName,
  seedId,
  bannerUri,
}: {
  width: number;
  uri: string;
  base: Size;
  mask: Size;
  imageStyleSource: CropSource;
  displayName: string;
  seedId: string;
  bannerUri: string | null;
}) {
  const { t } = useAppTranslation();
  const cardWidth = Math.round(width * 0.56);
  const bannerHeight = Math.round(cardWidth / CROP_ASPECT.banner);
  return (
    <View style={{ flexDirection: "row", gap: space.sm }}>
      {/* On the profile card: banner + overlapping avatar + name. */}
      <View
        accessible
        accessibilityLabel={t("mobile:imageEditor.previewCard")}
        style={{ width: cardWidth, borderRadius: radius.xl, overflow: "hidden", backgroundColor: colors.sidebar }}
      >
        <ProfileBannerImage bannerUrl={bannerUri} seedId={seedId} height={bannerHeight} />
        <View style={{ paddingHorizontal: space.sm, paddingBottom: space.sm, marginTop: -PREVIEW_AVATAR / 2 }}>
          <View style={{ alignSelf: "flex-start", padding: 3, borderRadius: radius.pill, backgroundColor: colors.sidebar }}>
            <CropViewport
              uri={uri}
              base={base}
              mask={mask}
              frame={{ width: PREVIEW_AVATAR, height: PREVIEW_AVATAR }}
              round
              source={imageStyleSource}
            />
          </View>
          <Text type="ui" tone="display" numberOfLines={1} style={{ fontWeight: "600" }}>
            {displayName}
          </Text>
        </View>
      </View>
      {/* In messages: the 32px row avatar beside a sample line. */}
      <View
        accessible
        accessibilityLabel={t("mobile:imageEditor.previewMessage")}
        style={{
          flex: 1,
          flexDirection: "row",
          gap: space.sm,
          padding: space.sm,
          borderRadius: radius.xl,
          backgroundColor: colors.sidebar,
          alignSelf: "stretch",
        }}
      >
        <CropViewport
          uri={uri}
          base={base}
          mask={mask}
          frame={{ width: PREVIEW_ROW_AVATAR, height: PREVIEW_ROW_AVATAR }}
          round
          source={imageStyleSource}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
            <Text type="meta" tone="default" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "600" }}>
              {displayName}
            </Text>
            <Text type="caption" tone="faint">
              {t("mobile:imageEditor.previewTime")}
            </Text>
          </View>
          <Text type="meta" tone="muted" numberOfLines={3} style={{ fontWeight: "400" }}>
            {t("mobile:imageEditor.previewSample")}
          </Text>
        </View>
      </View>
    </View>
  );
}

function BannerPreview({
  width,
  uri,
  base,
  mask,
  imageStyleSource,
  displayName,
  avatarUri,
}: {
  width: number;
  uri: string;
  base: Size;
  mask: Size;
  imageStyleSource: CropSource;
  displayName: string;
  avatarUri: string | null;
}) {
  const { t } = useAppTranslation();
  const cardWidth = Math.round(width * 0.62);
  const frame = { width: cardWidth, height: Math.round(cardWidth / CROP_ASPECT.banner) };
  return (
    <View
      accessible
      accessibilityLabel={t("mobile:imageEditor.previewCard")}
      style={{ width: cardWidth, alignSelf: "center", borderRadius: radius.xl, overflow: "hidden", backgroundColor: colors.sidebar }}
    >
      <CropViewport uri={uri} base={base} mask={mask} frame={frame} round={false} source={imageStyleSource} />
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.sm, marginTop: -20 }}>
        <View style={{ padding: 3, borderRadius: radius.pill, backgroundColor: colors.sidebar }}>
          <Avatar name={displayName} size={40} uri={avatarUri} />
        </View>
        <Text type="ui" tone="display" numberOfLines={1} style={{ flex: 1, fontWeight: "600", paddingBottom: 2 }}>
          {displayName}
        </Text>
      </View>
    </View>
  );
}

// ── Animated GIF banner: keep it moving, or crop a still ────────────────────

function AnimatedChoice({
  source,
  applying,
  error,
  onKeep,
  onCrop,
}: {
  source: ProfileImageSource;
  applying: boolean;
  error: string | null;
  onKeep: () => void;
  onCrop: () => void;
}) {
  const { t } = useAppTranslation();
  const { width } = useWindowDimensions();
  const previewW = Math.min(width - space.lg * 2, 420);
  return (
    <View style={{ flex: 1, paddingHorizontal: space.lg, gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <Text type="subheading" tone="display">
          {t("mobile:imageEditor.animatedTitle")}
        </Text>
        <Text type="ui" tone="muted" style={{ fontWeight: "400" }}>
          {t("mobile:imageEditor.animatedBody")}
        </Text>
      </View>
      {/* The GIF itself, moving, in the card's 8:3 — exactly how it would show. */}
      <View style={{ width: previewW, height: previewW / CROP_ASPECT.banner, alignSelf: "center", borderRadius: FRAME_RADIUS, overflow: "hidden", backgroundColor: colors.surface }}>
        <Image source={{ uri: source.originalUri }} style={StyleSheet.absoluteFill} contentFit="cover" autoplay />
      </View>
      <ChoiceRow
        icon={<Sparkles size={20} color={colors.accent} />}
        title={t("mobile:imageEditor.keepAnimation")}
        hint={t("mobile:imageEditor.keepAnimationHint")}
        onPress={onKeep}
        busy={applying}
      />
      <ChoiceRow
        icon={<Crop size={20} color={colors.fgMuted} />}
        title={t("mobile:imageEditor.cropStill")}
        hint={t("mobile:imageEditor.cropStillHint")}
        onPress={onCrop}
        disabled={applying}
      />
      {error ? <Banner variant="danger" title={t("mobile:imageEditor.errorTitle")} description={error} /> : null}
    </View>
  );
}

function ChoiceRow({
  icon,
  title,
  hint,
  onPress,
  busy = false,
  disabled = false,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled || busy}
      dimmed={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${hint}`}
      accessibilityState={{ busy }}
      tone={colors.surface}
      pressedTone={colors.surfaceRaised}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.xl, borderCurve: "continuous" }}
    >
      <View style={{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" }}>
        {icon}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text type="body" tone="default" style={{ fontWeight: "600" }}>
          {title}
        </Text>
        <Text type="meta" tone="faint">
          {hint}
        </Text>
      </View>
      {busy ? <ActivityIndicator size="small" color={colors.fgMuted} /> : null}
    </Touchable>
  );
}
