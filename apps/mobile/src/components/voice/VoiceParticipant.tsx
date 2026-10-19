import { memo } from "react";
import { View } from "react-native";
import { HeadphoneOff, MicOff, MonitorPlay, Video, VolumeX } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { VoiceParticipant } from "@demli/media";
import { Avatar } from "@/components/Avatar";
import { colors, radius, space } from "@/theme/theme";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { openParticipantVolumeSheet } from "./ParticipantVolumeSheet";

/**
 * Full-width participant row for the voice-room roster (the stage's fallback
 * before the tile grid takes over).
 *
 * Koyu Masa row grammar: no card, no lift — a press is a tone change only, and
 * "speaking" is the avatar's own coral ring (the same ring the member list and
 * the tiles use), not a row highlight that would flash the whole line on every
 * syllable. Memoized: the engine keeps rows referentially stable across no-op
 * active-speaker ticks, so a tick re-renders only the participant that changed
 * (CLAUDE.md §27).
 */
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
  const rowStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
  } as const;
  const content = (
    <>
      <Avatar name={name} size={36} uri={avatarUrl} speaking={participant.speaking} />
      <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
        <Text type="body" tone="default" numberOfLines={1} style={{ flexShrink: 1, fontWeight: "500" }}>
          {name}
        </Text>
        {participant.isLocal ? (
          <Text type="meta" tone="faint">
            {t("mobile:voice.youParenthetical")}
          </Text>
        ) : null}
      </View>
      {mutedForYou ? <VolumeX size={17} color={colors.fgMuted} strokeWidth={2} /> : null}
      {participant.cameraEnabled ? <Video size={17} color={colors.accent} strokeWidth={2} /> : null}
      {participant.screenSharing ? (
        <MonitorPlay size={17} color={colors.accent} strokeWidth={2} />
      ) : null}
      {!participant.micEnabled ? <MicOff size={17} color={colors.danger} strokeWidth={2} /> : null}
      {/* Deafened → headphone-off next to the mic-muted glyph (desktop parity, §11).
          Fed from the peer's LiveKit deafen attribute; a deafened user is mic-muted
          too, so both icons show. accessibilityLabel keeps it screen-reader legible. */}
      {participant.deafened ? (
        <HeadphoneOff
          size={17}
          color={colors.danger}
          strokeWidth={2}
          accessibilityLabel={t("mobile:voice.deafenedIndicator")}
        />
      ) : null}
    </>
  );
  // Your own row has nothing to adjust: a plain row, so it neither answers a
  // press with a wash nor announces itself as a disabled control.
  if (participant.isLocal) return <View style={rowStyle}>{content}</View>;
  return (
    <Touchable
      onLongPress={() => openParticipantVolumeSheet(participant.identity)}
      delayLongPress={350}
      accessibilityLabel={t("mobile:voice.userVolume.open", { name })}
      style={rowStyle}
    >
      {content}
    </Touchable>
  );
});
