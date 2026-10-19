import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Platform, Pressable } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Bluetooth,
  Check,
  Headphones,
  Phone,
  Smartphone,
  Volume2,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import {
  getAudioRouteSnapshot,
  refreshAudioRoute,
  subscribeAudioRoute,
} from "@/media/audio-route";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space, typography } from "@/theme/theme";

/**
 * Audio output route picker (audit D1) — the single biggest voice gap on mobile.
 *
 * The plumbing already existed unused: the voice store's `setOutputDevice` →
 * engine `setOutputDevice` → the RN adapter's `switchActiveDevice("audiooutput")`
 * → `AudioSession.selectAudioOutput`. This component is the missing UI: a compact
 * pill in the voice room's status strip that opens a bottom sheet of the routes
 * the OS currently offers (speaker / earpiece / headphones / bluetooth on
 * Android; automatic / speaker on iOS), and drives the same store action.
 *
 * Self-contained: it reads `status` / `setOutputDevice` straight from the store,
 * so the parent only drops it in — the DM call, the group call and the server
 * voice room all mount this same component. On Android the pill shows the route
 * audio is ACTUALLY on (media/audio-route: audioswitch's selection plus its change
 * event), so a session that auto-started on the loudspeaker says so, and a
 * headset or Bluetooth device appearing mid-call updates it. Rendered only while
 * a room's audio session is live (connected / reconnecting).
 */

/** iOS routes — what `AudioSession.getAudioOutputs()` returns there (static). */
const IOS_ROUTES = ["default", "force_speaker"] as const;

/** Icon + localized label for a raw route id from `AudioSession.getAudioOutputs()`. */
function routeMeta(id: string, t: AppTFunction): { Icon: LucideIcon; label: string } {
  switch (id) {
    case "speaker":
    case "force_speaker":
      return { Icon: Volume2, label: t("mobile:voice.routeSpeaker") };
    case "earpiece":
      return { Icon: Phone, label: t("mobile:voice.routeEarpiece") };
    case "headset":
      return { Icon: Headphones, label: t("mobile:voice.routeHeadset") };
    case "bluetooth":
      return { Icon: Bluetooth, label: t("mobile:voice.routeBluetooth") };
    case "default":
      return { Icon: Smartphone, label: t("mobile:voice.routeAutomatic") };
    default:
      // Unknown/OS-specific id: keep it selectable, just show the raw name.
      return { Icon: Volume2, label: id };
  }
}

export function AudioOutputControl() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  const status = useVoiceStore((s) => s.status);
  const lastPick = useVoiceStore((s) => s.selectedOutputDeviceId);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const route = useSyncExternalStore(subscribeAudioRoute, getAudioRouteSnapshot);

  const [open, setOpen] = useState(false);

  // The audio session is only started while in a room, so routing is meaningful
  // only then.
  const active = status === "connected" || status === "reconnecting";

  useEffect(() => {
    if (active) void refreshAudioRoute();
    else setOpen(false);
  }, [active]);

  if (!active) return null;

  const ios = Platform.OS === "ios";
  const routes: readonly string[] = ios ? IOS_ROUTES : route.available;
  // Android: the live route; the last pick only stands in when the native read
  // is unavailable. iOS has no readback, so the pick is all there is.
  const selected = ios ? lastPick : (route.selected ?? lastPick);
  const echoHint =
    !ios && selected === "speaker" && routes.some((r) => r === "earpiece" || r === "headset" || r === "bluetooth");

  const onOpen = () => {
    void refreshAudioRoute(); // a headset/bluetooth device may have (dis)appeared
    setOpen(true);
  };

  const onSelect = (id: string) => {
    setOutputDevice(id);
    setOpen(false);
  };

  const current = selected ? routeMeta(selected, t) : { Icon: Volume2, label: t("mobile:voice.outputTitle") };
  const CurrentIcon = current.Icon;

  return (
    <>
      <Pressable
        onPress={onOpen}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:voice.outputA11y")}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          paddingHorizontal: space.sm,
          paddingVertical: space.xs,
          borderRadius: radius.pill,
          borderCurve: "continuous",
          backgroundColor: colors.surfaceRaised,
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <CurrentIcon size={15} color={colors.fgMuted} />
        <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 12, fontWeight: "600", maxWidth: 96 }}>
          {current.label}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          onPress={() => setOpen(false)}
          accessibilityLabel={t("buttons.close")}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
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
              paddingHorizontal: space.md,
              gap: space.xs,
            }}
          >
            <Text
              style={{
                color: colors.fgFaint,
                fontSize: typography.size["2xs"],
                fontWeight: "700",
                letterSpacing: 0.6,
                textTransform: "uppercase",
                paddingHorizontal: space.sm,
                paddingBottom: space.xs,
              }}
            >
              {t("mobile:voice.outputTitle")}
            </Text>

            {routes.length === 0 ? (
              <Text style={{ color: colors.fgMuted, fontSize: 14, paddingHorizontal: space.sm, paddingVertical: space.md }}>
                {t("mobile:voice.outputEmpty")}
              </Text>
            ) : (
              routes.map((id) => {
                const { Icon, label } = routeMeta(id, t);
                const isSelected = id === selected;
                return (
                  <Pressable
                    key={id}
                    onPress={() => onSelect(id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.md,
                      paddingVertical: space.md,
                      paddingHorizontal: space.sm,
                      borderRadius: radius.md,
                      borderCurve: "continuous",
                      backgroundColor: pressed ? colors.surfaceRaised : "transparent",
                    })}
                  >
                    <Icon size={20} color={isSelected ? colors.accent : colors.fgMuted} />
                    <Text style={{ flex: 1, color: colors.fg, fontSize: 15, fontWeight: "600" }}>{label}</Text>
                    {isSelected ? <Check size={18} color={colors.accent} /> : null}
                  </Pressable>
                );
              })
            )}

            {echoHint ? (
              <Text
                style={{
                  color: colors.fgFaint,
                  fontSize: 12,
                  lineHeight: 17,
                  paddingHorizontal: space.sm,
                  paddingTop: space.xs,
                }}
              >
                {t("mobile:voice.outputSpeakerEchoHint")}
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
