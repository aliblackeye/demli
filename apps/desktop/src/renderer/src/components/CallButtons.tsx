import { Phone, Video } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@demli/ui";
import type { CallMedia, DmId, UserId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { getCallController, useCallState } from "../lib/call-controller";
import { useFriends } from "../queries/social-queries";
import { isCallLive } from "@demli/client-core";

/**
 * DM header call actions (ADR 0012 Wave 6) — start a 1-1 voice or video call.
 *
 * Disabled with a tooltip when the pair is no longer accepted friends (a DM
 * survives an unfriend, ADR 0010; the server re-checks the gate anyway, but the
 * UI must not offer a dead button — §35), and while any call is already live
 * (the single call slot is busy). Clicking drives the shared controller, which
 * mints the token and joins the LiveKit room — media never crosses the WS.
 */
export function CallButtons({ dmId, peerId }: { dmId: DmId; peerId: UserId }): JSX.Element {
  const { t } = useAppTranslation();
  const { data: friends } = useFriends();
  const call = useCallState();

  const isFriend = (friends ?? []).some((f) => f.user.id === peerId);
  const busy = isCallLive(call) || call.pending;
  const disabled = !isFriend || busy;

  const start = (media: CallMedia): void => {
    if (disabled) return;
    void getCallController()?.startCall({ dmId, media });
  };

  const hint = !isFriend ? t("desktop:call.notFriends") : undefined;

  return (
    <>
      <CallIconButton
        label={t("desktop:call.voiceCall")}
        hint={hint}
        disabled={disabled}
        onClick={() => start("audio")}
        icon={<Phone className="size-[18px]" />}
      />
      <CallIconButton
        label={t("desktop:call.videoCall")}
        hint={hint}
        disabled={disabled}
        onClick={() => start("video")}
        icon={<Video className="size-[18px]" />}
      />
    </>
  );
}

function CallIconButton({
  label,
  hint,
  disabled,
  onClick,
  icon,
}: {
  label: string;
  hint?: string;
  disabled: boolean;
  onClick: () => void;
  icon: JSX.Element;
}): JSX.Element {
  const button = (
    <Button variant="ghost" size="icon" aria-label={label} disabled={disabled} onClick={onClick}>
      {icon}
    </Button>
  );
  return (
    <Tooltip>
      {/* span keeps the tooltip working while the button is disabled */}
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint ?? label}</TooltipContent>
    </Tooltip>
  );
}
