import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RoleId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { ToggleRow } from "@/components/ToggleRow";
import { localizeError } from "@/lib/errors";
import { ROLE_DOT_FALLBACK } from "@/lib/roles";
import { useGroupDetails, useRoles, useSetMemberRoles } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * Assign a member's roles (ADR 0007). The mobile equivalent of the desktop
 * MembersTab row menu: a checklist of the server's roles, saved on each toggle.
 * Owner ∨ MANAGE_ROLES; guests can hold none. The API re-checks the escalation
 * guard on every write.
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

  // Reconcile local selection with the server's roleIds (initial seed + after a
  // successful save the invalidated details refetch returns the same set).
  // Re-seed the local selection whenever the server's role set changes identity
  // (initial load + after a successful save the invalidated details refetch
  // returns the same set), not on every render.
  const roleIds = member?.roleIds;
  const serverKey = (roleIds ?? []).join(",");
  useEffect(() => {
    setAssigned(new Set(roleIds ?? []));
  }, [serverKey]);

  const toggle = (roleId: RoleId, next: boolean) => {
    if (!userId) return;
    const nextSet = new Set(assigned);
    if (next) nextSet.add(roleId);
    else nextSet.delete(roleId);
    setAssigned(nextSet);
    setMemberRoles.mutate(
      { userId, roleIds: [...nextSet] },
      {
        onError: (err) => {
          // Revert the optimistic toggle and surface the reason.
          setAssigned(new Set(member?.roleIds ?? []));
          Alert.alert(t("mobile:memberRoles.title"), localizeError(err, t));
        },
      },
    );
  };

  const roleList = roles ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.app }}
      contentContainerStyle={{
        padding: space.lg,
        paddingBottom: space.xl + insets.bottom,
        gap: space.lg,
      }}
    >
      <Stack.Screen options={{ title: t("mobile:memberRoles.title") }} />

      {isLoading && !details ? (
        <View style={{ paddingTop: space.xl, alignItems: "center" }}>
          <ActivityIndicator color={colors.fgFaint} />
        </View>
      ) : null}

      {!isLoading && !member ? (
        <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center", paddingTop: space.xl }}>
          {t("mobile:memberRoles.notFound")}
        </Text>
      ) : null}

      {member ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <Avatar
              name={member.user.displayName || member.user.username}
              size={44}
              uri={member.user.avatarUrl}
            />
            <View style={{ flex: 1 }}>
              <Text variant="display" numberOfLines={1} style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
                {member.user.displayName || member.user.username}
              </Text>
              <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                {t("mobile:memberRoles.hint")}
              </Text>
            </View>
          </View>

          {isGuest ? (
            <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md }}>
              <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
                {t("mobile:memberRoles.guestNote")}
              </Text>
            </View>
          ) : roleList.length === 0 ? (
            <Text style={{ color: colors.fgMuted, fontSize: 13 }}>
              {t("mobile:memberRoles.noRoles")}
            </Text>
          ) : (
            <View style={{ marginHorizontal: -space.md }}>
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
          )}
        </>
      ) : null}
    </ScrollView>
  );
}
