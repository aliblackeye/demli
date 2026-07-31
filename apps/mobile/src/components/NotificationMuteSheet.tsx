import { Modal, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AtSign, Bell, BellOff, Check, Clock, Infinity as InfinityIcon } from "lucide-react-native";
import type { NotificationMuteScope } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { colors, radius, space } from "../theme/theme";
import { activeMuteMode, muteKey, useChatStore } from "../stores/chat-store";
import { useClearNotificationMute, useSetNotificationMute } from "../queries/notification-queries";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The target a mute sheet acts on: a channel or a whole group/server. */
export interface MuteTarget {
  scope: NotificationMuteScope;
  targetId: string;
  /** Display name for the sheet header (channel/server name). */
  name: string;
}

/**
 * Long-press notification-mute sheet (migration 0013) — mobile's parity of the
 * desktop context-menu "Mute notifications" submenu. Built on the same RN Modal
 * bottom-sheet pattern as {@link MessageActionSheet} (OTA-safe, no native sheet
 * module). Rows: mode (All / Only @mentions), timed presets (15m / 1h / 8h),
 * indefinite, and Unmute (only when currently muted). Every row is fully wired
 * (§35 — no dead affordances).
 */
export function NotificationMuteSheet({
  visible,
  target,
  onClose,
}: {
  visible: boolean;
  target: MuteTarget | null;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const setMute = useSetNotificationMute();
  const clearMute = useClearNotificationMute();

  const entry = useChatStore((s) =>
    target ? s.notificationMutes[muteKey(target.scope, target.targetId)] : undefined,
  );
  // Honor expiry: an elapsed timed mute reads as unmuted here too.
  const activeMode = target
    ? activeMuteMode(entry ? { [muteKey(target.scope, target.targetId)]: entry } : {}, target.scope, target.targetId)
    : null;
  const isMuted = activeMode !== null;
  const isIndefiniteAll = activeMode === "all" && (entry?.until ?? null) === null;

  function apply(mode: "all" | "mentions", untilMs?: number): void {
    if (!target) return;
    setMute.mutate({
      scope: target.scope,
      targetId: target.targetId,
      mode,
      until: untilMs ? new Date(Date.now() + untilMs).toISOString() : undefined,
    });
    onClose();
  }

  function unmute(): void {
    if (!target) return;
    clearMute.mutate({ scope: target.scope, targetId: target.targetId });
    onClose();
  }

  return (
    <Modal
      visible={visible && target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
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
          {/* Header: what is being muted. */}
          <Text
            style={{
              color: colors.fgMuted,
              fontSize: 13,
              fontWeight: "600",
              paddingHorizontal: space.sm,
              paddingBottom: space.xs,
            }}
            numberOfLines={1}
          >
            {t("mobile:mute.muteNotifications")}
            {target ? ` · ${target.name}` : ""}
          </Text>

          <MuteRow
            icon={<Bell size={20} color={colors.fgMuted} />}
            label={t("mobile:mute.all")}
            active={isIndefiniteAll}
            onPress={() => apply("all")}
          />
          <MuteRow
            icon={<AtSign size={20} color={colors.fgMuted} />}
            label={t("mobile:mute.mentionsOnly")}
            active={activeMode === "mentions"}
            onPress={() => apply("mentions")}
          />

          <Divider />

          <MuteRow
            icon={<Clock size={20} color={colors.fgMuted} />}
            label={t("mobile:mute.min15")}
            onPress={() => apply("all", 15 * MINUTE)}
          />
          <MuteRow
            icon={<Clock size={20} color={colors.fgMuted} />}
            label={t("mobile:mute.hour1")}
            onPress={() => apply("all", HOUR)}
          />
          <MuteRow
            icon={<Clock size={20} color={colors.fgMuted} />}
            label={t("mobile:mute.hours8")}
            onPress={() => apply("all", 8 * HOUR)}
          />
          <MuteRow
            icon={<InfinityIcon size={20} color={colors.fgMuted} />}
            label={t("mobile:mute.indefinite")}
            onPress={() => apply("all")}
          />

          {isMuted ? (
            <>
              <Divider />
              <MuteRow
                icon={<BellOff size={20} color={colors.accent} />}
                label={t("mobile:mute.unmute")}
                labelColor={colors.accent}
                onPress={unmute}
              />
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.stroke, marginVertical: space.xs }} />;
}

function MuteRow({
  icon,
  label,
  active,
  labelColor,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  labelColor?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
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
      {icon}
      <Text style={{ flex: 1, color: labelColor ?? colors.fg, fontSize: 15, fontWeight: "600" }}>
        {label}
      </Text>
      {active ? <Check size={18} color={colors.accent} /> : null}
    </Pressable>
  );
}
