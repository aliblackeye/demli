import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AlertCircle, Check, MessageSquare, UserPlus, Users, X } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import type { PresenceStatus, User } from "@demli/types";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { Segmented } from "@/components/Segmented";
import { SkeletonList } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { PersonRow } from "@/components/social/PersonRow";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { toast } from "@/components/ui/Toast";
import type { FieldError } from "@demli/client-core";
import { addFriendError, validateAddFriendInput } from "@/lib/add-friend";
import { localizeError, localizeFieldError } from "@/lib/errors";
import { useTabScreenBottomClearance } from "@/lib/use-bottom-chrome";
import {
  useAcceptFriendRequest,
  useFriendRequests,
  useFriends,
  useOpenDm,
  useRemoveFriendRequest,
  useSendFriendRequestByUsername,
} from "@/queries/social-queries";
import { useChatStore } from "@/stores/chat-store";
import { colors, space } from "@/theme/theme";

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

/** Same size as a kit IconButton, so a row never jumps while its action works. */
function BusySlot({ label }: { label: string }) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
    >
      <ActivityIndicator size="small" color={colors.fgMuted} />
    </View>
  );
}

/** First-load placeholder, in the list's own padding. */
function ListSkeleton() {
  return (
    <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg }}>
      <SkeletonList count={6} leadingSize={40} />
    </View>
  );
}

/** A load that failed with nothing cached: what happened + one way forward. */
function LoadError({
  title,
  error,
  retrying,
  onRetry,
}: {
  title: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: space.lg }}>
      <EmptyState
        tone="error"
        icon={<AlertCircle size={22} color={colors.danger} />}
        title={title}
        subtitle={localizeError(error, t)}
        action={
          <Button variant="secondary" size="sm" label={t("buttons.retry")} loading={retrying} onPress={onRetry} />
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Friends (accepted, presence-sorted, split into "around now" and the rest)
// ---------------------------------------------------------------------------

type FriendRow =
  | { key: string; kind: "heading"; label: string }
  | { key: string; kind: "friend"; user: User; status: PresenceStatus };

function FriendsTab({ onAddFriend }: { onAddFriend: () => void }) {
  const { t } = useAppTranslation();
  const { data: friends, isPending, isError, error, refetch, isRefetching } = useFriends();
  const presence = useChatStore((s) => s.presence);
  const openDm = useOpenDm();
  // Tab pill + (during a call) the voice bar — the last row scrolls clear of both.
  const bottomClearance = useTabScreenBottomClearance();
  const [openingId, setOpeningId] = useState<string | null>(null);
  /** The friend whose USER menu is open (long press), or null. */
  const [memberTarget, setMemberTarget] = useState<MemberSheetTarget | null>(null);

  const rows = useMemo<FriendRow[]>(() => {
    const list = (friends ?? []).map((f) => ({
      user: f.user,
      status: presence[f.user.id] ?? ("offline" as PresenceStatus),
    }));
    list.sort(
      (a, b) =>
        PRESENCE_RANK[a.status] - PRESENCE_RANK[b.status] ||
        a.user.displayName.localeCompare(b.user.displayName),
    );
    const around = list.filter((r) => PRESENCE_RANK[r.status] < 3);
    const away = list.filter((r) => PRESENCE_RANK[r.status] === 3);
    const out: FriendRow[] = [];
    if (around.length > 0) {
      out.push({ key: "h:on", kind: "heading", label: t("mobile:friends.onlineSection", { count: around.length }) });
      for (const r of around) out.push({ key: r.user.id, kind: "friend", ...r });
    }
    if (away.length > 0) {
      out.push({ key: "h:off", kind: "heading", label: t("mobile:friends.offlineSection", { count: away.length }) });
      for (const r of away) out.push({ key: r.user.id, kind: "friend", ...r });
    }
    return out;
  }, [friends, presence, t]);

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
      onError: (err) =>
        toast({
          variant: "danger",
          title: t("mobile:friends.messageErrorTitle"),
          description: localizeError(err, t),
        }),
      onSettled: () => setOpeningId(null),
    });
  };

  if (isPending) return <ListSkeleton />;
  if (isError && !friends) {
    return (
      <LoadError
        title={t("mobile:friends.loadErrorTitle")}
        error={error}
        retrying={isRefetching}
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <>
      <FlatList<FriendRow>
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{
          paddingHorizontal: space.md,
          paddingBottom: space.xl + bottomClearance,
          gap: 2,
          flexGrow: 1,
        }}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        renderItem={({ item }) =>
          item.kind === "heading" ? (
            <SectionHeading style={{ paddingHorizontal: space.md }}>{item.label}</SectionHeading>
          ) : (
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
              accessibilityHint={t("mobile:home.longPressOptionsA11y")}
              trailing={
                openingId === item.user.id ? (
                  <BusySlot label={t("mobile:friends.message")} />
                ) : (
                  <IconButton
                    icon={MessageSquare}
                    variant="secondary"
                    label={t("mobile:friends.message")}
                    disabled={openingId !== null}
                    onPress={() => onMessage(item.user)}
                  />
                )
              }
            />
          )
        }
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: "center", paddingTop: space.xl }}>
            <EmptyState
              icon={<Users size={22} color={colors.fgMuted} />}
              title={t("mobile:friends.noFriendsTitle")}
              subtitle={t("mobile:friends.noFriendsSubtitle")}
              action={
                <Button
                  variant="accent"
                  size="sm"
                  icon={UserPlus}
                  label={t("mobile:friends.addFriend")}
                  onPress={onAddFriend}
                />
              }
            />
          </View>
        }
      />
      {/* The friends list is not inside a server, so the menu drops every
          server-scoped entry (roles, invite, kick/ban) on its own. */}
      <MemberActionSheet target={memberTarget} groupId={null} onClose={() => setMemberTarget(null)} />
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
  // Tab pill + (during a call) the voice bar — the last row scrolls clear of both.
  const bottomClearance = useTabScreenBottomClearance();

  const inc = incoming.data ?? [];
  const out = outgoing.data ?? [];
  const onError = (err: unknown) =>
    toast({
      variant: "danger",
      title: t("mobile:friends.actionErrorTitle"),
      description: localizeError(err, t),
    });

  const refetchBoth = () => {
    void incoming.refetch();
    void outgoing.refetch();
  };

  // Pull-to-refresh (audit #14): one gesture refetches both request directions.
  const refreshControl = (
    <RefreshControl
      refreshing={incoming.isRefetching || outgoing.isRefetching}
      onRefresh={refetchBoth}
      tintColor={colors.fgMuted}
      colors={[colors.accent]}
      progressBackgroundColor={colors.surfaceRaised}
    />
  );

  if (incoming.isPending || outgoing.isPending) return <ListSkeleton />;

  // A failed load must not read as "no pending requests".
  const failed = incoming.isError ? incoming : outgoing.isError ? outgoing : null;
  if (failed && inc.length === 0 && out.length === 0) {
    return (
      <LoadError
        title={t("mobile:friends.requestsLoadErrorTitle")}
        error={failed.error}
        retrying={incoming.isRefetching || outgoing.isRefetching}
        onRetry={refetchBoth}
      />
    );
  }

  if (inc.length === 0 && out.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingBottom: space.xl * 2 + bottomClearance,
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
        paddingHorizontal: space.md,
        paddingBottom: space.xl + bottomClearance,
        gap: 2,
      }}
      refreshControl={refreshControl}
    >
      {/* One direction loaded, the other did not: keep what we have, and say
          the rest is missing instead of letting it read as "none". */}
      {failed ? (
        <Banner
          variant="danger"
          title={t("mobile:friends.requestsLoadErrorTitle")}
          action={{ label: t("buttons.retry"), onPress: refetchBoth }}
          style={{ marginTop: space.md }}
        />
      ) : null}
      {inc.length > 0 ? (
        <>
          <SectionHeading tone="muted" style={{ paddingHorizontal: space.md }}>
            {t("mobile:friends.incomingSection", { count: inc.length })}
          </SectionHeading>
          {inc.map((r) => (
            <PersonRow
              key={r.user.id}
              user={r.user}
              onPress={() => openProfile(r.user)}
              trailing={
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <IconButton
                    icon={Check}
                    variant="accent"
                    label={t("mobile:friends.accept")}
                    haptic="success"
                    disabled={accept.isPending}
                    onPress={() => accept.mutate(r.user.id, { onError })}
                  />
                  <IconButton
                    icon={X}
                    variant="danger"
                    label={t("mobile:friends.decline")}
                    disabled={remove.isPending}
                    onPress={() => remove.mutate(r.user.id, { onError })}
                  />
                </View>
              }
            />
          ))}
        </>
      ) : null}

      {out.length > 0 ? (
        <>
          <SectionHeading style={{ paddingHorizontal: space.md }}>
            {t("mobile:friends.outgoingSection", { count: out.length })}
          </SectionHeading>
          {out.map((r) => (
            <PersonRow
              key={r.user.id}
              user={r.user}
              subtitle={t("mobile:friends.pendingSubtitle")}
              showPresence={false}
              onPress={() => openProfile(r.user)}
              trailing={
                <IconButton
                  icon={X}
                  label={t("mobile:friends.cancelRequest")}
                  disabled={remove.isPending}
                  onPress={() => remove.mutate(r.user.id, { onError })}
                />
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
  // Tab pill + (during a call) the voice bar — the last row scrolls clear of both.
  const bottomClearance = useTabScreenBottomClearance();
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
        paddingBottom: space.xl + bottomClearance,
        gap: space.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <TextField
        label={t("mobile:friends.addByUsernameLabel")}
        value={username}
        onChangeText={(next) => {
          setUsername(next);
          // Clear a stale rejection (and a stale "sent") as soon as the user types.
          if (error) setError(null);
          if (sent) setSent(false);
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
        <Banner variant="success" title={t("mobile:friends.addSent")} onDismiss={() => setSent(false)} />
      ) : null}
      <Button
        variant="accent"
        size="lg"
        block
        icon={UserPlus}
        label={t("mobile:friends.addSend")}
        onPress={onSend}
        loading={send.isPending}
      />
    </ScrollView>
  );
}

/**
 * Friends hub (ADR 0010 §8) — a bottom-tab surface (founder directive): one
 * screen, three segments — accepted friends (who is around first, tap → profile,
 * message → DM), pending requests (incoming accept/decline + outgoing cancel),
 * and add-by-username (#111). The tab bar's header supplies the title, so there
 * is no in-screen Stack.Screen header here.
 *
 * Every segment draws its own loading (skeleton rows), failed (what happened +
 * retry), empty (what this list is for + the one next step) and ideal state.
 * Action failures surface as a toast on top of the list, not a blocking alert.
 */
export default function FriendsScreen() {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<Tab>("friends");
  const incoming = useFriendRequests("incoming");
  const incomingCount = incoming.data?.length ?? 0;

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
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs }}>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          accessibilityLabel={t("mobile:friends.title")}
          options={[
            { value: "friends", label: t("mobile:friends.tabFriends") },
            {
              value: "requests",
              label:
                incomingCount > 0
                  ? t("mobile:friends.tabRequestsCount", { count: incomingCount })
                  : t("mobile:friends.tabRequests"),
            },
            { value: "add", label: t("mobile:friends.tabAdd") },
          ]}
        />
      </View>
      {tab === "friends" ? (
        <FriendsTab onAddFriend={() => setTab("add")} />
      ) : tab === "requests" ? (
        <RequestsTab />
      ) : (
        <AddTab />
      )}
    </Screen>
  );
}
