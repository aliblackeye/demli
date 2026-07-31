import { useEffect, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, MessageCircle, UserPlus, X } from "lucide-react-native";
import { toTranslateFn, useAppTranslation } from "@/lib/i18n";
import { colors, elevation, radius, space } from "@/theme/theme";
import {
  useInAppNotificationStore,
  type InAppNotificationKind,
} from "@/stores/in-app-notification-store";

/** How long a banner stays before it auto-slides away. */
const VISIBLE_MS = 4500;
/** Off-screen resting offset (well above the notch) for the slide animation. */
const HIDDEN_Y = -220;

/** Per-kind glyph. */
function kindIcon(kind: InAppNotificationKind) {
  if (kind === "friend-accepted") return Check;
  if (kind === "message") return MessageCircle;
  return UserPlus;
}

/**
 * The single foreground in-app banner (founder: friend requests had NO visible
 * feedback while the app was open). Mounted once, globally, in the authed layout —
 * next to the VoiceMiniBar — so it floats over every authed screen. Slides down
 * from the top, auto-dismisses, and routes to the relevant surface on tap.
 *
 * Animation is RN's built-in `Animated` (translateY on the native driver), no
 * reanimated — OTA-safe, same as the rest of the mobile app. The store holds i18n
 * keys; this component resolves them (it has the translator the realtime layer
 * lacks). Re-triggered whenever `current.id` changes, so a second request while
 * the first is still up simply replaces it and replays the slide-in.
 */
export function InAppNotificationBanner() {
  const { t } = useAppTranslation();
  // The notification's keys are dynamic (chosen by the realtime layer), so the
  // strictly-typed `t` can't accept them directly — resolve them through the
  // codebase's sanctioned loose translator (same escape hatch as system messages).
  const translate = toTranslateFn(t);
  const insets = useSafeAreaInsets();
  const current = useInAppNotificationStore((s) => s.current);
  const dismiss = useInAppNotificationStore((s) => s.dismiss);
  const translateY = useRef(new Animated.Value(HIDDEN_Y)).current;

  const id = current?.id;
  useEffect(() => {
    if (!id) return;
    // Reset above the screen, then spring in. `setValue` guards the case where a
    // previous banner left the value at 0 (already on-screen).
    translateY.setValue(HIDDEN_Y);
    const enter = Animated.spring(translateY, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 8,
      speed: 14,
    });
    enter.start();
    const timer = setTimeout(() => {
      Animated.timing(translateY, {
        toValue: HIDDEN_Y,
        duration: 220,
        useNativeDriver: true,
      }).start(() => dismiss(id));
    }, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [id, translateY, dismiss]);

  if (!current) return null;

  const Icon = kindIcon(current.kind);
  const accepted = current.kind === "friend-accepted";
  // Title/body come from a raw string (message banners) or an i18n key (social).
  const title = current.titleText ?? (current.titleKey ? translate(current.titleKey) : "");
  const body = current.bodyText ?? (current.bodyKey ? translate(current.bodyKey, current.bodyParams) : "");

  const onPress = () => {
    dismiss(current.id);
    if (current.href) router.push(current.href as never);
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + space.xs,
        left: space.md,
        right: space.md,
        transform: [{ translateY }],
        // Above the native header + the voice mini bar.
        zIndex: 1000,
        elevation: 24,
      }}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${body}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingVertical: space.md,
          paddingHorizontal: space.md,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          backgroundColor: colors.surfaceRaised,
          borderWidth: 1,
          borderColor: colors.stroke,
          ...elevation.panel,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: accepted ? colors.online : colors.accent,
          }}
        >
          {/* Both plate colours (green / accent orange) are light, so the
              glyph is the dark on-accent ink rather than white. */}
          <Icon size={19} color={colors.onAccent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 14, fontWeight: "700" }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 13, marginTop: 1 }}>
            {body}
          </Text>
        </View>
        <Pressable
          onPress={() => dismiss(current.id)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:friends.notif.dismiss")}
          style={{ padding: space.xs }}
        >
          <X size={18} color={colors.fgFaint} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}
