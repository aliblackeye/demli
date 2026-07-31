import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { Text } from "@/components/ui/Text";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, MessageSquare, UserPlus, Users, X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { PresenceStatus, User } from "@demli/types";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { Segmented } from "@/components/Segmented";
import { TextField } from "@/components/TextField";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { IconButton } from "@/components/social/IconButton";
import { PersonRow } from "@/components/social/PersonRow";
import type { FieldError } from "@demli/client-core";
import { addFriendError, validateAddFriendInput } from "@/lib/add-friend";
import { localizeError, localizeFieldError } from "@/lib/errors";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import {
  useAcceptFriendRequest,
  useFriendRequests,
  useFriends,
  useOpenDm,
  useRemoveFriendRequest,
  useSendFriendRequestByUsername,
} from "@/queries/social-queries";
import { useChatStore } from "@/stores/chat-store";
import { colors, space, typography } from "@/theme/theme";

type Tab = "friends" | "requests" | "add";

/** Sort key: online, idle, dnd, then offline (invisible→offline). */
const PRESENCE_RANK: Record<PresenceStatus, number> = {
  online: 0,
  idle: 1,
  dnd: 2,
  offline: 3,
  invisible: 3,
};

function openProfile(user: User): void {
  router.push({
    pathname: "/user/[userId]",
    params: { userId: user.id, name: user.displayName },
  });
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: space.sm,
        paddingTop: space.md,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

function CenteredSpinner() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={colors.fgFaint} />
    </View>
  );
}

function ErrorRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useAppTranslation();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.md }}>
      <Text selectable style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
        {message}
      </Text>
      <Pressable onPress={onRetry} hitSlop={8}>
        <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>{t("buttons.retry")}</Text>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Friends (accepted, presence-sorted)
// ---------------------------------------------------------------------------

function FriendsTab() {
  const { t } = useAppTranslation();
  const { data: friends, isPending, isError, error, refetch, isRefetching } = useFriends();
  const presence = useChatStore((s) => s.presence);
  const openDm = useOpenDm();
  const insets = useSafeAreaInsets();
  const [openingId, setOpeningId] = useState<string | null>(null);
  /** The friend whose USER menu is open (long press), or null. */
  const [memberTarget, setMemberTarget] = useState<MemberSheetTarget | null>(null);

  const rows = useMemo(() => {
    const list = (friends ?? []).map((f) => ({
      user: f.user,
      status: presence[f.user.id] ?? ("offline" as PresenceStatus),
    }));
    return list.sort(
      (a, b) =>
        PRESENCE_RANK[a.status] - PRESENCE_RANK[b.status] ||
        a.user.displayName.localeCompare(b.user.displayName),
    );
  }, [friends, presence]);

  const onMessage = (user: User) => {
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

  if (isPending) return <CenteredSpinner />;
  if (isError) return <ErrorRetry message={localizeError(error, t)} onRetry={() => void refetch()} />;

  return (
    <>
    <FlatList
      data={rows}
      keyExtractor={(r) => r.user.id}
      contentContainerStyle={{
        padding: space.md,
        paddingBottom: space.md + insets.bottom + TAB_BAR_CONTENT_HEIGHT,
        gap: space.sm,
      }}
      refreshing={isRefetching}
      onRefresh={() => void refetch()}
      renderItem={({ item }) => (
        <PersonRow
          user={item.user}
          onPress={() => openProfile(item.user)}
          onLongPress={() =>
            setMemberTarget({
              userId: item.user.id,
              displayName: item.user.displayName,
              username: item.user.username,
            })
          }
          trailing={
            <IconButton
              accessibilityLabel={t("mobile:friends.message")}
              disabled={openingId === item.user.id}
              onPress={() => onMessage(item.user)}
            >
              {openingId === item.user.id ? (
                <ActivityIndicator size="small" color={colors.fgMuted} />
              ) : (
                <MessageSquare size={18} color={colors.accent} />
              )}
            </IconButton>
          }
        />
      )}
      ListEmptyComponent={
        <View style={{ paddingTop: space.xl }}>
          <EmptyState
            icon={<Users size={22} color={colors.fgMuted} />}
            title={t("mobile:friends.noFriendsTitle")}
            subtitle={t("mobile:friends.noFriendsSubtitle")}
          />
        </View>
      }
    />
      {/* The friends list is not inside a server, so the menu drops every
          server-scoped entry (roles, invite, kick/ban) on its own. */}
      <MemberActionSheet
        target={memberTarget}
        groupId={null}
        onClose={() => setMemberTarget(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Requests (incoming accept/decline + outgoing cancel)
// ---------------------------------------------------------------------------

function RequestsTab() {
  const { t } = useAppTranslation();
  const incoming = useFriendRequests("incoming");
  const outgoing = useFriendRequests("outgoing");
  const accept = useAcceptFriendRequest();
  const remove = useRemoveFriendRequest();
  const insets = useSafeAreaInsets();

  const inc = incoming.data ?? [];
  const out = outgoing.data ?? [];
  const onError = (err: unknown) =>
    Alert.alert(t("mobile:friends.actionErrorTitle"), localizeError(err, t));

  // Pull-to-refresh (audit #14): one gesture refetches both request directions.
  const refreshControl = (
    <RefreshControl
      refreshing={incoming.isRefetching || outgoing.isRefetching}
      onRefresh={() => {
        void incoming.refetch();
        void outgoing.refetch();
      }}
      tintColor={colors.fgMuted}
      colors={[colors.accent]}
    />
  );

  if (incoming.isPending || outgoing.isPending) return <CenteredSpinner />;

  if (inc.length === 0 && out.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingBottom: space.xl * 2 + insets.bottom + TAB_BAR_CONTENT_HEIGHT,
        }}
        refreshControl={refreshControl}
      >
        <EmptyState
          icon={<UserPlus size={22} color={colors.fgMuted} />}
          title={t("mobile:friends.noRequestsTitle")}
          subtitle={t("mobile:friends.noRequestsSubtitle")}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.md,
        paddingBottom: space.md + insets.bottom + TAB_BAR_CONTENT_HEIGHT,
        gap: space.sm,
      }}
      refreshControl={refreshControl}
    >
      {inc.length > 0 ? (
        <>
          <SectionLabel>{t("mobile:friends.incomingSection", { count: inc.length })}</SectionLabel>
          {inc.map((r) => (
            <PersonRow
              key={r.user.id}
              user={r.user}
              onPress={() => openProfile(r.user)}
              trailing={
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <IconButton
                    variant="accent"
                    accessibilityLabel={t("mobile:friends.accept")}
                    disabled={accept.isPending}
                    onPress={() => accept.mutate(r.user.id, { onError })}
                  >
                    <Check size={18} color={colors.onAccent} />
                  </IconButton>
                  <IconButton
                    variant="danger"
                    accessibilityLabel={t("mobile:friends.decline")}
                    disabled={remove.isPending}
                    onPress={() => remove.mutate(r.user.id, { onError })}
                  >
                    <X size={18} color={colors.danger} />
                  </IconButton>
                </View>
              }
            />
          ))}
        </>
      ) : null}

      {out.length > 0 ? (
        <>
          <SectionLabel>{t("mobile:friends.outgoingSection", { count: out.length })}</SectionLabel>
          {out.map((r) => (
            <PersonRow
              key={r.user.id}
              user={r.user}
              subtitle={t("mobile:friends.pendingSubtitle")}
              showPresence={false}
              onPress={() => openProfile(r.user)}
              trailing={
                <IconButton
                  accessibilityLabel={t("mobile:friends.cancelRequest")}
                  disabled={remove.isPending}
                  onPress={() => remove.mutate(r.user.id, { onError })}
                >
                  <X size={18} color={colors.fgMuted} />
                </IconButton>
              }
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Add (by username — #111 replaces friend codes)
// ---------------------------------------------------------------------------

function AddTab() {
  const { t } = useAppTranslation();
  const send = useSendFriendRequestByUsername();
  const insets = useSafeAreaInsets();
  const [username, setUsername] = useState("");
  /** Field-level rejection (local rule OR server), as a KEY so it re-translates. */
  const [error, setError] = useState<FieldError | null>(null);
  const [sent, setSent] = useState(false);

  const onSend = () => {
    // The shared schema decides — the same one the API runs on this body — so a
    // too-short or illegal handle is caught on the field instead of after a
    // round trip.
    const result = validateAddFriendInput(username);
    if (!result.ok) {
      setError(result.error);
      setSent(false);
      return;
    }
    setError(null);
    setSent(false);
    // Send the NORMALIZED handle the schema produced, not the raw field text.
    send.mutate(result.username, {
      onSuccess: () => {
        setUsername("");
        setSent(true);
      },
      onError: (err) => setError(addFriendError(err)),
    });
  };

  return (
    <ScrollView
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.xl + insets.bottom + TAB_BAR_CONTENT_HEIGHT,
        gap: space.xl,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: space.md }}>
        <TextField
          label={t("mobile:friends.addByUsernameLabel")}
          value={username}
          onChangeText={(next) => {
            setUsername(next);
            // Clear a stale rejection as soon as the user starts fixing it.
            if (error) setError(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t("mobile:friends.addByUsernamePlaceholder")}
          hint={t("mobile:friends.addByUsernameHint")}
          error={error ? localizeFieldError(t, error) : null}
          onSubmitEditing={onSend}
          returnKeyType="send"
        />
        {sent ? (
          <Text style={{ color: colors.online, fontSize: 13 }}>{t("mobile:friends.addSent")}</Text>
        ) : null}
        <Button label={t("mobile:friends.addSend")} onPress={onSend} loading={send.isPending} />
      </View>
    </ScrollView>
  );
}

/**
 * Friends hub (ADR 0010 §8) — a bottom-tab surface (founder directive): one
 * screen, three segments — accepted friends (presence-sorted, tap → profile,
 * message → DM), pending requests (incoming accept/decline + outgoing cancel),
 * and add-by-username (#111). The tab bar's header supplies the title, so there
 * is no in-screen Stack.Screen header here.
 */
export default function FriendsScreen() {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<Tab>("friends");

  // Honor an optional `?tab=` query param so the retired friend-code deep link
  // (app/arkadas/[code]) can bounce the user straight to the Add-by-username
  // segment. An effect (not just useState) covers the case where this tab
  // screen is already mounted when the navigation arrives.
  const params = useLocalSearchParams<{ tab?: string }>();
  useEffect(() => {
    if (params.tab === "add" || params.tab === "requests" || params.tab === "friends") {
      setTab(params.tab);
    }
  }, [params.tab]);

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs }}>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "friends", label: t("mobile:friends.tabFriends") },
            { value: "requests", label: t("mobile:friends.tabRequests") },
            { value: "add", label: t("mobile:friends.tabAdd") },
          ]}
        />
      </View>
      {tab === "friends" ? <FriendsTab /> : tab === "requests" ? <RequestsTab /> : <AddTab />}
    </Screen>
  );
}
