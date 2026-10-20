/**
 * The room controls in a VOICE channel's chat header (M20).
 *
 * A voice channel's chat is the same {@link ChatView} every text channel uses —
 * the point of this component is that it is the ONLY thing that differs, so no
 * second chat surface had to exist for voice. It carries the one action the
 * shared header cannot infer: connect me to (or take me back to, or disconnect
 * me from) the room this conversation belongs to.
 *
 * Which controls show is decided by the pure rules in ../lib/voice-channel-chat,
 * so the sidebar row and this header can never disagree about whether you are in
 * a room, and "return to the stage" never renders as a button that does nothing.
 * Every action routes through ../lib/channel-actions, which drives the single
 * `@demli/media` FSM (§11) — no media lifecycle lives here.
 *
 * Renders nothing at all on a text channel.
 */

import { MonitorPlay, PhoneCall, PhoneOff } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import type { Channel } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useVoiceStore } from "../stores/voice-store";
import { useUiStore } from "../stores/ui-store";
import { useHasStageVideo } from "../hooks/useHasStageVideo";
import { voiceChatHeaderActions } from "../lib/voice-channel-chat";
import { joinVoiceChannel, leaveVoiceRoom, returnToVoiceStage } from "../lib/channel-actions";

export function VoiceChannelHeaderControls({
  channel,
  groupName,
}: {
  channel: Channel;
  /** The server's name, recorded on a join for the voice panel's label. */
  groupName: string | null;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const voiceRoomId = useVoiceStore((s) => s.roomId);
  const voiceStatus = useVoiceStore((s) => s.status);
  const stageFocused = useUiStore((s) => s.stageFocused);
  const hasStageVideo = useHasStageVideo();

  if (channel.kind !== "voice") return null;

  const actions = voiceChatHeaderActions(channel.id, {
    voiceRoomId,
    voiceStatus,
    hasStageVideo,
    stageFocused,
  });

  return (
    <>
      {actions.map((action) => {
        if (action === "join") {
          return (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="accent"
                  data-testid="voice-header-join"
                  onClick={() => joinVoiceChannel(channel, groupName)}
                  className="h-8 gap-1.5 px-3 text-xs"
                >
                  <PhoneCall className="size-3.5" aria-hidden />
                  {t("desktop:channel.joinVoiceShort")}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("desktop:channel.joinVoice", { channel: channel.name })}
              </TooltipContent>
            </Tooltip>
          );
        }
        if (action === "return-to-stage") {
          return (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("desktop:voice.returnToStage")}
                  onClick={returnToVoiceStage}
                  className={cn("bg-accent-surface text-accent-hover hover:bg-accent/20 hover:text-accent-hover")}
                >
                  <MonitorPlay className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("desktop:voice.returnToStage")}</TooltipContent>
            </Tooltip>
          );
        }
        return (
          <Tooltip key={action}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("desktop:voice.disconnect")}
                onClick={leaveVoiceRoom}
                className="hover:bg-danger/12 hover:text-danger active:bg-danger/20"
              >
                <PhoneOff className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("desktop:voice.disconnect")}</TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}
