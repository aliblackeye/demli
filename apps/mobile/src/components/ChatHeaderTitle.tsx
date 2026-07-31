/**
 * Conversation header titles (founder P0: "in a DM I can't see whether the other
 * person is online").
 *
 * Two variants, both mounted as a route's `headerTitle` so the signal sits right
 * next to the name where the founder looked for it:
 *  - {@link DmHeaderTitle}       peer name + presence dot + status line,
 *  - {@link ChatSummaryHeaderTitle} channel/group name + "N members · M online".
 *
 * Performance (CLAUDE.md §27): every presence read here goes through a NARROW
 * zustand selector that returns a primitive (a status string / a count), so a
 * presence tick re-renders only this small header — never the message FlatList,
 * which subscribes to its own slices. No network call is added either: presence
 * is already fed by the realtime handshake + `presence.updated` deltas.
 */
import { memo } from "react";
import { View } from "react-native";
import { Text } from "./ui/Text";
import { Hash, Smartphone, Volume2 } from "lucide-react-native";
import type { PresenceStatus, UserId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useChatStore } from "../stores/chat-store";
import { Avatar } from "./Avatar";
import { colors, presenceColor, radius, space } from "../theme/theme";
import { countOnline, presenceLabelKey, showsMobileGlyph } from "./chat-header-presence";

/**
 * Channel-kind glyph before the name — the desktop ChatView header pattern
 * (`<Hash> #channel-name` / speaker for voice) instead of a "#" baked into the
 * title string. Same visual role as desktop's `size-5 text-fg-faint`.
 */
function ChannelGlyph({ kind }: { kind: "hash" | "voice" }) {
  if (kind === "voice") return <Volume2 size={17} color={colors.fgFaint} strokeWidth={2.25} />;
  return <Hash size={17} color={colors.fgFaint} strokeWidth={2.25} />;
}

/** The colored status dot (or phone glyph for a mobile-connected peer). */
function PresenceGlyph({
  status,
  onMobile,
}: {
  status: PresenceStatus;
  onMobile: boolean;
}) {
  const color = presenceColor(status);
  if (onMobile) return <Smartphone size={11} color={color} strokeWidth={2.75} />;
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: radius.pill,
        backgroundColor: color,
      }}
    />
  );
}

/**
 * DM header title: the peer's name with a live presence dot + status line under
 * it. `userId` is threaded through the route params by every push site; when it
 * is missing (a malformed deep link) this degrades to the plain name.
 */
function DmHeaderTitleImpl({ userId, name }: { userId?: UserId; name: string }) {
  const { t } = useAppTranslation();
  // Primitive-returning selectors: this header re-renders only when THIS peer's
  // status/platform actually changes, not on every presence event (§27).
  const status = useChatStore((s) =>
    userId ? (s.presence[userId] ?? "offline") : null,
  );
  const platform = useChatStore((s) => (userId ? s.presencePlatforms[userId] : undefined));
  // Peer avatar in the DM header. The users map is already populated
  // by the message/roster pipeline; the selector yields a string primitive so
  // avatar churn — not presence ticks — is the only extra re-render (§27).
  const avatarUrl = useChatStore((s) => (userId ? (s.users[userId]?.avatarUrl ?? null) : null));

  if (status === null) {
    return (
      <Text variant="display" numberOfLines={1} style={{ color: colors.fg, fontSize: 17, fontWeight: "700" }}>
        {name}
      </Text>
    );
  }

  const label = t(presenceLabelKey(status, platform));
  const onMobile = showsMobileGlyph(status, platform);

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Avatar name={name} size={30} uri={avatarUrl} />
      <View style={{ justifyContent: "center", flexShrink: 1 }}>
        <Text variant="display" numberOfLines={1} style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
          {name}
        </Text>
        <View
          accessible
          accessibilityLabel={t("mobile:chat.headerPresenceA11y", { name, status: label })}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: 1 }}
        >
          <PresenceGlyph status={status} onMobile={onMobile} />
          <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 11.5 }}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

export const DmHeaderTitle = memo(DmHeaderTitleImpl);

/**
 * Group-chat / server-channel header title: the name with a
 * "N members · M online" roster summary under it.
 *
 * `memberIds` comes from the roster the screen already fetched (no extra
 * request). The online count is folded INSIDE the selector so the subscription
 * yields a number — a presence tick that doesn't change the count re-renders
 * nothing (§27).
 */
function ChatSummaryHeaderTitleImpl({
  title,
  memberIds,
  glyph,
}: {
  title: string;
  memberIds: readonly UserId[];
  /** Channel-kind icon before the name (desktop `# name` pattern). Omitted for
      flat group chats, which have no channel kind. */
  glyph?: "hash" | "voice";
}) {
  const { t } = useAppTranslation();
  const onlineCount = useChatStore((s) => countOnline(s.presence, memberIds));

  if (memberIds.length === 0) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        {glyph ? <ChannelGlyph kind={glyph} /> : null}
        <Text
          variant="display"
          numberOfLines={1}
          style={{ color: colors.fg, fontSize: 17, fontWeight: "700", flexShrink: 1 }}
        >
          {title}
        </Text>
      </View>
    );
  }

  const summary = t("mobile:chat.memberSummary", {
    count: memberIds.length,
    online: onlineCount,
  });

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      {glyph ? <ChannelGlyph kind={glyph} /> : null}
      <View style={{ justifyContent: "center", flexShrink: 1 }}>
        <Text variant="display" numberOfLines={1} style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
          {title}
        </Text>
        <Text
          accessibilityLabel={summary}
          numberOfLines={1}
          style={{ color: colors.fgMuted, fontSize: 11.5, marginTop: 1 }}
        >
          {summary}
        </Text>
      </View>
    </View>
  );
}

export const ChatSummaryHeaderTitle = memo(ChatSummaryHeaderTitleImpl);
