import { Modal, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check } from "lucide-react-native";
import {
  SELECTABLE_PRESENCE_STATUSES,
  type SelectablePresenceStatus,
} from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "../theme/theme";
import { presenceColor } from "../theme/theme";

// `as const` keeps the values as literal catalog keys so the typed `t()` accepts
// them (a plain `string` would not satisfy its key union).
const LABEL_KEY = {
  online: "mobile:presence.online",
  idle: "mobile:presence.idle",
  dnd: "mobile:presence.dnd",
  invisible: "mobile:presence.invisible",
} as const satisfies Record<SelectablePresenceStatus, string>;

/** Only dnd + invisible carry an explanation — their behavior is non-obvious. */
const DESC_KEY: Partial<
  Record<SelectablePresenceStatus, "mobile:presence.dndDesc" | "mobile:presence.invisibleDesc">
> = {
  dnd: "mobile:presence.dndDesc",
  invisible: "mobile:presence.invisibleDesc",
};

/**
 * A standalone presence dot for the picker rows (the Avatar draws its own).
 * `dnd` gets the white dash; `invisible`/`offline` read as the gray dot
 * (mobile's existing offline treatment — {@link presenceColor} maps both to gray).
 */
export function PresenceDot({ status }: { status: SelectablePresenceStatus }) {
  return (
    <View
      style={{
        width: 12,
        height: 12,
        borderRadius: radius.pill,
        backgroundColor: presenceColor(status),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {status === "dnd" ? (
        // Light red dot, so the dash is the dark on-accent ink (see Avatar).
        <View
          style={{ width: 5, height: 2, borderRadius: radius.pill, backgroundColor: colors.onAccent }}
        />
      ) : null}
    </View>
  );
}

/**
 * The status picker (mobile mirror of the desktop renderer's
 * StatusPicker). A bottom sheet listing the four selectable statuses — Online /
 * Idle / Do Not Disturb / Invisible — each with its colored dot and (for
 * dnd/invisible) a one-line description. Selecting one persists it, repaints the
 * dot, and re-broadcasts to peers via the caller's `onSelect`.
 */
export function StatusPicker({
  visible,
  current,
  onSelect,
  onClose,
}: {
  visible: boolean;
  current: SelectablePresenceStatus;
  onSelect: (status: SelectablePresenceStatus) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
        {/* Sheet — its own Pressable swallows taps so they don't dismiss it. */}
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.sm,
            paddingBottom: space.md + insets.bottom,
            paddingHorizontal: space.md,
          }}
        >
          {/* Grabber. */}
          <View style={{ alignItems: "center", paddingBottom: space.sm }}>
            <View
              style={{
                width: 40,
                height: 4,
                borderRadius: radius.pill,
                backgroundColor: colors.strokeStrong,
              }}
            />
          </View>

          <Text
            style={{
              color: colors.fg,
              fontSize: 15,
              fontWeight: "700",
              paddingHorizontal: space.sm,
              paddingBottom: space.xs,
            }}
          >
            {t("mobile:presence.menuLabel")}
          </Text>

          {SELECTABLE_PRESENCE_STATUSES.map((status) => {
            const descKey = DESC_KEY[status];
            const selected = status === current;
            return (
              <Pressable
                key={status}
                onPress={() => onSelect(status)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={t(LABEL_KEY[status])}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: space.md,
                  paddingVertical: space.md,
                  paddingHorizontal: space.sm,
                  borderRadius: radius.md,
                  borderCurve: "continuous",
                  backgroundColor: pressed ? colors.surfaceRaised : "transparent",
                })}
              >
                <View style={{ paddingTop: 3 }}>
                  <PresenceDot status={status} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                    {t(LABEL_KEY[status])}
                  </Text>
                  {descKey ? (
                    <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 16 }}>
                      {t(descKey)}
                    </Text>
                  ) : null}
                </View>
                {selected ? <Check size={18} color={colors.accent} style={{ marginTop: 2 }} /> : null}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
