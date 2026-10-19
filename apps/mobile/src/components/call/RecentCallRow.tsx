import { memo } from "react";
import { View } from "react-native";
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation, type AppTFunction } from "../../lib/i18n";
import type { RecentCall } from "../../lib/clients";
import { dmRelativeTime } from "../../lib/dm-preview";
import { colors, radius, space, typography } from "../../theme/theme";
import { Avatar } from "../Avatar";
import { IconButton } from "../ui/IconButton";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

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
  if (isMissedIncoming(call)) return <PhoneMissed size={14} color={colors.danger} strokeWidth={2} />;
  if (call.direction === "outgoing") {
    return <PhoneOutgoing size={14} color={colors.fgFaint} strokeWidth={2} />;
  }
  return <PhoneIncoming size={14} color={colors.fgFaint} strokeWidth={2} />;
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
 *
 * Koyu Masa row grammar: no card, the row sits on the page; a press is a tone
 * change only (nothing lifts); the direction glyph moves under the name, next to
 * the outcome it explains; the media glyph is the call-back disc itself, so the
 * row says "voice" or "video" exactly once.
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
        gap: space.xs,
        paddingRight: space.sm,
      }}
    >
      <Touchable
        onPress={() => onOpen(call.peer.id)}
        accessibilityRole="button"
        accessibilityLabel={`${call.peer.displayName}, ${callSummary(call, t)}${time ? `, ${time}` : ""}`}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          minHeight: 64,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: radius.lg,
          borderCurve: "continuous",
        }}
      >
        <Avatar name={call.peer.displayName} size={44} uri={call.peer.avatarUrl} />
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              color: missed ? colors.danger : colors.fg,
              fontSize: 15,
              lineHeight: 20,
              fontWeight: "600",
            }}
          >
            {call.peer.displayName}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
            <DirectionGlyph call={call} />
            <Text
              numberOfLines={1}
              style={{
                flexShrink: 1,
                color: missed ? colors.danger : colors.fgMuted,
                fontSize: 13,
                fontVariant: ["tabular-nums"],
              }}
            >
              {callSummary(call, t)}
            </Text>
          </View>
        </View>
        {time ? (
          <Text
            style={{
              color: colors.fgFaint,
              fontSize: typography.size["2xs"],
              fontWeight: "500",
              fontVariant: ["tabular-nums"],
            }}
          >
            {time}
          </Text>
        ) : null}
      </Touchable>

      <IconButton
        icon={isVideo ? Video : Phone}
        // The raised disc — a calm, repeatable action on every row. Disabled (40%)
        // unless you are friends and no call is live; the server re-checks both.
        variant="secondary"
        disabled={!canCall}
        haptic="light"
        label={t("mobile:recentCalls.callBack")}
        onPress={() => onCallBack(call)}
      />
    </View>
  );
}

export const RecentCallRow = memo(RecentCallRowImpl);
