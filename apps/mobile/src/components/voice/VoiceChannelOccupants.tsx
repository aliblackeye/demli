import { memo } from "react";
import { View } from "react-native";
import { Text } from "../ui/Text";
import { MicOff } from "lucide-react-native";
import type { VoiceOccupant } from "@demli/protocol";
import { Avatar } from "@/components/Avatar";
import { useAppTranslation } from "@/lib/i18n";
import { useChatStore } from "@/stores/chat-store";
import { NO_OCCUPANTS, useVoiceOccupancyStore } from "@/stores/voice-occupancy-store";
import { colors, space } from "@/theme/theme";

/** Left indent so occupant avatars line up under the channel title (icon + gaps). */
const OCCUPANT_INDENT = space.lg + 20 + space.md;

/**
 * One occupant of a voice channel — the cross-channel "who is in voice" row. The
 * server `voice.participant_*` delta carries only `{ userId, muted }` (no
 * speaking / camera state; that lives in the voice screen for the room you are
 * in). Resolves the display name + avatar from the shared user directory (seeded
 * by group details). Memoized so an unrelated occupant change never rerenders it.
 */
const VoiceOccupantRow = memo(function VoiceOccupantRow({
  occupant,
}: {
  occupant: VoiceOccupant;
}) {
  const user = useChatStore((s) => s.users[occupant.userId]);
  const name = user?.displayName ?? user?.username ?? occupant.userId;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 3 }}>
      <Avatar name={name} size={22} uri={user?.avatarUrl ?? null} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.fgMuted, fontSize: 13 }}>
        {name}
      </Text>
      {occupant.muted ? <MicOff size={13} color={colors.fgFaint} /> : null}
    </View>
  );
});

/**
 * The members currently connected to a voice channel, nested under its row in the
 * server channel list. Server-authoritative: fed by
 * `voice.participant_*` deltas + the `auth.succeeded` snapshot via the occupancy
 * store, so it shows who is in rooms the user has not joined and updates live.
 * Renders nothing for an empty voice channel.
 */
export function VoiceChannelOccupants({ channelId }: { channelId: string }) {
  const { t } = useAppTranslation();
  const occupants = useVoiceOccupancyStore(
    (s): readonly VoiceOccupant[] => s.byChannel[channelId] ?? NO_OCCUPANTS,
  );
  if (occupants.length === 0) return null;
  return (
    <View
      accessibilityLabel={t("mobile:group.inVoiceA11y")}
      style={{ paddingLeft: OCCUPANT_INDENT, paddingRight: space.md, paddingBottom: space.xs, gap: 2 }}
    >
      {occupants.map((occupant) => (
        <VoiceOccupantRow key={occupant.userId} occupant={occupant} />
      ))}
    </View>
  );
}
