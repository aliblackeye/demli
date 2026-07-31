import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import { HeadphoneOff, MicOff, MonitorPlay, Video, VolumeX } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { VoiceParticipant } from "@demli/media";
import { Avatar } from "@/components/Avatar";
import { colors, radius, space, typography } from "@/theme/theme";
import { openParticipantVolumeSheet } from "./ParticipantVolumeSheet";

/**
 * A speaking ring wrapper around the avatar. Green ring while `speaking`, a faint
 * hairline otherwise so the layout never jumps. Memoized rows mean speaking ticks
 * only re-render the participant that actually changed (CLAUDE.md §27) — the
 * engine keeps rows referentially stable across no-op active-speaker ticks.
 */
function SpeakingAvatar({
  name,
  avatarUrl,
  size,
  speaking,
}: {
  name: string;
  avatarUrl: string | null;
  size: number;
  speaking: boolean;
}) {
  return (
    <View
      style={{
        padding: 2,
        borderRadius: radius.pill,
        borderWidth: 2,
        borderColor: speaking ? colors.online : "transparent",
      }}
    >
      <Avatar name={name} size={size} uri={avatarUrl} />
    </View>
  );
}

/** Full-width participant row for the voice-room list. */
export const VoiceParticipantRow = memo(function VoiceParticipantRow({
  participant,
  name,
  avatarUrl,
}: {
  participant: VoiceParticipant;
  name: string;
  /** Resolved by the room surface from the same sources as `name`. */
  avatarUrl: string | null;
}) {
  const { t } = useAppTranslation();
  // Long-press a REMOTE row → per-user volume sheet (never the local user). A 0
  // level shows the "muted for you" glyph.
  const mutedForYou = !participant.isLocal && participant.volume <= 0;
  return (
    <Pressable
      onLongPress={
        participant.isLocal ? undefined : () => openParticipantVolumeSheet(participant.identity)
      }
      delayLongPress={350}
      accessibilityLabel={
        participant.isLocal ? undefined : t("mobile:voice.userVolume.open", { name })
      }
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: participant.speaking ? colors.surfaceRaised : "transparent",
      }}
    >
      <SpeakingAvatar name={name} avatarUrl={avatarUrl} size={36} speaking={participant.speaking} />
      <Text style={{ flex: 1, color: colors.fg, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>
        {name}
        {participant.isLocal ? `  ${t("mobile:voice.youParenthetical")}` : ""}
      </Text>
      {mutedForYou ? <VolumeX size={17} color={colors.fgMuted} /> : null}
      {participant.cameraEnabled ? <Video size={17} color={colors.accent} /> : null}
      {participant.screenSharing ? <MonitorPlay size={17} color={colors.accent} /> : null}
      {!participant.micEnabled ? <MicOff size={17} color={colors.danger} /> : null}
      {/* Deafened → headphone-off next to the mic-muted glyph (desktop parity, §11).
          Fed from the peer's LiveKit deafen attribute; a deafened user is mic-muted
          too, so both icons show. accessibilityLabel keeps it screen-reader legible. */}
      {participant.deafened ? (
        <HeadphoneOff
          size={17}
          color={colors.danger}
          accessibilityLabel={t("mobile:voice.deafenedIndicator")}
        />
      ) : null}
    </Pressable>
  );
});

/** Compact chip for the horizontal strip under the screen-share focus view. */
export const VoiceParticipantChip = memo(function VoiceParticipantChip({
  participant,
  name,
  avatarUrl,
}: {
  participant: VoiceParticipant;
  name: string;
  /** Resolved by the share surface from the same sources as `name`. */
  avatarUrl: string | null;
}) {
  const { t } = useAppTranslation();
  const label = participant.isLocal ? t("mobile:common.you") : name;
  return (
    <View style={{ alignItems: "center", width: 64, gap: space.xs }}>
      <View>
        <SpeakingAvatar name={name} avatarUrl={avatarUrl} size={44} speaking={participant.speaking} />
        {!participant.micEnabled ? (
          <View
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              backgroundColor: colors.app,
              borderRadius: radius.pill,
              padding: 2,
            }}
          >
            <MicOff size={12} color={colors.danger} />
          </View>
        ) : null}
        {participant.cameraEnabled ? (
          <View
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              backgroundColor: colors.app,
              borderRadius: radius.pill,
              padding: 2,
            }}
          >
            <Video size={12} color={colors.accent} />
          </View>
        ) : null}
      </View>
      <Text style={{ color: colors.fgMuted, fontSize: typography.size["2xs"] }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
});
