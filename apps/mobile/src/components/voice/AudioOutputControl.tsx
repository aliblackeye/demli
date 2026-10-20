import { useEffect, useState, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import {
  Bluetooth,
  Check,
  ChevronDown,
  Headphones,
  Phone,
  Smartphone,
  Volume2,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAppTranslation, type AppTFunction } from "@/lib/i18n";
import {
  getAudioRouteSnapshot,
  noteUserAudioRoutePick,
  refreshAudioRoute,
  subscribeAudioRoute,
} from "@/media/audio-route";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space } from "@/theme/theme";
import { Banner } from "../ui/Banner";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

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
 *
 * Koyu Masa: the trigger is a compact surface chip (glyph + route + a chevron
 * that says "this opens something"); the picker is the kit's draggable Sheet with
 * radio rows — the chosen route in the coral selected-row wash with a check — and
 * the speaker echo advice as an info banner under the list.
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
    noteUserAudioRoutePick(id);
    setOutputDevice(id);
    setOpen(false);
  };

  const current = selected ? routeMeta(selected, t) : { Icon: Volume2, label: t("mobile:voice.outputTitle") };
  const CurrentIcon = current.Icon;

  return (
    <>
      <Touchable
        onPress={onOpen}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:voice.outputA11y")}
        accessibilityValue={{ text: current.label }}
        tone={colors.surfaceRaised}
        pressedTone={colors.raisedHover}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          minHeight: 32,
          paddingLeft: space.sm + 2,
          paddingRight: space.sm,
          borderRadius: radius.pill,
          borderCurve: "continuous",
        }}
      >
        <CurrentIcon size={15} color={colors.fg} strokeWidth={2} />
        <Text
          numberOfLines={1}
          style={{ color: colors.fg, fontSize: 12, fontWeight: "600", maxWidth: 96 }}
        >
          {current.label}
        </Text>
        <ChevronDown size={14} color={colors.fgMuted} strokeWidth={2} />
      </Touchable>

      <Sheet visible={open} onClose={() => setOpen(false)} title={t("mobile:voice.outputTitle")}>
        <View accessibilityRole="radiogroup" style={{ gap: space.xs }}>
          {routes.length === 0 ? (
            <Text type="ui" tone="muted" style={{ paddingHorizontal: space.sm, paddingVertical: space.md }}>
              {t("mobile:voice.outputEmpty")}
            </Text>
          ) : (
            routes.map((id) => {
              const { Icon, label } = routeMeta(id, t);
              const isSelected = id === selected;
              return (
                <Touchable
                  key={id}
                  onPress={() => onSelect(id)}
                  haptic="light"
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: isSelected }}
                  tone={isSelected ? colors.accentSurface : undefined}
                  pressedTone={isSelected ? colors.accentSurfaceStrong : colors.wash}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    minHeight: 52,
                    paddingHorizontal: space.md,
                    borderRadius: radius.lg,
                    borderCurve: "continuous",
                  }}
                >
                  <Icon size={20} color={isSelected ? colors.accent : colors.fgMuted} strokeWidth={2} />
                  <Text
                    style={{
                      flex: 1,
                      color: isSelected ? colors.accent : colors.fg,
                      fontSize: 15,
                      fontWeight: isSelected ? "600" : "500",
                    }}
                  >
                    {label}
                  </Text>
                  {isSelected ? <Check size={18} color={colors.accent} strokeWidth={2.25} /> : null}
                </Touchable>
              );
            })
          )}
        </View>

        {echoHint ? (
          <Banner
            variant="info"
            title={t("mobile:voice.outputSpeakerEchoTitle")}
            description={t("mobile:voice.outputSpeakerEchoHint")}
            style={{ marginTop: space.sm }}
          />
        ) : null}
      </Sheet>
    </>
  );
}
