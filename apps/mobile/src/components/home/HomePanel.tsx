import { View } from "react-native";
import { AgeVerifyBanner } from "@/components/AgeVerifyBanner";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { DmListPanel } from "./DmListPanel";
import { ServerPanel } from "./ServerPanel";

/**
 * The right PANEL of the Home shell. Its whole content is driven by the rail's
 * selection: the Home/DM entry (`null`) shows the DM list; a server id shows
 * that server's channel list. A selection change re-renders only this subtree
 * (the rail items are memoized), never the chat/message surfaces (§27).
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
      {selectedServerId === null ? <DmListPanel /> : <ServerPanel groupId={selectedServerId} />}
    </View>
  );
}
