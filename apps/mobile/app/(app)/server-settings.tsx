import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus, ScrollText } from "lucide-react-native";
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { ChipSelect } from "@/components/ChipSelect";
import { Row } from "@/components/Row";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import { canSeeModerationLog } from "@/lib/moderation-log";
import { buildMemberColorMap } from "@/lib/permissions";
import { ROLE_DOT_FALLBACK } from "@/lib/roles";
import {
  useCreateRole,
  useGroupDetails,
  useRoles,
  useServerPermissions,
} from "@/queries/chat-queries";
import { useDeleteGroup, useUpdateGroup } from "@/queries/management-queries";
import { colors, radius, space, typography } from "@/theme/theme";

/** Sentinel key for "no system channel" in the picker. */
const SYSTEM_CHANNEL_OFF = "__off__";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

/** Small colored dot for a role row's leading slot. */
function RoleDot({ color }: { color: string | null }) {
  return (
    <View
      style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color ?? ROLE_DOT_FALLBACK }}
    />
  );
}

/**
 * Server settings. General (rename, icon, system channel, delete) is owner-only.
 * Roles + Members sections are shown to owner ∨ MANAGE_ROLES (ADR 0007) — the
 * gating is cosmetic; the API re-checks every mutation. Presented as a modal.
 */
export default function ServerSettings() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = params.groupId ?? null;
  const insets = useSafeAreaInsets();

  const { data, isLoading } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);
  const { isOwner, can } = useServerPermissions(groupId);
  const canManageRoles = isOwner || can(PERMISSIONS.MANAGE_ROLES);

  const updateGroup = useUpdateGroup(groupId);
  const deleteGroup = useDeleteGroup(groupId);
  const createRole = useCreateRole(groupId);
  const group = data?.group;
  const textChannels = (data?.channels ?? []).filter((c) => c.kind === "text");
  const members = data?.members ?? [];
  const memberColors = useMemo(() => buildMemberColorMap(members, roles), [members, roles]);

  const [name, setName] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [systemChannelId, setSystemChannelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Seed the form from the fetched server once.
  useEffect(() => {
    if (group && !hydrated) {
      setName(group.name);
      setIconUrl(group.iconUrl ?? "");
      setSystemChannelId(group.systemChannelId ?? null);
      setHydrated(true);
    }
  }, [group, hydrated]);

  const systemChannelOptions = [
    { key: SYSTEM_CHANNEL_OFF, label: t("mobile:common.off") },
    ...textChannels.map((c) => ({ key: c.id, label: `# ${c.name}` })),
  ];

  const onSave = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
      setError(t("mobile:serverSettings.validationName", { max: GROUP_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    updateGroup.mutate(
      { name: trimmed, iconUrl: iconUrl.trim() || null, systemChannelId },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  const onDelete = () => {
    Alert.alert(
      t("mobile:serverSettings.deleteConfirmTitle"),
      t("mobile:serverSettings.deleteConfirmBody", {
        name: group?.name ?? t("mobile:serverSettings.deleteConfirmFallbackName"),
      }),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.delete"),
          style: "destructive",
          onPress: () =>
            deleteGroup.mutate(undefined, {
              onSuccess: () => router.navigate("/groups"),
              onError: (err) =>
                Alert.alert(t("mobile:serverSettings.deleteError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  const onCreateRole = () => {
    if (!groupId || createRole.isPending) return;
    createRole.mutate(
      { name: t("mobile:roleEditor.newRoleName") },
      {
        onSuccess: ({ role }) =>
          router.push({ pathname: "/role-settings", params: { groupId, roleId: role.id } }),
        onError: (err) =>
          Alert.alert(t("mobile:serverSettings.rolesSection"), localizeError(err, t)),
      },
    );
  };

  const openRole = (roleId: string) =>
    router.push({ pathname: "/role-settings", params: { groupId: groupId ?? "", roleId } });

  const openMemberRoles = (userId: string) =>
    router.push({ pathname: "/member-roles", params: { groupId: groupId ?? "", userId } });

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.app }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen options={{ title: t("mobile:serverSettings.title") }} />

        {isLoading && !group ? (
          <View style={{ paddingTop: space.xl, alignItems: "center" }}>
            <ActivityIndicator color={colors.fgFaint} />
          </View>
        ) : null}

        {group ? (
          <>
            {error ? (
              <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
                <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
                  {error}
                </Text>
              </View>
            ) : null}

            {isOwner ? (
              <>
                <View style={{ alignItems: "center", gap: space.sm }}>
                  <Avatar name={name || group.name} size={72} uri={iconUrl} />
                </View>

                <View style={{ gap: space.md }}>
                  <TextField
                    label={t("mobile:serverSettings.nameLabel")}
                    value={name}
                    onChangeText={setName}
                    maxLength={GROUP_NAME_MAX_LENGTH}
                    placeholder={t("mobile:serverSettings.namePlaceholder")}
                  />
                  <TextField
                    label={t("mobile:serverSettings.iconLabel")}
                    value={iconUrl}
                    onChangeText={setIconUrl}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder={t("mobile:serverSettings.iconPlaceholder")}
                    hint={t("mobile:common.imageLinkHint")}
                  />

                  <View style={{ gap: space.sm }}>
                    <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
                      {t("mobile:serverSettings.systemChannel")}
                    </Text>
                    <ChipSelect
                      options={systemChannelOptions}
                      selectedKey={systemChannelId ?? SYSTEM_CHANNEL_OFF}
                      onSelect={(key) =>
                        setSystemChannelId(key === SYSTEM_CHANNEL_OFF ? null : key)
                      }
                    />
                    <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                      {t("mobile:serverSettings.systemChannelHint")}
                    </Text>
                  </View>

                  <Button label={t("mobile:common.saveChanges")} onPress={onSave} loading={updateGroup.isPending} />
                </View>
              </>
            ) : null}

            {canManageRoles ? (
              <>
                <View style={{ height: 1, backgroundColor: colors.stroke }} />

                <View style={{ gap: space.sm }}>
                  <SectionLabel>{t("mobile:serverSettings.rolesSection")}</SectionLabel>
                  <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                    {t("mobile:serverSettings.rolesHint")}
                  </Text>
                  <View style={{ gap: space.xs }}>
                    {(roles ?? []).length === 0 ? (
                      <Text style={{ color: colors.fgMuted, fontSize: 13, paddingVertical: space.xs }}>
                        {t("mobile:serverSettings.noRoles")}
                      </Text>
                    ) : (
                      (roles ?? []).map((role) => (
                        <Row
                          key={role.id}
                          title={role.name}
                          leading={<RoleDot color={role.color} />}
                          onPress={() => openRole(role.id)}
                        />
                      ))
                    )}
                    <Row
                      title={t("mobile:serverSettings.newRole")}
                      accent
                      leading={<Plus size={20} color={colors.accent} />}
                      showChevron={false}
                      onPress={onCreateRole}
                    />
                  </View>
                </View>

                {/* Custom emoji (M17). Open to every member — the API lets any
                    member upload, and deletion is gated per-row (uploader ∨
                    owner) on the screen itself. */}
                <View style={{ gap: space.sm }}>
                  <SectionLabel>{t("mobile:emoji.title")}</SectionLabel>
                  <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                    {t("mobile:emoji.hint")}
                  </Text>
                  <Row
                    title={t("mobile:emoji.tab")}
                    onPress={() =>
                      router.push({
                        pathname: "/server-emoji",
                        params: { groupId: groupId ?? "" },
                      })
                    }
                  />
                </View>

                <View style={{ gap: space.sm }}>
                  <SectionLabel>{t("mobile:serverSettings.membersSection")}</SectionLabel>
                  <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                    {t("mobile:serverSettings.membersHint")}
                  </Text>
                  <View style={{ gap: space.xs }}>
                    {members.map((member) => (
                      <Row
                        key={member.userId}
                        title={member.user.displayName || member.user.username}
                        subtitle={
                          member.role === "owner"
                            ? t("mobile:role.owner")
                            : member.role === "guest"
                              ? t("mobile:role.guest")
                              : t("mobile:role.member")
                        }
                        leading={
                          <Avatar
                            name={member.user.displayName || member.user.username}
                            size={36}
                            uri={member.user.avatarUrl}
                          />
                        }
                        trailing={
                          memberColors.get(member.userId) ? (
                            <RoleDot color={memberColors.get(member.userId) ?? null} />
                          ) : undefined
                        }
                        onPress={() => openMemberRoles(member.userId)}
                      />
                    ))}
                  </View>
                </View>
              </>
            ) : null}

            {/* Audit log (M18): owner ∨ KICK_MEMBERS — the SAME gate the endpoint
                enforces ("whoever may moderate may see what has been
                moderated"). Anyone else never sees the row at all, rather than a
                row that 403s on open (§35). Deliberately OUTSIDE the
                MANAGE_ROLES block above: a moderator who may kick but not manage
                roles still gets the log. */}
            {canSeeModerationLog(isOwner, can) ? (
              <>
                <View style={{ height: 1, backgroundColor: colors.stroke }} />

                <View style={{ gap: space.sm }}>
                  <SectionLabel>{t("mobile:moderationLog.title")}</SectionLabel>
                  <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                    {t("mobile:moderationLog.description")}
                  </Text>
                  <Row
                    title={t("mobile:moderationLog.rowTitle")}
                    subtitle={t("mobile:moderationLog.rowSubtitle")}
                    leading={<ScrollText size={20} color={colors.fgMuted} />}
                    onPress={() =>
                      router.push({
                        pathname: "/moderation-log",
                        params: { groupId: groupId ?? "" },
                      })
                    }
                  />
                </View>
              </>
            ) : null}

            {isOwner ? (
              <>
                <View style={{ height: 1, backgroundColor: colors.stroke }} />

                <View style={{ gap: space.md }}>
                  <SectionLabel>{t("mobile:common.dangerZone")}</SectionLabel>
                  <Button
                    label={t("mobile:serverSettings.delete")}
                    variant="danger"
                    onPress={onDelete}
                    loading={deleteGroup.isPending}
                    style={{ borderRadius: radius.md }}
                  />
                </View>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
