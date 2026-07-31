import { m } from "framer-motion";
import { viewFade } from "@demli/app-ui";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useVoiceStore } from "../stores/voice-store";
import { resolveVoiceGroupId } from "../lib/voice-surface";
import { useHasStageVideo } from "../hooks/useHasStageVideo";
import { useVisibleConversation } from "../notifications/visible-conversation";
import { ChatView } from "./ChatView";
import { VideoStage } from "./VideoStage";
import { FriendsView } from "./FriendsView";
import { RecentCallsView } from "./RecentCallsView";
import { DmView } from "./DmView";
import { GroupChatView } from "./GroupChatView";

/**
 * Center column for the server surface (§7): the voice-room VIDEO
 * STAGE (cameras + screen-share with focus / fullscreen / filmstrip / movable
 * PiP) shows only when there is live video AND the user is focused on the stage.
 * Clicking a text channel flips `stageFocused` off (ChannelItem) so the center
 * returns to CHAT while voice/video keep running in the background — the user is
 * never trapped behind the stage. Clicking the connected voice channel (or the
 * VoicePanel "return to view") flips it back on. With no live video the center is
 * always chat.
 */
function ServerCenter(): JSX.Element {
  const hasVideo = useHasStageVideo();
  const stageFocused = useUiStore((s) => s.stageFocused);
  // The stage belongs to the server whose voice channel we are actually in.
  //
  // A voice session is global — one engine, one room — so "is there video?" is
  // true no matter which server the user is LOOKING at. Staging on that alone
  // carried the camera from server to server and painted it over an unrelated
  // server's chat (founder: "sunucular arası geçiş yapınca kameram ortada
  // duruyor"). The room's owning group is the missing half of the question.
  //
  // Unattributable rooms resolve to `null` and therefore do not stage anywhere,
  // which is the safe direction: chat is always a correct thing to show, a
  // misplaced stage never is.
  const roomId = useVoiceStore((s) => s.roomId);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const voiceGroupId = resolveVoiceGroupId(roomId);
  const stageBelongsHere = voiceGroupId !== null && voiceGroupId === activeGroupId;
  const showStage = hasVideo && stageFocused && stageBelongsHere;

  // Tell the notify policy what this column is actually painting. While the
  // STAGE is up there is no message list on screen, so no conversation counts as
  // "being read" and a message in the staged channel must still notify.
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  useVisibleConversation(showStage ? null : activeChannelId);

  return (
    // Opacity-only crossfade (paint, not layout) as the center flips between the
    // video stage and chat. The key is stage/chat ONLY — a channel switch keeps
    // key="chat", so the message list is never re-faded, and there is no extra
    // layout node (same root, same classes) so the fragile chat flex chain is
    // untouched (§27 + the MessageList height note).
    <m.div
      key={showStage ? "stage" : "chat"}
      variants={viewFade}
      initial="initial"
      animate="animate"
      className="flex min-w-0 flex-1 flex-col bg-app"
    >
      {showStage ? <VideoStage /> : <ChatView />}
    </m.div>
  );
}

/**
 * Center pane for the home surface (ADR 0010 §5): the Friends table, the recent
 * calls history, a 1:1 DM, or a flat group chat, chosen by the chat store's
 * `homeView`.
 */
function HomeCenter(): JSX.Element {
  const homeView = useChatStore((s) => s.homeView);
  const activeChannelId = useChatStore((s) => s.activeChannelId);

  // Same declaration as ServerCenter, and the reason this is published rather
  // than derived: `openFriends()` / `openRecentCalls()` leave `activeChannelId`
  // pointing at the last DM, so reading the store alone would silence a DM the
  // user cannot see. Only the two CONVERSATION sub-views claim a stream; the
  // friends table and the call history claim a surface instead, so a friend
  // request is suppressed exactly while the friends table is up.
  const isConversation = homeView === "dm" || homeView === "groupChat";
  useVisibleConversation(
    isConversation ? activeChannelId : null,
    homeView === "friends" ? "friends" : homeView === "recentCalls" ? "recentCalls" : null,
  );

  const view =
    homeView === "friends" ? (
      <FriendsView />
    ) : homeView === "recentCalls" ? (
      <RecentCallsView />
    ) : homeView === "dm" ? (
      <DmView />
    ) : (
      <GroupChatView />
    );
  // Keyed opacity crossfade between home destinations. The wrapper mirrors the
  // flex classes a center child carries (flex-1 + min-h-0 + flex-col) so the
  // inner view resolves its height exactly as when it was a direct child; opacity
  // is paint-only and never affects the flex/scroll chain. Keyed by homeView, so
  // switching between two DMs (both "dm") does NOT re-fade the message list.
  return (
    <m.div
      key={homeView}
      variants={viewFade}
      initial="initial"
      animate="animate"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {view}
    </m.div>
  );
}

/**
 * The shell's main conversation column, chosen by the active surface: the home
 * (friends / recent-calls / DM / group-chat) center, or the server (chat /
 * video stage) center. Extracted so BOTH the desktop four-column shell and the
 * mobile single-column shell render the exact same center — the only difference
 * between the two layouts is the navigation chrome AROUND this column, never the
 * column itself.
 */
export function AppCenter(): JSX.Element {
  const isHome = useChatStore((s) => s.activeView === "home");
  return isHome ? <HomeCenter /> : <ServerCenter />;
}
