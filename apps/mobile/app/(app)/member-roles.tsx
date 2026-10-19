import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Check, Shield, UserX } from "lucide-react-native";
import type { RoleId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton, SkeletonList } from "@/components/Skeleton";
import { ToggleRow } from "@/components/ToggleRow";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { ROLE_DOT_FALLBACK } from "@/lib/roles";
import { useGroupDetails, useRoles, useSetMemberRoles } from "@/queries/chat-queries";
import { colors, motion, radius, space } from "@/theme/theme";

/**
 * Assign a member's roles (ADR 0007). The mobile equivalent of the desktop
 * MembersTab row menu: a checklist of the server's roles, saved on each toggle.
 * Owner ∨ MANAGE_ROLES; guests can hold none. The API re-checks the escalation
 * guard on every write.
 *
 * Koyu Masa: the member's identity on top, the checklist in a card, and the
 * save state said quietly beside the heading ("Saving…" → "Saved"). A refused
 * toggle springs back and the reason appears in a banner, not a dialog.
 */
export default function MemberRoles() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; userId: string }>();
  const groupId = params.groupId ?? null;
  const userId = params.userId ?? null;
  const insets = useSafeAreaInsets();

  const { data: details, isLoading } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);
  const setMemberRoles = useSetMemberRoles(groupId);

  const member = details?.members.find((m) => m.userId === userId) ?? null;
  const isGuest = member?.role === "guest";

  const [assigned, setAssigned] = useState<Set<RoleId>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  // Re-seed the local selection whenever the server's role set changes identity
  // (initial load + after a successful save the invalidated details refetch
  // returns the same set), not on every render.
  const roleIds = member?.roleIds;
  const serverKey = (roleIds ?? []).join(",");
  useEffect(() => {
    setAssigned(new Set(roleIds ?? []));
  }, [serverKey]);

  // "Saved" is a moment, not a state: it fades after a short beat.
  useEffect(() => {
    if (savedAt === 0) return;
    const timer = setTimeout(() => setSavedAt(0), 1800);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const toggle = (roleId: RoleId, next: boolean) => {
    if (!userId) return;
    setError(null);
    const nextSet = new Set(assigned);
    if (next) nextSet.add(roleId);
    else nextSet.delete(roleId);
    setAssigned(nextSet);
    setMemberRoles.mutate(
      { userId, roleIds: [...nextSet] },
      {
        onSuccess: () => setSavedAt(Date.now()),
        onError: (err) => {
          // Revert the optimistic toggle and surface the reason.
          setAssigned(new Set(member?.roleIds ?? []));
          setError(localizeError(err, t));
        },
      },
    );
  };

  const roleList = roles ?? [];
  const memberName = member ? member.user.displayName || member.user.username : "";

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.app }}
      contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom, gap: space.lg }}
    >
      <Stack.Screen options={{ title: t("mobile:memberRoles.title") }} />

      {isLoading && !details ? (
        <View style={{ gap: space.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Skeleton width={48} height={48} radius={radius.pill} />
            <Skeleton width="50%" height={18} />
          </View>
          <SkeletonList count={4} lines={1} leadingSize={20} leadingRadius={6} />
        </View>
      ) : null}

      {!isLoading && !member ? (
        <EmptyState
          icon={<UserX size={22} color={colors.fgMuted} />}
          title={t("mobile:memberRoles.notFound")}
          action={<Button label={t("common:buttons.back")} variant="secondary" size="sm" onPress={() => router.back()} />}
        />
      ) : null}

      {member ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.xl, backgroundColor: colors.surface }}>
            <Avatar name={memberName} size={48} uri={member.user.avatarUrl} ringColor={colors.surface} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text type="subheading" tone="display" numberOfLines={1}>
                {memberName}
              </Text>
              <Text type="meta" tone="faint" numberOfLines={1} style={{ fontWeight: "400" }}>
                @{member.user.username}
              </Text>
            </View>
          </View>

          <Text type="meta" tone="faint" style={{ paddingHorizontal: space.xs, fontWeight: "400" }}>
            {t("mobile:memberRoles.hint")}
          </Text>

          {error ? <Banner variant="danger" title={t("mobile:memberRoles.saveErrorTitle")} description={error} onDismiss={() => setError(null)} /> : null}

          {isGuest ? (
            <Banner variant="info" icon={Shield} title={t("mobile:memberRoles.guestNote")} />
          ) : roleList.length === 0 ? (
            <EmptyState compact icon={<Shield size={22} color={colors.fgMuted} />} title={t("mobile:memberRoles.noRoles")} />
          ) : (
            <View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <SectionEyebrow>{t("mobile:serverSettings.rolesSection")}</SectionEyebrow>
                <View accessibilityLiveRegion="polite" style={{ paddingBottom: space.sm, paddingHorizontal: space.xs }}>
                  {setMemberRoles.isPending ? (
                    <Text type="caption" tone="faint">
                      {t("mobile:memberRoles.saving")}
                    </Text>
                  ) : savedAt > 0 ? (
                    <Animated.View
                      entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
                      exiting={FadeOut.duration(motion.duration.hover).reduceMotion(ReduceMotion.System)}
                      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                    >
                      <Check size={12} color={colors.success} strokeWidth={2.5} />
                      <Text type="caption" tone="success">
                        {t("mobile:memberRoles.saved")}
                      </Text>
                    </Animated.View>
                  ) : null}
                </View>
              </View>
              <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl, borderCurve: "continuous", padding: space.xs }}>
                {roleList.map((role) => (
                  <ToggleRow
                    key={role.id}
                    label={role.name}
                    dotColor={role.color ?? ROLE_DOT_FALLBACK}
                    checked={assigned.has(role.id)}
                    disabled={setMemberRoles.isPending}
                    onToggle={() => toggle(role.id, !assigned.has(role.id))}
                  />
                ))}
              </View>
            </View>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}
