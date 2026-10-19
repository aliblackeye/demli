import { View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { AgeVerifyBanner } from "@/components/AgeVerifyBanner";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { motion } from "@/theme/theme";
import { DmListPanel } from "./DmListPanel";
import { ServerPanel } from "./ServerPanel";

/**
 * The right PANEL of the Home shell. Its whole content is driven by the rail's
 * selection: the Home/DM entry (`null`) shows the DM list; a server id shows
 * that server's channel list. A selection change re-renders only this subtree
 * (the rail items are memoized), never the chat/message surfaces (§27).
 *
 * Switching is a state change, so it gets one quiet motion: the new panel
 * fades in on the `fast` step (keyed by the selection, so the swap reads as
 * "this is now a different place" rather than a flicker). The content comes
 * from the query cache, so there is no loading flash under the fade. Reduced
 * motion: an instant swap.
 *
 * The two strips above the content are both self-erasing: the connection banner
 * only while the socket is down, the age reminder only for an account with no
 * date of birth that has not waved it off. Neither ever blocks the panel.
 */
export function HomePanel({ selectedServerId }: { selectedServerId: string | null }) {
  return (
    <View style={{ flex: 1 }}>
      <ConnectionBanner />
      <AgeVerifyBanner />
      <Animated.View
        key={selectedServerId ?? "home"}
        entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
        style={{ flex: 1 }}
      >
        {selectedServerId === null ? <DmListPanel /> : <ServerPanel groupId={selectedServerId} />}
      </Animated.View>
    </View>
  );
}
