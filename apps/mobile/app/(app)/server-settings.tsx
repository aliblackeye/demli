import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloudOff, Plus, Save, ScrollText, Smile, Trash2 } from "lucide-react-native";
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { PERMISSIONS } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { ChipSelect } from "@/components/ChipSelect";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import {
  DangerZone,
  ROW_ICON_INSET,
  SectionEyebrow,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { resolveListLoadState } from "@/lib/load-state";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { canSeeModerationLog } from "@/lib/moderation-log";
import { buildMemberColorMap } from "@/lib/permissions";
import { ROLE_DOT_FALLBACK } from "@/lib/roles";
import { useCreateRole, useGroupDetails, useRoles, useServerPermissions } from "@/queries/chat-queries";
import { useDeleteGroup, useUpdateGroup } from "@/queries/management-queries";
import { colors, radius, space } from "@/theme/theme";

/** Sentinel key for "no system channel" in the picker. */
const SYSTEM_CHANNEL_OFF = "__off__";

/** Role colour dot in a 32px slot, so role rows line up with icon rows. */
function RoleDot({ color }: { color: string | null }) {
  return (
    <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color ?? ROLE_DOT_FALLBACK }} />
    </View>
  );
}

function ServerSettingsSkeleton() {
  return (
    <View style={{ gap: space.xl }}>
      <View style={{ alignItems: "center", gap: space.md }}>
        <Skeleton width={72} height={72} radius={radius.pill} />
        <Skeleton width="40%" height={18} />
      </View>
      <Skeleton width="100%" height={44} radius={radius.lg} />
      <Skeleton width="100%" height={44} radius={radius.lg} />
      <Skeleton width="100%" height={160} radius={radius.xl} />
    </View>
  );
}

/**
 * Server settings. General (rename, icon, system channel, delete) is owner-only.
 * Roles + Members sections are shown to owner ∨ MANAGE_ROLES (ADR 0007) — the
 * gating is cosmetic; the API re-checks every mutation. Presented as a modal.
 *
 * Koyu Masa: the server's identity on top (icon + name, previewing the edit),
 * the general form on the page, every list a settings card (roles with their
 * colour, members with avatars, emoji, audit log), deletion in the danger zone
 * behind a sheet that names the server and what goes with it. Loading draws the
 * shape; a failed load says so with a retry; errors appear where they happened.
 */
export default function ServerSettings() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = params.groupId ?? null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const { data, isLoading, isError, error: loadError, refetch, isFetching } = useGroupDetails(groupId);
  const rolesQuery = useRoles(groupId);
  const roles = rolesQuery.data;
  // "No roles yet" only after the roles request SUCCEEDED empty — never while it
  // is loading or after it failed (that offered an owner to create a first role
  // on a server that already has some).
  const rolesState = resolveListLoadState(rolesQuery, roles);
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
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length === 0 || trimmedName.length > GROUP_NAME_MAX_LENGTH;
  const dirty =
    !!group &&
    (trimmedName !== group.name ||
      (iconUrl.trim() || null) !== (group.iconUrl ?? null) ||
      systemChannelId !== (group.systemChannelId ?? null));

  const onSave = () => {
    if (nameInvalid) {
      setError(t("mobile:serverSettings.validationName", { max: GROUP_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    updateGroup.mutate(
      { name: trimmedName, iconUrl: iconUrl.trim() || null, systemChannelId },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  const onDelete = () => {
    setDeleteError(null);
    deleteGroup.mutate(undefined, {
      onSuccess: () => {
        setConfirmDelete(false);
        router.navigate("/groups");
      },
      onError: (err) => setDeleteError(localizeError(err, t)),
    });
  };

  const onCreateRole = () => {
    if (!groupId || createRole.isPending) return;
    setRolesError(null);
    createRole.mutate(
      { name: t("mobile:roleEditor.newRoleName") },
      {
        onSuccess: ({ role }) => router.push({ pathname: "/role-settings", params: { groupId, roleId: role.id } }),
        onError: (err) => setRolesError(localizeError(err, t)),
      },
    );
  };

  const openRole = (roleId: string) =>
    router.push({ pathname: "/role-settings", params: { groupId: groupId ?? "", roleId } });

  const openMemberRoles = (userId: string) =>
    router.push({ pathname: "/member-roles", params: { groupId: groupId ?? "", userId } });

  const roleLabel = (role: "owner" | "member" | "guest") =>
    role === "owner" ? t("mobile:role.owner") : role === "guest" ? t("mobile:role.guest") : t("mobile:role.member");

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <Stack.Screen options={{ title: t("mobile:serverSettings.title") }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom + keyboard, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {isLoading && !group ? <ServerSettingsSkeleton /> : null}

        {isError && !group ? (
          <EmptyState
            tone="error"
            icon={<CloudOff size={22} color={colors.danger} />}
            title={t("mobile:serverSettings.loadErrorTitle")}
            subtitle={localizeError(loadError, t)}
            action={
              <Button label={t("common:buttons.retry")} variant="secondary" size="sm" onPress={() => void refetch()} loading={isFetching} />
            }
          />
        ) : null}

        {group ? (
          <>
            {/* Identity — previews the name/icon being edited. */}
            <View style={{ alignItems: "center", gap: space.sm }}>
              <Avatar name={name || group.name} size={72} uri={iconUrl.trim() || null} />
              <Text type="heading" tone="display" numberOfLines={2} style={{ textAlign: "center" }}>
                {trimmedName || group.name}
              </Text>
              <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                {t("mobile:serverSettings.memberCount", { count: members.length })}
              </Text>
            </View>

            {isOwner ? (
              <View style={{ gap: space.lg }}>
                {error ? <Banner variant="danger" title={t("mobile:serverSettings.saveErrorTitle")} description={error} /> : null}
                <TextField
                  label={t("mobile:serverSettings.nameLabel")}
                  value={name}
                  onChangeText={setName}
                  maxLength={GROUP_NAME_MAX_LENGTH}
                  placeholder={t("mobile:serverSettings.namePlaceholder")}
                  error={nameInvalid && hydrated ? t("mobile:serverSettings.validationName", { max: GROUP_NAME_MAX_LENGTH }) : null}
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
                  <SectionEyebrow style={{ paddingBottom: 0 }}>{t("mobile:serverSettings.systemChannel")}</SectionEyebrow>
                  <ChipSelect
                    accessibilityLabel={t("mobile:serverSettings.systemChannel")}
                    options={systemChannelOptions}
                    selectedKey={systemChannelId ?? SYSTEM_CHANNEL_OFF}
                    onSelect={(key) => setSystemChannelId(key === SYSTEM_CHANNEL_OFF ? null : key)}
                  />
                  <Text type="meta" tone="faint" style={{ paddingHorizontal: space.xs, fontWeight: "400" }}>
                    {t("mobile:serverSettings.systemChannelHint")}
                  </Text>
                </View>
                <Button
                  label={t("mobile:common.saveChanges")}
                  icon={Save}
                  variant="accent"
                  size="lg"
                  block
                  onPress={onSave}
                  loading={updateGroup.isPending}
                  disabled={!dirty || nameInvalid}
                />
              </View>
            ) : null}

            {canManageRoles ? (
              <>
                <View style={{ gap: space.sm }}>
                  {rolesError ? <Banner variant="danger" title={t("mobile:serverSettings.rolesSection")} description={rolesError} /> : null}
                  <SettingsSection
                    title={t("mobile:serverSettings.rolesSection")}
                    footer={t("mobile:serverSettings.rolesHint")}
                    separatorInset={ROW_ICON_INSET}
                  >
                    {rolesState === "loading" ? (
                      <SettingsRow key="loading" title={t("mobile:serverSettings.loading")} busy chevron={false} />
                    ) : null}
                    {rolesState === "error" ? (
                      <SettingsRow
                        key="error"
                        icon={CloudOff}
                        destructive
                        title={t("mobile:memberRoles.rolesLoadErrorTitle")}
                        subtitle={localizeError(rolesQuery.error, t)}
                        value={t("buttons.retry")}
                        onPress={() => void rolesQuery.refetch()}
                        busy={rolesQuery.isFetching}
                      />
                    ) : null}
                    {rolesState === "empty" ? (
                      <SettingsRow key="none" title={t("mobile:serverSettings.noRoles")} chevron={false} />
                    ) : null}
                    {(roles ?? []).map((role) => (
                      <SettingsRow key={role.id} leading={<RoleDot color={role.color} />} title={role.name} onPress={() => openRole(role.id)} />
                    ))}
                    <SettingsRow
                      key="new"
                      icon={Plus}
                      accent
                      title={t("mobile:serverSettings.newRole")}
                      onPress={onCreateRole}
                      busy={createRole.isPending}
                      chevron={false}
                    />
                  </SettingsSection>
                </View>

                {/* Custom emoji (M17). Open to every member — the API lets any
                    member upload, and deletion is gated per-row (uploader ∨
                    owner) on the screen itself. */}
                <SettingsSection title={t("mobile:emoji.title")} footer={t("mobile:emoji.hint")}>
                  <SettingsRow
                    icon={Smile}
                    title={t("mobile:emoji.tab")}
                    onPress={() => router.push({ pathname: "/server-emoji", params: { groupId: groupId ?? "" } })}
                  />
                </SettingsSection>

                <SettingsSection
                  title={t("mobile:serverSettings.membersSection")}
                  footer={t("mobile:serverSettings.membersHint")}
                  separatorInset={ROW_ICON_INSET + 4}
                >
                  {members.map((member) => {
                    const memberName = member.user.displayName || member.user.username;
                    const color = memberColors.get(member.userId) ?? null;
                    return (
                      <SettingsRow
                        key={member.userId}
                        leading={<Avatar name={memberName} size={36} uri={member.user.avatarUrl} ringColor={colors.surface} />}
                        title={memberName}
                        subtitle={roleLabel(member.role)}
                        trailing={
                          color ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} /> : undefined
                        }
                        onPress={() => openMemberRoles(member.userId)}
                      />
                    );
                  })}
                </SettingsSection>
              </>
            ) : null}

            {/* Audit log (M18): owner ∨ KICK_MEMBERS — the SAME gate the endpoint
                enforces ("whoever may moderate may see what has been
                moderated"). Anyone else never sees the row at all, rather than a
                row that 403s on open (§35). Deliberately OUTSIDE the
                MANAGE_ROLES block above: a moderator who may kick but not manage
                roles still gets the log. */}
            {canSeeModerationLog(isOwner, can) ? (
              <SettingsSection title={t("mobile:moderationLog.title")} footer={t("mobile:moderationLog.description")}>
                <SettingsRow
                  icon={ScrollText}
                  title={t("mobile:moderationLog.rowTitle")}
                  subtitle={t("mobile:moderationLog.rowSubtitle")}
                  onPress={() => router.push({ pathname: "/moderation-log", params: { groupId: groupId ?? "" } })}
                />
              </SettingsSection>
            ) : null}

            {isOwner ? (
              <DangerZone
                title={t("mobile:common.dangerZone")}
                description={t("mobile:serverSettings.dangerDescription")}
              >
                <Button
                  label={t("mobile:serverSettings.delete")}
                  icon={Trash2}
                  variant="danger"
                  onPress={() => {
                    setDeleteError(null);
                    setConfirmDelete(true);
                  }}
                />
              </DangerZone>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={confirmDelete}
        title={t("mobile:serverSettings.deleteConfirmTitle")}
        body={t("mobile:serverSettings.deleteConfirmBody", {
          name: group?.name ?? t("mobile:serverSettings.deleteConfirmFallbackName"),
        })}
        confirmLabel={t("buttons.delete")}
        confirmIcon={Trash2}
        onConfirm={onDelete}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setConfirmDelete(false)}
        busy={deleteGroup.isPending}
        error={deleteError}
        errorTitle={t("mobile:serverSettings.deleteError")}
      />
    </View>
  );
}
