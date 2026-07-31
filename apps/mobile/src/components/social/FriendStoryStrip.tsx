import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import type { PresenceStatus, User } from "@demli/types";
import { useAppTranslation } from "../../lib/i18n";
import { localizeError } from "../../lib/errors";
import { useFriends, useOpenDm } from "../../queries/social-queries";
import { useChatStore } from "../../stores/chat-store";
import { colors, presenceColor, radius, space, typography } from "../../theme/theme";
import { Avatar } from "../Avatar";

/** First word of a display name, so the strip label stays compact. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Horizontal "who's around" strip for the top of the Home screen: the caller's
 * friends that are currently online/idle, each a
 * presence-ringed avatar. Tapping one opens (idempotently creates) the DM and
 * routes into it — the fastest path to "message a friend who's online".
 *
 * Self-hides when nobody is online, so it never leaves an empty band. Presence is
 * inherent to this view, so it intentionally re-reads the presence map (this is
 * NOT the message list §27 guards — it's a small, presence-scoped strip).
 */
export function FriendStoryStrip() {
  const { t } = useAppTranslation();
  const { data: friends } = useFriends();
  const presence = useChatStore((s) => s.presence);
  const openDm = useOpenDm();
  const [openingId, setOpeningId] = useState<string | null>(null);

  const online = useMemo(() => {
    const rank: Record<PresenceStatus, number> = {
      online: 0,
      idle: 1,
      dnd: 2,
      offline: 3,
      invisible: 3,
    };
    return (friends ?? [])
      .map((f) => ({ user: f.user, status: presence[f.user.id] ?? ("offline" as PresenceStatus) }))
      .filter((f) => f.status !== "offline")
      .sort(
        (a, b) => rank[a.status] - rank[b.status] || a.user.displayName.localeCompare(b.user.displayName),
      );
  }, [friends, presence]);

  if (online.length === 0) return null;

  const onOpen = (user: User) => {
    if (openingId) return;
    setOpeningId(user.id);
    openDm.mutate(user.id, {
      onSuccess: ({ dm }) => {
        router.push({
          pathname: "/dm/[dmId]",
          params: {
            dmId: dm.id,
            streamId: dm.streamId,
            name: dm.participant.displayName,
            userId: dm.participant.id,
          },
        });
      },
      onError: (err) => Alert.alert(t("mobile:friends.messageErrorTitle"), localizeError(err, t)),
      onSettled: () => setOpeningId(null),
    });
  };

  return (
    <View style={{ paddingTop: space.sm, paddingBottom: space.xs }}>
      <Text
        style={{
          color: colors.fgFaint,
          fontSize: typography.size["2xs"],
          fontWeight: "700",
          letterSpacing: 0.6,
          textTransform: "uppercase",
          paddingHorizontal: space.md + space.xs,
          paddingBottom: space.sm,
        }}
      >
        {t("mobile:home.storyOnline")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.md, gap: space.md }}
      >
        {online.map(({ user, status }) => (
          <Pressable
            key={user.id}
            onPress={() => onOpen(user)}
            accessibilityRole="button"
            accessibilityLabel={t("mobile:friends.message")}
            style={{ alignItems: "center", width: 64, gap: space.xs }}
          >
            <View
              style={{
                padding: 2,
                borderRadius: radius.pill,
                borderWidth: 2,
                borderColor: presenceColor(status),
                opacity: openingId === user.id ? 0.5 : 1,
              }}
            >
              <Avatar name={user.displayName} size={52} uri={user.avatarUrl} />
              {openingId === user.id ? (
                <View
                  style={{
                    position: "absolute",
                    top: 2,
                    left: 2,
                    right: 2,
                    bottom: 2,
                    borderRadius: radius.pill,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "rgba(0,0,0,0.35)",
                  }}
                >
                  <ActivityIndicator size="small" color={colors.fg} />
                </View>
              ) : null}
            </View>
            <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: typography.size["2xs"], maxWidth: 64 }}>
              {firstName(user.displayName)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
