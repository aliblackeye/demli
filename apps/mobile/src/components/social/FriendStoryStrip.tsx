import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { router } from "expo-router";
import type { PresenceStatus, User } from "@demli/types";
import { useAppTranslation } from "../../lib/i18n";
import { localizeError } from "../../lib/errors";
import { useFriends, useOpenDm } from "../../queries/social-queries";
import { useChatStore } from "../../stores/chat-store";
import { colors, radius, space, typography } from "../../theme/theme";
import { Avatar } from "../Avatar";
import { SectionHeading } from "../ui/SectionHeading";
import { Touchable } from "../ui/Touchable";

/** First word of a display name, so the strip label stays compact. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

const ITEM_WIDTH = 64;

/**
 * Horizontal "who's around" strip for the top of the Home DM list: the caller's
 * friends that are online / idle / do-not-disturb, each an avatar wearing its
 * presence dot. Tapping one opens (idempotently creates) the DM and routes into
 * it — the fastest path to "message a friend who's around".
 *
 * Koyu Masa: the avatars carry the kit's presence dot instead of a coloured
 * story ring; a press is a tone change on the tile, and while the DM opens the
 * tapped friend dims with a small spinner over them (one at a time).
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
      .filter((f) => f.status !== "offline" && f.status !== "invisible")
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
    <View style={{ paddingBottom: space.sm }}>
      <SectionHeading style={{ paddingHorizontal: space.sm, paddingTop: space.sm }}>
        {t("mobile:home.storyOnline")}
      </SectionHeading>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.xs, gap: space.xs }}
      >
        {online.map(({ user, status }) => {
          const opening = openingId === user.id;
          return (
            <Touchable
              key={user.id}
              onPress={() => onOpen(user)}
              disabled={openingId !== null}
              dimmed={false}
              accessibilityRole="button"
              accessibilityLabel={t("mobile:home.storyOpenA11y", { name: user.displayName })}
              accessibilityState={{ busy: opening }}
              pressedTone={colors.raisedPressed}
              style={{
                width: ITEM_WIDTH + space.sm,
                alignItems: "center",
                gap: space.xs,
                paddingVertical: space.sm,
                borderRadius: radius.lg,
                borderCurve: "continuous",
              }}
            >
              <View style={{ opacity: opening ? 0.5 : 1 }}>
                <Avatar name={user.displayName} size={52} uri={user.avatarUrl} presence={status} />
                {opening ? (
                  <View
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <ActivityIndicator size="small" color={colors.fgDisplay} />
                  </View>
                ) : null}
              </View>
              <Text
                numberOfLines={1}
                style={{
                  color: colors.fgMuted,
                  fontSize: typography.size["2xs"],
                  lineHeight: 14,
                  fontWeight: "500",
                  maxWidth: ITEM_WIDTH,
                }}
              >
                {firstName(user.displayName)}
              </Text>
            </Touchable>
          );
        })}
      </ScrollView>
    </View>
  );
}
