import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable } from "react-native";
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
import { getAudioOutputRoutes } from "@/media/livekit-room";
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
 * Self-contained: it reads `status` / `selectedOutputDeviceId` / `setOutputDevice`
 * straight from the store, so the parent only drops it in. Routes are enumerated
 * through the media adapter (the one place mobile touches the LiveKit SDK), never
 * by importing the SDK here. Rendered only while a room's audio session is live
 * (connected / reconnecting); otherwise there is nothing to route and we hide.
 */

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
  const selected = useVoiceStore((s) => s.selectedOutputDeviceId);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);

  const [routes, setRoutes] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  // The audio session is only started while in a room, so routing is meaningful
  // (and getAudioOutputs succeeds) only then.
  const active = status === "connected" || status === "reconnecting";

  const refresh = useCallback(() => {
    void getAudioOutputRoutes().then(setRoutes);
  }, []);

  // Enumerate when the session goes live; clear (and close) when it ends so a
  // stale route list can't linger.
  useEffect(() => {
    if (active) refresh();
    else {
      setRoutes([]);
      setOpen(false);
    }
  }, [active, refresh]);

  if (!active) return null;

  const onOpen = () => {
    refresh(); // re-enumerate: a headset/bluetooth device may have (dis)appeared
    setOpen(true);
  };

  const onSelect = (id: string) => {
    setOutputDevice(id);
    setOpen(false);
  };

  // The pill reflects the current pick, or a neutral speaker + generic label
  // until the user chooses one (Android auto-routes before any explicit pick).
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
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
