import { useLocalSearchParams } from "expo-router";
import { VoiceRoomScreen } from "@/components/voice/VoiceRoomScreen";
import { parseVoiceScreenIntent } from "@/components/voice/voice-channel-nav";

/**
 * Voice channel route — thin. Reads the channel params and hands off to the
 * `VoiceRoomScreen` component (the skill rule: routes never co-locate logic).
 *
 * `intent` (M20) says WHY the screen was opened: connect me to this room, or
 * just show me its chat. Absent — every deep link, push notification and mini
 * bar return that predates M20 — parses to `"join"`, so nothing that used to
 * connect stops connecting.
 */
export default function VoiceRoute() {
  const params = useLocalSearchParams<{
    channelId: string;
    groupId?: string;
    name?: string;
    intent?: string;
  }>();
  return (
    <VoiceRoomScreen
      channelId={params.channelId}
      groupId={params.groupId}
      channelName={params.name}
      intent={parseVoiceScreenIntent(params.intent)}
    />
  );
}
