import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import Constants from "expo-constants";
import { Text } from "@/components/ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Phone, Settings, Smile, UserRound, Users, UsersRound } from "lucide-react-native";
import { visibleCustomStatus } from "@demli/client-core";
import type { SelectablePresenceStatus } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { PresenceDot, StatusPicker } from "@/components/StatusPicker";
import { TAB_BAR_CONTENT_HEIGHT } from "@/lib/tab-bar";
import { useFriendRequests, useMe } from "@/queries/social-queries";
import { setSelfPresenceStatus } from "@/realtime/connection";
import { useAuthStore } from "@/stores/auth-store";
import { useSelfPresenceStore } from "@/stores/self-presence-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * You tab: the caller's own identity card plus quick links to
 * the surfaces that were previously buried in the Home header — Edit profile,
 * Friends (with a dot when requests are waiting), and Settings. Deliberately thin
 * — it links to the existing screens rather than duplicating them.
 */
export default function YouTab() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const meQuery = useMe();
  const me = meQuery.data;
  const incoming = useFriendRequests("incoming");
  const hasIncoming = (incoming.data?.length ?? 0) > 0;

  const name = me?.displayName ?? me?.username ?? "";
  // Evaluated against the clock, not just read: a status whose "clears at 18:00"
  // passed while the app stayed open must stop showing here too (§35).
  const customStatus = visibleCustomStatus(me);
  // Same source as settings.tsx's version row — the app.json version baked at
  // build time (matches the APK because eas.json pins appVersionSource=local).
  const appVersion = Constants.expoConfig?.version ?? null;

  // The user's own CHOSEN presence status (the status picker). Keyed by the
  // session user id so an account switch shows that account's pick.
  const [statusOpen, setStatusOpen] = useState(false);
  const meId = useAuthStore((s) => s.user?.id);
  const status: SelectablePresenceStatus = useSelfPresenceStore((s) =>
    meId ? (s.statusByUser[meId] ?? "online") : "online",
  );
  const statusLabel = {
    online: t("mobile:presence.online"),
    idle: t("mobile:presence.idle"),
    dnd: t("mobile:presence.dnd"),
    invisible: t("mobile:presence.invisible"),
  } satisfies Record<SelectablePresenceStatus, string>;

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: space.md,
          paddingBottom: space.md + insets.bottom + TAB_BAR_CONTENT_HEIGHT,
          gap: space.sm,
        }}
        refreshControl={
          <RefreshControl
            refreshing={meQuery.isRefetching || incoming.isRefetching}
            onRefresh={() => {
              void meQuery.refetch();
              void incoming.refetch();
            }}
            tintColor={colors.fgMuted}
            colors={[colors.accent]}
          />
        }
      >
        {/* Identity card */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.md,
            padding: space.lg,
            borderRadius: radius.lg,
            borderCurve: "continuous",
            backgroundColor: colors.surface,
          }}
        >
          <Avatar name={name || "?"} size={60} uri={me?.avatarUrl} presence={status} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="display" numberOfLines={1} style={{ color: colors.fg, fontSize: 20, fontWeight: "700" }}>
              {name}
            </Text>
            {me?.username ? (
              <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 14 }}>
                @{me.username}
              </Text>
            ) : null}
            {/* Status line under the name — PLAIN TEXT, one line, never markdown. */}
            {customStatus ? (
              <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 13 }}>
                {customStatus}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={{ height: space.sm }} />

        <Row
          title={t("mobile:presence.menuLabel")}
          subtitle={statusLabel[status]}
          leading={
            <View style={{ width: 20, alignItems: "center", justifyContent: "center" }}>
              <PresenceDot status={status} />
            </View>
          }
          onPress={() => setStatusOpen(true)}
        />
        {/* Custom status (M18) — the desktop keeps this next to the status
            picker in the user footer; mobile's equivalent is right under the
            presence row. Shows the live line so "edit" is obvious. */}
        <Row
          title={customStatus ? t("mobile:customStatus.edit") : t("mobile:customStatus.set")}
          subtitle={customStatus ?? t("mobile:customStatus.rowSubtitleEmpty")}
          leading={<Smile size={20} color={colors.fgMuted} />}
          onPress={() => router.push("/custom-status")}
        />
        <Row
          title={t("mobile:you.editProfile")}
          subtitle={t("mobile:you.profileSubtitle")}
          leading={<UserRound size={20} color={colors.fgMuted} />}
          onPress={() => router.push("/profile")}
        />
        <Row
          title={t("mobile:you.friends")}
          subtitle={t("mobile:you.friendsSubtitle")}
          leading={<Users size={20} color={colors.fgMuted} />}
          trailing={
            hasIncoming ? (
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: radius.pill,
                  backgroundColor: colors.accent,
                }}
              />
            ) : undefined
          }
          onPress={() => router.push("/friends")}
        />
        <Row
          title={t("mobile:you.recentCalls")}
          subtitle={t("mobile:you.recentCallsSubtitle")}
          leading={<Phone size={20} color={colors.fgMuted} />}
          onPress={() => router.push("/recent-calls")}
        />
        <Row
          title={t("mobile:accounts.switchTitle")}
          subtitle={t("mobile:accounts.switchSubtitle")}
          leading={<UsersRound size={20} color={colors.fgMuted} />}
          onPress={() => router.push("/switch-account")}
        />
        <Row
          title={t("mobile:you.settings")}
          subtitle={t("mobile:you.settingsSubtitle")}
          leading={<Settings size={20} color={colors.fgMuted} />}
          onPress={() => router.push("/settings")}
        />

        {/* Brand + version footer — the desktop SettingsShell "v{version}" line.
            Full runtime detail (OTA id, runtime version) stays in Settings. */}
        {appVersion ? (
          <Text
            selectable
            style={{
              color: colors.fgFaint,
              fontSize: 12,
              textAlign: "center",
              paddingTop: space.lg,
            }}
          >
            {t("mobile:you.version", { version: appVersion })}
          </Text>
        ) : null}
      </ScrollView>
      <StatusPicker
        visible={statusOpen}
        current={status}
        onSelect={(next) => {
          setSelfPresenceStatus(next);
          setStatusOpen(false);
        }}
        onClose={() => setStatusOpen(false)}
      />
    </Screen>
  );
}
