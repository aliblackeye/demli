import { ChannelSidebar as ChannelSidebarView } from "@demli/app-ui";
import { ChannelItem } from "./ChannelItem";
import { VoicePanel } from "./VoicePanel";
import { UserFooter } from "./UserFooter";

/**
 * Desktop ChannelSidebar: the shared @demli/app-ui channel column (data via
 * useShellData) with the desktop's voice/draft/mutation-coupled ChannelItem as
 * the per-row renderer, plus the VoicePanel and UserFooter slots below the list.
 * The row key is provided by the shared component's keyed Fragment.
 *
 * The whole options object is forwarded to the row: besides `canManage` and
 * `groupName` it now carries the M18 reorder affordances (`ordering`) and the
 * drag props the row spreads onto its button, so all the placement math stays in
 * the shared layer and none of it leaks into this binding.
 */
export function ChannelSidebar(): JSX.Element {
  return (
    <ChannelSidebarView
      renderChannel={(channel, options) => (
        <ChannelItem channel={channel} options={options} />
      )}
      voicePanel={<VoicePanel />}
      userFooter={<UserFooter />}
    />
  );
}
