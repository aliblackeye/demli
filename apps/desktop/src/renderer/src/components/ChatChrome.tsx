import { useMemo } from "react";
import { WifiOff } from "lucide-react";
import type { ChannelId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";

/**
 * Shared chat-surface chrome used by both the server channel view (ChatView)
 * and the flat group-chat view (GroupChatView): the "… is typing" strip and the
 * realtime connection banner. Both key off the message pipeline's channel id
 * (a server channel id, or a group's `streamId`).
 */

/** "mira is typing…" strip above the composer; renders nothing when quiet. */
export function TypingIndicator({ channelId }: { channelId: ChannelId }): JSX.Element | null {
  const { t } = useAppTranslation();
  const channelTyping = useChatStore((s) => s.typing[channelId]);
  const users = useChatStore((s) => s.users);

  const names = useMemo(() => {
    if (!channelTyping) return [];
    const now = Date.now();
    return Object.entries(channelTyping)
      .filter(([, expiresAt]) => expiresAt > now)
      .map(([userId]) => users[userId]?.displayName ?? t("desktop:chat.someone"));
  }, [channelTyping, users, t]);

  if (names.length === 0) return null;

  const label =
    names.length === 1
      ? t("desktop:chat.typingOne", { name: names[0] })
      : names.length === 2
        ? t("desktop:chat.typingTwo", { a: names[0], b: names[1] })
        : t("desktop:chat.typingMany");

  return (
    <p aria-live="polite" className="px-4 pb-1 text-xs text-fg-muted">
      <span className="font-semibold">{label}</span>
    </p>
  );
}

/** Thin banner shown while the realtime connection is down. */
export function ConnectionBanner(): JSX.Element | null {
  const { t } = useAppTranslation();
  const status = useChatStore((s) => s.connectionStatus);
  if (status === "online" || status === "idle") return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 bg-idle/15 px-4 py-1.5 text-xs text-idle"
    >
      <WifiOff className="size-3.5" />
      {status === "connecting" ? t("desktop:chat.connecting") : t("desktop:chat.reconnecting")}
    </div>
  );
}
