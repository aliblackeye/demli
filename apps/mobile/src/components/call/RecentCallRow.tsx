import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "../../lib/i18n";
import type { RecentCall } from "../../lib/clients";
import { dmRelativeTime } from "../../lib/dm-preview";
import { colors, radius, space, typography } from "../../theme/theme";
import { Avatar } from "../Avatar";

/** True when the viewer MISSED an incoming call — the danger-color case. */
function isMissedIncoming(call: RecentCall): boolean {
  return call.status === "missed" && call.direction === "incoming";
}

/** `m:ss` (or `h:mm:ss`) talk time, e.g. "0:42", "2:14", "1:02:03". */
function formatCallDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Short localized summary of a call outcome (direction + duration, or status). */
function callSummary(call: RecentCall, t: AppTFunction): string {
  const duration = call.durationSeconds !== null ? formatCallDuration(call.durationSeconds) : null;
  switch (call.status) {
    case "ended": {
      const base =
        call.direction === "outgoing"
          ? t("mobile:recentCalls.directionOutgoing")
          : t("mobile:recentCalls.directionIncoming");
      return duration ? `${base} · ${duration}` : base;
    }
    case "missed":
      return call.direction === "incoming"
        ? t("mobile:recentCalls.statusMissed")
        : t("mobile:recentCalls.statusNoAnswer");
    case "declined":
      return t("mobile:recentCalls.statusDeclined");
    case "canceled":
      return t("mobile:recentCalls.statusCanceled");
    case "upgraded":
      return t("mobile:recentCalls.statusMovedToGroup");
    case "ringing":
    case "active":
      return t("mobile:recentCalls.statusOngoing");
    default:
      return "";
  }
}

function DirectionGlyph({ call }: { call: RecentCall }) {
  if (isMissedIncoming(call)) return <PhoneMissed size={15} color={colors.danger} />;
  if (call.direction === "outgoing") return <PhoneOutgoing size={15} color={colors.fgFaint} />;
  return <PhoneIncoming size={15} color={colors.fgFaint} />;
}

/**
 * A call-history row (Voice-UX #2), modeled on the DM row: presence-free avatar +
 * peer name + a direction/media/duration summary + a compact relative time, plus
 * a trailing "call back" button. The button re-initiates with the SAME media and
 * is disabled (dimmed) unless the pair are friends and no call is live (`canCall`)
 * — the server re-checks both, this is the UX guard. Missed INCOMING calls are
 * emphasized in the danger color — only whoever actually missed it sees the red.
 *
 * The tappable name/avatar region and the call-back button are SIBLING pressables
 * (not nested) so a tap resolves unambiguously to one action.
 */
function RecentCallRowImpl({
  call,
  canCall,
  onOpen,
  onCallBack,
}: {
  call: RecentCall;
  canCall: boolean;
  onOpen: (peerId: UserId) => void;
  onCallBack: (call: RecentCall) => void;
}) {
  const { t } = useAppTranslation();
  const missed = isMissedIncoming(call);
  const isVideo = call.media === "video";
  const time = dmRelativeTime(call.createdAt, t);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
      }}
    >
      <Pressable
        onPress={() => onOpen(call.peer.id)}
        accessibilityRole="button"
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Avatar name={call.peer.displayName} size={46} uri={call.peer.avatarUrl} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <DirectionGlyph call={call} />
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, color: missed ? colors.danger : colors.fg, fontSize: 15, fontWeight: "600" }}
            >
              {call.peer.displayName}
            </Text>
            {isVideo ? (
              <Video size={13} color={colors.fgFaint} />
            ) : (
              <Phone size={13} color={colors.fgFaint} />
            )}
          </View>
          <Text numberOfLines={1} style={{ color: missed ? colors.danger : colors.fgMuted, fontSize: 13 }}>
            {callSummary(call, t)}
          </Text>
        </View>
        {time ? (
          <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"], fontVariant: ["tabular-nums"] }}>{time}</Text>
        ) : null}
      </Pressable>

      <Pressable
        onPress={() => onCallBack(call)}
        disabled={!canCall}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:recentCalls.callBack")}
        accessibilityState={{ disabled: !canCall }}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surfaceRaised,
          opacity: !canCall ? 0.4 : pressed ? 0.6 : 1,
        })}
      >
        {isVideo ? <Video size={18} color={colors.accent} /> : <Phone size={18} color={colors.accent} />}
      </Pressable>
    </View>
  );
}

export const RecentCallRow = memo(RecentCallRowImpl);
