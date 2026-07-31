/**
 * Full-screen avatar viewer — "tap the avatar, see it big, and move around
 * inside it" (founder's reference; desktop's AvatarLightbox).
 *
 * Built on RN core only — `Animated` + `PanResponder` — because the app ships
 * neither react-native-gesture-handler nor reanimated, and pulling one in for a
 * picture viewer would cost OTA-safety (CLAUDE.md §32): a new native module
 * means the change can no longer reach users as a JS update. That constraint
 * shapes the gestures:
 *
 *  - PINCH is implemented from raw touches (two-finger distance ratio) rather
 *    than a gesture library. It is the whole reason the responder tracks
 *    `nativeEvent.touches` instead of just `dx/dy`.
 *  - DOUBLE-TAP toggles between fit and 2.5×, which is how most people zoom a
 *    photo on a phone anyway and is the only zoom that works one-handed.
 *  - PAN is clamped to the scaled image's own overflow, so you can never drag
 *    the picture off-screen and lose it.
 *
 * `useNativeDriver` for both transforms keeps the gesture off the JS thread.
 */

import { useMemo, useRef, useState } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Text } from "@/components/ui/Text";
import { Avatar } from "@/components/Avatar";
import { colors, radius, space, typography } from "@/theme/theme";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** What a double-tap zooms to — enough to read a face, not so much it gets lost. */
const DOUBLE_TAP_SCALE = 2.5;
/** Max gap between two taps that still counts as a double tap. */
const DOUBLE_TAP_MS = 280;

/** Distance between the first two active touches, or null with fewer than two. */
function touchDistance(event: GestureResponderEvent): number | null {
  const touches = event.nativeEvent.touches;
  if (touches.length < 2) return null;
  const [a, b] = touches;
  if (!a || !b) return null;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
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
  const { width, height } = useWindowDimensions();

  // Square viewport, inset from the edges so the close button never overlaps it.
  const size = Math.min(width, height) - space.xl * 2;

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  // Committed values (what the last gesture ended on). `Animated.Value` has no
  // synchronous read, so the gesture math tracks them here.
  const committed = useRef({ scale: 1, x: 0, y: 0 });
  const gesture = useRef({ startDistance: 0, startScale: 1, startX: 0, startY: 0 });
  const lastTapAt = useRef(0);
  const [zoomed, setZoomed] = useState(false);

  const reset = (animated = true): void => {
    committed.current = { scale: 1, x: 0, y: 0 };
    setZoomed(false);
    if (animated) {
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
      ]).start();
    } else {
      scale.setValue(1);
      translateX.setValue(0);
      translateY.setValue(0);
    }
  };

  /** Keep the image's edges inside the viewport at the current scale. */
  const clamp = (value: number, current: number): number => {
    const overflow = Math.max(0, (size * current - size) / 2);
    return Math.min(overflow, Math.max(-overflow, value));
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, state) =>
          Math.abs(state.dx) > 2 || Math.abs(state.dy) > 2,
        onPanResponderGrant: (event) => {
          gesture.current = {
            startDistance: touchDistance(event) ?? 0,
            startScale: committed.current.scale,
            startX: committed.current.x,
            startY: committed.current.y,
          };
          // Double-tap: toggle between fit and DOUBLE_TAP_SCALE.
          const now = Date.now();
          if (now - lastTapAt.current < DOUBLE_TAP_MS) {
            lastTapAt.current = 0;
            if (committed.current.scale > MIN_SCALE) {
              reset();
            } else {
              committed.current = { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 };
              setZoomed(true);
              Animated.parallel([
                Animated.spring(scale, {
                  toValue: DOUBLE_TAP_SCALE,
                  useNativeDriver: true,
                  bounciness: 0,
                }),
                Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }),
              ]).start();
            }
            return;
          }
          lastTapAt.current = now;
        },
        onPanResponderMove: (event, state) => {
          const distance = touchDistance(event);
          if (distance !== null && gesture.current.startDistance > 0) {
            // Pinch: scale by the ratio of finger distances since the gesture began.
            const next = Math.min(
              MAX_SCALE,
              Math.max(
                MIN_SCALE,
                gesture.current.startScale * (distance / gesture.current.startDistance),
              ),
            );
            committed.current.scale = next;
            scale.setValue(next);
            setZoomed(next > MIN_SCALE);
            return;
          }
          // Pan, only meaningful once the image overflows the viewport.
          const x = clamp(gesture.current.startX + state.dx, committed.current.scale);
          const y = clamp(gesture.current.startY + state.dy, committed.current.scale);
          committed.current.x = x;
          committed.current.y = y;
          translateX.setValue(x);
          translateY.setValue(y);
        },
        onPanResponderRelease: () => {
          // A pinch that ended below 1× snaps back to fit rather than leaving a
          // shrunken picture floating in a black screen.
          if (committed.current.scale <= MIN_SCALE) reset();
          else {
            gesture.current.startDistance = 0;
            committed.current.x = clamp(committed.current.x, committed.current.scale);
            committed.current.y = clamp(committed.current.y, committed.current.scale);
            translateX.setValue(committed.current.x);
            translateY.setValue(committed.current.y);
          }
        },
      }),
    // `size` is the only value the clamp math reads that can change (rotation).
    [size],
  );

  const trimmedUrl = url?.trim() ? url.trim() : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onShow={() => reset(false)}
      supportedOrientations={["portrait", "landscape"]}
    >
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.94)" }}>
        {/* Tapping the backdrop closes — but only while the image is at fit
            scale. Once zoomed, a stray tap outside the picture is far more
            likely a missed pan than a request to dismiss. */}
        <Pressable
          accessibilityLabel={t("common:buttons.close")}
          onPress={zoomed ? undefined : onClose}
          disabled={zoomed}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <View
            {...responder.panHandlers}
            style={{ width: size, height: size, overflow: "hidden", borderRadius: radius.lg }}
          >
            <Animated.View
              style={{
                width: size,
                height: size,
                transform: [{ translateX }, { translateY }, { scale }],
              }}
            >
              {trimmedUrl ? (
                <Image
                  source={{ uri: trimmedUrl }}
                  style={{ width: size, height: size }}
                  contentFit="contain"
                  transition={120}
                  accessibilityIgnoresInvertColors
                />
              ) : (
                // No photo: show the same initials tile the rest of the app uses,
                // so the gesture is consistent for every person in the roster.
                <View style={{ alignItems: "center", justifyContent: "center", flex: 1 }}>
                  <Avatar name={name} size={size * 0.7} uri={null} />
                </View>
              )}
            </Animated.View>
          </View>
        </Pressable>

        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t("common:buttons.close")}
          style={({ pressed }) => ({
            position: "absolute",
            top: insets.top + space.md,
            right: space.lg,
            width: 40,
            height: 40,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.55)",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <X size={22} color="#ffffff" />
        </Pressable>

        <Text
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: insets.bottom + space.lg,
            textAlign: "center",
            color: colors.fgFaint,
            fontSize: typography.size["2xs"],
          }}
        >
          {t("mobile:userProfile.avatarZoomHint")}
        </Text>
      </View>
    </Modal>
  );
}
