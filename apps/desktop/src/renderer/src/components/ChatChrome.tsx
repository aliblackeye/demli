import { useMemo } from "react";
import { AnimatePresence, m } from "framer-motion";
import { WifiOff } from "lucide-react";
import { bannerDrop } from "@demli/app-ui";
import type { ChannelId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";

/**
 * Shared chat-surface chrome used by both the server channel view (ChatView)
 * and the flat group-chat view (GroupChatView): the "… is typing" strip and the
 * realtime connection banner. Both key off the message pipeline's channel id
 * (a server channel id, or a group's `streamId`).
 */

/**
 * The landing's "yazıyor" dots: three 4px dots breathing one after another
 * (1.2s, 0.2s apart). Opacity only — a CSS pulse, so no per-frame JS while a
 * friend types — and `motion-reduce:animate-none` leaves them as a still
 * ellipsis for viewers who asked for less motion (an infinite animation clamped
 * to 0.01ms by the global guard would flicker instead of stopping).
 */
function TypingDots(): JSX.Element {
  return (
    <span aria-hidden className="inline-flex items-center gap-[3px]">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 animate-pulse rounded-full bg-fg-muted motion-reduce:animate-none"
          style={{ animationDuration: "1.2s", animationDelay: `${index * 0.2}s` }}
        />
      ))}
    </span>
  );
}

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
    <p
      aria-live="polite"
      className="flex animate-fade-in items-center gap-2 px-4 pb-1 text-xs text-fg-muted"
    >
      <TypingDots />
      <span className="truncate font-medium">{label}</span>
    </p>
  );
}

/**
 * Thin banner shown while the realtime connection is down. It drops in from
 * the top edge and retracts on reconnect (framer `bannerDrop`, LazyMotion-safe),
 * so "back online" is felt as the strip leaving rather than a blink.
 */
export function ConnectionBanner(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useChatStore((s) => s.connectionStatus);
  const down = status !== "online" && status !== "idle";
  return (
    <AnimatePresence initial={false}>
      {down && (
        <m.div
          key="connection-banner"
          role="status"
          variants={bannerDrop}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex shrink-0 items-center gap-2 bg-warning/12 px-4 py-2 text-label text-warning"
        >
          <WifiOff aria-hidden className="size-3.5 shrink-0" />
          {status === "connecting" ? t("desktop:chat.connecting") : t("desktop:chat.reconnecting")}
        </m.div>
      )}
    </AnimatePresence>
  );
}
