import { useState, type ReactNode } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import Constants from "expo-constants";
import { Text } from "@/components/ui/Text";
import { router } from "expo-router";
import { Pencil, Phone, Settings, Smile, UserRound, Users, UsersRound } from "lucide-react-native";
import { visibleCustomStatus } from "@demli/client-core";
import type { SelectablePresenceStatus } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Skeleton } from "@/components/Skeleton";
import { PresenceDot, StatusPicker } from "@/components/StatusPicker";
import { CountPill } from "@/components/ui/Badge";
import { Glow } from "@/components/ui/Glow";
import { Touchable } from "@/components/ui/Touchable";
import { useTabScreenBottomClearance } from "@/lib/use-bottom-chrome";
import { useFriendRequests, useMe } from "@/queries/social-queries";
import { setSelfPresenceStatus } from "@/realtime/connection";
import { useAuthStore } from "@/stores/auth-store";
import { useSelfPresenceStore } from "@/stores/self-presence-store";
import { colors, radius, space } from "@/theme/theme";

/** One grouped card of rows — the settings recipe ("gruplar surface kartında"). */
function RowGroup({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.card,
        borderCurve: "continuous",
        padding: space.xs,
        gap: 2,
      }}
    >
      {children}
    </View>
  );
}

/** The leading glyph of a You row: muted ink, fixed box so titles align. */
function RowIcon({ children }: { children: ReactNode }) {
  return <View style={{ width: 24, alignItems: "center", justifyContent: "center" }}>{children}</View>;
}

/**
 * You tab: the caller's own identity card plus quick links to the surfaces that
 * were previously buried in the Home header — status, profile, friends (with
 * the pending-request count), recent calls, accounts, settings. Deliberately
 * thin — it links to the existing screens rather than duplicating them.
 *
 * The identity card is the design system's profile card: a borderless card
 * with the one coral light along its top edge, the avatar with its presence
 * dot, the name in the display face. Tapping it edits the profile. While the
 * profile is first loading the card shows its own placeholder shapes.
 */
export default function YouTab() {
  const { t } = useAppTranslation();
  // Tab pill + (during a call) the voice bar — the last row scrolls clear of both.
  const bottomClearance = useTabScreenBottomClearance();
  const meQuery = useMe();
  const me = meQuery.data;
  const incoming = useFriendRequests("incoming");
  const incomingCount = incoming.data?.length ?? 0;

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
          paddingHorizontal: space.lg,
          paddingTop: space.sm,
          paddingBottom: space.xl + bottomClearance,
          gap: space.md,
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
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
      >
        {/* Identity card — tap to edit the profile. */}
        <Touchable
          onPress={() => router.push("/profile")}
          tone={colors.surface}
          pressedTone={colors.surfaceRaised}
          accessibilityRole="button"
          accessibilityLabel={name ? `${name}, ${t("mobile:you.editProfile")}` : t("mobile:you.editProfile")}
          style={{
            borderRadius: radius.card,
            borderCurve: "continuous",
            overflow: "hidden",
            padding: space.lg,
            paddingTop: space.xl,
          }}
        >
          <Glow size={320} style={{ top: -230, left: "50%", marginLeft: -160 }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
            {me ? (
              <Avatar
                name={name || "?"}
                size={64}
                uri={me.avatarUrl}
                presence={status}
                ring
                ringColor={colors.surface}
              />
            ) : (
              <Skeleton width={64} height={64} radius={radius.pill} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              {me ? (
                <>
                  <Text
                    variant="display"
                    numberOfLines={1}
                    style={{ color: colors.fgDisplay, fontSize: 22, lineHeight: 28, fontWeight: "600", letterSpacing: -0.2 }}
                  >
                    {name}
                  </Text>
                  {me.username ? (
                    <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 19 }}>
                      @{me.username}
                    </Text>
                  ) : null}
                  {/* Status line under the name — PLAIN TEXT, one line, never markdown. */}
                  {customStatus ? (
                    <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 13, lineHeight: 18 }}>
                      {customStatus}
                    </Text>
                  ) : null}
                </>
              ) : (
                <>
                  <Skeleton width="60%" height={18} radius={radius.sm} />
                  <Skeleton width="40%" height={12} radius={radius.sm} style={{ marginTop: space.xs }} />
                </>
              )}
            </View>
            <Pencil size={16} color={colors.fgFaint} />
          </View>
        </Touchable>

        <RowGroup>
          <Row
            title={t("mobile:presence.menuLabel")}
            subtitle={statusLabel[status]}
            leading={
              <RowIcon>
                <PresenceDot status={status} />
              </RowIcon>
            }
            onPress={() => setStatusOpen(true)}
          />
          {/* Custom status (M18) — the desktop keeps this next to the status
              picker in the user footer; mobile's equivalent is right under the
              presence row. Shows the live line so "edit" is obvious. */}
          <Row
            title={customStatus ? t("mobile:customStatus.edit") : t("mobile:customStatus.set")}
            subtitle={customStatus ?? t("mobile:customStatus.rowSubtitleEmpty")}
            leading={
              <RowIcon>
                <Smile size={20} color={colors.fgMuted} />
              </RowIcon>
            }
            onPress={() => router.push("/custom-status")}
          />
        </RowGroup>

        <RowGroup>
          <Row
            title={t("mobile:you.editProfile")}
            subtitle={t("mobile:you.profileSubtitle")}
            leading={
              <RowIcon>
                <UserRound size={20} color={colors.fgMuted} />
              </RowIcon>
            }
            onPress={() => router.push("/profile")}
          />
          <Row
            title={t("mobile:you.friends")}
            subtitle={t("mobile:you.friendsSubtitle")}
            leading={
              <RowIcon>
                <Users size={20} color={colors.fgMuted} />
              </RowIcon>
            }
            trailing={
              incomingCount > 0 ? (
                <CountPill
                  text={incomingCount > 99 ? "99+" : String(incomingCount)}
                  label={t("mobile:friends.requestsBadgeA11y", { count: incomingCount })}
                />
              ) : undefined
            }
            onPress={() => router.push("/friends")}
          />
          <Row
            title={t("mobile:you.recentCalls")}
            subtitle={t("mobile:you.recentCallsSubtitle")}
            leading={
              <RowIcon>
                <Phone size={20} color={colors.fgMuted} />
              </RowIcon>
            }
            onPress={() => router.push("/recent-calls")}
          />
        </RowGroup>

        <RowGroup>
          <Row
            title={t("mobile:accounts.switchTitle")}
            subtitle={t("mobile:accounts.switchSubtitle")}
            leading={
              <RowIcon>
                <UsersRound size={20} color={colors.fgMuted} />
              </RowIcon>
            }
            onPress={() => router.push("/switch-account")}
          />
          <Row
            title={t("mobile:you.settings")}
            subtitle={t("mobile:you.settingsSubtitle")}
            leading={
              <RowIcon>
                <Settings size={20} color={colors.fgMuted} />
              </RowIcon>
            }
            onPress={() => router.push("/settings")}
          />
        </RowGroup>

        {/* Brand + version footer — the desktop SettingsShell "v{version}" line.
            Full runtime detail (OTA id, runtime version) stays in Settings. */}
        {appVersion ? (
          <Text
            selectable
            style={{
              color: colors.fgFaint,
              fontSize: 12,
              lineHeight: 16,
              textAlign: "center",
              paddingTop: space.sm,
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
