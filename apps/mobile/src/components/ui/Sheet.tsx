/**
 * Sheet — the draggable bottom sheet every mobile menu, picker and detail
 * panel opens in. The RN twin of the desktop Dialog/Sheet on Koyu Masa:
 * borderless base card (radius 24 on top), a grabber, an optional Onest title,
 * over the 55% scrim.
 *
 * Motion (theme/motion.ts presets, reduced motion honoured):
 *  - Opens on the authored position spring from below; the scrim fades with
 *    the card's travel (it is DERIVED from the card position, so a drag dims
 *    and undims it continuously instead of on a timer).
 *  - Drag the grabber, the header, or the content when it is scrolled to the
 *    top. Release picks a snap with velocity projection (kit-math
 *    `resolveRelease`): a flick lands one stop further, a hard downward flick
 *    or a drag past the last stop dismisses. Pulling above the top stop
 *    rubber-bands instead of hitting a wall.
 *  - The released velocity is handed to the spring, so the card keeps its
 *    momentum instead of restarting from rest.
 *
 * Keyboard: the card lifts by the REAL IME height (lib/use-keyboard-height —
 * KeyboardAvoidingView gets no inset under Android edge-to-edge), and its
 * height cap shrinks with it, so a text field in a sheet is never buried.
 *
 * Accessibility: modal to TalkBack/VoiceOver, the Android back button and the
 * iOS escape gesture close it (when dismissible), the scrim and the grabber are
 * labelled close buttons, the title is a header.
 *
 * Dismissal is a request, not a fact (ui/sheet-dismiss.ts): a drag, a flick,
 * the scrim or back asks `onClose`, and the card only leaves once the caller
 * flips `visible`. A caller that keeps it open (the member menu's editors step
 * back to the menu) gets the card sprung back from the release point at once.
 *
 * Built on RN `Modal` (not a third-party sheet) for a window above everything
 * — tabs, the call bar — with the hardware back button wired. Gesture handlers
 * inside a Modal need their own GestureHandlerRootView on Android (it is a
 * separate window), so the sheet brings one. For the same reason the root
 * toaster cannot draw over it: the sheet hosts its own <Toaster/>, which takes
 * the shared queue while the sheet is the topmost window.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Modal,
  Pressable,
  View,
  useWindowDimensions,
  type ScrollView,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTranslation } from "@/lib/i18n";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { motionTo, useReducedMotion } from "@/theme/motion";
import { colors, radius, space } from "@/theme/theme";
import { resolveRelease, resolveSnapHeights, rubberBand, type SnapPoint } from "./kit-math";
import { createDismissController } from "./sheet-dismiss";
import { Text } from "./Text";
import { Toaster } from "./Toast";

export type SheetProps = {
  visible: boolean;
  /** The user asked to close (scrim, drag, back). Flip `visible` to false. */
  onClose: () => void;
  /** After the exit motion finished and the sheet unmounted. */
  onClosed?: () => void;
  title?: string;
  description?: string;
  /** Header row content on the title's right (a "Done" button, a count). */
  headerAccessory?: ReactNode;
  children: ReactNode;
  /** Fixed below the scroll area — primary actions that must stay in reach. */
  footer?: ReactNode;
  /**
   * Snap heights (px or "%" of the available height). Omit for a sheet exactly
   * as tall as its content (menus), capped to the screen.
   */
  snapPoints?: readonly SnapPoint[];
  /** Index into the ascending snap heights to open at. Default 0 (the lowest). */
  initialSnap?: number;
  /** False: no scrim-tap / drag / back dismissal — the caller closes it. */
  dismissible?: boolean;
  /** False: the body does not scroll (it manages its own list). */
  scrollable?: boolean;
  /** Spoken name when there is no `title`. */
  accessibilityLabel?: string;
  /** Inner padding of the content area. Default space.md. */
  contentPadding?: number;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * The body's scroll view, for a caller that must move it (an emoji picker
   * returning to the top when its category changes). Scrollable sheets only.
   */
  scrollRef?: RefObject<ScrollView>;
};

const GRABBER_AREA = 20;

export function Sheet({
  visible,
  onClose,
  onClosed,
  title,
  description,
  headerAccessory,
  children,
  footer,
  snapPoints,
  initialSnap = 0,
  dismissible = true,
  scrollable = true,
  accessibilityLabel,
  contentPadding = space.md,
  contentStyle,
  scrollRef,
}: SheetProps) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { height: windowHeight } = useWindowDimensions();

  const [mounted, setMounted] = useState(visible);

  // Freeze what the card shows while it slides out. Callers typically derive
  // `visible` from a target (`visible={target !== null}`) and render rows FROM
  // that target, so on close the content would empty out and the card would
  // collapse mid-exit. The frozen copy is inert (pointerEvents off below), so a
  // stale row can never fire against a target that is already gone.
  const frozen = useRef({ title, description, headerAccessory, children, footer });
  if (visible) frozen.current = { title, description, headerAccessory, children, footer };
  const shown = frozen.current;
  const [cardHeight, setCardHeight] = useState(0);
  const [atTopSnap, setAtTopSnap] = useState(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Leave the top of the screen visible so the sheet still reads as a sheet,
  // and so the scrim that dismisses it stays reachable.
  const available = Math.max(240, windowHeight - keyboard - insets.top - space.xxl);
  const fixed = snapPoints !== undefined && snapPoints.length > 0;
  const heights = resolveSnapHeights(snapPoints, available, cardHeight);
  const fullHeight = fixed ? (heights[heights.length - 1] ?? 0) : Math.min(cardHeight, available);
  const offsets = heights.map((h) => Math.max(0, fullHeight - h));
  const startIndex = Math.min(Math.max(0, initialSnap), Math.max(0, offsets.length - 1));

  // Card offset (translateY), the gesture's anchor, and the geometry the
  // worklets read. Off-screen until the card has measured itself.
  const y = useSharedValue(windowHeight);
  const anchor = useSharedValue(0);
  const moved = useSharedValue(false);
  const scrollY = useSharedValue(0);
  const closedY = useSharedValue(windowHeight);
  const lowestOpen = useSharedValue(0);
  const offsetsSV = useSharedValue<number[]>([0]);
  const scrollsContent = useSharedValue(false);

  const measured = cardHeight > 0;
  const closedOffset = fullHeight + insets.bottom + space.xxl;

  // Which stop the card rests at — kept across geometry changes (keyboard).
  const snapIndex = useRef(startIndex);
  const offsetsKey = offsets.join(",");

  // Mirror the geometry into the worklets' shared values.
  useEffect(() => {
    offsetsSV.value = offsets;
    closedY.value = closedOffset;
    lowestOpen.value = offsets[0] ?? 0;
  }, [offsetsKey, closedOffset]);

  const finishClose = useCallback(() => {
    if (visibleRef.current) return;
    setMounted(false);
    setCardHeight(0);
    onClosed?.();
  }, [onClosed]);

  // Latest stop offsets, for the JS-side spring back.
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const dismissal = useRef(
    createDismissController({
      close: () => onCloseRef.current(),
      isVisible: () => visibleRef.current,
      springBack: (velocity) => {
        y.value = motionTo(offsetsRef.current[snapIndex.current] ?? 0, "position", {
          velocity,
          reduced: reducedRef.current,
        });
      },
      later: (fn) => requestAnimationFrame(() => requestAnimationFrame(fn)),
    }),
  ).current;

  // Close choreography: slide out, then unmount. After a drag the card leaves
  // on the position spring with the finger's momentum; otherwise (scrim, back,
  // the caller closing it) on the standard step.
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const velocity = dismissal.takeExitVelocity();
    if (!mounted) return;
    const onDone = (finished?: boolean) => {
      "worklet";
      if (finished) scheduleOnRN(finishClose);
    };
    y.value =
      velocity === null
        ? motionTo(closedY.value, "standard", { reduced, onDone })
        : motionTo(closedY.value, "position", { reduced, velocity, onDone });
  }, [visible]);

  // Every commit answers a pending dismiss request: still visible = declined.
  useEffect(() => {
    dismissal.afterCommit(visible);
  });

  // Once mounted AND measured: travel in to the opening stop; afterwards, a
  // geometry change (content grew, keyboard rose) re-settles at the same stop.
  const opened = useRef(false);
  useEffect(() => {
    if (!visible) {
      opened.current = false;
      return;
    }
    if (!measured) return;
    if (!opened.current) {
      opened.current = true;
      snapIndex.current = startIndex;
      y.value = closedOffset;
      setAtTopSnap(startIndex === offsets.length - 1);
    }
    const index = Math.min(snapIndex.current, offsets.length - 1);
    y.value = motionTo(offsets[index] ?? 0, "position", { reduced });
  }, [visible, measured, offsetsKey]);

  const settled = useCallback(
    (index: number) => {
      snapIndex.current = index;
      setAtTopSnap(index === offsets.length - 1);
    },
    [offsets.length],
  );

  /** Scrim, back button, grabber tap: ask without a velocity. */
  const requestClose = useCallback(() => {
    if (!dismissible) return;
    dismissal.request(null);
  }, [dismissible, dismissal]);

  /** A drag released past the dismiss threshold: ask, carrying its speed. */
  const requestDragClose = useCallback(
    (velocity: number) => {
      if (!dismissible) return;
      dismissal.request(velocity);
    },
    [dismissible, dismissal],
  );

  const pan = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onStart(() => {
      "worklet";
      anchor.value = y.value;
      moved.value = false;
    })
    .onUpdate((e) => {
      "worklet";
      const list = offsetsSV.value;
      const top = list[list.length - 1] ?? 0;
      // Content is scrolled: let the list scroll, and re-anchor so the card
      // starts following from the moment the list reaches its top.
      if (scrollY.value > 0) {
        anchor.value = y.value - e.translationY;
        return;
      }
      let next = anchor.value + e.translationY;
      if (next < top) {
        // Above the top stop: a scrolling body takes the gesture; otherwise
        // the card rubber-bands.
        next = scrollsContent.value ? top : top - rubberBand(top - next, closedY.value);
      }
      if (next !== y.value) moved.value = true;
      y.value = next;
    })
    .onEnd((e) => {
      "worklet";
      if (!moved.value) return;
      const list = offsetsSV.value;
      const index = resolveRelease(y.value, e.velocityY, list, closedY.value, dismissible);
      if (index === -1) {
        // Hold at the release point until the caller answers (one commit,
        // ~a frame): it either closes (the exit carries this velocity) or
        // keeps the sheet, which then springs back from right here.
        scheduleOnRN(requestDragClose, e.velocityY);
        return;
      }
      y.value = motionTo(list[index] ?? 0, "position", { velocity: e.velocityY, reduced });
      scheduleOnRN(settled, index);
    });

  const scrollGesture = Gesture.Native();
  const bodyPan = pan.simultaneousWithExternalGesture(scrollGesture);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => {
    const span = Math.max(1, closedY.value - lowestOpen.value);
    const p = 1 - Math.min(1, Math.max(0, (y.value - lowestOpen.value) / span));
    return { opacity: p };
  });

  const onCardLayout = (e: LayoutChangeEvent) => {
    if (fixed) {
      if (cardHeight === 0) setCardHeight(1);
      return;
    }
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0 && h !== cardHeight) setCardHeight(h);
  };

  // The body "scrolls" only when its content is taller than its viewport; a
  // short menu rubber-bands on an upward pull instead.
  const bodyHeight = useRef(0);
  const bodyContent = useRef(0);
  const updateScrolls = () => {
    scrollsContent.value = bodyContent.current > bodyHeight.current + 1;
  };
  const onBodyLayout = (e: LayoutChangeEvent) => {
    bodyHeight.current = e.nativeEvent.layout.height;
    updateScrolls();
  };
  const onBodyContentSize = (_w: number, h: number) => {
    bodyContent.current = h;
    updateScrolls();
  };

  const bottomPad = keyboard > 0 ? space.md : space.md + insets.bottom;
  const close = dismissible ? requestClose : undefined;

  const header = (
    <View>
      <Pressable
        onPress={close}
        disabled={!dismissible}
        accessibilityRole="button"
        accessibilityLabel={t("common:buttons.close")}
        accessibilityElementsHidden={!dismissible}
        importantForAccessibility={dismissible ? "yes" : "no-hide-descendants"}
        style={{ height: GRABBER_AREA, alignItems: "center", justifyContent: "center" }}
      >
        <View style={{ width: 36, height: 4, borderRadius: radius.pill, backgroundColor: colors.strokeStrong }} />
      </Pressable>
      {shown.title || shown.headerAccessory ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            paddingHorizontal: space.lg,
            paddingBottom: shown.description ? space.xs : space.sm,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            {shown.title ? (
              <Text type="heading" tone="display" accessibilityRole="header" numberOfLines={2}>
                {shown.title}
              </Text>
            ) : null}
          </View>
          {shown.headerAccessory}
        </View>
      ) : null}
      {shown.description ? (
        <Text
          type="ui"
          tone="muted"
          style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, fontWeight: "400" }}
        >
          {shown.description}
        </Text>
      ) : null}
    </View>
  );

  const body = scrollable ? (
    <GestureDetector gesture={scrollGesture}>
      <Animated.ScrollView
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        scrollEnabled={atTopSnap || !fixed}
        bounces={false}
        overScrollMode="never"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onLayout={onBodyLayout}
        onContentSizeChange={onBodyContentSize}
        // Natural height: hug the content, but SHRINK under the card's cap so
        // a 17-row moderator menu scrolls instead of running off the screen.
        style={fixed ? { flex: 1 } : { flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={[
          { gap: space.xs, paddingHorizontal: contentPadding, paddingBottom: shown.footer ? space.sm : bottomPad },
          contentStyle,
        ]}
      >
        {shown.children}
      </Animated.ScrollView>
    </GestureDetector>
  ) : (
    <View
      style={[
        fixed ? { flex: 1 } : null,
        { paddingHorizontal: contentPadding, paddingBottom: shown.footer ? space.sm : bottomPad },
        contentStyle,
      ]}
    >
      {shown.children}
    </View>
  );

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => close?.()}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View
          style={[
            { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim },
            scrimStyle,
          ]}
        >
          <Pressable
            onPress={close}
            disabled={!dismissible}
            accessibilityRole="button"
            accessibilityLabel={t("common:buttons.close")}
            importantForAccessibility={dismissible ? "yes" : "no-hide-descendants"}
            style={{ flex: 1 }}
          />
        </Animated.View>
        <View pointerEvents="box-none" style={{ flex: 1, justifyContent: "flex-end", paddingBottom: keyboard }}>
          <GestureDetector gesture={bodyPan}>
            <Animated.View
              accessibilityViewIsModal
              pointerEvents={visible ? "auto" : "none"}
              accessibilityLabel={shown.title ? undefined : accessibilityLabel}
              onAccessibilityEscape={close}
              onLayout={onCardLayout}
              style={[
                {
                  maxHeight: available,
                  height: fixed ? fullHeight : undefined,
                  backgroundColor: colors.app,
                  borderTopLeftRadius: radius.card,
                  borderTopRightRadius: radius.card,
                  borderCurve: "continuous",
                  opacity: measured ? 1 : 0,
                },
                cardStyle,
              ]}
            >
              {header}
              {body}
              {shown.footer ? (
                <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: bottomPad, gap: space.sm }}>
                  {shown.footer}
                </View>
              ) : null}
              {/* Skirt: the card's colour continues below its edge, so a
                  rubber-band pull upward never opens a gap at the bottom. */}
              <View
                pointerEvents="none"
                style={{ position: "absolute", left: 0, right: 0, top: "100%", height: windowHeight, backgroundColor: colors.app }}
              />
            </Animated.View>
          </GestureDetector>
        </View>
        {/* This window's toast host — see the header comment. */}
        <Toaster placement="top" />
      </GestureHandlerRootView>
    </Modal>
  );
}
